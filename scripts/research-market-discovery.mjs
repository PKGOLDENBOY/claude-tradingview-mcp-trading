#!/usr/bin/env node
/** Developer-only inventory pilot. Makes exactly two public GET metadata requests.
 * Does NOT request historical candles, train strategies, touch Railway, or trade. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverBitgetSpotUniverse } from '../research/market-discovery.js';
import { planHistoryWindows } from '../research/market-universe-history.js';

export function parseDiscoveryArgs(argv) {
  const params={maxPlanMarkets:100,minTurnover24h:250000,maxSpreadBps:40,minListingAgeDays:30,output:null};
  const allowed={'max-plan-markets':'maxPlanMarkets','min-turnover-24h':'minTurnover24h',
    'max-spread-bps':'maxSpreadBps','min-listing-age-days':'minListingAgeDays','output':'output'};
  for (const a of argv) {
    const match=/^--([a-z0-9-]+)=(.+)$/.exec(a);
    if (!match || !Object.hasOwn(allowed,match[1])) throw new Error('UNKNOWN_DISCOVERY_ARGUMENT');
    const [ ,name,val ]=match;
    params[allowed[name]]=name==='output'?val:Number(val);
  }
  if (!Number.isInteger(params.maxPlanMarkets) || params.maxPlanMarkets<1 || params.maxPlanMarkets>10000 ||
      !Number.isFinite(params.minTurnover24h) || params.minTurnover24h<0 ||
      !Number.isFinite(params.maxSpreadBps) || params.maxSpreadBps<=0 ||
      !Number.isInteger(params.minListingAgeDays) || params.minListingAgeDays<0 ||
      params.output!==null && (!params.output.endsWith('.json') || params.output.length>512))
    throw new Error('INVALID_DISCOVERY_ARGUMENT');
  return params;
}

export async function discoveryMain(argv=process.argv.slice(2),{fetchFn=globalThis.fetch,nowMs=Date.now()}={}) {
  const p=parseDiscoveryArgs(argv);
  const universe=await discoverBitgetSpotUniverse({...p,fetchFn,nowMs});
  const selected=universe.markets.filter(x=>x.researchEligible).slice(0,p.maxPlanMarkets);
  const estimates=selected.map(m=>{
    const windows=planHistoryWindows({symbol:m.symbol,firstAvailableMs:m.firstListedMs,nowMs});
    return {symbol:m.symbol,firstListedMs:m.firstListedMs,
      plannedRequestCount:windows.length,plannedCandleSlots:windows.reduce((sum,w)=>sum+w.expectedHours,0),
      note:'ESTIMATE_ONLY_NOT_FETCHED'};
  });
  const report={
    event:'RESEARCH_UNIVERSE_DISCOVERY_PILOT',
    safety:{publicGetOnly:true,authenticatedRequests:false,orders:false,historicalCandlesDownloaded:0},
    limitation:'Current Bitget spot universe, not point-in-time/delisted coins or all exchanges.',
    universe,
    historyPlanning:{requestedLookbackDays:3653,marketsEstimated:estimates.length,
      estimatedHistoryGetRequests:estimates.reduce((sum,m)=>sum+m.plannedRequestCount,0),
      marketEstimates:estimates,note:'HTTP requests are estimates, not downloaded candle data or proof of availability.'},
  };
  const filename=p.output??('research-data/market-universe/snapshot-'+new Date(nowMs).toISOString().replace(/[:.]/g,'-')+'.json');
  mkdirSync(dirname(resolve(filename)),{recursive:true});
  writeFileSync(filename,JSON.stringify(report,null,2)+'\n',{flag:'wx',encoding:'utf8',mode:0o600});
  console.log(JSON.stringify({event:report.event,asof:universe.asof,
    marketCount:universe.marketCount,researchEligible:universe.researchEligibleCount,
    historyRequestsEstimated:report.historyPlanning.estimatedHistoryGetRequests,output:filename,
    safety:'NO_ORDER_ENDPOINTS;NO_HISTORY_DOWNLOADED;NO_RAILWAY_CHANGES'}));
  return report;
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {await discoveryMain();}
  catch(err) {console.error(JSON.stringify({event:'RESEARCH_UNIVERSE_DISCOVERY_FAILED',
    reason:String(err?.message??err).slice(0,300),safety:'NO_ORDERS'}));process.exitCode=1;}
}
