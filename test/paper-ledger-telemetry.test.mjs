import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizePaperLedgerForLog } from "../lib/paper-ledger-telemetry.mjs";

const exit={type:"exit",paperTrading:true,orderPlaced:true,feeAdjusted:true,
  timestamp:"2026-10-22T12:00:00.000Z",symbol:"BTCUSDT",
  quantity:0.001,pnlUSD:1.25,orderId:"PAPER-X"};
test("telemetry summarizes fees without revealing trade records or secrets",()=>{
  const state={trades:[exit],apiKey:"NEVER_LEAK",positions:{BTCUSDT:{secret:"NEVER_LEAK"}}};
  const out=summarizePaperLedgerForLog(state,1);
  assert.equal(out.mode,"PAPER");
  assert.equal(out.realizedPaperExitPnlUSD,1.25);
  assert.equal(out.auditableFeeAdjustedExitEvents,1);
  assert.equal(out.exitEventWinRatePct,100);
  assert.equal(out.liveMoneyReady,false);
  assert.equal(out.all100PaperTradesVerified,false);
  assert.equal(out.independentCompletedRoundTrips,null);
  assert.ok(!JSON.stringify(out).includes("NEVER_LEAK"));
  assert.ok(!JSON.stringify(out).includes("BTCUSDT"));
});
test("empty ledger is not presented as profitable or complete",()=>{
  const out=summarizePaperLedgerForLog({trades:[]},2);
  assert.equal(out.auditableFeeAdjustedExitEvents,0);
  assert.equal(out.exitEventWinRatePct,null);
  assert.equal(out.exitEventProfitFactor,null);
});
test("corrupt/missing ledger fails closed",()=>{
  assert.throws(()=>summarizePaperLedgerForLog(null,1),/MISSING_PERSISTED_TRADE_EVENTS/);
  assert.throws(()=>summarizePaperLedgerForLog({trades:null},1),/MISSING_PERSISTED_TRADE_EVENTS/);
});
test("runtime publishes only PAPER evidence, and never forces live trades",()=>{
  const src=readFileSync(new URL("../bot.js",import.meta.url),"utf8");
  const start=src.indexOf("function logPaperLedgerEvidence() {");
  const end=src.indexOf("// ───",start);
  assert.ok(start>=0,"audit emitter missing");
  assert.ok(src.includes('PAPER_LEDGER_EVIDENCE'));
  assert.ok(src.includes('if (!CONFIG.paperTrading) return;'));
  assert.ok(src.includes('setInterval(logPaperLedgerEvidence, 60 * 60 * 1000)'));
  assert.ok(!src.slice(start,start+1300).includes("saveLog("));
  assert.ok(!src.slice(start,start+1300).includes("writeFileSync("));
});
