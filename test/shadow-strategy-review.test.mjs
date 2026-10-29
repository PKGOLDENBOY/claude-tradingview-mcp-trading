import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateShadowSnapshot } from '../lib/shadow-strategy-review.mjs';

const fixture=JSON.parse(readFileSync(
  new URL('../reports/shadow-strategy-snapshot-20261029.json',import.meta.url),'utf8'));
const copy=()=>structuredClone(fixture);

test('read-only Railway snapshot: scalp and momentum lose after modeled costs',()=>{
  const r=evaluateShadowSnapshot(copy());
  assert.equal(r.noStrategyProfitabilityDemonstrated,true);
  assert.equal(r.conclusions.scalp.assessment,'LOSING_OBSERVED_SHADOW_SAMPLE');
  assert.equal(r.conclusions.scalp.closedProxyPositions,21);
  assert.equal(r.conclusions.scalp.simulatedNetRealizedPnlUSD,-7.6831);
  assert.equal(r.conclusions.scalp.reportedProfitFactor,0.215);
  assert.equal(r.conclusions.momentum.assessment,'LOSING_OBSERVED_SHADOW_SAMPLE');
  assert.equal(r.conclusions.momentum.closedProxyPositions,21);
  assert.equal(r.conclusions.momentum.simulatedNetRealizedPnlUSD,-75.3685);
  assert.equal(r.conclusions.momentum.reportedProfitFactor,0.325);
  assert.equal(r.conclusions.momentum.distinctTradesIndependentlyReconciled,false);
});
test('swing open positions receive NO fabricated win rate or completed paper trades',()=>{
  const r=evaluateShadowSnapshot(copy());
  assert.equal(r.conclusions.swing.assessment,'NO_REALIZED_VERDICT');
  assert.equal(r.conclusions.swing.closedProxyPositions,0);
  assert.equal(r.conclusions.swing.openProxyPositions,2);
  assert.equal(r.conclusions.swing.simulatedOpenMarkUSD,-3.094);
  assert.equal(r.conclusions.swing.reportedWinRatePct,null);
  assert.equal(r.conclusions.swing.reportedProfitFactor,null);
  assert.equal(r.conclusions.swing.historyAndOosIndependentlyValidated,false);
});
test('bad provenance and unsafe non-paper source fail closed',()=>{
  for(const mutate of [
    r=>{r.event.safety='EXCHANGE_WRITES_ALLOWED';},
    r=>{r.event.tag='UNRELATED_EVENT';},
    r=>{r.source.logTimestampUtc='bad';},
    r=>{r.schemaVersion=3;}
  ]){
    const sample=copy();mutate(sample);
    assert.throws(()=>evaluateShadowSnapshot(sample),/INVALID_SHADOW_PROVENANCE/);
  }
});
test('inconsistent counters and duplicate/partial position claims are not accepted',()=>{
  const a=copy();a.event.stats.scalp.entries=18;
  assert.throws(()=>evaluateShadowSnapshot(a),/INCONSISTENT_STRATEGY_METRICS_SCALP/);
  const b=copy();b.event.stats.swing.exits=1;
  assert.throws(()=>evaluateShadowSnapshot(b),/INCONSISTENT_STRATEGY_METRICS_SWING/);
  const c=copy();c.event.stats.momentum.wins=22;
  assert.throws(()=>evaluateShadowSnapshot(c),/INCONSISTENT_STRATEGY_METRICS_MOMENTUM/);
  const d=copy();d.event.stats.scalp.unpricedOpen=1;
  assert.throws(()=>evaluateShadowSnapshot(d),/INCONSISTENT_STRATEGY_METRICS_SCALP/);
});
test('wrong P&L/win-rate or invalid profit factor rejected',()=>{
  const a=copy();a.event.stats.momentum.combinedSimulatedPnlUSD=800;
  assert.throws(()=>evaluateShadowSnapshot(a),/INCONSISTENT_STRATEGY_METRICS_MOMENTUM/);
  const b=copy();b.event.stats.scalp.winRatePct=99;
  assert.throws(()=>evaluateShadowSnapshot(b),/INCONSISTENT_STRATEGY_METRICS_SCALP/);
  const c=copy();c.event.stats.scalp.profitFactor=-1;
  assert.throws(()=>evaluateShadowSnapshot(c),/INCONSISTENT_STRATEGY_METRICS_SCALP/);
});
test('no open-only swing sample can be represented as positive realized performance',()=>{
  const a=copy();a.event.stats.swing.winRatePct=100;
  assert.throws(()=>evaluateShadowSnapshot(a),/INCONSISTENT_STRATEGY_METRICS_SWING/);
  const b=copy();b.event.stats.swing.profitFactor=1.5;
  assert.throws(()=>evaluateShadowSnapshot(b),/INCONSISTENT_STRATEGY_METRICS_SWING/);
});
