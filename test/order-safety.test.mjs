import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {planSpotSellQuantity, confirmSpotSellFill, confirmZeroFillCancellation} from "../lib/order-safety.mjs";

test("requested half-position sell remains half, never full balance", () => {
  const p = planSpotSellQuantity({available:0.1, requested:0.05, precision:4});
  assert.equal(p.size,"0.0500"); assert.equal(p.quantity,0.05);
});
test("requested 30 percent swing sell remains 30 percent",()=>{
  assert.equal(planSpotSellQuantity({available:10,requested:3,precision:3}).size,"3.000");
});
test("full-balance sell is explicit when quantity is omitted",()=>{
  assert.equal(planSpotSellQuantity({available:1.234568,requested:null,precision:4}).size,"1.2345");
});
test("overselling is rejected instead of being silently clamped",()=>{
  assert.throws(()=>planSpotSellQuantity({available:0.08,requested:0.1,precision:6}),/exceeds available/);
});
test("reject invalid, negative and precision-below-dust quantities",()=>{
  for (const requested of [-1,0,NaN,Infinity]) {
    assert.throws(()=>planSpotSellQuantity({available:1,requested,precision:6}));
  }
  assert.throws(()=>planSpotSellQuantity({available:1,requested:0.000001,precision:3}));
  assert.throws(()=>planSpotSellQuantity({available:1,requested:0.5,precision:99}));
});
test("partial, canceled and unknown sells do not qualify as completed",()=>{
  for (const status of ["partially_filled","cancelled","live","new",null]) {
    assert.equal(confirmSpotSellFill({status,confirmedQty:0.5,requestedQty:1,precision:6}),false);
  }
  assert.equal(confirmSpotSellFill({status:"filled",confirmedQty:0.5,requestedQty:1,precision:6}),false);
  assert.equal(confirmSpotSellFill({status:"filled",confirmedQty:1,requestedQty:1,precision:6}),true);
});
test("only zero-fill cancellations authorize another action",()=>{
  assert.equal(confirmZeroFillCancellation({status:"cancelled",confirmedQty:0}),true);
  assert.equal(confirmZeroFillCancellation({status:"cancelled",confirmedQty:0.1}),false);
  assert.equal(confirmZeroFillCancellation({status:"filled",confirmedQty:0}),false);
});
test("bot live paths must wire up sell quantity, confirmations, hard stop and backtest deny",()=>{
  const src=readFileSync(new URL("../bot.js", import.meta.url),"utf8");
  assert.ok(src.includes("planSpotSellQuantity({"));
  assert.ok(src.includes("confirmSpotSellFill({"));
  assert.ok(src.includes("confirmZeroFillCancellation({"));
  assert.ok(src.includes("haltOnUnconfirmedSell("));
  assert.ok(src.includes('"BACKTEST_UNAVAILABLE: "'));
  assert.ok(src.includes('LIVE_TRADING_APPROVED === "true"'));
});
