/**
 * Backtest — replays historical candles bar by bar using the same
 * indicator logic as bot.js (no Claude API calls, rule-based only).
 *
 * Usage:
 *   node backtest.js                  — test all symbols, 1H, 500 bars
 *   node backtest.js BTCUSDT          — single symbol
 *   node backtest.js BTCUSDT 4H 1000  — custom timeframe + bar count
 */

import "dotenv/config";
import { writeFileSync } from "fs";

const SYMBOL    = process.argv[2] || null;
const TIMEFRAME = process.argv[3] || "15m";
const LIMIT     = parseInt(process.argv[4] || "500");
const SAVE      = process.argv.includes("--save");

const SYMBOLS = SYMBOL
  ? [SYMBOL.toUpperCase()]
  : (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,AXSUSDT,ADAUSDT,XRPUSDT")
      .split(",").map(s => s.trim().toUpperCase());

const TRADE_SIZE_USD  = parseFloat(process.env.MAX_TRADE_SIZE_USD || "2");
const FEE_PCT         = 0.001; // 0.1% taker fee each way
const TRAIL_PCT       = 0.02;  // 2% trailing stop

// ─── Market Data ─────────────────────────────────────────────────────────────

const INTERVAL_MAP = { "1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1H":"1h","4H":"4h","1D":"1day","1W":"1week" };

async function fetchCandles(symbol, interval, limit) {
  const granularity = INTERVAL_MAP[interval] || "1h";
  const perPage = 1000;
  const pages = Math.ceil(limit / perPage);
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

// ─── Indicators (identical to bot.js) ────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * mult + ema * (1 - mult);
  return ema;
}

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

function calcVWAP(candles) {
  const w = candles.slice(-20);
  const cumVol = w.reduce((s, c) => s + c.volume, 0);
  if (cumVol === 0) return null;
  return w.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0) / cumVol;
}

function calcVolume(candles) {
  const recent = candles.slice(-20);
  const avg = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  return { current: candles[candles.length - 1].volume, avg, aboveAvg: candles[candles.length - 1].volume > avg };
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
  return { macdLine, signal, histogram, bullish: histogram > 0 };
}

function calcBB(closes) {
  if (closes.length < 20) return null;
  const slice = closes.slice(-20);
  const mid = slice.reduce((a, b) => a + b, 0) / 20;
  const std = Math.sqrt(slice.reduce((s, c) => s + Math.pow(c - mid, 2), 0) / 20);
  const upper = mid + 2 * std, lower = mid - 2 * std;
  const price = closes[closes.length - 1];
  return { upper, mid, lower, pct: (price - lower) / (upper - lower) };
}

// ─── Entry Signal (mirrors safety check in bot.js) ───────────────────────────

function shouldEnter(candles) {
  if (candles.length < 50) return { enter: false, reason: "not enough data" };

  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const ema8   = calcEMA(closes, 8);
  const ema21  = calcEMA(closes, 21);
  const vwap   = calcVWAP(candles);
  const rsi3   = calcRSI(closes, 3);
  const vol    = calcVolume(candles);
  const adx    = calcADX(candles);
  const macd   = calcMACD(closes);
  const bb     = calcBB(closes);

  if (!ema8 || !ema21 || !vwap || rsi3 === null) return { enter: false, reason: "indicators not ready" };

  const distVwap = Math.abs((price - vwap) / vwap) * 100;

  // Core mandatory conditions (must all pass)
  const core = [
    { pass: price > vwap,      label: "price > VWAP" },
    { pass: price > ema8,      label: "price > EMA8" },
    { pass: ema8 > ema21,      label: "EMA8 > EMA21 uptrend" },
    { pass: rsi3 < 35,         label: "RSI3 < 35 (oversold)" },
    { pass: distVwap < 2.0,    label: "within 2% of VWAP" },
  ];

  const coreFailed = core.filter(c => !c.pass).map(c => c.label);
  if (coreFailed.length > 0) return { enter: false, reason: `core failed: ${coreFailed.join(", ")}` };

  // Soft confirmation — at least 2 of 4 must pass
  const soft = [
    { pass: vol.aboveAvg,      label: "volume above avg" },
    { pass: adx?.trending,     label: "ADX > 25" },
    { pass: macd?.bullish,     label: "MACD bullish" },
    { pass: bb ? bb.pct < 0.5 : false, label: "BB% < 50" },
  ];
  const softPassed = soft.filter(c => c.pass).length;
  if (softPassed < 2) return { enter: false, reason: `soft signals: only ${softPassed}/4 passed` };

  return { enter: true, reason: `core ✅ + ${softPassed}/4 soft signals`, price, ema8, vwap, rsi3 };
}

// ─── Exit Signal ─────────────────────────────────────────────────────────────

function shouldExit(candles, position) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const ema8   = calcEMA(closes, 8);
  const vwap   = calcVWAP(candles);
  const rsi3   = calcRSI(closes, 3);
  const macd   = calcMACD(closes);
  const bb     = calcBB(closes);

  const newHigh = Math.max(price, position.highWatermark);
  const trailingStop = newHigh * (1 - TRAIL_PCT);

  const reasons = [];
  if (rsi3 > 70)                          reasons.push("RSI3 > 70");
  if (price < vwap && price < ema8)       reasons.push("trend reversed");
  if (price < trailingStop)               reasons.push(`trailing stop (${(TRAIL_PCT*100)}% from peak)`);
  if (macd && !macd.bullish)              reasons.push("MACD bearish");
  if (bb && bb.pct > 0.9)                 reasons.push("BB% > 90 (overbought)");

  return { exit: reasons.length > 0, reasons, newHigh, price };
}

// ─── Backtest Engine ─────────────────────────────────────────────────────────

function backtest(symbol, allCandles) {
  const trades   = [];
  let   position = null;
  const MIN_BARS = 50;

  for (let i = MIN_BARS; i < allCandles.length; i++) {
    const candles = allCandles.slice(0, i + 1);
    const price   = candles[candles.length - 1].close;

    if (position) {
      const { exit, reasons, newHigh, price: exitPrice } = shouldExit(candles, position);
      position.highWatermark = newHigh;

      if (exit) {
        const quantity  = TRADE_SIZE_USD / position.entryPrice;
        const exitValue = quantity * exitPrice;
        const entryFee  = TRADE_SIZE_USD * FEE_PCT;
        const exitFee   = exitValue * FEE_PCT;
        const grossPnl  = exitValue - TRADE_SIZE_USD;
        const netPnl    = grossPnl - entryFee - exitFee;
        const pnlPct    = (exitPrice - position.entryPrice) / position.entryPrice * 100;
        const barsHeld  = i - position.entryBar;

        trades.push({
          entryTime:  new Date(position.entryTime).toISOString().slice(0, 16),
          exitTime:   new Date(candles[candles.length - 1].time).toISOString().slice(0, 16),
          entryPrice: position.entryPrice,
          exitPrice,
          pnlPct,
          netPnl,
          barsHeld,
          exitReasons: reasons,
          win: netPnl > 0,
        });

        position = null;
      }
    } else {
      const { enter, reason, price: entryPrice } = shouldEnter(candles);
      if (enter) {
        position = {
          entryPrice,
          entryTime: candles[candles.length - 1].time,
          entryBar:  i,
          highWatermark: entryPrice,
        };
      }
    }
  }

  return trades;
}

// ─── Report ───────────────────────────────────────────────────────────────────

function report(symbol, trades, candles) {
  if (trades.length === 0) {
    console.log(`\n${symbol}: No trades triggered in ${candles.length} bars.`);
    return null;
  }

  const wins      = trades.filter(t => t.win);
  const losses    = trades.filter(t => !t.win);
  const winRate   = (wins.length / trades.length * 100).toFixed(1);
  const totalPnl  = trades.reduce((s, t) => s + t.netPnl, 0);
  const avgWin    = wins.length    ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length       : 0;
  const avgLoss   = losses.length  ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length   : 0;
  const bestTrade = trades.reduce((b, t) => t.pnlPct > b.pnlPct ? t : b, trades[0]);
  const worstTrade= trades.reduce((b, t) => t.pnlPct < b.pnlPct ? t : b, trades[0]);
  const avgBars   = (trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length).toFixed(1);

  // Max drawdown — running equity curve
  let peak = 0, maxDD = 0, equity = 0;
  for (const t of trades) {
    equity += t.netPnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const profitFactor = losses.length && Math.abs(losses.reduce((s,t)=>s+t.netPnl,0)) > 0
    ? (wins.reduce((s,t)=>s+t.netPnl,0) / Math.abs(losses.reduce((s,t)=>s+t.netPnl,0))).toFixed(2)
    : "∞";

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ${symbol}  |  ${TIMEFRAME}  |  ${candles.length} bars  |  $${TRADE_SIZE_USD} per trade
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Trades:        ${trades.length}  (${wins.length}W / ${losses.length}L)
  Win rate:      ${winRate}%
  Total P&L:     $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)}
  Profit factor: ${profitFactor}
  Avg win:       +${avgWin.toFixed(2)}%
  Avg loss:      ${avgLoss.toFixed(2)}%
  Max drawdown:  $${maxDD.toFixed(4)}
  Avg hold:      ${avgBars} bars

  Best trade:    +${bestTrade.pnlPct.toFixed(2)}%  (entry ${bestTrade.entryTime}, exit ${bestTrade.exitReasons.join(", ")})
  Worst trade:   ${worstTrade.pnlPct.toFixed(2)}%  (entry ${worstTrade.entryTime}, exit ${worstTrade.exitReasons.join(", ")})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (trades.length <= 20) {
    console.log("\n  All trades:");
    for (const t of trades) {
      const icon = t.win ? "✅" : "❌";
      console.log(`  ${icon}  ${t.entryTime} → ${t.exitTime}  |  entry $${t.entryPrice.toFixed(4)}  exit $${t.exitPrice.toFixed(4)}  |  ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%  ($${t.netPnl >= 0 ? "+" : ""}${t.netPnl.toFixed(4)})  |  ${t.barsHeld} bars  |  ${t.exitReasons.join(", ")}`);
    }
  }

  return {
    symbol,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat(winRate),
    totalPnl: parseFloat(totalPnl.toFixed(4)),
    profitFactor,
    avgWinPct: parseFloat(avgWin.toFixed(2)),
    avgLossPct: parseFloat(avgLoss.toFixed(2)),
    updatedAt: new Date().toISOString().slice(0, 10),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Multi-timeframe mode: test each TF and keep the best result per coin
const MULTI_TF = process.argv.includes("--multi");
const TEST_TIMEFRAMES = MULTI_TF ? ["5m", "15m", "30m", "1H"] : [TIMEFRAME];
const TF_LIMITS = { "5m": 2000, "15m": 1000, "30m": 1000, "1H": 500, "4H": 200 };

console.log(`\n🔬 Backtest — ${MULTI_TF ? "MULTI-TF (5m/15m/30m/1H)" : TIMEFRAME} | up to ${LIMIT} bars | $${TRADE_SIZE_USD}/trade | Fee: ${FEE_PCT*100}%`);
console.log(`   Symbols: ${SYMBOLS.join(", ")}\n`);

const summaries = [];

for (const symbol of SYMBOLS) {
  let bestSummary = null;

  for (const tf of TEST_TIMEFRAMES) {
    const barLimit = MULTI_TF ? (TF_LIMITS[tf] || 500) : LIMIT;
    process.stdout.write(`Fetching ${symbol} ${tf}...`);
    try {
      const candles = await fetchCandles(symbol, tf, barLimit);
      process.stdout.write(` ${candles.length} bars`);
      const trades  = backtest(symbol, candles);
      const summary = report(symbol, trades, candles);
      if (summary) {
        summary.timeframe = tf;
        if (!bestSummary || summary.totalPnl > bestSummary.totalPnl) {
          bestSummary = summary;
        }
        process.stdout.write(` → WR ${summary.winRate}% P&L $${summary.totalPnl >= 0 ? "+" : ""}${summary.totalPnl.toFixed(4)}\n`);
      } else {
        process.stdout.write(` → no trades\n`);
      }
    } catch (err) {
      process.stdout.write(` ❌ ${err.message}\n`);
    }
  }

  if (bestSummary) {
    summaries.push(bestSummary);
    if (MULTI_TF) console.log(`  ⭐ Best TF for ${symbol}: ${bestSummary.timeframe} (WR ${bestSummary.winRate}% P&L $${bestSummary.totalPnl >= 0 ? "+" : ""}${bestSummary.totalPnl.toFixed(4)})\n`);
  }
}

if (summaries.length > 1) {
  console.log(`\n${"═".repeat(54)}`);
  console.log(`  SUMMARY — all ${summaries.length} symbols`);
  console.log(`${"═".repeat(54)}`);
  const totalPnl = summaries.reduce((s, r) => s + r.totalPnl, 0);
  const avgWR    = (summaries.reduce((s, r) => s + r.winRate, 0) / summaries.length).toFixed(1);
  for (const s of summaries) {
    const icon = s.totalPnl >= 0 ? "✅" : "❌";
    console.log(`  ${icon}  ${s.symbol.padEnd(10)} WR ${s.winRate}%  P&L $${s.totalPnl >= 0 ? "+" : ""}${s.totalPnl.toFixed(4)}  PF ${s.profitFactor}  (${s.trades} trades)`);
  }
  console.log(`${"─".repeat(54)}`);
  console.log(`  Average win rate:  ${avgWR}%`);
  console.log(`  Total P&L:         $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)}`);
  console.log(`${"═".repeat(54)}\n`);

  if (SAVE) {
    const out = {};
    for (const s of summaries) out[s.symbol] = s;
    writeFileSync("backtest_results.json", JSON.stringify(out, null, 2));
    console.log(`✅ Results saved to backtest_results.json\n`);
  }
}
