import test from "node:test";
import assert from "node:assert/strict";
import { formatTradeSizeSummary } from "../lib/trade-size-report.mjs";

test("reports actual trade fraction rather than uncapped Kelly fraction", () => {
  assert.equal(formatTradeSizeSummary(10, 100), "$10.00 (10.0% of $100.00)");
  assert.equal(formatTradeSizeSummary(25, 100), "$25.00 (25.0% of $100.00)");
});

test("uses actual size for a capped trade and does not change sizing", () => {
  assert.equal(formatTradeSizeSummary(10, 200), "$10.00 (5.0% of $200.00)");
  assert.equal(formatTradeSizeSummary(2.345, 100), "$2.35 (2.3% of $100.00)");
});

test("handles invalid portfolio without division by zero", () => {
  assert.equal(formatTradeSizeSummary(10, 0), "$10.00 (0.0% of $0.00)");
  assert.equal(formatTradeSizeSummary(NaN, NaN), "$0.00 (0.0% of $0.00)");
});
