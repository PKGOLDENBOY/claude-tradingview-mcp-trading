import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {HYPOTHESIS,trendPullbackSignal,evaluatePredeclaredTrend} from '../lib/trend-pullback-hypothesis.mjs';

function makeSeries() {
  const n=300;
  const s={length:n,ts:Float64Array.from({length:n},(_,i)=>i*3600000),
    open:new Float64Array(n).fill(100),high:new Float64Array(n).fill(101),
    low:new Float64Array(n).fill(99),close:new Float64Array(n).fill(100),
    quoteVolume:new Float64Array(n).fill(100000),
    priorQuoteVolume20:new Float64Array(n).fill(100000),
    ema:{24:new Float64Array(n).fill(102),80:new Float64Array(n).fill(98)},
    rsi:{14:new Float64Array(n).fill(49)}};
  s.ema[80][114]=97;s.rsi[14][119]=44;s.rsi[14][120]=51;
  s.ema[24][120]=99;s.ema[80][120]=98;
  return s;
}

test('fixed 1H spot-only hypothesis has explicit costs, no trading interface',()=>{
  assert.equal(HYPOTHESIS.side,'SPOT_LONG_ONLY');
  assert.equal(HYPOTHESIS.timeframe,'1H');
  assert.equal(HYPOTHESIS.promotion,'RESEARCH_ONLY_UNVALIDATED');
  assert.equal(HYPOTHESIS.assumptions.feePerSide,0.001);
  assert.equal(HYPOTHESIS.assumptions.adverseSlippagePerSide,0.001);
  assert.equal(HYPOTHESIS.assumptions.assumedHalfSpreadPerSide,0.0005);
  assert.deepEqual([...HYPOTHESIS.universe],['BTCUSDT','ETHUSDT','SOLUSDT','LINKUSDT','ADAUSDT']);
  const code=readFileSync(new URL('../lib/trend-pullback-hypothesis.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(code,/fetch\(|axios|placeOrder|submitOrder|\bbot\.js\b|process\.env/);
});

test('signal uses only closed and earlier bars, rejects malformed/stale data',()=>{
  const s=makeSeries();
  assert.equal(trendPullbackSignal(s,120),true);
  assert.equal(trendPullbackSignal(s,109),false);
  assert.equal(trendPullbackSignal(s,301),false);
  s.rsi[14][119]=47;assert.equal(trendPullbackSignal(s,120),false);
  s.rsi[14][119]=44;s.ema[80][114]=102;assert.equal(trendPullbackSignal(s,120),false);
  s.ema[80][114]=97;s.high[120]=120;assert.equal(trendPullbackSignal(s,120),false);
  s.high[120]=101;s.quoteVolume[120]=5;assert.equal(trendPullbackSignal(s,120),false);
  s.quoteVolume[120]=100000;s.close[120]=Number.NaN;
  assert.equal(trendPullbackSignal(s,120),false);
});

test('only three declared historical validation folds; no previously consumed holdout used',()=>{
  const series=makeSeries();const prepared=Object.fromEntries(HYPOTHESIS.universe.map(sym=>[sym,series]));
  const splits={folds:[
    {id:1,validation:{start:110,end:140}},
    {id:2,validation:{start:140,end:170}},
    {id:3,validation:{start:170,end:200}},
  ],get holdout(){throw new Error('CONSUMED_HOLDOUT_ACCESS_FORBIDDEN')}};
  const r=evaluatePredeclaredTrend(prepared,splits);
  assert.equal(r.status,'RETROSPECTIVE_VALIDATION_ONLY');
  assert.equal(r.independentOosVerified,false);
  assert.equal(r.liveMoneyReady,false);
  assert.equal(r.forwardPaperRoundTripsVerified,0);
  assert.equal(r.validation.folds.length,3);
  assert.ok(r.validation.trades>=0);
  assert.throws(()=>evaluatePredeclaredTrend({BTCUSDT:series},splits),/RESEARCH_UNIVERSE_INVALID/);
});
