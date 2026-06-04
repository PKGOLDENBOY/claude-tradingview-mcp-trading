// Replicates bot's detectMarketRegime() and multi-day bear block exactly
const resp = await fetch("https://api.bitget.com/api/v2/spot/market/candles?symbol=BTCUSDT&granularity=4h&limit=60");
const d = await resp.json();

// BitGet returns oldest-first (ascending) — no reverse needed
const candles = d.data.map(c => ({ t: new Date(+c[0]).toISOString(), o: +c[1], close: +c[4] }));
const closes = candles.map(c => c.close);
const price = closes[closes.length - 1];

function ema(arr, n) {
  const k = 2 / (n + 1);
  let e = arr[0];
  for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

const ema8  = ema(closes, 8);
const ema21 = ema(closes, 21);

// Regime bear: ema8 < ema21 * 0.995
const regimeBear = ema8 < ema21 * 0.995;
const regimeBull = ema8 > ema21 * 1.005;
const regime = regimeBear ? "BEAR" : regimeBull ? "TRENDING" : "RANGING";

// How far EMA8 needs to move to cross EMA21 * 0.995 (neutral) or EMA21 * 1.005 (bull)
const neutralThreshold = ema21 * 0.995;
const bullThreshold    = ema21 * 1.005;
const gapToNeutral = neutralThreshold - ema8;  // negative = already above
const gapToBull    = bullThreshold - ema8;

// Multi-day bear block: btc3dayChange <= -6 AND 4H bearish (ema8 < ema21)
const open3d = candles[Math.max(0, candles.length - 18)].o;
const change3d = (price - open3d) / open3d * 100;
const fourHbearish = ema8 < ema21;
const multiDayBlock = change3d <= -6 && fourHbearish;

// Last 4H candle change (pump bypass threshold is +2%)
const last4hChange = (candles[candles.length-1].close - candles[candles.length-2].close) / candles[candles.length-2].close * 100;

console.log("═══════════════════════════════════════");
console.log(`  BTC price:   $${price.toFixed(0)}`);
console.log(`  4H EMA8:     $${ema8.toFixed(0)}`);
console.log(`  4H EMA21:    $${ema21.toFixed(0)}`);
console.log(`  Last 4H chg: ${last4hChange >= 0 ? "+" : ""}${last4hChange.toFixed(2)}%`);
console.log("");
console.log("── REGIME BEAR BLOCK (EMA-based) ──────");
console.log(`  Condition:   EMA8 < EMA21 × 0.995`);
console.log(`  Currently:   $${ema8.toFixed(0)} < $${(ema21*0.995).toFixed(0)} ? ${regimeBear}`);
console.log(`  Regime:      ${regime}`);
if (regimeBear) {
  console.log(`  Lifts when:  EMA8 rises $${gapToNeutral.toFixed(0)} to $${neutralThreshold.toFixed(0)} → RANGING`);
  console.log(`               EMA8 rises $${gapToBull.toFixed(0)} to $${bullThreshold.toFixed(0)} → TRENDING (full entries)`);
  const candlesNeeded = Math.ceil(gapToNeutral / (price * 0.005));
  console.log(`  Rough ETA:   ~${candlesNeeded} × 4H candles of sustained upward price`);
  console.log(`               ≈ ${(candlesNeeded * 4 / 24).toFixed(1)} days if BTC keeps rising`);
}
console.log("");
console.log("── MULTI-DAY BEAR BLOCK (3-day %) ─────");
console.log(`  3-day open:  $${open3d.toFixed(0)}  (${candles[Math.max(0, candles.length-18)].t})`);
console.log(`  3-day chg:   ${change3d.toFixed(2)}%  (blocks at <= -6%)`);
console.log(`  4H bearish:  ${fourHbearish}`);
console.log(`  Block active: ${multiDayBlock}`);
console.log("");
console.log("── RECENT 4H CANDLES ───────────────────");
candles.slice(-8).forEach(c => console.log(`  ${c.t}  $${c.close.toFixed(0)}`));
