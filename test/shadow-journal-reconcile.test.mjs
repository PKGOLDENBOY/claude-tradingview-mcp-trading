import test from 'node:test';
import assert from 'node:assert/strict';
import {createShadowPositionEvidence,shadowEntryEvidence,shadowExitEvidence} from '../lib/shadow-auditable-events.mjs';
import {reconcileShadowEventJournal} from '../lib/shadow-journal-reconcile.mjs';

const MS=Date.parse('2026-10-29T16:00:00Z');
const UUID='aabbccdd-1111-4222-8333-1234567890ab';
function pair({id=UUID,price=101,strategy='scalp',symbol='BTCUSDT'}={}){
  const quantity=1,entryPrice=100,feeRate=.001;
  const pos={
    opened:MS,quantity,entryPrice,totalCost:100.1,
    auditEvidence:createShadowPositionEvidence({strategy,symbol,openedMs:MS,
      quantity,entryPrice,feeRate,idFactory:()=>id}),
  };
  const entry={tag:'SHADOW_ENTRY',strategy,symbol,
    safety:'PUBLIC_MARKET_READ_ONLY_SHADOW',
    ...shadowEntryEvidence(pos,{strategy,symbol})};
  const simulatedPnl=price*(1-feeRate)-100.1;
  const exit={tag:'SHADOW_EXIT',strategy,symbol,
    safety:'PUBLIC_MARKET_READ_ONLY_SHADOW',
    ...shadowExitEvidence(pos,{strategy,symbol,exitPrice:price,
      closedMs:MS+30_000,reportedNetPnlUsd:simulatedPnl})};
  return {entry,exit};
}
test('v2 shadow fills reconcile fees and ID without claiming actual forward PAPER',()=>{
  const {entry,exit}=pair();
  const r=reconcileShadowEventJournal([entry,exit]);
  assert.equal(r.completedShadowProxyPositions,1);
  assert.equal(r.structuralIntegrityIssues.length,0);
  assert.equal(r.openProxyPositionIds.length,0);
  assert.equal(r.modelledFeeAdjustedProxyPnlUsd,.799);
  assert.equal(r.proxyWinRatePct,100);
  assert.equal(r.proxyProfitFactor,null);
  assert.equal(r.independentlyReconciledProductionPaperRoundTrips,0);
  assert.equal(r.realMoneyProfitabilityDemonstrated,false);
  assert.equal(r.liveTradingReady,false);
});
test('partial journal entry cannot silently count as a completed round trip',()=>{
  const {entry}=pair();
  const r=reconcileShadowEventJournal([entry]);
  assert.equal(r.completedShadowProxyPositions,0);
  assert.equal(r.openProxyPositionIds.length,1);
  assert.equal(r.completeUninterruptedV2Journal,false);
});
test('journal missing entry cannot fabricate its opening fill',()=>{
  const {exit}=pair();
  const r=reconcileShadowEventJournal([exit]);
  assert.equal(r.completedShadowProxyPositions,0);
  assert.equal(r.structurallyReconciledClosedProxies,false);
  assert.ok(r.structuralIntegrityIssues.some(x=>x.type==='EXIT_WITHOUT_ENTRY'));
});
test('duplicate exit event after a restart is a fail-closed integrity problem',()=>{
  const {entry,exit}=pair();
  const r=reconcileShadowEventJournal([entry,exit,structuredClone(exit)]);
  assert.equal(r.completedShadowProxyPositions,1);
  assert.equal(r.structurallyReconciledClosedProxies,false);
  assert.ok(r.structuralIntegrityIssues.some(x=>x.type==='INVALID_OR_DUPLICATE_FILL'));
});
test('legacy event is excluded without invented IDs or hidden recovery',()=>{
  const {entry,exit}=pair();
  const legacy={tag:'SHADOW_EXIT',safety:'PUBLIC_MARKET_READ_ONLY_SHADOW',
    strategy:'scalp',symbol:'BTCUSDT',simulatedPnlUSD:50};
  const r=reconcileShadowEventJournal([legacy,entry,exit]);
  assert.equal(r.legacyEventsExcluded,1);
  assert.equal(r.completedShadowProxyPositions,1);
  assert.equal(r.completeUninterruptedV2Journal,false);
  assert.equal(r.independentlyReconciledProductionPaperRoundTrips,0);
});
test('changed fee, PnL and opposite symbol cannot fake reconciled profit',()=>{
  const original=pair();
  for(const mutate of [
    r=>{r[1].feeUsd=0;},
    r=>{r[1].reportedNetPnlUsd=100;},
    r=>{r[1].symbol='ADAUSDT';},
    r=>{r[1].fillTimestamp='2026-10-28T00:00:00Z';},
    r=>{r[1].safety='LIVE_ORDERS_ENABLED';},
    r=>{r[1].positionId='other-id';},
  ]){
    const events=structuredClone([original.entry,original.exit]);
    mutate(events);
    const result=reconcileShadowEventJournal(events);
    assert.equal(result.structurallyReconciledClosedProxies,false);
    assert.equal(result.independentlyReconciledProductionPaperRoundTrips,0);
  }
});
test('synthetic 100 matching SHADOW proxies are STILL zero genuine production PAPER trades',()=>{
  const events=[];
  for(let i=0;i<100;i++){
    const id='aabbccdd-1111-4222-8333-'+i.toString(16).padStart(12,'0');
    const {entry,exit}=pair({id,price:i%2===0?101:99});
    events.push(entry,exit);
  }
  const r=reconcileShadowEventJournal(events);
  assert.equal(r.completedShadowProxyPositions,100);
  assert.equal(r.structurallyReconciledClosedProxies,true);
  assert.equal(r.independentlyReconciledProductionPaperRoundTrips,0);
  assert.equal(r.forwardCandidateValidationComplete,false);
  assert.equal(r.realMoneyProfitabilityDemonstrated,false);
});
test('unsafe or massive journal cannot be laundered through this read-only auditor',()=>{
  assert.throws(()=>reconcileShadowEventJournal(null),/NOT_BOUNDED/);
  const r=reconcileShadowEventJournal([{},null]);
  assert.equal(r.completedShadowProxyPositions,0);
  assert.equal(r.structuralIntegrityIssues.length,2);
  assert.equal(r.liveTradingReady,false);
});
