import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auditShadowJournalFile} from '../scripts/audit-shadow-journal.mjs';
import {saveShadowCheckpoint} from '../lib/shadow-checkpoint.mjs';
import {createShadowPositionEvidence,shadowEntryEvidence,shadowExitEvidence}
  from '../lib/shadow-auditable-events.mjs';

const start=Date.parse('2026-10-29T16:00:00Z');
const pos={
  opened:start,quantity:1,entryPrice:100,totalCost:100.1,
  auditEvidence:createShadowPositionEvidence({
    strategy:'scalp',symbol:'BTCUSDT',openedMs:start,quantity:1,
    entryPrice:100,feeRate:.001,idFactory:()=>'aabbccdd-1111-4222-8333-1234567890ab',
  })
};
const common={strategy:'scalp',symbol:'BTCUSDT',safety:'PUBLIC_MARKET_READ_ONLY_SHADOW'};
const entry={tag:'SHADOW_ENTRY',...common,...shadowEntryEvidence(pos,common)};
const exit={tag:'SHADOW_EXIT',...common,...shadowExitEvidence(pos,{
  ...common,exitPrice:101,closedMs:start+2000,reportedNetPnlUsd:.799
})};
function withDir(fn){
  const dir=mkdtempSync(join(tmpdir(),'shadow-audit-cli-'));
  try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}
}
function saved(dir){
  const file=join(dir,'events.ndjson');
  const checkpoint=join(dir,'checkpoint.json');
  writeFileSync(file,[entry,exit].map(x=>JSON.stringify(x)).join('\n')+'\n');
  saveShadowCheckpoint(checkpoint,{
    startedAt:start,endsAt:start+10000,cycles:2,
    positions:{scalp:[]},
    summary:{scalp:{entries:1,exits:1,realizedUSD:.799}},
  });
  return {file,checkpoint};
}
test('offline CLI reads a v2 journal, compares checkpoint and never writes to either',()=>withDir(dir=>{
  const {file,checkpoint}=saved(dir);
  const before=readFileSync(file,'utf8');
  const audit=auditShadowJournalFile(file,checkpoint);
  assert.equal(audit.checkpointCountersMatch,true);
  assert.equal(audit.structuralIntegrityIssues.length,0);
  assert.equal(audit.completedShadowProxyPositions,1);
  assert.equal(audit.modelledFeeAdjustedProxyPnlUsd,.799);
  assert.equal(audit.independentlyReconciledProductionPaperRoundTrips,0);
  assert.match(audit.sha256,/^[a-f0-9]{64}$/);
  assert.equal(readFileSync(file,'utf8'),before);
}));
test('crash/replay count mismatch fails closed rather than counting silently',()=>withDir(dir=>{
  const {file,checkpoint}=saved(dir);
  const savedState=JSON.parse(readFileSync(checkpoint,'utf8'));
  savedState.summary.scalp.entries=2;
  writeFileSync(checkpoint,JSON.stringify(savedState)+'\n');
  const audit=auditShadowJournalFile(file,checkpoint);
  assert.equal(audit.checkpointCountersMatch,false);
  assert.equal(audit.structurallyReconciledClosedProxies,false);
  assert.ok(audit.structuralIntegrityIssues.some(x=>x.type==='CHECKPOINT_JOURNAL_COUNT_MISMATCH'));
}));
test('corrupt JSON and symlink journal are rejected without recovery or deletion',()=>withDir(dir=>{
  const {file}=saved(dir);
  writeFileSync(file,'{broken');
  assert.throws(()=>auditShadowJournalFile(file),/CORRUPT_JSON_LINE/);
  const linked=join(dir,'linked.ndjson');
  symlinkSync(file,linked);
  assert.throws(()=>auditShadowJournalFile(linked),/UNSAFE_OR_TOO_LARGE/);
  assert.equal(readFileSync(file,'utf8'),'{broken');
}));
test('audit without checkpoint never asserts persistent history completeness',()=>withDir(dir=>{
  const {file}=saved(dir);
  const audit=auditShadowJournalFile(file);
  assert.equal(audit.checkpointCountersMatch,null);
  assert.equal(audit.realMoneyProfitabilityDemonstrated,false);
}));
