// Public BitGet market candles: one shared scheduler and a bounded retry budget.
// GET-only module; it never touches credentials or order endpoints.
// The scheduler addresses bursts from simultaneous scalp/swing/timeframe scanners.
const timeframeMap = Object.freeze({
  "1m": ["1m", "1min", 60000],
  "3m": ["3m", "3min", 180000],
  "5m": ["5m", "5min", 300000],
  "15m": ["15m", "15min", 900000],
  "30m": ["30m", "30min", 1800000],
  "1H": ["1H", "1h", 3600000],
  "4H": ["4H", "4h", 14400000],
  "1D": ["1D", "1day", 86400000],
  "1W": ["1W", "1week", 604800000],
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const persistentCache = new Map();
let nextSlot = 0;
let throttleTail = Promise.resolve();

export function normaliseCandles(rows, opts = {}) {
  const now = opts.now ?? Date.now();
  const intervalMs = opts.intervalMs ?? 60000;
  const closedOnly = opts.closedOnly === true;
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter(r => Array.isArray(r) && r.length >= 6)
    .map(r => ({
      time: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
      low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
    }))
    .filter(c => Number.isFinite(c.time) && Number.isFinite(c.open) &&
       Number.isFinite(c.high) && Number.isFinite(c.low) &&
       Number.isFinite(c.close) && Number.isFinite(c.volume) &&
       c.open > 0 && c.close > 0 && c.low > 0 && c.high >= Math.max(c.open,c.close) &&
       c.low <= Math.min(c.open,c.close) && c.volume >= 0)
    .sort((a,b) => a.time - b.time);
  const dedup = [];
  for (const c of sorted) {
    if (closedOnly && c.time + intervalMs > now) continue;
    if (dedup.length && dedup[dedup.length - 1].time === c.time) dedup[dedup.length - 1] = c;
    else dedup.push(c);
  }
  return dedup;
}

export function createCandleClient(options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => Date.now());
  const pause = options.pause ?? sleep;
  const cache = options.cache ?? persistentCache;
  const spacingMs = options.spacingMs ?? 400; // 2.5 requests/second shared across symbols
  const cacheTtlMs = options.cacheTtlMs ?? 30000;
  const maxRetries = options.maxRetries ?? 2;
  const pending = new Map();
  // Serialize start times across all concurrent calls. No server-supplied delay ignored.
  async function waitForSlot() {
    const run = throttleTail.then(async () => {
      const delay = Math.max(0, nextSlot - now());
      if (delay) await pause(delay);
      nextSlot = now() + spacingMs;
    });
    throttleTail = run.catch(() => {});
    await run;
  }
  async function requestJSON(url) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await waitForSlot();
      try {
        const res = await fetcher(url, { method: "GET", signal: AbortSignal.timeout(12000) });
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= maxRetries) throw new Error("BitGet throttled/unavailable: HTTP " + res.status);
          const retryHeader = res.headers?.get?.("retry-after");
          const secs = Number(retryHeader);
          const ms = Number.isFinite(secs) && secs > 0 ? Math.min(15000, secs * 1000) : 750 * (2 ** attempt);
          await pause(ms);
          continue;
        }
        if (!res.ok) throw new Error("BitGet candles HTTP " + res.status);
        const json = await res.json();
        if (json.code !== "00000" || !Array.isArray(json.data)) {
          throw new Error("BitGet invalid candle payload: " + String(json.code ?? "no-code"));
        }
        return json.data;
      } catch (error) {
        if (attempt >= maxRetries || (!/fetch failed|timeout|aborted/i.test(error.message))) throw error;
        await pause(750 * (2 ** attempt));
      }
    }
    throw new Error("BitGet candle retry budget exhausted");
  }
  return async function marketCandles(symbol, timeframe, limit = 100, settings = {}) {
    if (!/^[A-Z0-9]{2,24}$/.test(symbol)) throw new Error("Invalid trading symbol");
    const tf = timeframeMap[timeframe];
    if (!tf) throw new Error("Unsupported timeframe " + timeframe);
    const count = Math.max(1, Math.min(1000, Number(limit) || 100));
    const key = symbol + ":" + timeframe + ":" + count + ":" + String(settings.closedOnly === true);
    const current = now();
    const hit = cache.get(key);
    if (hit && hit.expiry > current) return hit.candles;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const [v3, v2, intervalMs] = tf;
      const queryV3 = "https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=" +
        symbol + "&interval=" + v3 + "&limit=" + count;
      const queryV2 = "https://api.bitget.com/api/v2/spot/market/candles?symbol=" +
        symbol + "&granularity=" + v2 + "&limit=" + count;
      let rows;
      // V3 doesn't accept 1W; v2 handles weekly candles.
      if (timeframe === "1W") {
        rows = await requestJSON(queryV2);
      } else {
        try { rows = await requestJSON(queryV3); }
        catch (err) {
          // Back off instead of doubling requests after a 429 rate-limit response.
          if (/HTTP 429/.test(err.message)) throw err;
          try { rows = await requestJSON(queryV2); }
          catch (backup) { throw new Error("Both BitGet candle feeds failed: " + err.message + "; " + backup.message); }
        }
      }
      const candles = normaliseCandles(rows, { now: now(), intervalMs, closedOnly: settings.closedOnly });
      if (candles.length < 2) throw new Error("Not enough valid market candles: " + symbol);
      cache.set(key, { expiry: now() + cacheTtlMs, candles });
      if (cache.size > 2000) cache.clear();
      return candles;
    })();
    pending.set(key, work);
    try { return await work; }
    finally { if (pending.get(key) === work) pending.delete(key); }
  };
}

export const fetchMarketCandles = createCandleClient();
