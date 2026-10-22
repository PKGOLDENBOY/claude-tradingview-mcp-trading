import test from "node:test";
import assert from "node:assert/strict";
import {auditPaperLedger} from "../lib/paper-ledger-evidence.mjs";

const base={type:"exit",paperTrading:true,orderPlaced:true,feeAdjusted:true,
  symbol:"BTCUSDT",quantity:0.01,timestamp:"2026-10-20T12:00:00.000Z"};
test("audit counts only genuine fee-adjusted recorded paper exit events",()=>{
  const ledger={trades:[
    {...base,orderId:"A",pnlUSD:3},
    {...base,orderId:"A",pnlUSD:3}, // Exact duplicate must not count
    {...base,orderId:"B",timestamp:"2026-10-20T13:00:00.000Z",pnlUSD:-1},
    {...base,orderId:"C",timestamp:"2026-10-20T14:00:00.000Z",pnlUSD:-99,feeAdjusted:false},
    {...base,orderId:"D",timestamp:"2026-10-20T15:00:00.000Z",pnlUSD:22,orderPlaced:false},
    {...base,orderId:"E",timestamp:"2026-10-20T16:00:00.000Z",pnlUSD:null},
    {...base,orderId:"LIVE",timestamp:"2026-10-20T17:00:00.000Z",pnlUSD:999,paperTrading:false},
  ]};
  const a=auditPaperLedger(ledger,{initialEquityUsd:100});
  assert.equal(a.paperExitEventsSeen,6);
  assert.equal(a.auditableExitEvents,2);
  assert.equal(a.excludedExitEvents,4);
  assert.equal(a.realizedExitPnlUsd,2);
  assert.equal(a.winRatePct,50);
  assert.equal(a.profitFactor,3);
  assert.ok(a.exitOnlyRealizedDrawdownPct>0);
  assert.equal(a.completedIndependentRoundTripsVerified,null);
  assert.equal(a.readyForLiveMoney,false);
});
test("no trades means no artificial profitability, no fake 100 trades",()=>{
  const a=auditPaperLedger({trades:[]});
  assert.equal(a.auditableExitEvents,0);
  assert.equal(a.winRatePct,null);
  assert.equal(a.profitFactor,null);
  assert.equal(a.fullPortfolioMaxDrawdownPct,null);
  assert.equal(a.hasVerified100CompletedTrades,false);
});
test("missing records fail closed",()=>{
  assert.throws(()=>auditPaperLedger({}),/MISSING_PERSISTED_TRADE_EVENTS/);
  assert.throws(()=>auditPaperLedger(null),/MISSING_PERSISTED_TRADE_EVENTS/);
});
