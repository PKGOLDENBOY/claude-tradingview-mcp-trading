import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {LT_COINS,CONFIG_LT,parseClosedBars,scoreLtEntry,makeState,buyVirtual,
  sellVirtual,manageLongterm,snapshot} from "../lib/longterm-shadow-engine.mjs";
const DAY=86400000,base=Date.UTC(2026,8,15);
test("fixed production LT basket has 45 uniquely named USDT symbols",()=>{
  assert.equal(LT_COINS.length,45);
  assert.equal(new Set(LT_COINS).size,45);
  assert.ok(LT_COINS.every(s=>s.endsWith("USDT")));
});
test("candle parser excludes incomplete bars and malformed prices",()=>{
  const bars=[
    [base,100,110,99,105,10],
    [base+DAY,100,120,97,108,10],
    [base+2*DAY,100,120,97,108,10],
    [base-DAY,100,80,99,108,10],
  ];
  assert.deepEqual(parseClosedBars(bars,"1day",base+DAY+5).map(x=>x.timestamp),[base]);
  assert.deepEqual(parseClosedBars([[base,100,110,99,105,10]],"6h",base+6*3600000).length,1);
  assert.throws(()=>parseClosedBars(bars,"2hour",base+DAY));
});
test("unwarmed or invalid 11-condition history fails closed",()=>{
  assert.equal(scoreLtEntry([],[]).pass,false);
  assert.equal(scoreLtEntry(null,null).pass,false);
  const weekly=Array.from({length:54},(_,i)=>({close:100+i,volume:100,high:110+i,low:90+i}));
  const daily=Array.from({length:100},(_,i)=>({close:100+i*0.01,volume:100,high:101+i*.01,low:99+i*.01}));
  assert.equal(typeof scoreLtEntry(weekly,daily).pass,"boolean");
  assert.equal(scoreLtEntry(weekly,daily.map((x,i)=>i===9?{...x,close:NaN}:x)).pass,false);
});
test("paper buys retain fee-aware cash and do not spend reserve",()=>{
  const s=makeState(base);
  assert.equal(buyVirtual(s,"ETHUSDT",100,CONFIG_LT.t1USD,base),true);
  assert.equal(s.cashUsd,CONFIG_LT.initialUSD-CONFIG_LT.t1USD*(1+CONFIG_LT.feeRate));
  assert.equal(buyVirtual(s,"ETHUSDT",100,CONFIG_LT.t1USD,base),false);
  assert.equal(s.events[0].date,new Date(base).toISOString());
  assert.equal(buyVirtual(s,"LINKUSDT",100,150,base),false);
});
test("5-week stop loss books cost-inclusive realized LOSS; no actual exchange writes",()=>{
  const s=makeState(base);
  assert.equal(buyVirtual(s,"ETHUSDT",100,2.5,base),true);
  manageLongterm(s,{ETHUSDT:70},base+6*3600000,true);
  assert.equal(s.positions.ETHUSDT.open,false);
  assert.ok(s.positions.ETHUSDT.realizedPnlUsd<-0.72);
  assert.equal(snapshot(s,{}).simulatedSells,1);
  assert.equal(s.closedByReason.CATASTROPHIC_STOP,1);
});
test("8% DCA is gated during blocked market; unblocked first buys ONLY second tranche",()=>{
  const s=makeState(base);
  buyVirtual(s,"ADAUSDT",100,2.5,base);
  manageLongterm(s,{ADAUSDT:88},base+6*3600000,true);
  assert.equal(s.positions.ADAUSDT.t2Bought,false);
  manageLongterm(s,{ADAUSDT:88},base+12*3600000,false);
  assert.equal(s.positions.ADAUSDT.t2Bought,true);
  assert.equal(s.events.filter(e=>e.kind==="SIMULATED_BUY").length,2);
});
test("selling partial never liquidates full balance and fees reduce realized returns",()=>{
  const s=makeState(base);
  buyVirtual(s,"LINKUSDT",100,2.5,base);
  const q=s.positions.LINKUSDT.qty/2;
  const pnl=sellVirtual(s,"LINKUSDT",100,q,"PARTIAL",base+6*3600000);
  assert.ok(pnl<0);
  assert.equal(s.positions.LINKUSDT.open,true);
  assert.ok(s.positions.LINKUSDT.remainingQty>0);
  assert.throws(()=>sellVirtual(s,"LINKUSDT",100,1e6,"TOO_LARGE",base+6*3600000));
});
test("5-week history fetcher is public GET-only, never imports bot or authorizes real buys",()=>{
  const source=readFileSync(new URL("../scripts/longterm-5w-backtest.mjs",import.meta.url),"utf8");
  assert.ok(source.includes('method:"GET"'));
  assert.ok(source.includes('NONPUBLIC_API_PATH_BLOCKED'));
  assert.ok(source.includes('PUBLIC') || source.includes('public'));
  assert.ok(!source.includes('import "./bot.js"'));
  assert.ok(!source.includes('LIVE_TRADING_ENABLED'));
  assert.ok(!/method:\s*["']POST["']/.test(source));
  assert.ok(!source.includes('/trade/place-order'));
});

test("re-entering a previously closed coin creates a new live episode and preserves realized PnL",()=>{
  const s=makeState(base);
  assert.equal(buyVirtual(s,"HBARUSDT",100,2.5,base),true);
  const first=s.positions.HBARUSDT.qty;
  sellVirtual(s,"HBARUSDT",110,first,"TAKE_PROFIT",base+DAY);
  assert.equal(s.positions.HBARUSDT.open,false);
  assert.equal(s.positions.HBARUSDT.remainingQty,0);
  assert.equal(buyVirtual(s,"HBARUSDT",90,2.5,base+DAY*2),true);
  assert.equal(s.positions.HBARUSDT.open,true);
  assert.ok(s.positions.HBARUSDT.remainingQty>0);
  assert.equal(s.closedPositionsCount,1);
  const second=s.positions.HBARUSDT.qty;
  sellVirtual(s,"HBARUSDT",80,second,"CATASTROPHIC_STOP",base+DAY*3);
  const snap=snapshot(s,{HBARUSDT:80});
  assert.equal(snap.openPositions,0);
  assert.equal(snap.completeExits,2);
  assert.equal(snap.simulatedBuys,2);
  assert.equal(snap.simulatedSells,2);
  // With all positions sold, cash change MUST equal realized P&L to 6 decimals.
  assert.ok(Math.abs(snap.realizedPnlUSD-snap.combinedSimulatedPnlUSD)<0.00001);
  assert.ok(s.events.every(e=>e.kind!=="SIMULATED_BUY"||e.date.startsWith("2026-")));
});
