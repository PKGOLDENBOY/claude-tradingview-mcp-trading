import test from "node:test";
import assert from "node:assert/strict";
import { entrySafety, exitThresholdReason, spreadBps, STOP_REENTRY_COOLDOWN_MS } from "../lib/shadow-execution-safety.mjs";
import { mapTickerQuotes, positionPnl } from "../scripts/market-shadow-test.mjs";

// Regression: a newly listed, illiquid market can print an apparently stable
// last trade while its executable bid is catastrophically lower.
test("wide spread rejects the RMSGK-style entry even when last trade appears stable", () => {
  const quote = { lastPr: "384.77439", askPr: "384.77439", bidPr: "198.5" };
  assert.ok(spreadBps(quote) > 30);
  assert.deepEqual(entrySafety(quote, null, Date.UTC(2026, 9, 27)), {
    allowed: false, reason: "spread-too-wide"
  });
});

test("missing or crossed quotes fail closed", () => {
  for (const quote of [null, {}, { bidPr: "0", askPr: "100" },
    { bidPr: "101", askPr: "100" }, { bidPr: "NaN", askPr: "100" }]) {
    assert.equal(entrySafety(quote, null).allowed, false);
  }
});

test("post-stop cooldown persists for its full interval, then expires", () => {
  const now = Date.UTC(2026, 9, 27, 11, 8);
  const quote = { bidPr: "100", askPr: "100.01" };
  assert.equal(entrySafety(quote, now - STOP_REENTRY_COOLDOWN_MS + 1, now).reason, "post-stop-cooldown");
  assert.equal(entrySafety(quote, now - STOP_REENTRY_COOLDOWN_MS, now).allowed, true);
});

test("executable net loss triggers stop even when last price does not", () => {
  const entryCost = 100.1;
  const executableNetPnl = -48.3836;
  assert.equal(exitThresholdReason(executableNetPnl, entryCost, { stop: 0.03, tp: 0.06 }), "STOP");
});

test("live quote mapping preserves executable bid when last trade is unavailable", () => {
  const feed = [{ symbol: "RMSGKUSDT", bidPr: "85.8", askPr: "100" }];
  const quote = mapTickerQuotes(feed).get("RMSGKUSDT");
  assert.ok(quote);
  const position = {quantity:1, entryPrice:100, totalCost:100.1, opened:Date.now()};
  assert.equal(exitThresholdReason(positionPnl(position,quote),position.totalCost,
    {stop:0.03,tp:0.06}), "STOP");
  assert.equal(mapTickerQuotes([{symbol:"NOT/A/PAIR",bidPr:"1"}]).size, 0);
});
