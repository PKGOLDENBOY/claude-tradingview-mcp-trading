/**
 * Backtest v2 — upgraded strategy with StochRSI, ATR trailing stop,
 * bullish divergence detection, and a score-gated entry system.
 *
 * Usage:
 *   node backtest.js                        — 19-coin watchlist, multi-TF
 *   node backtest.js BTCUSDT 1H 500         — single symbol
 *   node backtest.js "" 1H 1000 --multi     — multi-TF mode
 *   node backtest.js "" 1H 1000 --multi --save   — save to backtest_results.json
 *   node backtest.js "" 1H 500 --v1         — run original strategy for comparison
 */

import "dotenv/config";
import { writeFileSync, readFileSync, existsSync } from "fs";

const SYMBOL    = process.argv[2] || null;
const TIMEFRAME = process.argv[3] || "1H";
const LIMIT     = parseInt(process.argv[4] || "500");
const SAVE      = process.argv.includes("--save");
const USE_V1    = process.argv.includes("--v1");
const MULTI_TF  = process.argv.includes("--multi");

const SYMBOLS = SYMBOL
  ? [SYMBOL.toUpperCase()]
  : (process.env.SYMBOLS || "NEARUSDT,ETCUSDT,LDOUSDT,TIAUSDT,OPUSDT,ICPUSDT,APTUSDT,IMXUSDT,LINKUSDT,ORDIUSDT,INJUSDT,PENDLEUSDT,ZECUSDT,GALAUSDT,DYMUSDT,EGLDUSDT,ZILUSDT,JUPUSDT,NOTUSDT,APEUSDT,LUNCUSDT,IDUSDT,SUSHIUSDT")
      .split(",").map(s => s.trim().toUpperCase());

const TRADE_SIZE_USD = parseFloat(process.env.MAX_TRADE_SIZE_USD || "2");
const FEE_PCT        = 0.001;  // 0.1% taker fee each way

// ─── Market Data ─────────────────────────────────────────────────────────────

const INTERVAL_MAP = {
  "1m":"1min","3m":"3min","5m":"5min","15m":"15min",
  "30m":"30min","1H":"1h","4H":"4h","1D":"1day","1W":"1week"
};

async function fetchCandles(symbol, interval, limit) {
  const granularity = INTERVAL_MAP[interval] || "1h";
  const perPage = 1000;
  const pages   = Math.ceil(limit / perPage);
  let all = [];

  for (let p = 0; p < pages; p++) {
    const endTime = all.length > 0 ? all[0].time : undefined;
    const url = `https://api.bitget.com/api/v2/spot/market/candles?symbol=${symbol}&granularity=${granularity}&limit=${perPage}${endTime ? `&endTime=${endTime - 1}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== "00000") throw new Error(json.msg);
    if (!json.data || json.data.length === 0) break;
    const batch = json.data.map(k => ({
      time:   parseInt(k[0]),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    })).sort((a, b) => a.time - b.time);
    all = [...batch, ...all];
    if (json.data.length < perPage) break;
  }

  return all.slice(-limit);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * mult + ema * (1 - mult);
  return ema;
}

// Wilder-smoothed RSI series — accurate for StochRSI
function calcRSISeries(closes, period = 14) {
  if (closes.length < period + 2) return [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  const series = [avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    series.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return series;
}

// Simple RSI (last period bars) — used for entry/exit checks
function calcRSI(closes, period = 3) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / avgLoss);
}

// StochRSI(14, 3) — stochastic of the 14-period RSI over a 3-bar window
function calcStochRSI(closes) {
  const rsiSeries = calcRSISeries(closes, 14);
  if (rsiSeries.length < 3) return null;
  const window = rsiSeries.slice(-3);
  const minRSI = Math.min(...window);
  const maxRSI = Math.max(...window);
  const range  = maxRSI - minRSI;
  const k = range === 0 ? 50 : ((window[window.length - 1] - minRSI) / range) * 100;
  return { k, oversold: k < 20, overbought: k > 80 };
}

// ATR(14) — average true range over last 14 bars
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < recent.length; i++) {
    const { high, low } = recent[i];
    const pC = recent[i - 1].close;
    sum += Math.max(high - low, Math.abs(high - pC), Math.abs(low - pC));
  }
  return sum / period;
}

function calcVWAP(candles) {
  const w = candles.slice(-20);
  const cumVol = w.reduce((s, c) => s + c.volume, 0);
  if (cumVol === 0) return null;
  return w.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0) / cumVol;
}

function calcVolume(candles) {
  const recent = candles.slice(-20);
  const avg = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const current = candles[candles.length - 1].volume;
  return { current, avg, ratio: current / avg };
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const e12 = calcEMA(closes, 12);
  const e26 = calcEMA(closes, 26);
  const macdLine = e12 - e26;
  const macdSeries = closes.map((_, i) => {
    if (i < 26) return null;
    return calcEMA(closes.slice(0, i + 1), 12) - calcEMA(closes.slice(0, i + 1), 26);
  }).filter(Boolean);
  const signal = calcEMA(macdSeries, 9);
  const histogram = macdLine - signal;
  // Detect histogram turning positive (momentum shift)
  let prevHistogram = null;
  if (macdSeries.length >= 10) {
    const prevMacd = macdSeries[macdSeries.length - 2] - calcEMA(macdSeries.slice(0, -1), 9);
    prevHistogram = prevMacd;
  }
  const turningBullish = prevHistogram !== null && prevHistogram < 0 && histogram > 0;
  return { macdLine, signal, histogram, bullish: histogram > 0, turningBullish };
}

function calcBB(closes) {
  if (closes.length < 20) return null;
  const slice = closes.slice(-20);
  const mid = slice.reduce((a, b) => a + b, 0) / 20;
  const std = Math.sqrt(slice.reduce((s, c) => s + Math.pow(c - mid, 2), 0) / 20);
  const upper = mid + 2 * std, lower = mid - 2 * std;
  const price = closes[closes.length - 1];
  const pct = (upper === lower) ? 0.5 : (price - lower) / (upper - lower);
  return { upper, mid, lower, pct, width: (upper - lower) / mid };
}

function calcADX(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-(period + 1));
  let plusDM = 0, minusDM = 0, trSum = 0;
  for (let i = 1; i < recent.length; i++) {
    const { high, low } = recent[i];
    const { high: pH, low: pL, close: pC } = recent[i - 1];
    const up = high - pH, down = pL - low;
    plusDM  += up > down && up > 0 ? up : 0;
    minusDM += down > up && down > 0 ? down : 0;
    trSum   += Math.max(high - low, Math.abs(high - pC), Math.abs(low - pC));
  }
  if (trSum === 0) return null;
  const pDI = (plusDM / trSum) * 100;
  const mDI = (minusDM / trSum) * 100;
  const dx  = Math.abs(pDI - mDI) / (pDI + mDI) * 100;
  return { adx: dx, plusDI: pDI, minusDI: mDI, trending: dx > 25 };
}

// Bullish divergence: price made lower low, but RSI(3) made higher low
function detectBullishDivergence(candles) {
  if (candles.length < 20) return false;
  const recent = candles.slice(-20);
  const lows   = recent.map(c => c.low);
  const closes = recent.map(c => c.close);

  // Find local lows (valleys) in the last 20 bars
  const valleys = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] &&
        lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
      valleys.push(i);
    }
  }
  if (valleys.length < 2) return false;

  const prev = valleys[valleys.length - 2];
  const curr = valleys[valleys.length - 1];

  if (lows[curr] >= lows[prev]) return false; // no lower low in price

  const rsiPrev = calcRSI(closes.slice(0, prev + 1), 3);
  const rsiCurr = calcRSI(closes.slice(0, curr + 1), 3);
  if (rsiPrev === null || rsiCurr === null) return false;

  return rsiCurr > rsiPrev; // RSI higher low = divergence
}

// ─── Strategy V2 Entry ────────────────────────────────────────────────────────
// Score-gated: core filters must pass, then score >= 3 from confirmations

function shouldEnterV2(candles) {
  if (candles.length < 60) return { enter: false, reason: "not enough data" };

  const closes    = candles.map(c => c.close);
  const price     = closes[closes.length - 1];
  const ema8      = calcEMA(closes, 8);
  const ema21     = calcEMA(closes, 21);
  const vwap      = calcVWAP(candles);
  const rsi3      = calcRSI(closes, 3);
  const bb        = calcBB(closes);
  const macd      = calcMACD(closes);
  const vol       = calcVolume(candles);
  const stochRsi  = calcStochRSI(closes);
  const atr       = calcATR(candles);
  const divergence = detectBullishDivergence(candles);

  if (!ema8 || !ema21 || !vwap || rsi3 === null) return { enter: false, reason: "indicators not ready" };

  // ── Core hard gates (all must pass) ──
  if (price <= vwap)         return { enter: false, reason: "price ≤ VWAP" };
  if (price <= ema8)         return { enter: false, reason: "price ≤ EMA8" };
  if (ema8 <= ema21)         return { enter: false, reason: "EMA8 ≤ EMA21 (downtrend)" };
  if (rsi3 >= 35)            return { enter: false, reason: `RSI3 ${rsi3.toFixed(1)} ≥ 35` };

  // ── Confirmation scoring (need ≥ 2) ──
  let score = 0;
  const signals = [];

  // RSI depth — deeper = better quality entry
  if      (rsi3 < 12)  { score += 3; signals.push(`RSI3=${rsi3.toFixed(1)} extreme`); }
  else if (rsi3 < 20)  { score += 2; signals.push(`RSI3=${rsi3.toFixed(1)} very low`); }
  else if (rsi3 < 28)  { score += 1; signals.push(`RSI3=${rsi3.toFixed(1)}`); }
  // rsi3 28-35: 0 pts — needs full support from other signals

  // BB position — near lower band confirms oversold at support
  if      (bb && bb.pct < 0.15)    { score += 2; signals.push(`BB%=${bb.pct.toFixed(2)} extreme`); }
  else if (bb && bb.pct < 0.35)    { score += 1; signals.push(`BB%=${bb.pct.toFixed(2)}`); }

  // StochRSI oversold — momentum confirmation
  if (stochRsi?.oversold)           { score += 2; signals.push(`StochRSI=${stochRsi.k.toFixed(0)} oversold`); }

  // Volume surge — real buying interest
  if (vol.ratio >= 1.5)             { score += 1; signals.push(`vol ${vol.ratio.toFixed(1)}x`); }

  // MACD
  if (macd?.turningBullish)         { score += 2; signals.push("MACD turning bullish"); }
  else if (macd?.bullish)           { score += 1; signals.push("MACD bullish"); }

  // Bullish divergence — price lower low + RSI higher low
  if (divergence)                   { score += 3; signals.push("bullish divergence!"); }

  if (score < 2) return { enter: false, reason: `score ${score}/2 (${signals.join(", ") || "none"})` };

  return { enter: true, score, reason: `v2 score ${score} — ${signals.join(", ")}`, price, ema8, vwap, rsi3, atr };
}

// ─── Strategy V2 Exit ─────────────────────────────────────────────────────────

const ATR_TRAIL_MULT = 1.5;
const MIN_TRAIL_PCT  = 0.015;
const MAX_TRAIL_PCT  = 0.03;   // cap at 3% so high-ATR coins don't baghold
const MAX_HOLD_BARS  = 30;

function shouldExitV2(candles, position) {
  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  const ema8     = calcEMA(closes, 8);
  const vwap     = calcVWAP(candles);
  const rsi3     = calcRSI(closes, 3);
  const macd     = calcMACD(closes);
  const bb       = calcBB(closes);
  const stochRsi = calcStochRSI(closes);
  const atr      = calcATR(candles);

  const newHigh  = Math.max(price, position.highWatermark);
  const trailPct = atr
    ? Math.min(Math.max(ATR_TRAIL_MULT * atr / newHigh, MIN_TRAIL_PCT), MAX_TRAIL_PCT)
    : 0.02;
  const trailingStop = newHigh * (1 - trailPct);

  const reasons = [];
  if (rsi3 > 70)                      reasons.push("RSI3 > 70");
  if (stochRsi?.overbought)           reasons.push(`StochRSI=${stochRsi.k.toFixed(0)} overbought`);
  if (bb && bb.pct > 0.85)            reasons.push("BB% > 85");
  if (price < vwap && price < ema8)   reasons.push("trend reversed");
  if (price < trailingStop)           reasons.push(`ATR stop (${(trailPct * 100).toFixed(1)}%)`);
  if (macd && !macd.bullish)          reasons.push("MACD bearish");
  if (position.barsHeld >= MAX_HOLD_BARS) reasons.push(`max ${MAX_HOLD_BARS} bars`);

  return { exit: reasons.length > 0, reasons, newHigh, price, trailPct };
}

// ─── Strategy V1 (original — for comparison) ─────────────────────────────────

function shouldEnterV1(candles) {
  if (candles.length < 50) return { enter: false, reason: "not enough data" };
  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  const ema8     = calcEMA(closes, 8);
  const ema21    = calcEMA(closes, 21);
  const vwap     = calcVWAP(candles);
  const rsi3     = calcRSI(closes, 3);
  const vol      = calcVolume(candles);
  const adx      = calcADX(candles);
  const macd     = calcMACD(closes);
  const bb       = calcBB(closes);

  if (!ema8 || !ema21 || !vwap || rsi3 === null) return { enter: false, reason: "indicators not ready" };

  const distVwap = Math.abs((price - vwap) / vwap) * 100;

  const core = [
    { pass: price > vwap,     label: "price > VWAP" },
    { pass: price > ema8,     label: "price > EMA8" },
    { pass: ema8 > ema21,     label: "EMA8 > EMA21" },
    { pass: rsi3 < 35,        label: "RSI3 < 35" },
    { pass: distVwap < 2.0,   label: "within 2% VWAP" },
  ];
  const failed = core.filter(c => !c.pass);
  if (failed.length > 0) return { enter: false, reason: `core: ${failed.map(c => c.label).join(", ")}` };

  const soft = [
    { pass: vol.ratio >= 1,     label: "vol above avg" },
    { pass: adx?.trending,      label: "ADX > 25" },
    { pass: macd?.bullish,      label: "MACD bullish" },
    { pass: bb ? bb.pct < 0.5 : false, label: "BB% < 50" },
  ];
  const softPassed = soft.filter(s => s.pass).length;
  if (softPassed < 2) return { enter: false, reason: `only ${softPassed}/4 soft signals` };

  return { enter: true, reason: `v1 core ✅ + ${softPassed}/4 soft`, price, ema8, vwap, rsi3, atr: null };
}

const TRAIL_PCT_V1 = 0.02;

function shouldExitV1(candles, position) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const ema8   = calcEMA(closes, 8);
  const vwap   = calcVWAP(candles);
  const rsi3   = calcRSI(closes, 3);
  const macd   = calcMACD(closes);
  const bb     = calcBB(closes);

  const newHigh      = Math.max(price, position.highWatermark);
  const trailingStop = newHigh * (1 - TRAIL_PCT_V1);

  const reasons = [];
  if (rsi3 > 70)                       reasons.push("RSI3 > 70");
  if (price < vwap && price < ema8)    reasons.push("trend reversed");
  if (price < trailingStop)            reasons.push("trailing stop 2%");
  if (macd && !macd.bullish)           reasons.push("MACD bearish");
  if (bb && bb.pct > 0.9)              reasons.push("BB% > 90");

  return { exit: reasons.length > 0, reasons, newHigh, price, trailPct: TRAIL_PCT_V1 };
}

// ─── Backtest Engine ──────────────────────────────────────────────────────────

const shouldEnter = USE_V1 ? shouldEnterV1 : shouldEnterV2;
const shouldExit  = USE_V1 ? shouldExitV1  : shouldExitV2;

function backtest(symbol, allCandles) {
  const trades   = [];
  let   position = null;

  for (let i = 60; i < allCandles.length; i++) {
    const candles = allCandles.slice(0, i + 1);
    const price   = candles[candles.length - 1].close;

    if (position) {
      position.barsHeld = i - position.entryBar;
      const { exit, reasons, newHigh } = shouldExit(candles, position);
      position.highWatermark = newHigh;

      if (exit) {
        const quantity  = TRADE_SIZE_USD / position.entryPrice;
        const exitValue = quantity * price;
        const netPnl    = exitValue - TRADE_SIZE_USD - (TRADE_SIZE_USD + exitValue) * FEE_PCT;
        const pnlPct    = (price - position.entryPrice) / position.entryPrice * 100;

        trades.push({
          entryTime:   new Date(position.entryTime).toISOString().slice(0, 16),
          exitTime:    new Date(candles[candles.length - 1].time).toISOString().slice(0, 16),
          entryPrice:  position.entryPrice,
          exitPrice:   price,
          pnlPct,
          netPnl,
          barsHeld:    position.barsHeld,
          exitReasons: reasons,
          win:         netPnl > 0,
          entryReason: position.entryReason,
        });

        position = null;
      }
    } else {
      const { enter, reason, price: ep, atr } = shouldEnter(candles);
      if (enter) {
        position = {
          entryPrice:    ep,
          entryTime:     candles[candles.length - 1].time,
          entryBar:      i,
          highWatermark: ep,
          barsHeld:      0,
          entryReason:   reason,
          atr,
        };
      }
    }
  }

  return trades;
}

// ─── Report ───────────────────────────────────────────────────────────────────

function report(symbol, trades, candles, tf) {
  if (trades.length === 0) {
    process.stdout.write(` → no trades\n`);
    return null;
  }

  const wins    = trades.filter(t => t.win);
  const losses  = trades.filter(t => !t.win);
  const winRate = (wins.length / trades.length * 100).toFixed(1);
  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const avgWin  = wins.length   ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const avgBars = (trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length).toFixed(1);

  let peak = 0, maxDD = 0, equity = 0;
  for (const t of trades) {
    equity += t.netPnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const grossWins   = wins.length   ? wins.reduce((s, t) => s + t.netPnl, 0) : 0;
  const grossLosses = losses.length ? Math.abs(losses.reduce((s, t) => s + t.netPnl, 0)) : 0;
  const profitFactor = grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : "∞";

  const expectancy = totalPnl / trades.length;

  process.stdout.write(` → WR ${winRate}% P&L $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)}\n`);

  if (SYMBOLS.length === 1) {
    const best  = trades.reduce((b, t) => t.pnlPct > b.pnlPct ? t : b, trades[0]);
    const worst = trades.reduce((b, t) => t.pnlPct < b.pnlPct ? t : b, trades[0]);
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ${symbol}  |  ${tf}  |  ${candles.length} bars  |  $${TRADE_SIZE_USD}/trade  |  ${USE_V1 ? "v1" : "v2"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Trades:        ${trades.length}  (${wins.length}W / ${losses.length}L)
  Win rate:      ${winRate}%
  Total P&L:     $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)}
  Profit factor: ${profitFactor}
  Expectancy:    $${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(4)}/trade
  Avg win:       +${avgWin.toFixed(2)}%
  Avg loss:      ${avgLoss.toFixed(2)}%
  Max drawdown:  $${maxDD.toFixed(4)}
  Avg hold:      ${avgBars} bars

  Best trade:    +${best.pnlPct.toFixed(2)}%  (${best.entryTime} → ${best.exitReasons.join(", ")})
  Worst trade:   ${worst.pnlPct.toFixed(2)}%  (${worst.entryTime} → ${worst.exitReasons.join(", ")})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    if (trades.length <= 25) {
      console.log("\n  All trades:");
      for (const t of trades) {
        const icon = t.win ? "✅" : "❌";
        console.log(`  ${icon}  ${t.entryTime} → ${t.exitTime}  |  ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%  ($${t.netPnl >= 0 ? "+" : ""}${t.netPnl.toFixed(4)})  |  ${t.barsHeld}b  |  out: ${t.exitReasons.join(", ")}`);
      }
    }
  }

  return {
    symbol,
    trades:       trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      parseFloat(winRate),
    totalPnl:     parseFloat(totalPnl.toFixed(4)),
    profitFactor,
    avgWinPct:    parseFloat(avgWin.toFixed(2)),
    avgLossPct:   parseFloat(avgLoss.toFixed(2)),
    expectancy:   parseFloat(expectancy.toFixed(4)),
    maxDrawdown:  parseFloat(maxDD.toFixed(4)),
    updatedAt:    new Date().toISOString().slice(0, 10),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const TEST_TIMEFRAMES = MULTI_TF ? ["5m", "15m", "30m", "1H"] : [TIMEFRAME];
const TF_LIMITS = { "5m": 2000, "15m": 1000, "30m": 1000, "1H": 500, "4H": 200 };

console.log(`\n🔬 Backtest ${USE_V1 ? "v1 (original)" : "v2 (upgraded)"} — ${MULTI_TF ? "MULTI-TF" : TIMEFRAME} | $${TRADE_SIZE_USD}/trade | Fee ${FEE_PCT * 100}%`);
if (!USE_V1) console.log(`   v2 features: StochRSI + ATR stop + divergence + score gate`);
console.log(`   Symbols (${SYMBOLS.length}): ${SYMBOLS.join(", ")}\n`);

const summaries = [];
const existing  = SAVE && existsSync("backtest_results.json")
  ? JSON.parse(readFileSync("backtest_results.json", "utf8"))
  : {};

for (const symbol of SYMBOLS) {
  let bestSummary = null;

  for (const tf of TEST_TIMEFRAMES) {
    const barLimit = MULTI_TF ? (TF_LIMITS[tf] || 500) : LIMIT;
    process.stdout.write(`Fetching ${symbol} ${tf}...`);
    try {
      const candles = await fetchCandles(symbol, tf, barLimit);
      process.stdout.write(` ${candles.length} bars`);
      const trades  = backtest(symbol, candles);
      const summary = report(symbol, trades, candles, tf);
      if (summary) {
        summary.timeframe = tf;
        if (!bestSummary || summary.totalPnl > bestSummary.totalPnl) bestSummary = summary;
      }
    } catch (err) {
      process.stdout.write(` ❌ ${err.message}\n`);
    }
  }

  if (bestSummary) {
    summaries.push(bestSummary);
    if (MULTI_TF) {
      const icon = bestSummary.totalPnl >= 0 ? "⭐" : "❌";
      console.log(`  ${icon} Best TF for ${bestSummary.symbol}: ${bestSummary.timeframe} (WR ${bestSummary.winRate}% P&L $${bestSummary.totalPnl >= 0 ? "+" : ""}${bestSummary.totalPnl.toFixed(4)} PF ${bestSummary.profitFactor})\n`);
    }
  }
}

if (summaries.length > 1) {
  const totalPnl = summaries.reduce((s, r) => s + r.totalPnl, 0);
  const avgWR    = (summaries.reduce((s, r) => s + r.winRate, 0) / summaries.length).toFixed(1);
  const winners  = summaries.filter(s => s.totalPnl > 0).sort((a, b) => b.totalPnl - a.totalPnl);
  const losers   = summaries.filter(s => s.totalPnl <= 0).sort((a, b) => a.totalPnl - b.totalPnl);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY — ${summaries.length} symbols | Strategy: ${USE_V1 ? "v1" : "v2"}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`\n  ✅ WINNERS (${winners.length}):`);
  for (const s of winners) {
    console.log(`     ${s.symbol.padEnd(12)} WR ${String(s.winRate).padStart(5)}%  P&L $+${s.totalPnl.toFixed(4).padStart(7)}  PF ${s.profitFactor}  exp $${s.expectancy}/trade  (${s.trades}T, ${s.timeframe})`);
  }
  if (losers.length > 0) {
    console.log(`\n  ❌ LOSERS (${losers.length}):`);
    for (const s of losers) {
      console.log(`     ${s.symbol.padEnd(12)} WR ${String(s.winRate).padStart(5)}%  P&L $${s.totalPnl.toFixed(4).padStart(8)}  PF ${s.profitFactor}  (${s.trades}T, ${s.timeframe})`);
    }
  }
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Average win rate:  ${avgWR}%`);
  console.log(`  Total P&L:         $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)}`);
  console.log(`${"═".repeat(60)}\n`);

  if (SAVE) {
    const out = { ...existing };
    for (const s of summaries) out[s.symbol] = s;
    writeFileSync("backtest_results.json", JSON.stringify(out, null, 2));
    console.log(`✅ Results saved → backtest_results.json\n`);
  }
}
