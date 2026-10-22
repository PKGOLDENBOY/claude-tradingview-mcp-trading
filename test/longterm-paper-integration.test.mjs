import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const bot=readFileSync(new URL("../bot.js",import.meta.url),"utf8");
const start=bot.indexOf("async function runLongTermPaperShadow() {");
const end=bot.indexOf("async function runLongTermPortfolio() {");
const shadow=bot.slice(start,end);
test("long-term adaptive shadow is present and opt-in only",()=>{
  assert.ok(start>0&&end>start);
  assert.ok(bot.includes('const LT_PAPER_SHADOW_ENABLED = process.env.LT_PAPER_SHADOW_ENABLED === "true";'));
  assert.ok(shadow.includes('if (!CONFIG.paperTrading || !LT_PAPER_SHADOW_ENABLED || EXCHANGE_WRITES_ALLOWED) return;'));
  assert.ok(bot.includes("if (CONFIG.paperTrading && LT_PAPER_SHADOW_ENABLED)"));
});
test("shadow path has no real exchange purchase or sale capability",()=>{
  for(const forbidden of ["placeOrder(","placeBitGetOrder(","requireExchangeWrites(","/trade/place-order","getBalance("]){
    assert.equal(shadow.includes(forbidden),false,forbidden);
  }
  assert.ok(shadow.includes('method: "GET"'));
  assert.ok(shadow.includes('fetchMarketCandles(sym, "1W", 56, { closedOnly: true })'));
  assert.ok(shadow.includes('fetchMarketCandles(sym, "1D", 210, { closedOnly: true })'));
  assert.ok(shadow.includes("buyLtPaper("));
  assert.ok(shadow.includes("manageLtPaperPositions("));
});
test("shadow uses an isolated durable paper-only ledger",()=>{
  assert.ok(shadow.includes('acct().logFile + ".lt-shadow.json"'));
  assert.ok(shadow.includes("JSON.parse(readFileSync(sourceFile"));
  assert.ok(shadow.includes('state?.mode !== "PUBLIC_MARKET_READ_ONLY_LONGTERM"'));
  assert.ok(shadow.includes('const temp = sourceFile + ".tmp"'));
  assert.ok(shadow.includes("renameSync(temp, sourceFile);"));
  assert.equal(shadow.includes("saveLog("),false);
  assert.ok(shadow.includes("lastEntryScanAt"));
  assert.ok(shadow.includes("state.lastStatus"));
});
test("adaptive mode refuses corrupted or missing market features",()=>{
  assert.ok(shadow.includes("Number.isFinite(regime?.volRatio) ? regime.volRatio : NaN"));
  assert.ok(shadow.includes("Number.isFinite(fearGreed?.value) ? fearGreed.value : NaN"));
  assert.ok(shadow.includes("if (failedFeeds <= 10 && picks.length > 0)"));
});
