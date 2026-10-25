import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERVAL_MS, parseAndValidateBars, chronologicalSplits,generateCandidates,
  prepareSeries,isSignal,simulateCandidate,evaluateCandidate,rankCandidateResults,
  sealedHoldout } from '../lib/accelerator-core.mjs';
import { syntheticBars,testUniverse } from './helpers.mjs';

test('420 bounded candidate configurations with four distinct families',()=>{
  const configs=generateCandidates();
  assert.equal(configs.length,420);
  assert.deepEqual([...new Set(configs.map(x=>x.family))].sort(),
    ['breakout','momentum','reversion','trend']);
  assert.equal(new Set(configs.map(c=>c.id)).size,420);
  for(const c of configs){assert.ok(c.stop>0&&c.stop<=.04);assert.ok(c.take>0&&c.take<=.06);}
});
test('historical candle strictness: duplicates, gaps, invalid range, unfinished bar rejected',()=>{
  const candles=syntheticBars(120);
  const now=candles.at(-1).ts+2*INTERVAL_MS;
  assert.equal(parseAndValidateBars(candles,{nowMs:now}).length,120);
  assert.throws(()=>parseAndValidateBars([...candles,candles[1]],{nowMs:now}),/DUPLICATE/);
  assert.throws(()=>parseAndValidateBars(candles.filter((x,i)=>i!==55),{nowMs:now}),/GAP/);
  assert.throws(()=>parseAndValidateBars([{...candles[0],high:1}],{nowMs:now}),/INVALID/);
  assert.throws(()=>parseAndValidateBars([candles.at(-1)],{nowMs:candles.at(-1).ts}),/INVALID/);
});
test('expanding train/validation folds have gaps and never touch final sealed holdout',()=>{
  const splits=chronologicalSplits(4320);
  assert.equal(splits.folds.length,3);
  for(const f of splits.folds){
    assert.ok(f.train.end<f.validation.start);
    assert.ok(f.validation.end<=splits.holdout.start);
    assert.ok(f.train.start<f.train.end && f.validation.start<f.validation.end);
  }
  assert.ok(splits.holdout.start>0.8*4320);
});
test('no future-bar leakage into any indicator at prior timestamp',()=>{
  const original=syntheticBars(300);
  const a=prepareSeries(original);
  const mutated=structuredClone(original);
  mutated[275]={...mutated[275],open:mutated[275].open,close:mutated[275].close*1.1,
    high:mutated[275].high*1.2};
  const b=prepareSeries(mutated);
  for(const i of [100,150,260]){
    for(const c of generateCandidates().slice(0,15))
      assert.equal(isSignal(c,a,i),isSignal(c,b,i));
  }
});
test('next-bar open execution and stop-first assumption on same-bar both-barrier crossing',()=>{
  const bars=syntheticBars(145,{trend:.002,fluctuation:0});
  // Force a bar where any open position stops, despite upper side also hitting TP.
  bars[130].high=bars[130].open*1.15;
  bars[130].low=bars[130].open*.80;
  const s=prepareSeries(bars);
  const candidate={id:'test',family:'trend',params:{fast:6,slow:30,minRsi:46},stop:.025,take:.03};
  const r=simulateCandidate(candidate,s,{start:110,end:145});
  assert.ok(r.events.length>0);
  assert.ok(r.events.some(x=>x.reason==='STOP'||x.reason==='STOP_GAP'));
  assert.ok(r.events.every(x=>x.exitIndex>=x.entryIndex));
  assert.ok(r.events.some(x=>x.entryIndex>110));
});
test('training selection never references the holdout, including if holdout is mutated',()=>{
  const data=testUniverse(1450),c=generateCandidates()[0],s=chronologicalSplits(1450);
  const prepared=Object.fromEntries(Object.entries(data).map(([k,v])=>[k,prepareSeries(v)]));
  const original=evaluateCandidate(c,prepared,s);
  for(const rows of Object.values(data))for(let i=s.holdout.start;i<rows.length;i++){
    rows[i].close*=.9; rows[i].open*=.9;rows[i].high*=1.2; rows[i].low*=.7;
  }
  const changed=Object.fromEntries(Object.entries(data).map(([k,v])=>[k,prepareSeries(v)]));
  const after=evaluateCandidate(c,changed,s);
  assert.deepEqual(original,after);
  assert.ok(sealedHoldout(c,prepared,s).trades>=0);
});
test('research ranking keeps rejected candidates out of selected field',()=>{
  const candidates=generateCandidates().slice(0,5);
  const vals=candidates.map((c,i)=>({id:c.id,family:c.family,score:i+1,eligible:false}));
  const report=rankCandidateResults(vals);
  assert.equal(report.selected,null);
  assert.equal(report.eligibleCount,0);
  assert.equal(report.top.length,5);
});
