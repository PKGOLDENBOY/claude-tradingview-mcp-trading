import test from "node:test";
import assert from "node:assert/strict";
import { fetchWalkForwardHistory, isFreshWalkForwardResult, splitWalkForwardWindow } from "../lib/walkforward-history.mjs";

const BAR = 900000;
const NOW = Date.UTC(2026, 9, 23, 15, 30);
const LAST = NOW - BAR;
const bars = Array.from({ length: 3200 }, (_, i) => ({
  time: LAST - (3199 - i) * BAR, open: 100, high: 101,
  low: 99, close: 100, volume: 20,
}));

function mockPage(log = []) {
  return async (_symbol, _tf, limit, settings) => {
    log.push({ limit, settings });
    return bars.filter(b => settings.endTime === undefined || b.time <= settings.endTime).slice(-limit);
  };
}

test("retrieves full 23d train + 7d OOS history with warmup", async () => {
  const calls = [];
  const result = await fetchWalkForwardHistory(mockPage(calls), "BTCUSDT", "15m", { now: NOW });
  assert.equal(result.length, 2910);
  assert.equal(result.at(-1).time, LAST);
  assert.equal(result.at(0).time, LAST - (2910 - 1) * BAR);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].settings.endTime, undefined);
  assert.equal(calls[1].settings.endTime, bars.at(-1000).time - 1);
  assert.equal(new Set(result.map(c => c.time)).size, 2910);
});

test("fails closed if the exchange ignores endTime pagination", async () => {
  const page = bars.slice(-1000);
  await assert.rejects(
    fetchWalkForwardHistory(async () => page, "BTCUSDT", "15m", { now: NOW }),
    /WALK_FORWARD_HISTORY_STALLED/,
  );
});

test("fails closed if history has gaps", async () => {
  const missing = bars.filter(x => x.time !== LAST - 180 * BAR);
  await assert.rejects(
    fetchWalkForwardHistory(async (_s, _tf, lim, settings) =>
      missing.filter(b => settings.endTime === undefined || b.time <= settings.endTime).slice(-lim),
      "BTCUSDT", "15m", { now: NOW }),
    /WALK_FORWARD_HISTORY_GAP/,
  );
});

test("fails closed on stale market candles", async () => {
  const past = bars.map(b => ({ ...b, time: b.time - 10 * BAR }));
  await assert.rejects(
    fetchWalkForwardHistory(async (_s, _tf, lim, settings) =>
      past.filter(b => settings.endTime === undefined || b.time <= settings.endTime).slice(-lim),
      "BTCUSDT", "15m", { now: NOW }),
    /WALK_FORWARD_STALE_HISTORY/,
  );
});

test("fails closed when there is insufficient historical data", async () => {
  const few = bars.slice(-1200);
  await assert.rejects(
    fetchWalkForwardHistory(async (_s, _tf, lim, settings) =>
      few.filter(b => settings.endTime === undefined || b.time <= settings.endTime).slice(-lim),
      "BTCUSDT", "15m", { now: NOW }),
    /WALK_FORWARD_INSUFFICIENT_HISTORY/,
  );
});

test("warmup is training-only; all 7 OOS days remain eligible for simulation", () => {
  const full = bars.slice(-2910);
  const { inSample, validationWithWarmup, oosSize, oosStartTime } = splitWalkForwardWindow(full, "15m");
  assert.equal(oosSize, 672);
  assert.equal(inSample.length, 2238); // 23d plus 30 indicators-only bars
  assert.equal(validationWithWarmup.length, 702);
  assert.equal(validationWithWarmup[0].time, inSample.at(-30).time);
  assert.equal(validationWithWarmup[30].time, oosStartTime);
  assert.equal(inSample.at(-1).time + BAR, oosStartTime);
  assert.equal(validationWithWarmup.at(-1).time, full.at(-1).time);
  assert.throws(() => splitWalkForwardWindow(full.slice(-1000), "15m"), /Invalid walk-forward/);
});

test("legacy cached backtests are never trusted as full-window OOS evidence", () => {
  const valid = { schemaVersion: 2, timeframe: "15m", oosDays: 7, historyBars: 2910,
    testedAt: new Date(NOW - 60000).toISOString(), recommendation: "TRADE" };
  assert.equal(isFreshWalkForwardResult(valid, "15m", NOW), true);
  assert.equal(isFreshWalkForwardResult({...valid, schemaVersion:1}, "15m", NOW), false);
  assert.equal(isFreshWalkForwardResult({...valid, historyBars:1000}, "15m", NOW), false);
  assert.equal(isFreshWalkForwardResult({...valid, oosDays:2.6}, "15m", NOW), false);
  assert.equal(isFreshWalkForwardResult({...valid, timeframe:"5m"}, "15m", NOW), false);
  assert.equal(isFreshWalkForwardResult({...valid, testedAt: new Date(NOW - 21*3600000).toISOString()}, "15m", NOW), false);
  assert.equal(isFreshWalkForwardResult({...valid, testedAt: new Date(NOW + 10000).toISOString()}, "15m", NOW), false);
});
