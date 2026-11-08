import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditProspectivePaper} from '../lib/forward-paper-evidence.mjs';

const m={candidateId:'ml-068',frozenAt:'2026-11-08T14:00:00Z',
  modelSha256:'a'.repeat(64),trainingDataSha256:'b'.repeat(64)};
const entry=(id,at='2026-11-08T15:00:00Z')=>({type:'ENTRY',source:'FORWARD_PAPER',
  candidateId:m.candidateId,modelSha256:m.modelSha256,positionId:'pos_'+id,eventId:'ent_'+id,
  symbol:'BTCUSDT',qty:1,priceUSD:100,feeUSD:0.1,slippageUSD:0.2,
  observedAt:at,recordedAt:at});
const exit=(id,at='2026-11-08T16:00:00Z')=>({type:'EXIT',source:'FORWARD_PAPER',
  candidateId:m.candidateId,modelSha256:m.modelSha256,positionId:'pos_'+id,eventId:'ext_'+id,
  symbol:'BTCUSDT',qty:1,priceUSD:110,feeUSD:0.11,slippageUSD:0.2,
  observedAt:at,recordedAt:at});
const now='2026-11-08T17:00:00Z';

test('closed prospective trades match entries by immutable ID with fees and slippage',()=>{
  const r=auditProspectivePaper({manifest:m,events:[entry('12345678'),exit('12345678')],now});
  assert.equal(r.internallyMatchedRoundTrips,1);
  assert.equal(r.realizedPnlUSD,9.39);
  assert.equal(r.openPositions,0);
  assert.equal(r.independentlyReconciledRoundTrips,null);
  assert.equal(r.liveMoneyReady,false);
});

test('before-freeze and shadow trades never count as forward',()=>{
  const old=entry('12345678','2026-11-07T15:00:00Z');
  const fake=entry('87654321');fake.source='SHADOW_SIMULATION';
  const r=auditProspectivePaper({manifest:m,events:[old,exit('12345678'),fake,exit('87654321')],now});
  assert.equal(r.internallyMatchedRoundTrips,0);
  assert.equal(r.rejectedEvents.length,4);
});

test('duplicate, missing, partial, and nonchronological fills cannot fake a round trip',()=>{
  const a=entry('12345678'),dup={...a,eventId:'ent_22222222'},partial={...exit('12345678'),qty:0.5};
  const r=auditProspectivePaper({manifest:m,events:[a,dup,partial],now});
  assert.equal(r.internallyMatchedRoundTrips,0);
  assert.equal(r.rejectedEvents.length,2);
  assert.equal(r.openPositions,1);
});

test('100 self-reported round trips are explicitly NOT independently verified',()=>{
  const entries=Array.from({length:100},(_,i)=>String(i).padStart(8,'0'));
  const events=entries.flatMap(id=>[entry(id),exit(id)]);
  const r=auditProspectivePaper({manifest:m,events,now});
  assert.equal(r.internallyMatchedRoundTrips,100);
  assert.equal(r.independentlyReconciledRoundTrips,null);
  assert.equal(r.independentlyVerifiedPaperTrades100,false);
  assert.equal(r.realOrdersAuthorized,false);
});

test('bad manifest and fabricated observation times fail closed; no network/orders in source',()=>{
  assert.throws(()=>auditProspectivePaper({manifest:{...m,modelSha256:'bogus'},events:[],now}),/FORWARD_MANIFEST_INVALID/);
  const r=auditProspectivePaper({manifest:m,events:[{...entry('12345678'),recordedAt:'2026-11-09T16:00:00Z'}],now});
  assert.equal(r.internallyMatchedRoundTrips,0);
  const s=readFileSync(new URL('../lib/forward-paper-evidence.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(s,/fetch\(|axios|submitOrder|placeOrder|[.]env/);
});
