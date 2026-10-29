/**
 * Bounded, resumable public-market-data research ONLY.
 * This module never reads exchange credentials or uses authenticated endpoints.
 * Every network request is an unauthenticated GET to the fixed Bitget v3
 * historical candles endpoint. No trading or live deployment.
 */
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { auditHourlyCandles, planHistoryWindows, TEN_YEARS_DAYS } from './market-universe-history.js';

export const HISTORY_ENDPOINT = '/api/v3/market/history-candles';
export const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const API_ORIGIN = 'https://api.bitget.com';
const MAX_PAGE_BYTES = 300_000;
const VALID_SYMBOL = /^[A-Z0-9]{3,32}$/;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = value => Number.isSafeInteger(value);
const safeSymbol = symbol => typeof symbol === 'string' && VALID_SYMBOL.test(symbol);

/** A frozen, checksummed research plan; current ONLINE symbols are not a historic universe. */
export function createHistoricalPlan(universe, {
  nowMs = Date.now(), lookbackDays = TEN_YEARS_DAYS,
  maxMarkets = 2, marketOffset = 0, candlesPerPage = 90
} = {}) {
  if (universe?.exchange !== 'Bitget' || universe.market !== 'SPOT' ||
      !Array.isArray(universe.markets) || !/^[a-f0-9]{64}$/.test(universe.inventorySha256 ?? '') ||
      !integer(nowMs) || nowMs <= HOUR_MS ||
      !integer(lookbackDays) || lookbackDays < 1 || lookbackDays > TEN_YEARS_DAYS ||
      !integer(maxMarkets) || maxMarkets < 1 || maxMarkets > 100 ||
      !integer(marketOffset) || marketOffset < 0 || marketOffset > 20_000 ||
      !integer(candlesPerPage) || candlesPerPage < 1 || candlesPerPage > 90) {
    throw new Error('INVALID_HISTORY_PLAN_INPUT');
  }
  if (hash(universe.markets) !== universe.inventorySha256)
    throw new Error('HISTORY_UNIVERSE_INVENTORY_CHECKSUM_MISMATCH');
  const markets = universe.markets.slice(marketOffset, marketOffset + maxMarkets).map(m => {
    if (!safeSymbol(m?.symbol)) throw new Error('INVALID_HISTORY_MARKET_SYMBOL');
    const listedMs = integer(m.firstListedMs) && m.firstListedMs > 0 && m.firstListedMs <= nowMs
      ? m.firstListedMs : null;
    return {symbol:m.symbol, listedMs, firstAvailableMs:listedMs ?? nowMs-lookbackDays*DAY_MS,
      researchEligible: m.researchEligible === true};
  });
  if (markets.length===0) throw new Error('HISTORY_MARKET_OFFSET_OUT_OF_RANGE');
  if (new Set(markets.map(m=>m.symbol)).size !== markets.length) throw new Error('DUPLICATE_HISTORY_SYMBOL');
  const plan = {
    schemaVersion:1, exchange:'Bitget', market:'SPOT',
    asof:universe.asof, anchorNowMs:nowMs, lookbackDays, candlesPerPage,
    universeSha256:universe.inventorySha256,
    inventoryMarketCount:universe.marketCount, requestedMaxMarkets:maxMarkets,
    marketOffset,
    selectedMarketCount:markets.length,
    selection:'CURRENT_ONLINE_SPOT_USDT_USDC_OFFSET_BATCH_BY_TURNOVER;NOT_POINT_IN_TIME',
    historicalCompleteness:'UNKNOWN_UNTIL_DOWNLOADED_AND_AUDITED',
    markets
  };
  return {...plan,planSha256:hash(plan)};
}

export function verifyHistoricalPlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.exchange !== 'Bitget' ||
      plan.market !== 'SPOT' || !integer(plan.anchorNowMs) ||
      !integer(plan.lookbackDays) || plan.lookbackDays < 1 || plan.lookbackDays > TEN_YEARS_DAYS ||
      !integer(plan.candlesPerPage) || plan.candlesPerPage < 1 || plan.candlesPerPage > 90 ||
      !Array.isArray(plan.markets) || plan.markets.length < 1 || plan.markets.length > 100 ||
      !Number.isSafeInteger(plan.marketOffset) || plan.marketOffset<0 || plan.marketOffset>20_000 ||
      !Number.isSafeInteger(plan.inventoryMarketCount) ||
      plan.inventoryMarketCount<plan.marketOffset+plan.markets.length ||
      !Number.isSafeInteger(plan.requestedMaxMarkets) || plan.requestedMaxMarkets<1 ||
      plan.requestedMaxMarkets>100 || !Number.isSafeInteger(plan.selectedMarketCount) ||
      plan.selectedMarketCount>plan.requestedMaxMarkets ||
      plan.selectedMarketCount !== plan.markets.length ||
      plan.markets.some(m => !safeSymbol(m?.symbol) || !integer(m.firstAvailableMs) ||
        m.firstAvailableMs <= 0 || m.firstAvailableMs > plan.anchorNowMs) ||
      new Set(plan.markets.map(m=>m.symbol)).size !== plan.markets.length ||
      !/^[a-f0-9]{64}$/.test(plan.planSha256 ?? '')) throw new Error('HISTORY_PLAN_INVALID');
  const {planSha256, ...body} = plan;
  if (hash(body) !== planSha256) throw new Error('HISTORY_PLAN_CHECKSUM_MISMATCH');
  return plan;
}

/** Bitget v3 history-candles: closed 1H bars, <=100 rows, <=90 day range.
 * An extra hour at either boundary accommodates documented exclusive endpoints
 * and rounding; all out-of-window bars are independently audited and excluded.
 */
export function historyRequestUrl(window) {
  const {symbol,startMs,endMs,expectedHours} = window ?? {};
  if (!safeSymbol(symbol) || !integer(startMs) || !integer(endMs) ||
      startMs < 2*HOUR_MS || endMs < startMs ||
      startMs % HOUR_MS !== 0 || endMs % HOUR_MS !== 0 ||
      !integer(expectedHours) || expectedHours !== (endMs-startMs)/HOUR_MS+1 ||
      expectedHours < 1 || expectedHours > 90) throw new Error('INVALID_HISTORY_WINDOW');
  const url = new URL(API_ORIGIN + HISTORY_ENDPOINT);
  for (const [k,v] of Object.entries({
    category:'SPOT',symbol,interval:'1H',type:'market',
    startTime:startMs-HOUR_MS,endTime:endMs+HOUR_MS,limit:100
  })) url.searchParams.set(k,String(v));
  if (Number(url.searchParams.get('endTime'))-Number(url.searchParams.get('startTime')) > 90*DAY_MS) {
    throw new Error('HISTORY_90_DAY_LIMIT');
  }
  return url.toString();
}

function validPrice(value, allowZero=false) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && (allowZero ? n>=0 : n>0) ? n : null;
}

/** No interpolation, forward-fill or fabricated candles. */
export function normalizeHistoryResponse(data, window) {
  historyRequestUrl(window);
  if (!Array.isArray(data) || data.length > 100) throw new Error('INVALID_HISTORY_RESPONSE_SIZE');
  const seen = new Map();
  let duplicates=0, outside=0;
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 7 || row.length > 8) throw new Error('INVALID_HISTORY_ROW');
    const timestamp=Number(row[0]);
    const values=row.slice(1,7).map((v,i)=>validPrice(v,i>=4));
    const [open,high,low,close,baseVol,quoteVol]=values;
    if (!integer(timestamp) || timestamp % HOUR_MS !== 0 || timestamp<=0 ||
        values.some(v=>v===null) ||
        high < Math.max(open,close,low) || low > Math.min(open,close) ||
        high < low) throw new Error('INVALID_HISTORY_OHLCV');
    const canonical=[timestamp,open,high,low,close,baseVol,quoteVol];
    if (timestamp < window.startMs || timestamp > window.endMs) {outside++;continue;}
    if (seen.has(timestamp)) {
      duplicates++;
      if (JSON.stringify(seen.get(timestamp)) !== JSON.stringify(canonical))
        throw new Error('HISTORY_CONFLICTING_DUPLICATE');
    } else seen.set(timestamp,canonical);
  }
  const rows=[...seen.values()].sort((a,b)=>a[0]-b[0]);
  const audit=auditHourlyCandles(rows,{startMs:window.startMs,endMs:window.endMs});
  return {rows,audit:{...audit,rawRows:data.length,outside,duplicates}};
}

/** Retry transport and 429/5xx only. Invalid payloads fail closed. */
export async function fetchHistoricalPage(window, {
  fetchFn=globalThis.fetch, sleepFn=sleep, beforeAttempt=async()=>{},
  attempts=3
}={}) {
  const url=historyRequestUrl(window);
  if (!integer(attempts) || attempts<1 || attempts>4 ||
      typeof fetchFn !== 'function' || typeof beforeAttempt !== 'function')
    throw new Error('INVALID_HISTORY_FETCH_OPTIONS');
  let last;
  for (let i=0;i<attempts;i++) {
    await beforeAttempt();
    let response;
    try {
      response=await fetchFn(url,{
        method:'GET',redirect:'error',credentials:'omit',
        signal:AbortSignal.timeout(12_000),
        headers:{Accept:'application/json','User-Agent':'AlphaBot-PAPER-history-pilot/1.0'}
      });
    } catch(err) {
      last=err;
      if (i+1<attempts) {await sleepFn(500*2**i);continue;}
      break;
    }
    const status=Number(response?.status) || 0;
    if (!response?.ok) {
      if ((status===429 || status>=500) && i+1<attempts) {
        last=new Error('HISTORY_TRANSIENT_HTTP_'+status);
        await sleepFn(500*2**i);continue;
      }
      throw new Error('HISTORY_HTTP_'+status);
    }
    const body=await response.json();
    if (body?.code !== '00000' || !Array.isArray(body?.data))
      throw new Error('HISTORY_API_RESPONSE_INVALID');
    return normalizeHistoryResponse(body.data,window);
  }
  throw new Error('HISTORY_NETWORK_RETRIES_EXHAUSTED: '+String(last?.message??last).slice(0,120));
}

export function historyPagePath(outputDir, window) {
  historyRequestUrl(window);
  return join(resolve(outputDir), 'pages', window.symbol,
    String(window.startMs)+'-'+String(window.endMs)+'.json');
}
export function makeHistoryRecord(plan,window,result,fetchedAt=new Date().toISOString()) {
  verifyHistoricalPlan(plan);
  const content={
    schemaVersion:1, source:'Bitget SPOT public v3 history-candles',
    safety:'UNAUTHENTICATED_GET_ONLY_NO_TRADES',
    planSha256:plan.planSha256,
    symbol:window.symbol, window, fetchedAt,
    audit:result.audit, rows:result.rows, rowsSha256:hash(result.rows),
    availability:'OBSERVED_PAGE_ONLY;MISSING_CANDLES_NOT_INTERPOLATED'
  };
  return {...content,checksumSha256:hash(content)};
}
export function verifyHistoryRecord(record,plan,window) {
  verifyHistoricalPlan(plan);
  if (!record || record.schemaVersion!==1 ||
      record.planSha256!==plan.planSha256 ||
      record.symbol!==window.symbol ||
      JSON.stringify(record.window)!==JSON.stringify(window) ||
      !Array.isArray(record.rows) ||
      record.rowsSha256!==hash(record.rows)) throw new Error('HISTORY_PAGE_INVALID');
  const {checksumSha256,...body}=record;
  if (!/^[a-f0-9]{64}$/.test(checksumSha256 ?? '') || checksumSha256!==hash(body))
    throw new Error('HISTORY_PAGE_CHECKSUM_MISMATCH');
  const normalized=normalizeHistoryResponse(record.rows,window);
  if (JSON.stringify(normalized.rows)!==JSON.stringify(record.rows) ||
      normalized.audit.unique!==record.audit?.unique ||
      normalized.audit.missing!==record.audit?.missing ||
      normalized.audit.expected!==record.audit?.expected) throw new Error('HISTORY_PAGE_COVERAGE_INVALID');
  return record;
}
export function loadHistoryRecord(path,plan,window) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('HISTORY_PAGE_SYMLINK_REFUSED');
  const size=statSync(path).size;
  if (size>MAX_PAGE_BYTES) throw new Error('HISTORY_PAGE_TOO_LARGE');
  let parsed;
  try {parsed=JSON.parse(readFileSync(path,'utf8'));}
  catch {throw new Error('HISTORY_PAGE_CORRUPT');}
  return verifyHistoryRecord(parsed,plan,window);
}

function immutableWrite(path,body) {
  mkdirSync(dirname(path),{recursive:true});
  const text=JSON.stringify(body)+'\n';
  const bytes=Buffer.byteLength(text);
  if (bytes>MAX_PAGE_BYTES) throw new Error('HISTORY_PAGE_TOO_LARGE');
  const fd=openSync(path,'wx',0o600);
  try {writeFileSync(fd,text,'utf8');fsyncSync(fd);}
  catch(err) {try {unlinkSync(path);} catch {} throw err;}
  finally {closeSync(fd);}
  return bytes;
}

/** Each resume reuses the SAME frozen plan and independently verifies every
 * saved page before skipping it; no overwrite, no silent state reset.
 */
export async function backfillHistoricalPages({
  plan,outputDir,maxNewPages=2,maxNewPagesPerMarket=null,
  maxStorageBytes=5_000_000,
  maxRuntimeMs=120_000,minDelayMs=300,fetchFn=globalThis.fetch,
  sleepFn=sleep,nowFn=Date.now
}={}) {
  verifyHistoricalPlan(plan);
  if (typeof outputDir!=='string' || !outputDir.trim() ||
      !integer(maxNewPages) || maxNewPages<1 || maxNewPages>100 ||
      maxNewPagesPerMarket!==null && (!integer(maxNewPagesPerMarket) ||
        maxNewPagesPerMarket<1 || maxNewPagesPerMarket>100) ||
      !integer(maxStorageBytes) || maxStorageBytes<50_000 || maxStorageBytes>500_000_000 ||
      !integer(maxRuntimeMs) || maxRuntimeMs<1_000 || maxRuntimeMs>3_600_000 ||
      !integer(minDelayMs) || minDelayMs<0 || minDelayMs>60_000)
    throw new Error('INVALID_BACKFILL_BUDGET');
  const root=resolve(outputDir);
  mkdirSync(root,{recursive:true});
  const totalBytes = dir => {
    let sum=0;
    for (const item of readdirSync(dir,{withFileTypes:true})) {
      const p=join(dir,item.name);
      if (item.isSymbolicLink()) throw new Error('BACKFILL_SYMLINK_REFUSED');
      if (item.isDirectory()) sum+=totalBytes(p);
      else if (item.isFile()) sum+=statSync(p).size;
      else throw new Error('BACKFILL_UNSUPPORTED_FILE');
    }
    return sum;
  };
  let storedBytes=totalBytes(root);
  if (storedBytes > maxStorageBytes) throw new Error('BACKFILL_EXISTING_STORAGE_EXCEEDS_BUDGET');
  const started=nowFn();
  const result={event:'HISTORY_BACKFILL_PILOT',planSha256:plan.planSha256,
    marketCount:plan.markets.length,downloadedPages:0,resumedPages:0,
    downloadedMarkets:0,perMarketCapReached:0,
    maxNewPagesPerMarket,
    storedCandleRows:0,missingCandleSlots:0,emptyPages:0,
    bytesWritten:0,storedBytes,safety:'GET_ONLY_PAPER_RESEARCH',complete:false,
    stoppedBecause:null};
  outer:for (const market of plan.markets) {
    let downloadedThisMarket=0;
    const windows=planHistoryWindows({symbol:market.symbol,
      firstAvailableMs:market.firstAvailableMs,nowMs:plan.anchorNowMs,
      maxCandlesPerRequest:plan.candlesPerPage,yearsDays:plan.lookbackDays});
    for(const window of windows) {
      if(nowFn()-started >= maxRuntimeMs) {result.stoppedBecause='RUNTIME_BUDGET';break outer;}
      const path=historyPagePath(root,window);
      // Resume MUST validate previously stored pages before enforcing the
      // per-run NEW-page cap. Otherwise a cap of one skips validation of
      // cached pages after the first new page and hides later corruption.
      if(existsSync(path)) {
        const record=loadHistoryRecord(path,plan,window);
        result.resumedPages++;
        result.storedCandleRows+=record.rows.length;
        result.missingCandleSlots+=record.audit.missing;
        if(record.rows.length===0)result.emptyPages++;
        continue;
      }
      if(maxNewPagesPerMarket!==null && downloadedThisMarket>=maxNewPagesPerMarket) {
        result.perMarketCapReached++;
        break;
      }
      if(result.downloadedPages>=maxNewPages){result.stoppedBecause='PAGE_BUDGET';break outer;}
      const response=await fetchHistoricalPage(window,{fetchFn,sleepFn,
        beforeAttempt:async()=>{await sleepFn(minDelayMs);}});
      const record=makeHistoryRecord(plan,window,response);
      const textBytes=Buffer.byteLength(JSON.stringify(record)+'\n');
      if (storedBytes+textBytes > maxStorageBytes) throw new Error('BACKFILL_STORAGE_BUDGET_REACHED');
      immutableWrite(path,record);
      storedBytes+=textBytes;result.bytesWritten+=textBytes;result.downloadedPages++;
      if(downloadedThisMarket===0)result.downloadedMarkets++;
      downloadedThisMarket++;
      result.storedCandleRows+=record.rows.length;
      result.missingCandleSlots+=record.audit.missing;
      if(record.rows.length===0)result.emptyPages++;
    }
  }
  if(result.stoppedBecause===null && result.perMarketCapReached>0)
    result.stoppedBecause='PER_MARKET_PAGE_BUDGET';
  result.complete=result.stoppedBecause===null;
  result.storedBytes=storedBytes;
  return result;
}

/** Frozen immutable plan saved once; its checksum binds every page on resume. */
export function saveHistoricalPlan(path,plan) {
  verifyHistoricalPlan(plan);
  if(existsSync(path))throw new Error('HISTORY_PLAN_ALREADY_EXISTS');
  return immutableWrite(path,plan);
}
export function loadHistoricalPlan(path) {
  if(lstatSync(path).isSymbolicLink())throw new Error('HISTORY_PLAN_SYMLINK_REFUSED');
  if(statSync(path).size>MAX_PAGE_BYTES)throw new Error('HISTORY_PLAN_TOO_LARGE');
  try {return verifyHistoricalPlan(JSON.parse(readFileSync(path,'utf8')));}
  catch(err){throw new Error('HISTORY_PLAN_LOAD_FAILED: '+String(err?.message??err));}
}
