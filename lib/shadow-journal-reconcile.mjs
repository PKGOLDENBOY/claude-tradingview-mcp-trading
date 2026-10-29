/**
 * Reconcile exported append-only SHADOW_ENTRY/SHADOW_EXIT event logs in memory.
 *
 * READ ONLY, no filesystem, network, credentials, orders, or hidden recovery.
 * This is an audit of a public-market SIGNAL PROXY, NOT 100 real/exchange or
 * production forward-PAPER trades. Repeated or orphaned events fail closed.
 */
import {SHADOW_EVIDENCE_SOURCE} from './shadow-auditable-events.mjs';

const UUID=/^shadow-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SYM=/^[A-Z0-9]{4,24}$/;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const positive=v=>finite(v)&&v>0;
const close=(a,b)=>Math.abs(a-b)<=Math.max(1e-7,Math.max(Math.abs(a),Math.abs(b))*1e-8);
const round=x=>Math.round(x*1e6)/1e6;

export function reconcileShadowEventJournal(events){
  if(!Array.isArray(events)||events.length>500000)
    throw new Error('SHADOW_JOURNAL_NOT_BOUNDED_EVENT_ARRAY');
  const paired=new Map(),seenFills=new Set(),issues=[];
  let legacyEventsExcluded=0;
  const addIssue=(type,positionId)=>{
    if(issues.length<100)issues.push({type,positionId:positionId??null});
  };
  for(const event of events){
    if(!event||typeof event!=='object'||Array.isArray(event)||
      (event.tag!=='SHADOW_ENTRY'&&event.tag!=='SHADOW_EXIT')||
      event.safety!=='PUBLIC_MARKET_READ_ONLY_SHADOW'){
      addIssue('UNSAFE_OR_MALFORMED_EVENT',event?.positionId);
      continue;
    }
    if(event.eventSchemaVersion!==2){
      // Events predating this schema lack original fill identifiers/prices.
      // Count and exclude; do not create synthetic corresponding entries.
      if(event.eventSchemaVersion===undefined||event.eventSchemaVersion===1){
        legacyEventsExcluded++;continue;
      }
      addIssue('UNRECOGNIZED_SCHEMA',event.positionId);continue;
    }
    const id=event.positionId;
    const expectedSide=event.tag==='SHADOW_ENTRY'?'BUY':'SELL';
    const expectedFill=id+ (expectedSide==='BUY'?':buy:1':':sell:1');
    const ms=Date.parse(event.fillTimestamp);
    if(event.auditEligible!==true||event.paperTrading!==true||
      event.spotLongOnly!==true||
      event.evidenceSource!==SHADOW_EVIDENCE_SOURCE||
      !UUID.test(id??'')||!SYM.test(event.symbol??'')||
      typeof event.strategy!=='string'||!event.strategy||
      event.side!==expectedSide||event.fillId!==expectedFill||
      !Number.isFinite(ms)||ms<=0||
      !positive(event.quantity)||!positive(event.executionPriceUsd)||
      !finite(event.feeUsd)||event.feeUsd<0||
      !finite(event.feeRate)||event.feeRate<0||event.feeRate>0.02||
      !close(event.feeUsd,
        event.quantity*event.executionPriceUsd*event.feeRate) ||
      seenFills.has(event.fillId)){
      addIssue('INVALID_OR_DUPLICATE_FILL',id);continue;
    }
    if(expectedSide==='SELL' &&
      (event.entryFillId!==id+':buy:1'||
      !finite(event.reportedNetPnlUsd))){
      addIssue('EXIT_MISSING_PAIRED_OR_REPORTED_PNL',id);continue;
    }
    seenFills.add(event.fillId);
    const record=paired.get(id)||{};
    if(record[expectedSide]){
      addIssue('DUPLICATE_POSITION_SIDE',id);continue;
    }
    record[expectedSide]={...event,fillMs:ms};
    paired.set(id,record);
  }
  let completedShadowProxyPositions=0,net=0,wins=0,
      grossProfit=0,grossLoss=0;
  const openProxyPositionIds=[];
  for(const [id,record] of paired){
    const entry=record.BUY,exit=record.SELL;
    if(!entry){
      addIssue('EXIT_WITHOUT_ENTRY',id);continue;
    }
    if(!exit){openProxyPositionIds.push(id);continue;}
    if(exit.fillMs<entry.fillMs||entry.symbol!==exit.symbol||
      entry.strategy!==exit.strategy||
      !close(entry.quantity,exit.quantity)||
      !close(entry.feeRate,exit.feeRate)){
      addIssue('UNMATCHED_ENTRY_EXIT',id);continue;
    }
    const pnl=exit.quantity*exit.executionPriceUsd -
      exit.feeUsd-entry.quantity*entry.executionPriceUsd-entry.feeUsd;
    if(!close(pnl,exit.reportedNetPnlUsd)){
      addIssue('REPORTED_PNL_MISMATCH',id);continue;
    }
    completedShadowProxyPositions++;
    net+=pnl;
    if(pnl>0){wins++;grossProfit+=pnl;}
    else if(pnl<0)grossLoss+=-pnl;
  }
  const completeEvidence=issues.length===0 &&
    openProxyPositionIds.length===0 && legacyEventsExcluded===0;
  return {
    source:'PUBLIC_MARKET_SHADOW_SIGNAL_PROXY_ONLY',
    recordsSeen:events.length,
    completedShadowProxyPositions,
    openProxyPositionIds,
    legacyEventsExcluded,
    structuralIntegrityIssues:issues,
    structurallyReconciledClosedProxies:issues.length===0,
    completeUninterruptedV2Journal:completeEvidence && events.length>0,
    modelledFeeAdjustedProxyPnlUsd:round(net),
    proxyWinRatePct:completedShadowProxyPositions ?
      round(100*wins/completedShadowProxyPositions):null,
    proxyProfitFactor:grossLoss>0?round(grossProfit/grossLoss):null,
    independentlyReconciledProductionPaperRoundTrips:0,
    realMoneyProfitabilityDemonstrated:false,
    forwardCandidateValidationComplete:false,
    liveTradingReady:false,
    limitations:[
      'Public GET-only shadow strategy proxies, not production PAPER or exchange fills.',
      'App-modeled fees and slippage are not independently authenticated venue executions.',
      'Journal may omit events before deployment or after crashes; completeness requires external checkpoint/restart audit.',
      'No full portfolio-equity marked drawdown or independent risk review supplied.',
    ],
  };
}
