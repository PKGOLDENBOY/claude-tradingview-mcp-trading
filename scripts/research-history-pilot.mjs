#!/usr/bin/env node
/**
 * AlphaBot bounded history pilot. PUBLIC GET ONLY; no exchange credentials,
 * orders, train/validation leakage, Railway changes or live trading.
 *
 * First run freezes a market inventory and a checksummed plan. Repeated runs
 * resume immutable, checksummed pages; changing the market count or lookback
 * requires a fresh output directory and a NEW independent evaluation plan.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverBitgetSpotUniverse } from '../research/market-discovery.js';
import {
  createHistoricalPlan,loadHistoricalPlan,saveHistoricalPlan,
  backfillHistoricalPages
} from '../research/historical-backfill.js';

const pause=ms=>new Promise(done=>setTimeout(done,ms));

export function parsePilotArgs(argv) {
  const params={
    maxMarkets:2,maxNewPages:2,maxStorageBytes:5_000_000,
    maxRuntimeSeconds:120,lookbackDays:3653,
    minDelayMs:300,outputDir:'research-data/history-pilot'
  };
  const mapping={
    'max-markets':'maxMarkets','max-new-pages':'maxNewPages',
    'max-storage-bytes':'maxStorageBytes',
    'max-runtime-seconds':'maxRuntimeSeconds',
    'lookback-days':'lookbackDays','min-delay-ms':'minDelayMs',
    'output-dir':'outputDir'
  };
  for(const arg of argv) {
    const m=/^--([a-z0-9-]+)=(.+)$/.exec(arg);
    if (!m || !Object.hasOwn(mapping,m[1])) throw new Error('UNKNOWN_HISTORY_PILOT_OPTION');
    const key=mapping[m[1]];
    params[key]=key==='outputDir'?m[2]:Number(m[2]);
  }
  if(!Number.isInteger(params.maxMarkets) || params.maxMarkets<1 || params.maxMarkets>100 ||
     !Number.isInteger(params.maxNewPages) || params.maxNewPages<1 || params.maxNewPages>100 ||
     !Number.isInteger(params.maxStorageBytes) || params.maxStorageBytes<50_000 || params.maxStorageBytes>500_000_000 ||
     !Number.isInteger(params.maxRuntimeSeconds) || params.maxRuntimeSeconds<1 || params.maxRuntimeSeconds>3600 ||
     !Number.isInteger(params.lookbackDays) || params.lookbackDays<1 || params.lookbackDays>3653 ||
     !Number.isInteger(params.minDelayMs) || params.minDelayMs<250 || params.minDelayMs>60_000 ||
     !params.outputDir || params.outputDir.length>512 || params.outputDir.includes('\0'))
    throw new Error('INVALID_HISTORY_PILOT_OPTION');
  return params;
}

export async function historyPilotMain(
  argv=process.argv.slice(2),
  {fetchFn=globalThis.fetch,nowMs=Date.now(),sleepFn=pause,log=console.log}={}
) {
  const p=parsePilotArgs(argv);
  const dir=resolve(p.outputDir);
  mkdirSync(dir,{recursive:true});
  const planFile=join(dir,'frozen-plan.json');
  let plan,discovered=false;
  if(existsSync(planFile)) {
    plan=loadHistoricalPlan(planFile);
    if(plan.requestedMaxMarkets!==p.maxMarkets || plan.lookbackDays!==p.lookbackDays ||
       plan.candlesPerPage!==90) throw new Error('FROZEN_PLAN_OPTIONS_CHANGED_USE_NEW_DIRECTORY');
  } else {
    const universe=await discoverBitgetSpotUniverse({fetchFn,nowMs});
    plan=createHistoricalPlan(universe,{nowMs,lookbackDays:p.lookbackDays,
      maxMarkets:p.maxMarkets});
    // Keep an immutable full inventory for transparency; this is NOT point-in-time
    // history of delistings. Do not truncate illiquid/new symbols in the snapshot.
    const full=JSON.stringify({event:'CURRENT_MARKET_UNIVERSE_SNAPSHOT',
      safety:'UNAUTHENTICATED_GET_ONLY',universe},null,2)+'\n';
    if(Buffer.byteLength(full)>5_000_000) throw new Error('INVENTORY_SNAPSHOT_TOO_LARGE');
    writeFileSync(join(dir,'market-inventory.json'),full,{flag:'wx',mode:0o600});
    saveHistoricalPlan(planFile,plan);
    discovered=true;
  }
  const result=await backfillHistoricalPages({
    plan,outputDir:dir,maxNewPages:p.maxNewPages,
    maxStorageBytes:p.maxStorageBytes,maxRuntimeMs:p.maxRuntimeSeconds*1000,
    minDelayMs:p.minDelayMs,fetchFn,sleepFn
  });
  const report={...result,discoveredNewInventory:discovered,
    inventoryMarketCount:plan.inventoryMarketCount,
    chosenMarketCount:plan.selectedMarketCount,
    freezeAsOf:plan.asof,
    caveat:'NO_WIDE_MARKET_BACKTEST_YET;NO_HISTORIC_DELISTED_UNIVERSE;NO_LIVE_TRADES'};
  log(JSON.stringify(report));
  return report;
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try{await historyPilotMain();}
  catch(err) {
    console.error(JSON.stringify({event:'HISTORY_PILOT_FAILED',
      error:String(err?.message??err).slice(0,220),
      safety:'PUBLIC_GET_ONLY_NO_ORDERS'}));
    process.exitCode=1;
  }
}
