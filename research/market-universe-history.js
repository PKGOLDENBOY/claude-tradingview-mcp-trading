// Research-only market universe and history coverage helpers.
// No exchange credentials, private endpoints, trading or deployment.
export const TEN_YEARS_DAYS = 3653;
export const DEFAULT_QUOTES = Object.freeze(["USDT", "USDC"]);
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

export function normalizeSpotSymbols(records, {quotes = DEFAULT_QUOTES} = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const allowed = new Set(quotes.map(x => String(x).toUpperCase()));
  const result = [];
  const seen = new Set();
  for (const row of records) {
    if (!row || typeof row !== "object") continue;
    const symbol = String(row.symbol ?? "").toUpperCase();
    const quote = String(row.quoteCoin ?? row.quoteAsset ?? "").toUpperCase();
    const base = String(row.baseCoin ?? row.baseAsset ?? "").toUpperCase();
    const status = String(row.status ?? "").toLowerCase();
    // Only explicitly tradable SPOT symbols; do not assume absent status is safe.
    if (!symbol || !base || !allowed.has(quote) ||
        !["online", "trading", "normal", "active"].includes(status) ||
        seen.has(symbol)) continue;
    seen.add(symbol);
    result.push({symbol, base, quote, status});
  }
  return result.sort((a,b) => a.symbol.localeCompare(b.symbol));
}

export function planHistoryWindows({symbol, firstAvailableMs, nowMs, maxCandlesPerRequest = 200, yearsDays = TEN_YEARS_DAYS}) {
  if (!symbol || !Number.isFinite(firstAvailableMs) || !Number.isFinite(nowMs) ||
      !Number.isInteger(maxCandlesPerRequest) || maxCandlesPerRequest < 1 ||
      !Number.isInteger(yearsDays) || yearsDays < 1) throw new TypeError("Invalid history parameters");
  const lastClosedHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS - HOUR_MS;
  const earliestRequested = Math.max(firstAvailableMs, nowMs - yearsDays * DAY_MS);
  const firstHour = Math.ceil(earliestRequested / HOUR_MS) * HOUR_MS;
  if (firstHour > lastClosedHour) return [];
  const windows = [];
  for (let startMs = firstHour; startMs <= lastClosedHour; startMs += maxCandlesPerRequest * HOUR_MS) {
    const endMs = Math.min(lastClosedHour, startMs + (maxCandlesPerRequest - 1) * HOUR_MS);
    windows.push({symbol, startMs, endMs, expectedHours: (endMs - startMs) / HOUR_MS + 1});
  }
  return windows;
}

export function auditHourlyCandles(rows, {startMs, endMs}) {
  if (!Array.isArray(rows) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new TypeError("Invalid candles or bounds");
  const timestamps = new Set();
  let duplicates = 0, invalid = 0, outside = 0;
  for (const row of rows) {
    const t = Number(Array.isArray(row) ? row[0] : row?.timestamp);
    if (!Number.isFinite(t) || t % HOUR_MS !== 0) {invalid++; continue;}
    if (t < startMs || t > endMs) {outside++; continue;}
    if (timestamps.has(t)) duplicates++;
    timestamps.add(t);
  }
  const expected = Math.max(0, Math.floor((endMs - startMs) / HOUR_MS) + 1);
  return {expected, unique: timestamps.size, missing: Math.max(0, expected - timestamps.size), duplicates, invalid, outside};
}
