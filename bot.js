/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import http from "http";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  // Cloud environments (Railway, etc.) inject vars directly — no .env file needed
  if (missing.length === 0) {
    const csvPath = new URL("trades.csv", import.meta.url).pathname;
    console.log(`\n📄 Trade log: ${csvPath}`);
    console.log(
      `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
        `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
    );
    return;
  }

  if (!existsSync(".env")) {
    // Local setup: create .env template for the user to fill in
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try { execSync("open .env"); } catch {}
    throw new Error(`No .env file — fill in your BitGet credentials and re-run: node bot.js`);
  }

  if (missing.length > 0) {
    try { execSync("open .env"); } catch {}
    throw new Error(`Missing credentials in .env: ${missing.join(", ")}`);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Backtest results — loaded once at startup ────────────────────────────
const BACKTEST = existsSync("backtest_results.json")
  ? JSON.parse(readFileSync("backtest_results.json", "utf8"))
  : {};

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols: (process.env.SYMBOLS || process.env.SYMBOL || "NEARUSDT,ETCUSDT,LDOUSDT,TIAUSDT,OPUSDT,ICPUSDT,APTUSDT,IMXUSDT,LINKUSDT,ORDIUSDT,INJUSDT,PENDLEUSDT,ZECUSDT,GALAUSDT,DYMUSDT,EGLDUSDT,ZILUSDT,JUPUSDT,NOTUSDT,APEUSDT,LUNCUSDT,IDUSDT,SUSHIUSDT")
    .replace(/^SYMBOLS=/i, "")
    .split(",")
    .map((s) => s.trim().toUpperCase()),
  timeframe: process.env.TIMEFRAME || "15m",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizePct: (() => { const v = process.env.MAX_TRADE_SIZE_USD || "25%"; return v.trim().endsWith("%") ? parseFloat(v) / 100 : null; })(),
  maxTradeSizeUSD: (() => { const v = process.env.MAX_TRADE_SIZE_USD || "25%"; return v.trim().endsWith("%") ? null : parseFloat(v); })(),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [], portfolioValue: CONFIG.portfolioValue, dayStartValue: CONFIG.portfolioValue, dayStartDate: new Date().toISOString().slice(0, 10) };
  const log = JSON.parse(readFileSync(LOG_FILE, "utf8"));
  // Reset day start value each new day
  const today = new Date().toISOString().slice(0, 10);
  if (!log.portfolioValue) log.portfolioValue = CONFIG.portfolioValue;
  if (log.dayStartDate !== today) {
    log.dayStartDate = today;
    log.dayStartValue = log.portfolioValue;
  }
  if (!log.dayStartValue) log.dayStartValue = log.portfolioValue;
  return log;
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// Win rate over last N closed trades (exits with P&L)
function calcWinRate(trades, n = 10) {
  const closed = trades.filter((t) => t.type === "exit" && t.pnlPct !== undefined);
  const recent = closed.slice(-n);
  if (recent.length < 3) return null; // not enough history
  const wins = recent.filter((t) => t.pnlPct > 0).length;
  return { winRate: wins / recent.length, sample: recent.length, wins };
}

// Daily drawdown — sum of realised losses today vs portfolio value
function checkDailyDrawdown(log) {
  const today = new Date().toISOString().slice(0, 10);
  const todayExits = log.trades.filter(
    (t) => t.type === "exit" && t.timestamp.startsWith(today) && t.pnlUSD !== undefined,
  );
  const totalLoss = todayExits.reduce((sum, t) => sum + Math.min(t.pnlUSD, 0), 0);
  const drawdownPct = Math.abs(totalLoss) / (log.portfolioValue || CONFIG.portfolioValue) * 100;
  const limit = 10; // 10% max daily loss
  return { drawdownPct, totalLoss, paused: drawdownPct >= limit, limit };
}

// Daily profit target — stop trading once we've hit the goal for the day
function checkDailyProfitTarget(log) {
  const startValue = log.dayStartValue || CONFIG.portfolioValue;
  const currentValue = log.portfolioValue || CONFIG.portfolioValue;
  const gainPct = ((currentValue - startValue) / startValue) * 100;
  const target = 50; // 50% daily target — stop and protect gains
  return { gainPct, startValue, currentValue, targetHit: gainPct >= target, target };
}

// Adaptive mode — automatically tightens strategy when losing
// normal   (win rate > 60%): full strategy
// cautious (40–60%):         Claude needs 80%+ confidence
// defensive(25–40%):         half position size + RSI < 20
// paused   (< 25%):          stop trading entirely
function getAdaptiveMode(trades) {
  const wr = calcWinRate(trades, 10);
  if (!wr) return { mode: "normal", label: "📊 Normal — not enough history yet", rsiThreshold: 30, confidenceMin: 0, sizeMultiplier: 1.0 };
  if (wr.winRate >= 0.60) return { mode: "normal",    label: `✅ Normal — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample})`,    rsiThreshold: 30, confidenceMin: 0,  sizeMultiplier: 1.0 };
  if (wr.winRate >= 0.40) return { mode: "cautious",  label: `⚠️  Cautious — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample})`,  rsiThreshold: 30, confidenceMin: 80, sizeMultiplier: 1.0 };
  if (wr.winRate >= 0.25) return { mode: "defensive", label: `🔴 Defensive — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample})`, rsiThreshold: 20, confidenceMin: 85, sizeMultiplier: 0.5 };
  return { mode: "paused", label: `🛑 Paused — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample}) too low`, rsiThreshold: 20, confidenceMin: 90, sizeMultiplier: 0 };
}

// ─── Market Data (BitGet public API — free, no auth) ────────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1min",
    "3m": "3min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "1H": "1h",
    "4H": "4h",
    "1D": "1day",
    "1W": "1week",
  };
  const granularity = intervalMap[interval] || "1h";

  const url = `https://api.bitget.com/api/v2/spot/market/candles?symbol=${symbol}&granularity=${granularity}&limit=${Math.min(limit, 1000)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BitGet market data error: ${res.status}`);
  const json = await res.json();
  if (json.code !== "00000") throw new Error(`BitGet API error: ${json.msg}`);

  // BitGet returns newest-first; reverse so index 0 = oldest
  return json.data.reverse().map((k) => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12 - ema26;
  // Signal line needs series — approximate with last 9 MACD values
  const macdSeries = closes.map((_, i) => {
    if (i < 26) return null;
    return calcEMA(closes.slice(0, i + 1), 12) - calcEMA(closes.slice(0, i + 1), 26);
  }).filter(Boolean);
  const signal = calcEMA(macdSeries, 9);
  const histogram = macdLine - signal;
  return { macdLine, signal, histogram, bullish: histogram > 0 };
}

function calcBollingerBands(closes, period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, c) => s + Math.pow(c - mid, 2), 0) / period);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  const price = closes[closes.length - 1];
  const pct = (price - lower) / (upper - lower); // 0 = at lower band, 1 = at upper band
  return { upper, mid, lower, pct, width: ((upper - lower) / mid) * 100 };
}

function calcADX(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-(period + 1));
  let plusDM = 0, minusDM = 0, trSum = 0;
  for (let i = 1; i < recent.length; i++) {
    const high = recent[i].high, low = recent[i].low;
    const prevHigh = recent[i-1].high, prevLow = recent[i-1].low, prevClose = recent[i-1].close;
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDM  += upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM += downMove > upMove && downMove > 0 ? downMove : 0;
    trSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  if (trSum === 0) return null;
  const plusDI  = (plusDM / trSum) * 100;
  const minusDI = (minusDM / trSum) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  return { adx: dx, plusDI, minusDI, trending: dx > 25 };
}

function detectCandlePatterns(candles) {
  const patterns = [];
  const n = candles.length;
  if (n < 3) return patterns;
  const [c2, c1, c0] = [candles[n-3], candles[n-2], candles[n-1]];
  const body0 = Math.abs(c0.close - c0.open);
  const body1 = Math.abs(c1.close - c1.open);
  const range0 = c0.high - c0.low;

  // Hammer — small body at top, long lower wick, bullish reversal
  const lowerWick0 = Math.min(c0.open, c0.close) - c0.low;
  if (body0 < range0 * 0.3 && lowerWick0 > body0 * 2 && c0.close > c0.open)
    patterns.push("Hammer (bullish reversal)");

  // Bullish engulfing — bearish candle followed by larger bullish candle
  if (c1.close < c1.open && c0.close > c0.open && c0.open < c1.close && c0.close > c1.open)
    patterns.push("Bullish Engulfing (strong reversal)");

  // Doji — open ≈ close, indecision
  if (body0 < range0 * 0.1)
    patterns.push("Doji (indecision — wait for confirmation)");

  // Shooting star — small body at bottom, long upper wick, bearish reversal
  const upperWick0 = c0.high - Math.max(c0.open, c0.close);
  if (body0 < range0 * 0.3 && upperWick0 > body0 * 2 && c0.close < c0.open)
    patterns.push("Shooting Star (bearish reversal)");

  // Morning star — bearish, doji/small, bullish
  const body2 = Math.abs(c2.close - c2.open);
  if (c2.close < c2.open && body1 < (c2.high - c2.low) * 0.3 && c0.close > c0.open && c0.close > (c2.open + c2.close) / 2)
    patterns.push("Morning Star (strong bullish reversal)");

  return patterns;
}

function calcSupportResistance(candles, lookback = 50) {
  const recent = candles.slice(-lookback);
  const highs = recent.map(c => c.high);
  const lows  = recent.map(c => c.low);
  const price = candles[candles.length - 1].close;

  // Find swing highs and lows (local extremes)
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].high > recent[i-1].high && recent[i].high > recent[i-2].high &&
        recent[i].high > recent[i+1].high && recent[i].high > recent[i+2].high)
      swingHighs.push(recent[i].high);
    if (recent[i].low < recent[i-1].low && recent[i].low < recent[i-2].low &&
        recent[i].low < recent[i+1].low && recent[i].low < recent[i+2].low)
      swingLows.push(recent[i].low);
  }

  const nearestResistance = swingHighs.filter(h => h > price).sort((a, b) => a - b)[0] || null;
  const nearestSupport    = swingLows.filter(l => l < price).sort((a, b) => b - a)[0] || null;
  const distToResistance  = nearestResistance ? ((nearestResistance - price) / price * 100) : null;
  const distToSupport     = nearestSupport    ? ((price - nearestSupport) / price * 100) : null;
  const nearSupport       = distToSupport !== null && distToSupport < 1.5;

  return { nearestResistance, nearestSupport, distToResistance, distToSupport, nearSupport };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Wilder-smoothed RSI series for StochRSI accuracy
function calcRSISeries(closes, period = 14) {
  if (closes.length < period + 2) return [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  const series = [avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    series.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return series;
}

// StochRSI(14,3) — stochastic of RSI over a 3-bar window
function calcStochRSI(closes) {
  const rsiSeries = calcRSISeries(closes, 14);
  if (rsiSeries.length < 3) return null;
  const window = rsiSeries.slice(-3);
  const minR = Math.min(...window), maxR = Math.max(...window);
  const range = maxR - minR;
  const k = range === 0 ? 50 : ((window[window.length - 1] - minR) / range) * 100;
  return { k, oversold: k < 20, overbought: k > 80 };
}

// ATR(14) — average true range
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

// Bullish divergence: price lower low + RSI(3) higher low
function detectBullishDivergence(candles) {
  if (candles.length < 20) return false;
  const recent = candles.slice(-20);
  const lows = recent.map(c => c.low);
  const closes = recent.map(c => c.close);
  const valleys = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      valleys.push(i);
  }
  if (valleys.length < 2) return false;
  const prev = valleys[valleys.length - 2], curr = valleys[valleys.length - 1];
  if (lows[curr] >= lows[prev]) return false;
  const rsiPrev = calcRSI(closes.slice(0, prev + 1), 3);
  const rsiCurr = calcRSI(closes.slice(0, curr + 1), 3);
  return rsiPrev !== null && rsiCurr !== null && rsiCurr > rsiPrev;
}

// VWAP — rolling 20-bar, stays close to current price action
function calcVWAP(candles) {
  const window = candles.slice(-20);
  if (window.length === 0) return null;
  const cumTPV = window.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const cumVol = window.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// Volume — average over last 20 bars
function calcVolume(candles) {
  const recent = candles.slice(-20);
  const avg = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const current = candles[candles.length - 1].volume;
  return { current, avg, aboveAvg: current > avg };
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules, rsiThreshold = 30, vol = null, ema21 = null, bullTrend4h = null, adx = null, stochRsi = null, divergence = false, bb = null) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback — threshold tightens in defensive mode
    check(
      `RSI(3) below ${rsiThreshold} (snap-back setup in uptrend)`,
      `< ${rsiThreshold}`,
      rsi3.toFixed(2),
      rsi3 < rsiThreshold,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 2.5% of VWAP (not overextended)",
      "< 2.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 2.5,
    );

    // 5. EMA(8) above EMA(21) — confirmed uptrend on entry timeframe
    if (ema21 !== null) {
      check(
        "EMA(8) above EMA(21) (uptrend confirmed)",
        `> ${ema21.toFixed(2)}`,
        ema8.toFixed(2),
        ema8 > ema21,
      );
    }

    // 6. Trend alignment — logged for Claude but NOT a hard block
    if (bullTrend4h !== null) {
      console.log(`  ℹ️  Trend context (not a hard gate): ${bullTrend4h ? "✅ bullish" : "⚠️  bearish — Claude must be 90%+ confident"}`);
    }

    // 7. Volume — soft signal only, Claude weighs it
    if (vol) {
      const volRatio = (vol.current / vol.avg).toFixed(1);
      console.log(`  ℹ️  Volume: ${vol.aboveAvg ? "✅ above avg" : "⚠️ below avg"} (${volRatio}x avg) — not a hard block`);
    }

    // 8. ADX — soft signal only
    if (adx !== null) {
      console.log(`  ℹ️  ADX: ${adx.adx.toFixed(2)} (${adx.trending ? "✅ trending" : "⚠️ choppy"}) — not a hard block`);
    }

    // 9. StochRSI — v2 confirmation signal
    if (stochRsi !== null) {
      console.log(`  ℹ️  StochRSI K=${stochRsi.k.toFixed(1)}: ${stochRsi.oversold ? "✅ oversold (<20)" : stochRsi.overbought ? "⚠️ overbought (>80)" : "neutral"}`);
    }

    // 10. Bullish divergence
    if (divergence) {
      console.log(`  ✅ Bullish divergence detected — price lower low, RSI higher low`);
    }

    // 11. BB position
    if (bb !== null) {
      console.log(`  ℹ️  BB%: ${bb.pct.toFixed(2)} (${bb.pct < 0.2 ? "✅ near lower band" : bb.pct > 0.8 ? "⚠️ near upper band" : "mid-range"})`);
    }

    // v2 entry score summary
    let score = 0;
    const scoreSignals = [];
    if (rsi3 < 12) { score += 3; scoreSignals.push("RSI extreme"); }
    else if (rsi3 < 20) { score += 2; scoreSignals.push("RSI very low"); }
    else if (rsi3 < 28) { score += 1; scoreSignals.push("RSI low"); }
    if (bb && bb.pct < 0.15) { score += 2; scoreSignals.push("BB% extreme"); }
    else if (bb && bb.pct < 0.35) { score += 1; scoreSignals.push("BB% low"); }
    if (stochRsi?.oversold) { score += 2; scoreSignals.push("StochRSI oversold"); }
    if (vol && vol.current / vol.avg >= 1.5) { score += 1; scoreSignals.push("vol surge"); }
    if (divergence) { score += 3; scoreSignals.push("divergence!"); }
    console.log(`  ℹ️  v2 Entry Score: ${score}/2+ needed — [${scoreSignals.join(", ") || "none"}]`);
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 2.5% of VWAP (not overextended)",
      "< 2.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 2.5,
    );
  } else {
    // Neutral bias — allow entry only if deeply oversold (RSI < 25), Claude decides
    if (rsi3 !== null && rsi3 < 25) {
      console.log(`  Bias: NEUTRAL but RSI(3)=${rsi3.toFixed(1)} deeply oversold — passing to Claude\n`);
      check("RSI(3) deeply oversold (< 25) in neutral market", "< 25", rsi3.toFixed(2), true);
    } else {
      console.log("  Bias: NEUTRAL — no clear direction, RSI not oversold enough. No trade.\n");
      results.push({ label: "Market bias", required: "Bullish/bearish or RSI < 25", actual: "Neutral", pass: false });
    }
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Exit Conditions ─────────────────────────────────────────────────────────

function checkExitConditions(position, price, ema8, vwap, rsi3, candles = null, stochRsi = null, bb = null) {
  const reasons = [];
  const pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;

  // ATR-based trailing stop (1.5x ATR, capped 1.5%–3%)
  const atr = candles ? calcATR(candles) : null;
  const newHigh = Math.max(price, position.highWatermark || position.entryPrice);
  const trailPct = atr
    ? Math.min(Math.max(1.5 * atr / newHigh, 0.015), 0.03)
    : 0.02;
  const trailingStop = newHigh * (1 - trailPct);

  // Break-even floor — once up 1%, stop floors at entry price
  const breakEvenActive = newHigh >= position.entryPrice * 1.01;
  const effectiveStop = breakEvenActive ? Math.max(trailingStop, position.entryPrice) : trailingStop;

  console.log("\n── Exit Check ───────────────────────────────────────────\n");
  console.log(`  Open LONG from $${position.entryPrice.toFixed(2)} | Now: $${price.toFixed(2)} | P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`);
  console.log(`  Peak: $${newHigh.toFixed(2)} | Stop: $${effectiveStop.toFixed(2)} (ATR ${(trailPct*100).toFixed(1)}%) | ${breakEvenActive ? "🔒 Break-even active" : "⏳ Waiting for +1%"}\n`);

  const check = (label, condition) => {
    console.log(`  ${condition ? "🔴" : "✅"} ${label}`);
    if (condition) reasons.push(label);
  };

  check(`RSI(3) overbought > 70 | Actual: ${rsi3.toFixed(2)}`, rsi3 > 70);
  if (stochRsi) check(`StochRSI overbought > 80 | K=${stochRsi.k.toFixed(1)}`, stochRsi.overbought);
  if (bb) check(`BB% > 0.85 (at upper band) | BB%=${bb.pct.toFixed(2)}`, bb.pct > 0.85);
  check(`Trend reversed — price below VWAP and EMA(8)`, price < vwap && price < ema8);
  check(`ATR stop hit — $${effectiveStop.toFixed(2)} (${breakEvenActive ? "break-even floor" : `${(trailPct*100).toFixed(1)}% trail`})`, price < effectiveStop);

  return { shouldExit: reasons.length > 0, reasons, newHigh };
}

// ─── Claude AI Analysis ──────────────────────────────────────────────────────

async function analyzeWithClaude(price, ema8, vwap, rsi3, recentTrades, position = null, tvSignal = null, extraIndicators = {}, symbol = null) {
  const hasPosition = position && position.open;
  const { ema21, macd, bb, adx, patterns, sr, bullTrend4h, vol } = extraIndicators;
  const bt = symbol && BACKTEST[symbol];
  const btLine = bt
    ? `\n- Backtest history (${bt.trades} trades, ${bt.updatedAt}): WR ${bt.winRate}% | P&L $${bt.totalPnl >= 0 ? "+" : ""}${bt.totalPnl} | Avg win +${bt.avgWinPct}% / Avg loss ${bt.avgLossPct}% | Profit factor ${bt.profitFactor}`
    : "";

  const systemPrompt = hasPosition
    ? `You are an expert crypto exit analyst for a spot trading bot. You hold a LONG position and must decide: EXIT (sell now) or HOLD (ride the trend).

Exit signals (weight all of them):
- RSI(3) > 70: overbought — lean EXIT
- Price below VWAP AND EMA(8): trend reversed — EXIT to protect capital
- MACD histogram turns negative: momentum fading — lean EXIT
- BB% > 0.85: price at upper Bollinger Band — extended, reversal risk
- Shooting Star or Doji after run-up: reversal candle warning
- Price within 0.5% of resistance: near ceiling — consider EXIT
- Trailing stop hit (2% from peak): hard EXIT

Hold signals:
- ADX > 25 and rising: strong trend — let it run
- MACD still positive and rising: momentum intact
- BB% 0.40–0.70: middle of range, room left
- Bullish pattern on recent candle

Risk rules (non-negotiable):
- Spot only — no shorting
- Max 20 trades/day | Portfolio ~$12 USD

Use trade history to calibrate: if similar setups reversed hard before, EXIT early; if they kept running, HOLD longer.

Respond ONLY with valid JSON:
{
  "action": "EXIT" or "HOLD",
  "confidence": <integer 0-100>,
  "reasoning": "<one sentence>",
  "key_factors": ["<factor>", "<factor>"]
}`
    : `You are an expert crypto entry analyst for a multi-indicator spot trading bot. Analyze ALL indicators and decide: BUY (enter long) or HOLD (wait for better setup).

Strong BUY conditions (more alignment = higher confidence):
- Price > VWAP AND > EMA(8): bullish bias confirmed
- Price > EMA(21): medium-term uptrend intact
- RSI(3) < 30: oversold snap-back in uptrend (ideal entry)
- MACD histogram positive: momentum building
- BB% < 0.30: price near lower Bollinger Band (mean reversion opportunity)
- ADX > 25: trending market (avoids choppy false signals)
- Bullish candle pattern (Hammer, Bullish Engulfing, Morning Star): reversal confirmation
- Price near support level (< 1.5% above support): demand zone entry
- 4H trend bullish: aligned with bigger picture
- Volume above average: conviction behind the move

Avoid:
- ADX < 20: choppy/ranging market — false signals likely
- Shooting Star or Doji: indecision or reversal
- BB% > 0.80: already extended to upper band
- Price near resistance: ceiling nearby limits upside

Risk rules (non-negotiable):
- Spot only — no shorting, no leverage
- Max position $2 USD | Max 20 trades/day | Portfolio ~$12 USD

Learn from history: if similar setups triggered losses, raise the bar. If they worked, trust the signals.

Respond ONLY with valid JSON:
{
  "action": "BUY" or "HOLD",
  "confidence": <integer 0-100>,
  "reasoning": "<one sentence>",
  "key_factors": ["<factor>", "<factor>"],
  "price_target": <number or null>,
  "stop_suggestion": <number or null>
}`;

  const recentHistory = recentTrades
    .slice(-15)
    .map((t) => {
      const outcome = t.orderPlaced ? "EXECUTED" : "BLOCKED";
      const rsi = t.indicators?.rsi3?.toFixed(1) ?? "?";
      const ep = t.price?.toFixed(2) ?? "?";
      const ev = t.indicators?.vwap?.toFixed(2) ?? "?";
      const ee = t.indicators?.ema8?.toFixed(2) ?? "?";
      const pnl = t.pnlPct !== undefined ? ` P&L:${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%` : "";
      return `${t.timestamp.slice(0, 16)} | $${ep} | RSI=${rsi} | EMA8=$${ee} | VWAP=$${ev} | ${outcome}${pnl}`;
    })
    .join("\n");

  const distVWAP = ((price - vwap) / vwap) * 100;
  const distEMA  = ((price - ema8) / ema8) * 100;

  const positionLine = hasPosition
    ? `\nOpen position: LONG from $${position.entryPrice.toFixed(2)} | qty: ${position.quantity} | Peak: $${(position.highWatermark || position.entryPrice).toFixed(2)} | P&L: ${(((price - position.entryPrice) / position.entryPrice) * 100).toFixed(2)}%`
    : "\nNo open position.";

  const tvLine = tvSignal ? `\nTradingView signal: ${tvSignal}` : "";

  const winRateData = calcWinRate(recentTrades, 10);
  const winRateLine = winRateData
    ? `\nRecent win rate: ${winRateData.wins}/${winRateData.sample} (${(winRateData.winRate * 100).toFixed(0)}%) — ${winRateData.winRate < 0.4 ? "⚠️ losing streak, be very conservative" : winRateData.winRate >= 0.7 ? "✅ hot streak, stay disciplined" : "📊 neutral"}`
    : "";

  const macdLine  = macd  ? `\n- MACD:       Line ${macd.macdLine.toFixed(4)} | Signal ${macd.signal.toFixed(4)} | Histogram ${macd.histogram.toFixed(4)} | ${macd.bullish ? "✅ Bullish" : "🔴 Bearish"}` : "";
  const bbLine    = bb    ? `\n- Bollinger:  Upper $${bb.upper.toFixed(2)} | Mid $${bb.mid.toFixed(2)} | Lower $${bb.lower.toFixed(2)} | BB% ${(bb.pct * 100).toFixed(1)}% | Width ${bb.width.toFixed(2)}%` : "";
  const adxLine   = adx   ? `\n- ADX:        ${adx.adx.toFixed(2)} (${adx.trending ? "✅ trending" : "⚠️ choppy"}) | +DI ${adx.plusDI.toFixed(1)} | -DI ${adx.minusDI.toFixed(1)}` : "";
  const patternsLine = patterns?.length ? `\n- Patterns:   ${patterns.join(", ")}` : "\n- Patterns:   None detected";
  const srLine    = sr    ? `\n- Support:    ${sr.nearestSupport ? `$${sr.nearestSupport.toFixed(2)} (${sr.distToSupport?.toFixed(2)}% below)` : "not found"} | Resistance: ${sr.nearestResistance ? `$${sr.nearestResistance.toFixed(2)} (${sr.distToResistance?.toFixed(2)}% above)` : "not found"}` : "";
  const trendLine = bullTrend4h !== undefined ? `\n- Trend (1H/4H): ${bullTrend4h ? "✅ Bullish — higher timeframe confirms" : "🔴 Bearish — counter-trend trade, only buy if setup is exceptional (RSI very low, strong volume, clear support). Reduce confidence by 15-20pts if uncertain."}` : "";
  const ema21Line = ema21 ? `\n- EMA(21):    $${ema21.toFixed(2)} (${ema8 > ema21 ? "✅ EMA8 above" : "🔴 EMA8 below"})` : "";
  const volLine   = vol   ? `\n- Volume:     ${vol.aboveAvg ? "✅ above avg" : "⚠️ below avg"} (${(vol.current / vol.avg * 100).toFixed(0)}% of 20-bar avg)` : "";

  const userMessage = `Current snapshot:
- Price:      $${price.toFixed(2)}
- EMA(8):     $${ema8.toFixed(2)} (${distEMA >= 0 ? "+" : ""}${distEMA.toFixed(2)}% vs price)${ema21Line}
- VWAP:       $${vwap.toFixed(2)} (${distVWAP >= 0 ? "+" : ""}${distVWAP.toFixed(2)}% vs price)
- RSI(3):     ${rsi3.toFixed(2)}${macdLine}${bbLine}${adxLine}${patternsLine}${srLine}${trendLine}${volLine}${btLine}${positionLine}${tvLine}${winRateLine}

Recent trade history (oldest → newest, last ${Math.min(recentTrades.length, 15)}):
${recentHistory || "No prior trades recorded."}

${hasPosition ? "EXIT or HOLD?" : "BUY or HOLD?"}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = response.content[0].text.trim();
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(text);
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const portfolio = log.portfolioValue || CONFIG.portfolioValue;
  const sizePct = CONFIG.maxTradeSizePct || 0.25;
  const tradeSize = CONFIG.maxTradeSizeUSD ? Math.min(portfolio * sizePct, CONFIG.maxTradeSizeUSD) : portfolio * sizePct;

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} (${(sizePct * 100).toFixed(0)}% of $${portfolio.toFixed(2)})`,
  );

  return true;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price, quantityOverride = null) {
  const quantity = quantityOverride ?? (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  const claudeTag = logEntry.claudeAnalysis
    ? `Claude ${logEntry.claudeAnalysis.action} ${logEntry.claudeAnalysis.confidence}%: ${logEntry.claudeAnalysis.reasoning}`
    : null;

  if (logEntry.type === "exit") {
    const pnlStr = logEntry.pnlPct !== undefined
      ? ` P&L: ${logEntry.pnlPct >= 0 ? "+" : ""}${logEntry.pnlPct.toFixed(2)}%`
      : "";
    if (!logEntry.shouldExit) {
      mode = "HELD";
      orderId = "HELD";
      notes = claudeTag ?? `Holding${pnlStr}`;
    } else {
      const val = (parseFloat(logEntry.quantity) * logEntry.price);
      side = "SELL";
      quantity = logEntry.quantity;
      totalUSD = val.toFixed(2);
      fee = (val * 0.001).toFixed(4);
      netAmount = (val - val * 0.001).toFixed(2);
      orderId = logEntry.orderId || "";
      mode = logEntry.paperTrading ? "PAPER" : "LIVE";
      notes = claudeTag ?? `Exit: ${logEntry.exitReasons?.join("; ")}${pnlStr}`;
    }
  } else if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = claudeTag ?? `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = claudeTag ?? "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : (claudeTag ?? "All conditions met");
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run(tvSignal = null, symbol = null) {
  symbol = (symbol || CONFIG.symbols[0]).toUpperCase();
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  if (tvSignal) console.log(`  Trigger: 📡 TradingView ${tvSignal} — ${symbol}`);
  else console.log(`  Trigger: ⏱ 15-min poll — ${symbol}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Daily profit target — lock in gains, stop trading for the day once hit
  const dailyProfit = checkDailyProfitTarget(log);
  console.log(`\n🎯 Daily goal: $${dailyProfit.startValue.toFixed(2)} → $${(dailyProfit.startValue * 1.5).toFixed(2)} (+50%) | Current: $${dailyProfit.currentValue.toFixed(2)} (${dailyProfit.gainPct >= 0 ? "+" : ""}${dailyProfit.gainPct.toFixed(2)}%)`);
  if (dailyProfit.targetHit) {
    console.log(`\n🏆 DAILY TARGET HIT — up ${dailyProfit.gainPct.toFixed(2)}% today! Protecting profits, done for the day.`);
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }

  // Drawdown stop — pause all trading if down 10% on the day
  const drawdown = checkDailyDrawdown(log);
  if (drawdown.paused) {
    console.log(`\n🛑 DRAWDOWN STOP — down ${drawdown.drawdownPct.toFixed(2)}% today ($${Math.abs(drawdown.totalLoss).toFixed(4)} lost)`);
    console.log(`   Limit: ${drawdown.limit}% per day. Bot paused until tomorrow.`);
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }
  if (drawdown.drawdownPct > 0) {
    console.log(`\n⚠️  Daily drawdown: ${drawdown.drawdownPct.toFixed(2)}% / ${drawdown.limit}% limit`);
  }

  // Adaptive mode — auto-adjusts strategy based on recent win rate
  const adaptive = getAdaptiveMode(log.trades);
  console.log(`\n🧠 Strategy mode: ${adaptive.label}`);
  if (adaptive.mode === "paused") {
    console.log(`   Win rate too low — trading paused to protect capital.`);
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }

  // Fetch candle data — entry TF + 1H + 4H for trend confirmation
  console.log("\n── Fetching market data from BitGet ────────────────────\n");
  const [candles, candles1h, candles4h] = await Promise.all([
    fetchCandles(symbol, CONFIG.timeframe, 500),
    fetchCandles(symbol, "1H", 100),
    fetchCandles(symbol, "4H", 100),
  ]);
  const closes = candles.map((c) => c.close);
  const closes1h = candles1h.map((c) => c.close);
  const closes4h = candles4h.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Entry TF indicators
  const ema8  = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const vwap  = calcVWAP(candles);
  const rsi3  = calcRSI(closes, 3);
  const vol   = calcVolume(candles);

  // 1H trend confirmation
  const ema8_1h  = calcEMA(closes1h, 8);
  const ema21_1h = calcEMA(closes1h, 21);
  const bullTrend1h = ema8_1h > ema21_1h;

  // 4H trend confirmation
  const ema8_4h  = calcEMA(closes4h, 8);
  const ema21_4h = calcEMA(closes4h, 21);
  const bullTrend4h = ema8_4h > ema21_4h;

  // Pass if either 1H or 4H is bullish
  const bullTrendConfirmed = bullTrend1h || bullTrend4h;

  // Advanced indicators
  const macd       = calcMACD(closes);
  const bb         = calcBollingerBands(closes);
  const adx        = calcADX(candles);
  const patterns   = detectCandlePatterns(candles);
  const sr         = calcSupportResistance(candles);
  const stochRsi   = calcStochRSI(closes);
  const divergence = detectBullishDivergence(candles);

  console.log(`  EMA(8):   $${ema8.toFixed(2)} | EMA(21): $${ema21.toFixed(2)} | ${ema8 > ema21 ? "✅ entry TF uptrend" : "🔴 entry TF downtrend"}`);
  console.log(`  1H trend: EMA(8) $${ema8_1h.toFixed(2)} vs EMA(21) $${ema21_1h.toFixed(2)} | ${bullTrend1h ? "✅ 1H uptrend" : "🔴 1H downtrend"}`);
  console.log(`  4H trend: EMA(8) $${ema8_4h.toFixed(2)} vs EMA(21) $${ema21_4h.toFixed(2)} | ${bullTrend4h ? "✅ 4H uptrend" : "🔴 4H downtrend"}`);
  console.log(`  VWAP:     $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):   ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);
  console.log(`  Volume:   ${vol.aboveAvg ? "✅ above avg" : "⚠️  below avg"} (${(vol.current / vol.avg * 100).toFixed(0)}% of avg)`);
  console.log(`  MACD:     ${macd.bullish ? "✅ bullish" : "🔴 bearish"} | hist ${macd.histogram.toFixed(4)}`);
  console.log(`  Bollinger: BB% ${(bb.pct * 100).toFixed(1)}% | width ${bb.width.toFixed(2)}% | ${bb.pct < 0.2 ? "⬇️ near lower band" : bb.pct > 0.8 ? "⬆️ near upper band" : "↔️ mid-range"}`);
  console.log(`  ADX:      ${adx ? `${adx.adx.toFixed(2)} (${adx.trending ? "✅ trending" : "⚠️ choppy"}) | +DI ${adx.plusDI.toFixed(1)} -DI ${adx.minusDI.toFixed(1)}` : "N/A"}`);
  console.log(`  StochRSI: K=${stochRsi ? stochRsi.k.toFixed(1) : "N/A"} | ${stochRsi?.oversold ? "✅ oversold" : stochRsi?.overbought ? "⚠️ overbought" : "neutral"}`);
  console.log(`  Divergence: ${divergence ? "✅ Bullish divergence detected!" : "none"}`);
  console.log(`  Patterns: ${patterns.length ? patterns.join(", ") : "None detected"}`);
  console.log(`  S/R:      Support $${sr.nearestSupport?.toFixed(2) ?? "?"} (${sr.distToSupport?.toFixed(2) ?? "?"}% below) | Resistance $${sr.nearestResistance?.toFixed(2) ?? "?"} (${sr.distToResistance?.toFixed(2) ?? "?"}% above)`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  const currentPortfolio = log.portfolioValue || CONFIG.portfolioValue;
  const sizePct = CONFIG.maxTradeSizePct || 0.25;
  const rawSize = currentPortfolio * sizePct * adaptive.sizeMultiplier;
  const tradeSize = CONFIG.maxTradeSizeUSD ? Math.min(rawSize, CONFIG.maxTradeSizeUSD) : rawSize;
  console.log(`\n💰 Portfolio: $${currentPortfolio.toFixed(4)} | Trade size: $${tradeSize.toFixed(4)} (${(sizePct * 100).toFixed(0)}%)`);

  // Always require 90%+ confidence — only trade very high conviction setups
  const CONFIDENCE_MIN = 90;
  const position = (log.positions || {})[symbol] || null;

  // TradingView SELL with no position, or BUY with position already open — nothing to do
  if (tvSignal === "SELL" && !position) {
    console.log("\n📡 TradingView SELL received — no open position to close. Skipping.");
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }
  if (tvSignal === "BUY" && position && position.open) {
    console.log("\n📡 TradingView BUY received — already holding a position. Skipping.");
    console.log(`   Entry: $${position.entryPrice.toFixed(2)} | Now: $${price.toFixed(2)}`);
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }

  if (position && position.open) {
    // ── EXIT FLOW ──────────────────────────────────────────────────────────
    const { shouldExit, reasons, newHigh } = checkExitConditions(position, price, ema8, vwap, rsi3, candles, stochRsi, bb);
    // Update high watermark for trailing stop
    if (newHigh > (position.highWatermark || 0)) {
      log.positions[symbol] = { ...position, highWatermark: newHigh };
      saveLog(log);
    }

    // TradingView SELL overrides rule check — indicator says exit now
    let finalExit = tvSignal === "SELL" ? true : shouldExit;
    let claudeAnalysis = null;

    if (anthropic) {
      console.log("\n── Claude AI Analysis ───────────────────────────────────\n");
      try {
        claudeAnalysis = await analyzeWithClaude(price, ema8, vwap, rsi3, log.trades, position, tvSignal, { ema21, macd, bb, adx, patterns, sr, bullTrend4h: bullTrendConfirmed, vol }, symbol);
        finalExit = claudeAnalysis.action === "EXIT";
        console.log(`  Decision:   ${claudeAnalysis.action} (${claudeAnalysis.confidence}% confidence)`);
        console.log(`  Reasoning:  ${claudeAnalysis.reasoning}`);
        if (claudeAnalysis.key_factors?.length) {
          claudeAnalysis.key_factors.forEach((f) => console.log(`  • ${f}`));
        }
        if (finalExit !== shouldExit) {
          console.log(`\n  ⚡ Override: rules said ${shouldExit ? "EXIT" : "HOLD"} — Claude says ${claudeAnalysis.action}`);
        }
      } catch (err) {
        console.log(`  ⚠️  Claude unavailable (${err.message}) — using rule-based decision`);
        finalExit = shouldExit;
      }
    }

    console.log("\n── Decision ─────────────────────────────────────────────\n");

    const pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;
    const pnlUSD = (price - position.entryPrice) * parseFloat(position.quantity);

    const logEntry = {
      timestamp: new Date().toISOString(),
      type: "exit",
      symbol,
      timeframe: CONFIG.timeframe,
      price,
      entryPrice: position.entryPrice,
      pnlPct,
      pnlUSD,
      indicators: { ema8, vwap, rsi3 },
      exitReasons: reasons,
      shouldExit: finalExit,
      claudeAnalysis,
      quantity: position.quantity,
      tradeSize,
      orderPlaced: false,
      orderId: null,
      paperTrading: CONFIG.paperTrading,
      limits: {
        maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
        maxTradesPerDay: CONFIG.maxTradesPerDay,
        tradesToday: countTodaysTrades(log),
      },
    };

    if (!finalExit) {
      if (claudeAnalysis) {
        console.log(`✅ CLAUDE: HOLD — ${claudeAnalysis.reasoning}`);
      } else {
        console.log(`✅ HOLDING LONG — no exit signal`);
      }
      console.log(`   Entry: $${position.entryPrice.toFixed(2)} | Now: $${price.toFixed(2)} | P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`);
    } else {
      if (claudeAnalysis) {
        console.log(`🔴 CLAUDE: EXIT — ${claudeAnalysis.reasoning}`);
      } else {
        console.log(`🔴 CLOSING LONG — ${reasons.join("; ")}`);
      }
      console.log(`   Entry: $${position.entryPrice.toFixed(2)} | Exit: $${price.toFixed(2)} | P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(4)})`);

      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER SELL — would sell ${position.quantity} ${symbol} at market`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-SELL-${Date.now()}`;
        log.positions = { ...(log.positions || {}), [symbol]: null };
        // Compound portfolio value
        log.portfolioValue = (log.portfolioValue || CONFIG.portfolioValue) + pnlUSD;
        console.log(`💰 Portfolio updated: $${log.portfolioValue.toFixed(4)} (${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(4)})`);
      } else {
        console.log(`\n🔴 PLACING LIVE SELL — ${position.quantity} ${symbol}`);
        try {
          const order = await placeBitGetOrder(symbol, "sell", null, price, position.quantity);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          log.positions = { ...(log.positions || {}), [symbol]: null };
          // Compound portfolio value
          log.portfolioValue = (log.portfolioValue || CONFIG.portfolioValue) + pnlUSD;
          console.log(`✅ SELL ORDER PLACED — ${order.orderId}`);
          console.log(`💰 Portfolio updated: $${log.portfolioValue.toFixed(4)} (${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(4)})`);
        } catch (err) {
          console.log(`❌ SELL ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
        }
      }
    }

    log.trades.push(logEntry);
    saveLog(log);
    console.log(`\nDecision log saved → ${LOG_FILE}`);
    writeTradeCsv(logEntry);

  } else {
    // ── ENTRY FLOW ──────────────────────────────────────────────────────────
    const { results, allPass: rulesPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules, adaptive.rsiThreshold, vol, ema21, bullTrendConfirmed, adx, stochRsi, divergence, bb);

    let claudeAnalysis = null;
    let allPass = rulesPass;

    if (anthropic) {
      console.log("\n── Claude AI Analysis ───────────────────────────────────\n");
      try {
        claudeAnalysis = await analyzeWithClaude(price, ema8, vwap, rsi3, log.trades, null, tvSignal, { ema21, macd, bb, adx, patterns, sr, bullTrend4h: bullTrendConfirmed, vol }, symbol);
        const meetsConfidence = claudeAnalysis.confidence >= CONFIDENCE_MIN;
        allPass = claudeAnalysis.action === "BUY" && meetsConfidence;
        console.log(`  Decision:   ${claudeAnalysis.action} (${claudeAnalysis.confidence}% confidence)`);
        console.log(`  Min confidence required: ${CONFIDENCE_MIN}% (high-conviction mode)`);
        console.log(`  Reasoning:  ${claudeAnalysis.reasoning}`);
        if (claudeAnalysis.key_factors?.length) {
          claudeAnalysis.key_factors.forEach((f) => console.log(`  • ${f}`));
        }
        if (claudeAnalysis.price_target) console.log(`  Target:     $${claudeAnalysis.price_target}`);
        if (claudeAnalysis.stop_suggestion) console.log(`  Stop:       $${claudeAnalysis.stop_suggestion}`);
        if (!meetsConfidence && claudeAnalysis.action === "BUY") {
          console.log(`\n  ⚠️  BUY blocked — confidence ${claudeAnalysis.confidence}% below ${CONFIDENCE_MIN}% minimum`);
        }
        if (allPass !== rulesPass) {
          console.log(`\n  ⚡ Override: rules said ${rulesPass ? "PASS" : "BLOCK"} — Claude says ${claudeAnalysis.action}`);
        }
      } catch (err) {
        console.log(`  ⚠️  Claude unavailable (${err.message}) — using rule-based decision`);
        allPass = rulesPass;
      }
    }

    console.log("\n── Decision ─────────────────────────────────────────────\n");

    const logEntry = {
      timestamp: new Date().toISOString(),
      type: "entry",
      symbol,
      timeframe: CONFIG.timeframe,
      price,
      indicators: { ema8, vwap, rsi3 },
      conditions: results,
      allPass,
      claudeAnalysis,
      tradeSize,
      orderPlaced: false,
      orderId: null,
      paperTrading: CONFIG.paperTrading,
      limits: {
        maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
        maxTradesPerDay: CONFIG.maxTradesPerDay,
        tradesToday: countTodaysTrades(log),
      },
    };

    if (!allPass) {
      if (claudeAnalysis) {
        console.log(`🚫 CLAUDE: HOLD — ${claudeAnalysis.reasoning}`);
        if (rulesPass) console.log(`   (Rules said PASS — Claude overrode based on trade history)`);
      } else {
        const failed = results.filter((r) => !r.pass).map((r) => r.label);
        console.log(`🚫 TRADE BLOCKED`);
        console.log(`   Failed conditions:`);
        failed.forEach((f) => console.log(`   - ${f}`));
      }
    } else {
      if (claudeAnalysis) {
        console.log(`✅ CLAUDE: BUY (${claudeAnalysis.confidence}% confidence)`);
        console.log(`   ${claudeAnalysis.reasoning}`);
        if (!rulesPass) console.log(`   (Rules said BLOCK — Claude overrode based on trade history)`);
      } else {
        console.log(`✅ ALL CONDITIONS MET`);
      }

      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER TRADE — would buy ${symbol} ~$${tradeSize.toFixed(2)} at market`);
        console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-${Date.now()}`;
        log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: (tradeSize / price).toFixed(6), orderId: logEntry.orderId } };
      } else {
        console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${symbol}`);
        try {
          const order = await placeBitGetOrder(symbol, "buy", tradeSize, price);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: (tradeSize / price).toFixed(6), orderId: order.orderId } };
          console.log(`✅ ORDER PLACED — ${order.orderId}`);
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
        }
      }
    }

    log.trades.push(logEntry);
    saveLog(log);
    console.log(`\nDecision log saved → ${LOG_FILE}`);
    writeTradeCsv(logEntry);
  }

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  const PORT = process.env.PORT || 3000;

  const server = http.createServer((req, res) => {
    // Health check — Railway uses this to confirm the service is up
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }

    // Status endpoint — shows current bot state, positions, last decisions
    if (req.method === "GET" && req.url === "/status") {
      const log = loadLog();
      const today = new Date().toISOString().slice(0, 10);
      const todayTrades = log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced);
      const todayExits = log.trades.filter(t => t.type === "exit" && t.timestamp.startsWith(today) && t.pnlUSD !== undefined);
      const totalPnl = todayExits.reduce((s, t) => s + (t.pnlUSD || 0), 0);
      const winRate = calcWinRate(log.trades, 10);
      const drawdown = checkDailyDrawdown(log);
      const adaptive = getAdaptiveMode(log.trades);
      const dailyProfit = checkDailyProfitTarget(log);
      const status = {
        time: new Date().toISOString(),
        version: "v4-stochrsi-atr",
        timeframe: CONFIG.timeframe,
        mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
        symbols: CONFIG.symbols,
        portfolio: `$${(log.portfolioValue || CONFIG.portfolioValue).toFixed(4)}`,
        dailyGoal: `$${dailyProfit.startValue.toFixed(2)} → $${(dailyProfit.startValue * 1.5).toFixed(2)} | ${dailyProfit.gainPct >= 0 ? "+" : ""}${dailyProfit.gainPct.toFixed(2)}% ${dailyProfit.targetHit ? "🏆 TARGET HIT" : ""}`,
        positions: log.positions || {},
        todayTrades: todayTrades.length,
        todayPnl: `$${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)}`,
        drawdown: `${drawdown.drawdownPct.toFixed(2)}% / ${drawdown.limit}%`,
        paused: drawdown.paused,
        winRate: winRate ? `${winRate.wins}/${winRate.sample} (${(winRate.winRate*100).toFixed(0)}%)` : "not enough data",
        strategyMode: adaptive.label,
        lastTrades: log.trades.slice(-5).map(t => ({
          time: t.timestamp?.slice(0,16),
          type: t.type,
          symbol: t.symbol,
          price: t.price,
          pnl: t.pnlPct ? `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%` : null,
          decision: t.claudeAnalysis?.action || (t.shouldExit ? "EXIT" : "HOLD"),
          placed: t.orderPlaced,
          blockedBy: !t.orderPlaced && t.conditions ? t.conditions.filter(c => !c.pass).map(c => c.label) : undefined,
          claudeReason: t.claudeAnalysis?.reasoning || undefined,
        })),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    // TradingView webhook
    if (req.method === "POST" && req.url === "/webhook") {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const action = (payload.action || "").toUpperCase();
          const sym = (payload.symbol || CONFIG.symbols[0]).toUpperCase();
          if (!["BUY", "SELL"].includes(action)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: 'action must be "BUY" or "SELL"' }));
            return;
          }
          if (!CONFIG.symbols.includes(sym)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Unknown symbol: ${sym}. Allowed: ${CONFIG.symbols.join(", ")}` }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ received: true, action, symbol: sym }));
          console.log(`\n📡 TradingView webhook: ${action} ${sym}`);
          run(action, sym).catch((err) => console.error("Webhook run error:", err));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`\n🌐 Webhook server listening on port ${PORT}`);
    console.log(`   Symbols:     ${CONFIG.symbols.join(", ")}`);
    console.log(`   Polling:     every 15 minutes\n`);

    // Run first check immediately on startup
    (async () => {
      for (const sym of CONFIG.symbols) {
        await run(null, sym).catch((err) => console.error(`Startup ${sym} error:`, err));
      }
    })();
  });

  // Check all symbols every 5 minutes
  setInterval(async () => {
    for (const sym of CONFIG.symbols) {
      await run(null, sym).catch((err) => console.error(`Poll ${sym} error:`, err));
    }
  }, 5 * 60 * 1000);
}
