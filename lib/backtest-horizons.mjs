/**
 * Read-only research lookback planning. Defines the maximum historical
 * public GET requests for a given candle interval; never opens orders.
 */
export const HORIZON_DAYS = Object.freeze([30, 90, 180, 365]);
const BAR_MS = Object.freeze({
  "6Hutc": 6*60*60*1000,
  "4h": 4*60*60*1000,
  "1Dutc": 24*60*60*1000,
  "1Wutc": 7*24*60*60*1000,
});
export function historyPageBudget(granularity, minimumTs, cutoff, limit = 200) {
  const interval = BAR_MS[granularity];
  if (!interval || !Number.isSafeInteger(minimumTs) || !Number.isSafeInteger(cutoff)
    || cutoff <= minimumTs || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("INVALID_PUBLIC_HISTORY_WINDOW");
  }
  const bars = Math.ceil((cutoff - minimumTs) / interval);
  // Keep extra pages for the warmup, closed-candle cut-off and a sparse page.
  return Math.min(25, Math.ceil(bars / limit) + 3);
}
