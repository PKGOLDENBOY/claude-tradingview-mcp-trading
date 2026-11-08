#!/usr/bin/env node
/**
 * Independent no-order prospective paper recorder for pre-frozen ML-068.
 * Never imports bot.js, reads credentials, or submits exchange orders.
 * Cron runs once: reads only public Bitget 1H candles and SPOT tickers,
 * evaluates the PREVIOUSLY CLOSED hour, and models virtual entries/exits.
 * Paper decisions are NOT exchange-verified/account-reconciled.
 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadHistoryForSymbols,CORE_SYMBOLS} from '../lib/accelerator-data.mjs';
import {INTERVAL_MS} from '../lib/accelerator-core.mjs';
import {NO_ORDER_MODE,PAPER_LIMITS,verifyFrozenArtifact,scoreFrozenML,sizeFrozenPaper} from '../lib/frozen-ml-forward-strategy.mjs';
import {FORWARD_MODE,inspectForwardLedger,appendForwardRecord,
  replayPaperEvidence,withExclusiveForwardLock} from '../lib/frozen-ml-forward-ledger.mjs';

const MODEL_URL=new URL('../models/frozen-ml068-20261108.json',import.meta.url);
const STORE='/forward-data/ml068-prospective.ndjson';
const LOCK='/forward-data/ml068-prospective.lock';
const CACHE='/forward-data/closed-1h-candle-cache';
const sha=v=>createHash('sha256').update(v).digest('hex');
const round=n=>Math.round(n*1e6)/1e6;
const stamp=now=>new Date(now).toISOString();
const log=(event,fields={})=>console.log(JSON.stringify({event,at:new Date().toISOString(),mode:NO_ORDER_MODE,...fields}));
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
export function loadFrozenModel(){
  const artifact=verifyFrozenArtifact(JSON.parse(readFileSync(MODEL_URL,'utf8')));
  const hashes={ml:sha(readFileSync(new URL('../lib/accelerator-ml.mjs',import.meta.url))),
    core:sha(readFileSync(new URL('../lib/accelerator-core.mjs',import.meta.url)))};
  if(hashes.ml!==artifact.codeHashes.ml || hashes.core!==artifact.codeHashes.core)
    throw new Error('FORWARD_MODEL_SOURCE_CHANGED_SINCE_FREEZE');
  return artifact;
}

/** Quote must contain genuine bid/ask prices. No fallback to last trade price. */
export function parseQuotes(rows,observedAt){
  if(!Array.isArray(rows)||!Number.isFinite(Date.parse(observedAt)))
    throw new Error('FORWARD_QUOTES_INVALID');
  const map=new Map();
  for(const q of rows){
    if(!CORE_SYMBOLS.includes(q.symbol))continue;
    const ask=Number(q.askPr),bid=Number(q.bidPr),last=Number(q.lastPr);
    if(!positive(ask)||!positive(bid)||!positive(last)||ask<bid)
      throw new Error('FORWARD_ORDERBOOK_QUOTE_INVALID_'+q.symbol);
    if(map.has(q.symbol))throw new Error('FORWARD_DUPLICATE_TICKER_'+q.symbol);
    map.set(q.symbol,{askUSD:ask,bidUSD:bid,lastUSD:last,observedAt});
  }
  if(map.size!==CORE_SYMBOLS.length)throw new Error('FORWARD_MISSING_CORE_TICKER');
  return map;
}
async function publicSpotTickers(){
  const url='https://api.bitget.com/api/v2/spot/market/tickers';
  const response=await fetch(url,{method:'GET',redirect:'error',
    signal:AbortSignal.timeout(9000),
    headers:{Accept:'application/json','User-Agent':'AlphaBot-frozen-no-order-paper/1.0'}});
  if(!response.ok)throw new Error('FORWARD_PUBLIC_GET_HTTP_'+response.status);
  const json=await response.json();
  if(json?.code!=='00000'||!Array.isArray(json.data))
    throw new Error('FORWARD_PUBLIC_GET_DATA_INVALID');
  return {quotes:parseQuotes(json.data,new Date().toISOString()),at:Date.now()};
}
export function makeEventId(type,fields){
  return 'f_'+sha(type+'|'+JSON.stringify(fields)).slice(0,24);
}
function checkPaperEntryPosition(e){
  if(!positive(e.qty)||!positive(e.entryTotalCostUSD)||!positive(e.entryReferenceUSD)||
    !Number.isFinite(Date.parse(e.at)))throw new Error('PAPER_POSITION_INVALID');
}
function paperPositionMarkedPnl(entry,quote,artifact){
  const a=artifact.assumptions;
  const fill=quote.bidUSD*(1-a.adverseSlippagePerSide-a.assumedHalfSpreadPerSide);
  const gross=entry.qty*fill;
  return round(gross*(1-a.feePerSide)-entry.entryTotalCostUSD);
}
function realizedEquity(state){return PAPER_LIMITS.initialEquityUSD+state.realizedPnlUSD;}
function currentDayStartEquity(records,now){
  const midnight=new Date(now).toISOString().slice(0,10)+'T00:00:00.000Z';
  return PAPER_LIMITS.initialEquityUSD+records.reduce((sum,row)=>
    sum+(row.event.type==='PAPER_EXIT'&&row.event.at<midnight?row.event.pnlUSD:0),0);
}
function peakRealizedEquity(records){
  let equity=PAPER_LIMITS.initialEquityUSD,peak=equity;
  for(const row of records){if(row.event.type==='PAPER_EXIT'){
    equity+=row.event.pnlUSD;peak=Math.max(peak,equity);
  }}
  return peak;
}
/** One chronologically prospective evaluation. Caller owns exclusive file lock. */
export async function runPaperCycle({nowMs=Date.now(),historyLoader=loadHistoryForSymbols,
  tickerLoader=publicSpotTickers,store=STORE,artifact=loadFrozenModel()}={}){
  verifyFrozenArtifact(artifact);
  if(nowMs<Date.parse(artifact.frozenAsOf))throw new Error('FORWARD_CLOCK_BEFORE_TRAINING_CUTOFF');
  let ledger=inspectForwardLedger(store,{manifestSha256:artifact.manifestSha256});
  let state=replayPaperEvidence(ledger.records,{manifestSha256:artifact.manifestSha256});
  let ordinal=0;
  const append=(type,fields)=>{
    const at=stamp(nowMs);
    const e={type,mode:FORWARD_MODE,manifestSha256:artifact.manifestSha256,
      candidateId:artifact.candidateId,at,eventId:makeEventId(type,{run:at,ordinal:ordinal++,...fields}),...fields};
    const tail=appendForwardRecord(store,e,ledger);
    ledger={...ledger,tailHash:tail.tailHash,nextSequence:tail.nextSequence,
      records:[...ledger.records,tail.record]};
    state=replayPaperEvidence(ledger.records,{manifestSha256:artifact.manifestSha256});
    return e;
  };
  if(!ledger.records.length)append('EXPERIMENT_START',{
    modelSha256:artifact.modelSha256,trainingDatasetSha256:artifact.trainingDatasetSha256,
    activationNotBefore:artifact.activationNotBefore,
    statement:'SYNTHETIC_NOT_ACCOUNT_OR_EXCHANGE_VERIFIED'});
  if(nowMs<=Date.parse(artifact.activationNotBefore)){
    append('HEARTBEAT',{status:'FROZEN_NOT_YET_ACTIVE',entries:state.entries,exits:state.exits});
    return {mode:FORWARD_MODE,status:'WAITING_FOR_ACTIVATION',entries:state.entries,exits:state.exits};
  }
  const lastAt=state.lastHeartbeatAt?Date.parse(state.lastHeartbeatAt):null;
  const gap=lastAt!==null && nowMs-lastAt>PAPER_LIMITS.maxObservedGapMinutes*60_000;
  if(gap)append('MARKET_DATA_GAP',{from:state.lastHeartbeatAt,until:stamp(nowMs),
    warning:'Recent quote movement between runs not fully observed; do not count fills as independent evidence.'});
  // Read only CLOSED public 1H history. Strict contiguous public data; no synthetic backfill.
  const asofMs=Math.floor(nowMs/INTERVAL_MS)*INTERVAL_MS;
  let history;
  try{history=await historyLoader({symbols:CORE_SYMBOLS,lookbackDays:60,
    asofMs,cacheDir:CACHE});
    if(history.successfulSymbols!==5 || history.excludedSymbols?.length ||
      CORE_SYMBOLS.some(sym=>!history.data?.[sym]))throw new Error('FORWARD_CANDLE_UNIVERSE_INCOMPLETE');
  }catch(err){
    append('ERROR',{step:'public_closed_candles',message:String(err.message).slice(0,140)});
    throw err;
  }
  let tickers;
  try{tickers=await tickerLoader();}
  catch(err){append('ERROR',{step:'public_spot_quotes',message:String(err.message).slice(0,140)});throw err;}
  if(!Number.isFinite(tickers.at)||tickers.at>nowMs+120_000 ||
     !tickers.quotes || !CORE_SYMBOLS.every(s=>tickers.quotes.has(s)) ){
    append('ERROR',{step:'quotes_stale_or_missing'});
    throw new Error('FORWARD_QUOTE_SNAPSHOT_INVALID');
  }
  const quoteAgeMs=Math.max(0,Date.now()-tickers.at);
  if(quoteAgeMs>PAPER_LIMITS.maxQuoteAgeMs){
    append('ERROR',{step:'quotes_expired',quoteAgeMs});
    throw new Error('FORWARD_QUOTE_SNAPSHOT_EXPIRED');
  }
  // First manage exits (stop-first precedence) at contemporaneous public bid quotes.
  for(const [symbol,entry] of state.positions){
    checkPaperEntryPosition(entry);
    const q=tickers.quotes.get(symbol);
    const hours=(nowMs-Date.parse(entry.at))/INTERVAL_MS;
    const stop=q.bidUSD<=entry.entryReferenceUSD*(1-artifact.candidate.stop);
    const take=q.bidUSD>=entry.entryReferenceUSD*(1+artifact.candidate.take);
    const reason=stop?'STOP':take?'TAKE_PROFIT':hours>=artifact.assumptions.maxHoldBars?'TIME_EXIT':null;
    if(!reason)continue;
    const a=artifact.assumptions;
    const rawBidUSD=q.bidUSD;
    const exitFillUSD=rawBidUSD*(1-a.adverseSlippagePerSide-a.assumedHalfSpreadPerSide);
    const gross=entry.qty*exitFillUSD,fee=gross*a.feePerSide;
    const exitNetProceedsUSD=round(gross-fee);
    const pnlUSD=round(exitNetProceedsUSD-entry.entryTotalCostUSD);
    append('PAPER_EXIT',{symbol,positionId:entry.positionId,reason,
      rawBidUSD,exitFillUSD,qty:entry.qty,
      exitFeeUSD:round(fee),exitNetProceedsUSD,pnlUSD,
      synthetic:true,exchangeVerified:false,quoteObservedAt:q.observedAt,
      evidenceDegraded:gap||state.gaps>0});
  }
  let processed=0,signals=0,newEntries=0;
  const recordMissingHistory=CORE_SYMBOLS.some(sym=>!history.data?.[sym]);
  if(!recordMissingHistory){
    for(const symbol of CORE_SYMBOLS){
      let signal;
      try{signal=scoreFrozenML(artifact,history.data[symbol],{symbol,observedAt:stamp(nowMs)});}
      catch(err){append('ERROR',{symbol,step:'frozen_model_signal',message:String(err.message).slice(0,140)});continue;}
      const barTime=Date.parse(signal.barCloseAt),lastBar=state.lastEvaluatedCandleBySymbol.get(symbol)||0;
      if(barTime<=lastBar||barTime<=Date.parse(artifact.activationNotBefore))continue;
      // Live observation of the latest closed candle, never retroactive trading.
      append('CANDLE_EVALUATED',{symbol,barCloseAt:signal.barCloseAt,
        probability:signal.probability,threshold:signal.threshold,signal:signal.signal,
        priceSource:'BITGET_PUBLIC_CLOSED_1H',datasetSha256:history.datasetSha256});
      processed++;
      if(!signal.signal)continue;
      signals++;
      const currentEquity=realizedEquity(state)+[...state.positions].reduce((sum,[s,p])=>
        sum+paperPositionMarkedPnl(p,tickers.quotes.get(s),artifact),0);
      const allowed=sizeFrozenPaper({equityUSD:currentEquity,
        dayStartEquityUSD:currentDayStartEquity(ledger.records,nowMs),
        peakEquityUSD:Math.max(currentEquity,peakRealizedEquity(ledger.records)),
        openNotionalUSD:[...state.positions.values()].reduce((sum,p)=>sum+p.notionalUSD,0),
        openPositions:state.positions.size,hasSymbolPosition:state.positions.has(symbol),
        askUSD:tickers.quotes.get(symbol).askUSD,
        bidUSD:tickers.quotes.get(symbol).bidUSD,quoteAgeMs},artifact);
      if(!allowed.allowed||gap||state.gaps>0||state.errors>0)continue;
      const q=tickers.quotes.get(symbol),a=artifact.assumptions;
      const fill=q.askUSD*(1+a.adverseSlippagePerSide+a.assumedHalfSpreadPerSide);
      const qty=allowed.notionalUSD/fill;
      const entryFee=allowed.notionalUSD*a.feePerSide;
      const posId='pos_'+sha(symbol+'|'+signal.barCloseAt+'|'+artifact.manifestSha256).slice(0,24);
      append('PAPER_ENTRY',{symbol,positionId:posId,signalBarCloseAt:signal.barCloseAt,
        probability:signal.probability,rawAskUSD:q.askUSD,fillPriceUSD:fill,
        entryReferenceUSD:q.askUSD,qty,notionalUSD:allowed.notionalUSD,
        entryFeeUSD:round(entryFee),entryTotalCostUSD:round(allowed.notionalUSD+entryFee),
        quoteObservedAt:q.observedAt,synthetic:true,exchangeVerified:false});
      newEntries++;
    }
  }
  append('HEARTBEAT',{status:'PROSPECTIVE_SYNTHETIC_ONLY',processed,signals,newEntries,
    entries:state.entries,exits:state.exits,realizedPaperUSD:round(state.realizedPnlUSD),
    observedGaps:state.gaps,errors:state.errors,
    independentlyReconciledRoundTrips:null,liveMoneyReady:false});
  return {mode:NO_ORDER_MODE,status:'PROSPECTIVE_SYNTHETIC_ONLY',processed,signals,newEntries,
    cumulativeEntries:state.entries,cumulativeSyntheticExits:state.exits,
    simulatedRealizedUSD:round(state.realizedPnlUSD),gaps:state.gaps,errors:state.errors,
    independentlyReconciledRoundTrips:null,realOrders:false};
}
async function main(){
  const result=await withExclusiveForwardLock(LOCK,()=>runPaperCycle());
  log('FROZEN_ML068_PAPER_CYCLE',result);
}
if(process.argv[1] && fileURLToPath(import.meta.url)===fileURLToPath(new URL('file://'+process.argv[1]))){
  try{await main();}catch(err){console.error(JSON.stringify({event:'FROZEN_ML068_PAPER_HALTED',
    error:String(err?.message||err).slice(0,250),safety:'NO_ORDERS'}));process.exitCode=1;}
}
