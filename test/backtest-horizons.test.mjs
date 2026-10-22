import test from "node:test";
import assert from "node:assert/strict";
import { HORIZON_DAYS, historyPageBudget } from "../lib/backtest-horizons.mjs";

const DAY = 86400000;
test("all requested monthly research horizons are present", () => {
  assert.deepEqual(HORIZON_DAYS, [30, 90, 180, 365]);
});
test("365-day 6h public history has enough pages to reach the start date", () => {
  const cutoff = Date.parse("2026-10-20T00:00:00.000Z");
  assert.ok(historyPageBudget("6Hutc", cutoff - 367*DAY, cutoff, 200) >= 9);
  assert.ok(historyPageBudget("4h", cutoff - 377*DAY, cutoff, 200) >= 13);
  assert.ok(historyPageBudget("1Dutc", cutoff - 465*DAY, cutoff, 200) >= 6);
});
test("invalid or unrestricted public API requests fail closed", () => {
  assert.throws(() => historyPageBudget("1min", 0, DAY), /INVALID_PUBLIC_HISTORY_WINDOW/);
  assert.throws(() => historyPageBudget("6Hutc", DAY, 0), /INVALID_PUBLIC_HISTORY_WINDOW/);
  assert.throws(() => historyPageBudget("6Hutc", 0, DAY, 1000), /INVALID_PUBLIC_HISTORY_WINDOW/);
});
