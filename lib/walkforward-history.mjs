/**
 * Fetch enough continuous CLOSED market candles for a genuine 23d train / 7d
 * out-of-sample walk-forward test. Public GET data only; fail closed on gaps.
 * This does not change signal thresholds or trading permissions.
 */
const BAR_MS = Object.freeze({
  "5m": 300000,
  "15m": 900000,
  "30m": 1800000,
  "1H": 3600000,
});
const DAY_MS = 86400000;

export async function fetchWalkForwardHistory(fetchPage, symbol, timeframe, opts = {}) {
  if (typeof fetchPage !== "function") throw new TypeError("fetchPage must be a function");
  const intervalMs = BAR_MS[timeframe];
  if (!intervalMs) throw new Error("Unsupported walk-forward timeframe: " + timeframe);
  const now = opts.now ?? Date.now();
  const trainingDays = 23, validationDays = 7, warmupBars = 30;
  const requiredBars = Math.ceil((trainingDays + validationDays) * DAY_MS / intervalMs) + warmupBars;
  const maxPages = Math.min(12, Math.ceil(requiredBars / 1000) + 2);
  const byTime = new Map();
  let oldest = null;

  for (let page = 0; page < maxPages && byTime.size < requiredBars; page++) {
    const endTime = oldest === null ? undefined : oldest - 1;
    const chunk = await fetchPage(symbol, timeframe, 1000,
      endTime === undefined ? { closedOnly: true } : { closedOnly: true, endTime });
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    let pageOldest = Infinity, additions = 0;
    for (const candle of chunk) {
      if (!candle || !Number.isSafeInteger(candle.time) ||
          (endTime !== undefined && candle.time > endTime) ||
          candle.time + intervalMs > now ||
          !Number.isFinite(candle.close) || candle.close <= 0) continue;
      pageOldest = Math.min(pageOldest, candle.time);
      if (!byTime.has(candle.time)) additions++;
      byTime.set(candle.time, candle);
    }
    if (!additions || !Number.isFinite(pageOldest) ||
        (oldest !== null && pageOldest >= oldest)) {
      throw new Error("WALK_FORWARD_HISTORY_STALLED: " + symbol + " " + timeframe + " page " + (page + 1) + " did not return older candles");
    }
    oldest = pageOldest;
    if (chunk.length < 2) break;
  }

  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (sorted.length < requiredBars) {
    throw new Error("WALK_FORWARD_INSUFFICIENT_HISTORY: " + symbol + " " + timeframe + " " + sorted.length + "/" + requiredBars + " closed bars (23d train + 7d OOS + warmup)");
  }
  const candles = sorted.slice(-requiredBars);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time - candles[i - 1].time !== intervalMs) {
      throw new Error("WALK_FORWARD_HISTORY_GAP: " + symbol + " " + timeframe + " between " + candles[i - 1].time + " and " + candles[i].time);
    }
  }
  // The last completed bar starts up to two intervals in the past.
  if (now - candles.at(-1).time > 2.5 * intervalMs) {
    throw new Error("WALK_FORWARD_STALE_HISTORY: " + symbol + " " + timeframe + " latest=" + candles.at(-1).time);
  }
  return candles;
}
