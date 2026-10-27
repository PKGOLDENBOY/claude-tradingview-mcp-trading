/**
 * Bitget SPOT universe discovery. RESEARCH ONLY.
 * Two public unauthenticated GET requests; no trading/order endpoints.
 * The inventory is comprehensive for currently ONLINE Bitget SPOT USDT/USDC
 * markets, not historical delisted markets or coins on other exchanges.
 */
import { createHash } from 'node:crypto';
import { normalizeSpotSymbols } from './market-universe-history.js';

const ORIGIN = 'https://api.bitget.com';
const ENDPOINTS = new Set(['/api/v3/market/instruments','/api/v3/market/tickers']);
const DAY_MS = 86400000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finitePositive = input => {
  const n = Number(input);
  return input === undefined || input === null || input === '' || !Number.isFinite(n) || n <= 0 ? null : n;
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function publicSpotMetadata(endpoint, {fetchFn=globalThis.fetch,retries=3}={}) {
  if (!ENDPOINTS.has(endpoint)) throw new Error('PUBLIC_METADATA_GET_ALLOWLIST_VIOLATION');
  if (!Number.isInteger(retries) || retries < 1 || retries > 5) throw new RangeError('RETRIES_INVALID');
  const url = new URL(ORIGIN + endpoint);
  url.searchParams.set('category','SPOT');
  let lastError;
  for (let attempt=0;attempt<retries;attempt++) {
    try {
      const response = await fetchFn(url.toString(), {
        method:'GET',redirect:'error',credentials:'omit',
        signal:AbortSignal.timeout(12000),
        headers:{Accept:'application/json','User-Agent':'AlphaBot-PAPER-research-market-discovery/1.0'}
      });
      if (!response?.ok) throw new Error('METADATA_HTTP_' + response?.status);
      const body = await response.json();
      if (body?.code !== '00000' || !Array.isArray(body?.data))
        throw new Error('INVALID_PUBLIC_METADATA_RESPONSE');
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt+1 < retries) await sleep(300*2**attempt);
    }
  }
  throw new Error('PUBLIC_METADATA_FETCH_FAILED: ' + String(lastError?.message ?? lastError).slice(0,160));
}

/**
 * Preserve every eligible *inventory* symbol, even when research filters fail.
 * "researchEligible" is a quality screen, never an order permission.
 */
export function classifySpotUniverse(instruments,tickers,{
  nowMs=Date.now(),minTurnover24h=250000,maxSpreadBps=40,
  minListingAgeDays=30
}={}) {
  if (!Array.isArray(instruments) || !Array.isArray(tickers) ||
      !Number.isFinite(nowMs) || !Number.isFinite(minTurnover24h) || minTurnover24h < 0 ||
      !Number.isFinite(maxSpreadBps) || maxSpreadBps <= 0 ||
      !Number.isInteger(minListingAgeDays) || minListingAgeDays < 0)
    throw new TypeError('INVALID_UNIVERSE_INPUT');
  const crypto = instruments.filter(r => r?.category === 'SPOT' &&
    (r.symbolType == null || String(r.symbolType).toLowerCase() === 'crypto') &&
    String(r.isReality ?? 'no').toLowerCase() !== 'yes');
  const symbols = normalizeSpotSymbols(crypto);
  const quotes = new Map(tickers.filter(t=>t && typeof t.symbol === 'string')
    .map(t=>[String(t.symbol).toUpperCase(),t]));
  const launch = new Map(crypto.map(x=>[String(x.symbol).toUpperCase(),x.launchTime]));
  const markets = symbols.map(s=>{
    const ticker=quotes.get(s.symbol);
    const turnover24h=finitePositive(ticker?.turnover24h);
    const bid=finitePositive(ticker?.bid1Price);
    const ask=finitePositive(ticker?.ask1Price);
    const spreadBps=bid && ask && ask>=bid ? (ask-bid)/((ask+bid)/2)*10000 : null;
    const firstListedMs=finitePositive(launch.get(s.symbol));
    const ageDays=firstListedMs && firstListedMs <= nowMs ?
      (nowMs-firstListedMs)/DAY_MS : null;
    const reasons=[];
    if (!ticker) reasons.push('TICKER_UNAVAILABLE');
    if (turnover24h === null || turnover24h < minTurnover24h) reasons.push('LOW_OR_UNKNOWN_TURNOVER');
    if (spreadBps === null || spreadBps > maxSpreadBps) reasons.push('WIDE_OR_UNKNOWN_SPREAD');
    if (ageDays === null) reasons.push('UNKNOWN_LISTING_AGE');
    else if (ageDays < minListingAgeDays) reasons.push('NEW_LISTING');
    return {
      ...s,firstListedMs,ageDays,turnover24h,spreadBps,
      researchEligible:reasons.length===0,
      researchExclusionReasons:reasons,
      researchCohort:ageDays===null?'UNKNOWN_AGE':ageDays<minListingAgeDays?'NEW_LISTING':
        turnover24h!==null && turnover24h>=10000000?'MAJOR_LIQUID':'ALTCOIN'
    };
  }).sort((a,b)=>(b.turnover24h??-1)-(a.turnover24h??-1)||a.symbol.localeCompare(b.symbol));
  return {
    asof:new Date(nowMs).toISOString(),exchange:'Bitget',market:'SPOT',
    selectionAssumptions:{minTurnover24h,maxSpreadBps,minListingAgeDays,
      note:'Current 24h quote turnover and top-of-book spread are NOT historical liquidity evidence.'},
    marketCount:markets.length,researchEligibleCount:markets.filter(m=>m.researchEligible).length,
    newlyListedCount:markets.filter(m=>m.researchCohort==='NEW_LISTING').length,
    markets,inventorySha256:hash(markets)
  };
}

export async function discoverBitgetSpotUniverse(options={}) {
  const instruments=await publicSpotMetadata('/api/v3/market/instruments',options);
  const tickers=await publicSpotMetadata('/api/v3/market/tickers',options);
  return classifySpotUniverse(instruments,tickers,options);
}
