/**
 * Bitget v3 public SPOT candle ingestion ONLY: authenticated endpoints are absent.
 * Durable checksum-verified offline cache drastically reduces repeated API calls.
 * No fallbacks to fake/forward-filled prices; gaps fail the affected symbol.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { INTERVAL_MS, parseAndValidateBars } from './accelerator-core.mjs';

export const CORE_SYMBOLS = Object.freeze(['BTCUSDT','ETHUSDT','SOLUSDT','LINKUSDT','ADAUSDT']);
const ORIGIN = 'https://api.bitget.com';
const SPOT_CANDLES = '/api/v3/market/candles';
const SPOT_HISTORY = '/api/v3/market/history-candles';
const DAY = 24*INTERVAL_MS;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const checksum = object=>createHash('sha256').update(JSON.stringify(object)).digest('hex');

export function makeRateLimiter({minimumIntervalMs=150}={}) {
  let next=0;
  return async function reserve() {
    const now=Date.now(),at=Math.max(now,next);
    next=at+minimumIntervalMs;
    if(at>now)await sleep(at-now);
  };
}

export async function publicBitgetCandles(path,params,{fetchFn=globalThis.fetch,rateLimit=makeRateLimiter(),retries=3}={}) {
  if(path!==SPOT_CANDLES && path!==SPOT_HISTORY)throw new Error('PUBLIC_GET_ALLOWLIST_VIOLATION');
  const allowed=['category','symbol','interval','startTime','endTime','limit'];
  if(Object.keys(params).some(k=>!allowed.includes(k))||params.category!=='SPOT'||params.interval!=='1H'||
    !CORE_SYMBOLS.includes(params.symbol) ||
    !Number.isSafeInteger(Number(params.startTime)) || !Number.isSafeInteger(Number(params.endTime)))
    throw new Error('UNSAFE_PUBLIC_CANDLE_PARAMETERS');
  if(path===SPOT_HISTORY && Number(params.limit)>100 ||
     path===SPOT_CANDLES && Number(params.limit)>1000) throw new Error('CANDLE_PAGE_TOO_LARGE');
  const url=new URL(ORIGIN+path);
  for(const key of allowed)if(params[key]!==undefined)url.searchParams.set(key,String(params[key]));
  let lastError;
  for(let attempt=0;attempt<retries;attempt++){
    await rateLimit();
    try{
      const response=await fetchFn(url.toString(),{
        method:'GET',redirect:'error',signal:AbortSignal.timeout(12000),
        headers:{Accept:'application/json','User-Agent':'AlphaBot-public-only-research/1.0'},
      });
      if(!response.ok)throw new Error('PUBLIC_CANDLE_HTTP_'+response.status);
      const body=await response.json();
      if(body?.code!=='00000'||!Array.isArray(body?.data))throw new Error('PUBLIC_CANDLE_RESPONSE_INVALID');
      return body.data;
    } catch(err){
      lastError=err;
      if(attempt+1<retries)await sleep(350*Math.pow(2,attempt));
    }
  }
  throw new Error('PUBLIC_CANDLE_FETCH_FAILED: '+String(lastError?.message||lastError).slice(0,140));
}

function readCache(cacheFile,symbol,nowMs) {
  if(!existsSync(cacheFile))return [];
  let record;
  try{record=JSON.parse(readFileSync(cacheFile,'utf8'));}
  catch(err){throw new Error('RESEARCH_CACHE_CORRUPT: '+err.message);}
  if(record?.schemaVersion!==1 || record.symbol!==symbol || record.interval!=='1H' ||
    !Array.isArray(record.bars) || record.checksum!==checksum(record.bars))
    throw new Error('RESEARCH_CACHE_INTEGRITY_FAILED: '+symbol);
  return parseAndValidateBars(record.bars,{nowMs});
}
function saveCache(cacheFile,symbol,bars){
  const record={schemaVersion:1,symbol,interval:'1H',savedAt:new Date().toISOString(),bars,
    checksum:checksum(bars)};
  const temporary=cacheFile+'.tmp';
  writeFileSync(temporary,JSON.stringify(record)+'\n',{encoding:'utf8',mode:0o600});
  renameSync(temporary,cacheFile);
}

function missingChunks(missing,asofMs,{maxPerHistory=90,maxPerRecent=900}={}){
  const tasks=[];
  const recentBoundary=asofMs-89*DAY;
  for(let i=0;i<missing.length;){
    const first=missing[i],recent=first>=recentBoundary;
    const capacity=recent?maxPerRecent:maxPerHistory;
    let j=i+1;
    while(j<missing.length && j-i<capacity && missing[j]===missing[j-1]+INTERVAL_MS &&
      (missing[j]>=recentBoundary)===recent) j++;
    const last=missing[j-1];
    tasks.push({first,last,path:recent?SPOT_CANDLES:SPOT_HISTORY,
      limit:recent?Math.min(1000,j-i+3):Math.min(100,j-i+3)});
    i=j;
  }
  return tasks;
}

/** Retain every used bar, reject revisions and ensure the entire requested window is contiguous. */
export async function fetchSymbolHistory(symbol,{
  cacheDir='research-data/cache',lookbackDays=180,asofMs=Math.floor(Date.now()/INTERVAL_MS)*INTERVAL_MS,
  fetchFn=globalThis.fetch,rateLimit=makeRateLimiter(),log=()=>{},
}={}){
  if(!CORE_SYMBOLS.includes(symbol))throw new Error('SYMBOL_NOT_ON_PUBLIC_RESEARCH_ALLOWLIST');
  if(!Number.isSafeInteger(lookbackDays)||lookbackDays<60||lookbackDays>365)
    throw new Error('RESEARCH_LOOKBACK_OUT_OF_RANGE');
  if(!Number.isSafeInteger(asofMs)||asofMs%INTERVAL_MS!==0||asofMs>Date.now()+INTERVAL_MS)
    throw new Error('RESEARCH_ASOF_INVALID');
  const startMs=asofMs-lookbackDays*DAY;
  mkdirSync(cacheDir,{recursive:true});
  const cacheFile=join(cacheDir,symbol+'-1H.json');
  const cached=readCache(cacheFile,symbol,Math.max(Date.now(),asofMs)+INTERVAL_MS);
  const byTime=new Map(cached.map(bar=>[bar.ts,bar]));
  const expected=[];
  for(let ts=startMs;ts<asofMs;ts+=INTERVAL_MS) expected.push(ts);
  const missing=expected.filter(ts=>!byTime.has(ts));
  const priorCached=expected.length-missing.length;
  let apiRequests=0,newBars=0;
  let tasks=missingChunks(missing,asofMs);
  // Retry missing slots once in shorter pages to recover from endpoint inclusivity rounding.
  for(let pass=0;pass<2 && tasks.length;pass++){
    for(const task of tasks){
      const params={category:'SPOT',symbol,interval:'1H',
        startTime:task.first-INTERVAL_MS,endTime:task.last+INTERVAL_MS-1,
        limit:task.limit};
      const rows=await publicBitgetCandles(task.path,params,{fetchFn,rateLimit});
      apiRequests++;
      for(const row of rows){
        const ts=Number(row?.[0]);
        if(!Number.isSafeInteger(ts)||ts<startMs||ts>=asofMs)continue;
        const [bar]=parseAndValidateBars([row],{nowMs:asofMs});
        const prior=byTime.get(ts);
        if(prior && JSON.stringify(prior)!==JSON.stringify(bar))
          throw new Error('CANDLE_DATA_REVISION_REQUIRES_REVIEW: '+symbol+':'+ts);
        if(!prior){byTime.set(ts,bar);newBars++;}
      }
    }
    const stillMissing=expected.filter(ts=>!byTime.has(ts));
    tasks=pass===0?missingChunks(stillMissing,asofMs,{maxPerHistory:35,maxPerRecent:150}):[];
  }
  const remaining=expected.filter(ts=>!byTime.has(ts));
  if(remaining.length)throw new Error('RESEARCH_INCOMPLETE_HISTORY: '+symbol+':'+remaining.length+
    ' missing, first '+new Date(remaining[0]).toISOString());
  const selected=expected.map(ts=>byTime.get(ts));
  // Cache the latest 365 days, never fabricate missing middle bars.
  const retained=[...byTime.values()].filter(bar=>bar.ts>=asofMs-365*DAY && bar.ts<asofMs)
    .sort((a,b)=>a.ts-b.ts);
  const contiguous=retained.every((bar,i)=>i===0||bar.ts===retained[i-1].ts+INTERVAL_MS);
  if(!contiguous)throw new Error('RESEARCH_CACHE_NONCONTIGUOUS');
  saveCache(cacheFile,symbol,retained);
  const bars=parseAndValidateBars(selected,{nowMs:asofMs});
  log({symbol,apiRequests,cacheHitBars:priorCached,newBars,totalBars:bars.length});
  return {symbol,bars,datasetSha256:checksum(bars),apiRequests,cacheHitBars:priorCached,newBars};
}

export async function loadHistoryForSymbols(options={}){
  const symbols=options.symbols||CORE_SYMBOLS;
  if(!Array.isArray(symbols)||symbols.length<3||new Set(symbols).size!==symbols.length ||
    symbols.some(sym=>!CORE_SYMBOLS.includes(sym)))throw new Error('RESEARCH_SYMBOL_UNIVERSE_INVALID');
  const limiter=makeRateLimiter();
  const results=[];
  const failures=[];
  // Bounded concurrency; shared limiter caps GET requests and never sends auth.
  let next=0;
  await Promise.all(Array.from({length:Math.min(3,symbols.length)},async()=>{
    while(next<symbols.length){
      const sym=symbols[next++];
      try{results.push(await fetchSymbolHistory(sym,{...options,rateLimit:limiter}));}
      catch(err){failures.push({symbol:sym,error:String(err?.message||err).slice(0,250)});}
    }
  }));
  results.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  if(results.length<3 || !results.some(r=>r.symbol==='BTCUSDT'))
    throw new Error('RESEARCH_DATA_COVERAGE_INSUFFICIENT: '+JSON.stringify(failures));
  const firstTs=results[0].bars[0].ts;
  if(results.some(r=>r.bars.length!==results[0].bars.length ||r.bars[0].ts!==firstTs))
    throw new Error('RESEARCH_CROSS_ASSET_TIME_MISMATCH');
  return {data:Object.fromEntries(results.map(r=>[r.symbol,r.bars])),
    datasetSha256:checksum(results.map(r=>[r.symbol,r.datasetSha256])),
    assets:results.map(({bars,...rest})=>rest),excludedSymbols:failures,
    successfulSymbols:results.length};
}
