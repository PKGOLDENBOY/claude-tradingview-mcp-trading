import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createShadowPositionEvidence,shadowEntryEvidence,shadowExitEvidence,
  SHADOW_EVIDENCE_SOURCE} from '../lib/shadow-auditable-events.mjs';
import {saveShadowCheckpoint,loadShadowCheckpoint,appendShadowEvidence,SHADOW_MODE}
  from '../lib/shadow-checkpoint.mjs';

const UUID='aabbccdd-1111-4222-8333-1234567890ab';
const MS=Date.parse('2026-10-29T16:00:00Z');
function newPosition(){
  const quantity=1,entryPrice=100,feeRate=0.001;
  const auditEvidence=createShadowPositionEvidence({
    strategy:'scalp',symbol:'BTCUSDT',openedMs:MS,
    quantity,entryPrice,feeRate,idFactory:()=>UUID,
  });
  return {opened:MS,quantity,entryPrice,totalCost:100.1,auditEvidence};
}
test('new shadow position gets stable UUID and exact two-sided fee-aware fills',()=>{
  const pos=newPosition();
  const entry=shadowEntryEvidence(pos,{strategy:'scalp',symbol:'BTCUSDT'});
  const exit=shadowExitEvidence(pos,{
    strategy:'scalp',symbol:'BTCUSDT',exitPrice:101,closedMs:MS+5000,
    reportedNetPnlUsd:0.799,
  });
  // 101 - 0.101 - 100.1 = 0.799
  assert.equal(entry.positionId,exit.positionId);
  assert.equal(entry.fillId,'shadow-'+UUID+':buy:1');
  assert.equal(exit.fillId,'shadow-'+UUID+':sell:1');
  assert.equal(exit.entryFillId,entry.fillId);
  assert.equal(entry.side,'BUY');
  assert.equal(exit.side,'SELL');
  assert.equal(entry.feeUsd,0.1);
  assert.equal(exit.feeUsd,0.101);
  assert.equal(exit.reportedNetPnlUsd,0.799);
  assert.equal(exit.evidenceSource,SHADOW_EVIDENCE_SOURCE);
  assert.equal(exit.spotLongOnly,true);
  assert.equal(exit.paperTrading,true);
});
test('legacy positions do NOT get manufactured IDs or fee receipts',()=>{
  const old={opened:MS,quantity:1,entryPrice:100,totalCost:100.1};
  const exit=shadowExitEvidence(old,{strategy:'swing',symbol:'BTCUSDT',
    exitPrice:101,closedMs:MS+5000,reportedNetPnlUsd:0.799});
  assert.equal(exit.auditEligible,false);
  assert.equal(exit.legacyMissingOriginalEntry,true);
  assert.equal(exit.positionId,undefined);
  assert.throws(()=>shadowEntryEvidence(old,{strategy:'swing',symbol:'BTCUSDT'}),
    /NEW_ENTRY_MISSING_AUDIT_ID/);
});
test('persisted evidence ID/entry timestamp survives checkpoint restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'shadow-audit-'));
  try {
    const file=join(dir,'shadow.json'),log=join(dir,'journal.ndjson');
    const original=newPosition();
    saveShadowCheckpoint(file,{startedAt:MS,endsAt:MS+10000,cycles:1,
      positions:{scalp:[['BTCUSDT',original]]},
      summary:{scalp:{entries:1,exits:0,realizedUSD:0}}});
    const reloaded=loadShadowCheckpoint(file).positions.scalp[0][1];
    assert.deepEqual(reloaded,original);
    const opening=shadowEntryEvidence(reloaded,{strategy:'scalp',symbol:'BTCUSDT'});
    appendShadowEvidence(log,{tag:'SHADOW_ENTRY',time:new Date(MS).toISOString(),
      safety:SHADOW_MODE,strategy:'scalp',symbol:'BTCUSDT',...opening});
    const closing=shadowExitEvidence(reloaded,{
      strategy:'scalp',symbol:'BTCUSDT',exitPrice:99,closedMs:MS+6000,
      reportedNetPnlUsd:-1.199,
    });
    appendShadowEvidence(log,{tag:'SHADOW_EXIT',time:new Date(MS+6000).toISOString(),
      safety:SHADOW_MODE,strategy:'scalp',symbol:'BTCUSDT',...closing});
    const events=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.length,2);
    assert.equal(events[0].positionId,events[1].positionId);
    assert.equal(events[0].fillId,events[1].entryFillId);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('invalid IDs, strategy mismatches, fee changes and false PnL fail closed',()=>{
  assert.throws(()=>createShadowPositionEvidence({
    strategy:'scalp',symbol:'BTCUSDT',openedMs:MS,quantity:1,
    entryPrice:100,feeRate:.001,idFactory:()=>'not-random',
  }),/POSITION_UUID_INVALID/);
  assert.throws(()=>shadowEntryEvidence(newPosition(),{
    strategy:'momentum',symbol:'BTCUSDT'
  }),/PERSISTED_POSITION_INCONSISTENT/);
  assert.throws(()=>shadowExitEvidence(newPosition(),{
    strategy:'scalp',symbol:'BTCUSDT',exitPrice:101,
    closedMs:MS+5000,reportedNetPnlUsd:25,
  }),/EXIT_PNL_ACCOUNTING_MISMATCH/);
  const wrong=newPosition();
  wrong.totalCost=100;
  assert.throws(()=>shadowEntryEvidence(wrong,{strategy:'scalp',symbol:'BTCUSDT'}),
    /PERSISTED_POSITION_INCONSISTENT/);
  const invalid=newPosition();invalid.auditEvidence.entryFillId='fabricated';
  assert.throws(()=>shadowEntryEvidence(invalid,{strategy:'scalp',symbol:'BTCUSDT'}),
    /PERSISTED_POSITION_INCONSISTENT/);
});
