import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSwingTrades, swingTradeMetrics } from '../lib/swing-backtest.mjs';

function setup({entryOpen=100,entryHigh=110,entryLow=100,closed=false}={}){
  const c=Array.from({length:48},(_,i)=>({time:i*14400000,open:100,high:101,low:99,close:100,volume:10}));
  const n=30;
  c[n].close=100;
  c[n+1]={...c[n+1],open:entryOpen,high:entryHigh,low:entryLow,close:entryOpen};
  const indicators={rsi3:Array(48).fill(99),ema8:Array(48).fill(102),
    ema21:Array(48).fill(100),vwap:Array(48).fill(100)};
  indicators.rsi3[n]=20;
  return {c,indicators,n};
}
test('simulator enters only after the signal has closed',()=>{
  const {c,indicators}=setup({entryOpen:100,entryHigh:113,entryLow:100});
  const t=simulateSwingTrades(c,30,0.10,0.05,indicators);
  assert.equal(t.length,1);
  assert.equal(t[0].exitReason,'TAKE_PROFIT');
  assert.ok(t[0].pct>0);
});
test('stop precedes target when both cross within the same unknown candle',()=>{
  const {c,indicators}=setup({entryOpen:100,entryHigh:125,entryLow:85});
  const t=simulateSwingTrades(c,30,0.10,0.05,indicators);
  assert.equal(t.length,1);
  assert.equal(t[0].exitReason,'STOP');
  assert.ok(t[0].pct<-5);
});
test('stop gap fills at worse open, not an impossible stop price',()=>{
  const {c,indicators}=setup({entryOpen:85,entryHigh:90,entryLow:80});
  const t=simulateSwingTrades(c,30,0.10,0.05,indicators);
  // stop derived from next open (85), so this candle itself is the fill bar
  // and cannot be a gap relative to its own fill; force the NEXT bar below stop.
  const z=setup({entryOpen:100,entryHigh:101,entryLow:99});
  z.c[32]={...z.c[32],open:88,high:89,low:85,close:88};
  const r=simulateSwingTrades(z.c,30,0.10,0.05,z.indicators);
  assert.equal(r[0].exitReason,'GAP_STOP');
  assert.ok(r[0].pct<-10);
});
test('incomplete positions never appear as realized winners',()=>{
  const {c,indicators}=setup({entryOpen:100,entryHigh:101,entryLow:99});
  const t=simulateSwingTrades(c,30,0.10,0.05,indicators,{maxHoldBars:100});
  assert.equal(t.length,0);
  assert.equal(swingTradeMetrics(t).sample,0);
});
test('closed trade metrics are calculated after two-sided costs',()=>{
  const {c,indicators}=setup({entryOpen:100,entryHigh:111,entryLow:99});
  const t=simulateSwingTrades(c,30,0.10,0.05,indicators);
  const m=swingTradeMetrics(t);
  assert.equal(m.sample,1);
  assert.equal(m.winRate,1);
  assert.ok(m.expectancyPct<10);
});
