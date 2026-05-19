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

const WATCHLIST = (process.env.WATCHLIST || "")
  .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

const CONFIG = {
  symbols: (process.env.SYMBOLS || process.env.SYMBOL || "KAVAUSDT,ZECUSDT,NEARUSDT,BNBUSDT,LINKUSDT,SOLUSDT,AXSUSDT,ADAUSDT,DOTUSDT,INJUSDT")
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
  let raw = readFileSync(LOG_FILE);
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) raw = raw.slice(3);
  const log = JSON.parse(raw.toString("utf8"));
  // Reset day start value each new day
  const today = new Date().toISOString().slice(0, 10);
  if (!log.portfolioValue) log.portfolioValue = CONFIG.portfolioValue;
  if (log.dayStartDate !== today) {
    log.dayStartDate = today;
    // Fix 5: Auto-sync portfolio to real BitGet USDT balance at day start
    // (async fetch done in run() — flag it here so run() knows to sync)
    log._needsPortfolioSync = true;
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
  const closed = trades.filter((t) => t.type === "exit" && t.pnlPct !== undefined && t.orderPlaced === true);
  const recent = closed.slice(-n);
  if (recent.length < 5) return null; // not enough history (min 5 trades for statistical validity)
  // Count wins as > 0.25% net — filters out trades that were "positive" but lost money after fees (0.2% round-trip)
  const wins = recent.filter((t) => t.pnlPct > 0.25).length;
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
  const target = 30; // 30% daily target — stop and protect gains
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
  if (wr.winRate >= 0.65) return { mode: "normal",    label: `✅ Normal — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample})`,    rsiThreshold: 30, confidenceMin: 70, sizeMultiplier: 1.0 };
  if (wr.winRate >= 0.45) return { mode: "cautious",  label: `⚠️  Cautious — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample})`,  rsiThreshold: 25, confidenceMin: 80, sizeMultiplier: 0.75 };
  if (wr.winRate >= 0.35) return { mode: "defensive", label: `🔴 Defensive — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample})`, rsiThreshold: 20, confidenceMin: 85, sizeMultiplier: 0.5 };
  return { mode: "paused", label: `🛑 Paused — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample}) too low`, rsiThreshold: 20, confidenceMin: 90, sizeMultiplier: 0 };
}

// ─── Self-Learning: Post-Trade Threshold Optimization ────────────────────────

function getEntryForExit(trades, exitTrade) {
  const exitTime = new Date(exitTrade.timestamp).getTime();
  return trades
    .filter(t => t.type === "entry" && t.symbol === exitTrade.symbol && t.orderPlaced)
    .filter(t => new Date(t.timestamp).getTime() < exitTime)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || null;
}

function learnFromTrades(log) {
  const exits = log.trades.filter(t => t.type === "exit" && t.orderPlaced);
  if (exits.length < 3) return false;
  if (!log.learnedThresholds) log.learnedThresholds = {};
  let changed = false;

  // Per-coin RSI threshold — find entry RSI that maximises expected value
  const symbols = [...new Set(exits.map(t => t.symbol))];
  for (const symbol of symbols) {
    const coinExits = exits.filter(t => t.symbol === symbol);
    if (coinExits.length < 5) continue;

    const pairs = coinExits.map(exit => {
      const entry = getEntryForExit(log.trades, exit);
      if (!entry || entry.indicators?.rsi3 === undefined || entry.indicators.rsi3 === null) return null;
      return { entryRSI: entry.indicators.rsi3, win: exit.pnlPct > 0, pnlPct: exit.pnlPct };
    }).filter(Boolean);

    if (pairs.length < 5) continue;

    let bestThreshold = 30, bestScore = -Infinity;
    for (let t = 15; t <= 40; t += 2) {
      const inScope = pairs.filter(p => p.entryRSI < t);
      if (inScope.length < 3) continue;
      const wins = inScope.filter(p => p.win).length;
      const winRate = wins / inScope.length;
      const avgPnl = inScope.reduce((s, p) => s + p.pnlPct, 0) / inScope.length;
      const score = winRate * Math.max(0, avgPnl);
      if (score > bestScore && winRate >= 0.50) { bestScore = score; bestThreshold = t; }
    }

    const prev = log.learnedThresholds[symbol];
    const allWins = pairs.filter(p => p.win).length;
    log.learnedThresholds[symbol] = {
      rsiThreshold: bestThreshold,
      basedOnTrades: pairs.length,
      winRate: (allWins / pairs.length * 100).toFixed(1),
      lastUpdated: new Date().toISOString().slice(0, 10),
    };
    if (!prev || prev.rsiThreshold !== bestThreshold) {
      console.log(`\n🧠 LEARNED: ${symbol} RSI gate → <${bestThreshold} (${pairs.length} live trades, ${(allWins/pairs.length*100).toFixed(0)}% WR)`);
      changed = true;
    }
  }

  // Global confidence floor — find minimum confidence where win rate >= 55%
  const confPairs = exits.map(exit => {
    const entry = getEntryForExit(log.trades, exit);
    if (!entry?.claudeAnalysis?.confidence) return null;
    return { confidence: entry.claudeAnalysis.confidence, win: exit.pnlPct > 0 };
  }).filter(Boolean);

  if (confPairs.length >= 10) {
    let bestConfMin = null;
    for (let c = 65; c <= 85; c += 5) {
      const above = confPairs.filter(p => p.confidence >= c);
      if (above.length < 5) continue;
      if (above.filter(p => p.win).length / above.length >= 0.55) { bestConfMin = c; break; }
    }
    if (bestConfMin && log.learnedThresholds._confidenceMin !== bestConfMin) {
      console.log(`\n🧠 LEARNED: Confidence floor → ${bestConfMin}% (${confPairs.length} trades)`);
      log.learnedThresholds._confidenceMin = bestConfMin;
      changed = true;
    }
  }

  return changed;
}

function getCoinRsiThreshold(symbol, log) {
  const learned = log?.learnedThresholds?.[symbol];
  if (learned && learned.basedOnTrades >= 5) return learned.rsiThreshold;
  const bt = BACKTEST[symbol];
  if (bt?.rsiThreshold) return bt.rsiThreshold;
  return 30;
}

// ─── Inline backtest optimizer ───────────────────────────────────────────────

function calcEMASeries(closes, period) {
  const k = 2 / (period + 1);
  let e = closes[0];
  return closes.map(c => { e = c * k + e * (1 - k); return e; });
}

function calcRSI3Series(closes) {
  const p = 3, r = new Array(p).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i-1]; d > 0 ? g += d : l -= d; }
  g /= p; l /= p;
  r.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    g = (g * (p-1) + (d > 0 ? d : 0)) / p;
    l = (l * (p-1) + (d < 0 ? -d : 0)) / p;
    r.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
  }
  return r;
}

function calcVWAPSeries(candles) {
  return candles.map((_, i) => {
    const w = candles.slice(Math.max(0, i - 23), i + 1);
    const tv = w.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
    const v = w.reduce((s, c) => s + c.volume, 0);
    return v > 0 ? tv / v : candles[i].close;
  });
}

function runBacktestSim(candles, rsiThreshold, takeProfit, stopLoss = 0.04) {
  const closes = candles.map(c => c.close);
  const ema8 = calcEMASeries(closes, 8);
  const rsi = calcRSI3Series(closes);
  const vwap = calcVWAPSeries(candles);
  const avgVol = candles.slice(0, 20).reduce((s, c) => s + c.volume, 0) / 20;
  const trades = [];
  let inTrade = false, entry = 0, bar = 0;
  for (let i = 30; i < candles.length - 1; i++) {
    if (inTrade) {
      const pct = (candles[i].close - entry) / entry;
      if (pct >= takeProfit || pct <= -stopLoss || (i - bar) >= 24) {
        trades.push({ pct: pct * 100, win: pct > 0 });
        inTrade = false;
      }
      continue;
    }
    const p = candles[i].close, rv = rsi[i];
    if (rv === null || rv === undefined) continue;
    if (p > vwap[i] && p > ema8[i] && rv < rsiThreshold &&
        Math.abs((p - vwap[i]) / vwap[i]) < 0.03 &&
        candles[i].volume > avgVol * 0.8) {
      inTrade = true; entry = candles[i+1].open; bar = i + 1;
    }
  }
  return trades;
}

function optimiseCoin(symbol, candles) {
  let best = null;
  for (const rsi of [15, 20, 25, 30, 35, 40, 45, 50]) {
    for (const tp of [0.03, 0.04, 0.05, 0.06, 0.08]) {
      for (const sl of [0.02, 0.03, 0.04, 0.05, 0.06]) {
        if (tp <= sl) continue; // TP must be larger than SL
        const trades = runBacktestSim(candles, rsi, tp, sl);
        if (trades.length < 5) continue;
        const wins = trades.filter(t => t.win), losses = trades.filter(t => !t.win);
        const wr = wins.length / trades.length;
        const aw = wins.length > 0 ? wins.reduce((s, t) => s + t.pct, 0) / wins.length : 0;
        const al = losses.length > 0 ? losses.reduce((s, t) => s + t.pct, 0) / losses.length : 0;
        const exp = wr * aw + (1 - wr) * al;
        if (wr < 0.70 || exp <= 0) continue;
        const score = wr * exp;
        if (!best || score > best.score) {
          best = { rsiThreshold: rsi, takeProfit: tp, stopLoss: sl, trades: trades.length,
            winRate: +(wr * 100).toFixed(1), expectancy: +exp.toFixed(2), score };
        }
      }
    }
  }
  const testedAt = new Date().toISOString();
  if (!best) return { symbol, trades: 0, winRate: 0, recommendation: "SKIP", rsiThreshold: 25, takeProfit: 0.05, stopLoss: 0.04, testedAt };
  return { symbol, ...best, recommendation: best.winRate >= 75 ? "TRADE" : "CAUTION", testedAt };
}

async function backtestCoin(symbol) {
  const existing = BACKTEST[symbol];
  if (existing?.testedAt && Date.now() - new Date(existing.testedAt).getTime() < 20 * 60 * 60 * 1000) {
    return existing; // fresh enough — skip re-test
  }
  const candles = await fetchCandles(symbol, "1H", 500);
  const result = optimiseCoin(symbol, candles);
  result.symbol = symbol;
  BACKTEST[symbol] = result;
  return result;
}

// ─── Momentum Mode — new coin launches ──────────────────────────────────────

function checkMomentumEntry(price, ema8, candles, vol, rsi3, stochRsi) {
  const results = [];
  const check = (label, required, actual, pass) => results.push({ label, required, actual, pass });

  // Volume surge — crowd piling in is the core signal
  const volRatio = vol.current / vol.avg;
  check("Volume surge (≥ 2× avg)", "≥ 2×", `${volRatio.toFixed(1)}×`, volRatio >= 2);

  // Price above EMA(8) — momentum is up
  check(`Price above EMA(8)`, `> ${ema8.toFixed(4)}`, price.toFixed(4), price > ema8);

  // RSI in momentum zone (50–85) — not oversold, not at extreme top
  check("RSI(3) in momentum zone (50–85)", "50–85", rsi3.toFixed(1), rsi3 >= 50 && rsi3 <= 85);

  // Higher highs on last 3 candles (price making new highs)
  const recent = candles.slice(-4);
  const higherHighs = recent.length >= 4 && recent.slice(-3).every((c, i, arr) => i === 0 || c.high >= arr[i - 1].high * 0.998);
  check("Price making higher highs", "rising", higherHighs ? "yes" : "no", higherHighs);

  // Not overbought on StochRSI (avoid buying the very top)
  if (stochRsi) check("StochRSI not at extreme (< 95)", "< 95", stochRsi.k.toFixed(1), stochRsi.k < 95);

  const allPass = results.every(r => r.pass);
  return { results, allPass };
}

// Scan BitGet tickers for potential new listings (< 7 days of 1H candle history)
async function scanNewListings(allTickers) {
  const candidates = allTickers
    .filter(t =>
      t.symbol.endsWith("USDT") &&
      !/UP|DOWN|BEAR|BULL|USDC|TUSD|BUSD|DAI/.test(t.symbol) &&
      parseFloat(t.usdtVolume) > 2_000_000 &&   // $2M+ volume
      parseFloat(t.change24h) > 0.08             // > 8% gain today — new listings pump hard
    )
    .sort((a, b) => parseFloat(b.change24h) - parseFloat(a.change24h))
    .slice(0, 8); // check top 8 gainers

  const newListings = [];
  for (const ticker of candidates) {
    try {
      const candles = await fetchCandles(ticker.symbol, "1H", 200);
      if (candles.length < 168) { // < 7 days of hourly history
        newListings.push(ticker.symbol);
        console.log(`  🆕 ${ticker.symbol.padEnd(14)} ${candles.length}H history | +${(parseFloat(ticker.change24h) * 100).toFixed(1)}% today | $${Math.round(parseFloat(ticker.usdtVolume) / 1e6)}M vol`);
      }
    } catch { /* skip on error */ }
  }
  return newListings;
}

// ─── Top Movers — swap coins every 4 hours ───────────────────────────────────

async function refreshTopMovers() {
  try {
    // Use BitGet's own spot ticker — avoids Binance geo-blocks and guarantees symbols are tradeable
    const res = await fetch("https://api.bitget.com/api/v2/spot/market/tickers");
    const json = await res.json();
    if (json.code !== "00000") throw new Error(`BitGet tickers error: ${json.msg}`);

    // ── Full market scan ────────────────────────────────────────────────────
    // Score every liquid USDT pair — both gainers and high-volume movers
    const allCoins = (json.data || []).filter(t =>
      t.symbol.endsWith("USDT") &&
      !/UP|DOWN|BEAR|BULL|USDC|TUSD|BUSD|DAI|USD1|FDUSD|RLUSD|PAXG|XAUT/.test(t.symbol) &&
      parseFloat(t.lastPr) >= 0.001 &&
      parseFloat(t.usdtVolume) > 1_000_000   // $1M+ volume — broad but liquid
    );

    // Score: weighted mix of volume rank + absolute 24h move (big moves = opportunity)
    const totalVol = allCoins.reduce((s, t) => s + parseFloat(t.usdtVolume), 0);
    const scored = allCoins.map(t => {
      const vol = parseFloat(t.usdtVolume);
      const chg = Math.abs(parseFloat(t.change24h)); // big moves (up OR down) = interesting
      const volScore = vol / totalVol * 100;
      const chgScore = Math.min(chg * 100, 30); // cap at 30 so mega-pumps don't dominate
      return { symbol: t.symbol, score: volScore * 0.4 + chgScore * 0.6, vol, chg: parseFloat(t.change24h) };
    }).sort((a, b) => b.score - a.score);

    // Take top 40 by score — mix of high-volume stalwarts + big movers
    const candidates = scored.slice(0, 40).map(t => t.symbol);
    console.log(`\n🌐 Full market scan — ${allCoins.length} liquid coins → top ${candidates.length} candidates`);

    // Backtest all candidates — 20H cache means most results are instant
    console.log(`📈 Backtesting candidates (cached results reused)...`);
    const qualified = [];
    for (const sym of candidates) {
      try {
        const result = await backtestCoin(sym);
        const icon = result.recommendation === "TRADE" ? "✅" : result.recommendation === "CAUTION" ? "⚠️ " : "🚫";
        if (result.trades > 0) {
          console.log(`  ${icon} ${sym.padEnd(14)} WR:${result.winRate}%  n:${result.trades}  exp:+${result.expectancy}%  RSI<${result.rsiThreshold}  TP:${(result.takeProfit*100).toFixed(0)}%`);
        } else {
          console.log(`  🚫 ${sym.padEnd(14)} no valid setup`);
        }
        if (result.recommendation !== "SKIP") qualified.push(sym);
      } catch (e) {
        console.log(`  ⚠️  ${sym}: backtest failed — skipping`);
      }
    }

    // Always keep coins with open positions so exits are never missed
    const log = loadLog();
    const heldSymbols = Object.entries(log.positions || {})
      .filter(([, p]) => p && p.open)
      .map(([sym]) => sym);

    // Scan for new listings (coins with < 7 days history pumping hard)
    console.log(`\n🆕 Scanning for new listings...`);
    const newListings = await scanNewListings(json.data || []);
    if (newListings.length === 0) console.log("  None found.");

    const combined = [...new Set([...qualified, ...heldSymbols, ...WATCHLIST, ...newListings])];

    if (combined.length === 0) {
      console.log(`\n   ⚠️  No movers qualified — keeping previous symbol list\n`);
    } else {
      CONFIG.symbols.length = 0;
      combined.forEach(s => CONFIG.symbols.push(s));
    }

    console.log(`   Qualified: ${qualified.length > 0 ? qualified.join(", ") : "none"}`);
    if (heldSymbols.length > 0) console.log(`   + Held: ${heldSymbols.join(", ")}`);
    if (WATCHLIST.length > 0) console.log(`   + Watchlist: ${WATCHLIST.join(", ")}`);
    console.log(`   Active (${CONFIG.symbols.length}): ${CONFIG.symbols.join(", ")}\n`);
  } catch (e) {
    console.error("Top movers fetch failed:", e.message);
  }
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

  // BitGet returns oldest-first (ascending) — no reverse needed
  return json.data.map((k) => ({
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

function calcSupportResistance(candles1h, candles4h = [], candlesDay = []) {
  const price = candles1h[candles1h.length - 1].close;

  function swingLevels(candles, lookback, strength = 2) {
    const recent = candles.slice(-lookback);
    const highs = [], lows = [];
    for (let i = strength; i < recent.length - strength; i++) {
      const isSwingHigh = recent.slice(i - strength, i).every(c => c.high <= recent[i].high) &&
                          recent.slice(i + 1, i + strength + 1).every(c => c.high <= recent[i].high);
      const isSwingLow  = recent.slice(i - strength, i).every(c => c.low >= recent[i].low) &&
                          recent.slice(i + 1, i + strength + 1).every(c => c.low >= recent[i].low);
      if (isSwingHigh) highs.push(recent[i].high);
      if (isSwingLow)  lows.push(recent[i].low);
    }
    return { highs, lows };
  }

  // Gather levels from all three timeframes (daily = strongest weight)
  const h1  = swingLevels(candles1h, 60, 2);
  const h4  = candles4h.length  > 5 ? swingLevels(candles4h,  60, 2) : { highs: [], lows: [] };
  const day = candlesDay.length > 5 ? swingLevels(candlesDay, 60, 2) : { highs: [], lows: [] };

  const allResistance = [...h1.highs, ...h4.highs, ...day.highs].filter(h => h > price);
  const allSupport    = [...h1.lows,  ...h4.lows,  ...day.lows ].filter(l => l < price);

  // Cluster nearby levels (within 1%) and pick the most confluent
  function bestLevel(levels, above) {
    if (!levels.length) return null;
    const sorted = above ? levels.sort((a, b) => a - b) : levels.sort((a, b) => b - a);
    // Score each level by how many others are within 1% of it
    let best = sorted[0], bestScore = 0;
    for (const lvl of sorted) {
      const score = sorted.filter(l => Math.abs(l - lvl) / lvl < 0.01).length;
      if (score > bestScore) { bestScore = score; best = lvl; }
    }
    return { price: best, confluences: bestScore };
  }

  const resistance = bestLevel(allResistance, true);
  const support    = bestLevel(allSupport, false);

  const nearestResistance = resistance?.price ?? null;
  const nearestSupport    = support?.price    ?? null;
  const distToResistance  = nearestResistance ? ((nearestResistance - price) / price * 100) : null;
  const distToSupport     = nearestSupport    ? ((price - nearestSupport) / price * 100)    : null;
  const nearSupport       = distToSupport !== null && distToSupport < 2.0;
  const nearResistance    = distToResistance !== null && distToResistance < 2.0;

  return {
    nearestResistance, nearestSupport,
    distToResistance, distToSupport,
    nearSupport, nearResistance,
    resistanceConf: resistance?.confluences ?? 0,
    supportConf:    support?.confluences    ?? 0,
  };
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

// ─── Professional-grade signals ─────────────────────────────────────────────

// Liquidity sweep (ICT / Smart Money Concept) — one of the highest-probability setups in trading.
// Institutions trigger retail stop orders below a swing low, then reverse hard upward.
// Pattern: price wicks below a recent swing low → closes back above it → currently recovering.
function detectLiquiditySweep(candles, lookback = 15) {
  if (candles.length < lookback + 3) return false;
  const window = candles.slice(-(lookback + 2));
  const swingLow = Math.min(...window.slice(0, -2).map(c => c.low));
  const prev = window[window.length - 2]; // last fully closed candle
  const curr = window[window.length - 1]; // candle currently forming
  const swept    = prev.low   < swingLow * 0.999; // wick briefly took out swing low
  const recovered = prev.close > swingLow;          // but closed back above it
  const recovering = curr.close > prev.close;       // momentum now positive
  return swept && recovered && recovering;
}

// Funding rate — perpetual futures market positioning.
// Negative funding: shorts pay longs = market is overcrowded short → squeeze risk → buy signal.
// Positive funding: longs pay shorts = market is overcrowded long → crowded trade → avoid.
async function getFundingRate(symbol) {
  try {
    const res = await fetch(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=USDT-FUTURES`);
    const data = await res.json();
    if (data.code !== "00000") return null;
    return parseFloat(data.data?.[0]?.fundingRate ?? 0);
  } catch { return null; }
}

// Kelly Criterion — mathematically optimal position size based on your own live trade history.
// f = W - (1-W)/R | W = win rate, R = avg win / avg loss
// Uses half-Kelly for safety (full Kelly maximises growth but has large drawdowns).
function kellyPositionPct(log, symbol, fallback = 0.25) {
  const exits = log.trades.filter(t =>
    t.type === "exit" && t.symbol === symbol && t.orderPlaced && t.pnlPct !== undefined
  );
  if (exits.length < 15) return fallback; // need 15+ trades for statistical validity
  const wins   = exits.filter(t => t.pnlPct >  0.25); // net of fees
  const losses = exits.filter(t => t.pnlPct <= 0.25);
  if (wins.length === 0 || losses.length === 0) return fallback;
  const W = wins.length / exits.length;
  const avgWin  =  wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length);
  const R = avgWin / avgLoss;
  const kelly = W - (1 - W) / R;
  return Math.max(0.10, Math.min(0.35, kelly / 2)); // half-Kelly, capped 10%–35%
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

function runSafetyCheck(price, ema8, vwap, rsi3, rules, rsiThreshold = 30, vol = null, ema21 = null, bullTrend4h = null, adx = null, stochRsi = null, divergence = false, bb = null, vwapBounce = false) {
  const results = [];
  let entryScore = 0;

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
  const atVwap = distFromVWAP < 0.5; // within 0.5% = essentially at VWAP
  const bullishBias = (price > vwap || atVwap) && price > ema8;
  const bearishBias = price < vwap && !atVwap && price < ema8;

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

    // 4. Not overextended from VWAP (relaxed to 2.5% in VWAP bounce mode)
    const vwapProximityLimit = vwapBounce ? 2.5 : 1.5;
    check(
      `Price within ${vwapProximityLimit}% of VWAP (not overextended)`,
      `< ${vwapProximityLimit}%`,
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < vwapProximityLimit,
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
    entryScore = score;
    console.log(`  ℹ️  v2 Entry Score: ${score}/3+ needed — [${scoreSignals.join(", ") || "none"}]`);
  } else if (bearishBias && rsi3 !== null && rsi3 < 25) {
    // Oversold in downtrend — snap-back long entry
    console.log(`  Bias: BEARISH but RSI(3)=${rsi3.toFixed(1)} — oversold snap-back, treating as long entry\n`);
    check("RSI(3) oversold (< 25) — snap-back in downtrend", "< 25", rsi3.toFixed(2), true);
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", distFromVWAP.toFixed(2) + "%", distFromVWAP < 1.5);
    // Counter-trend entries need confirmation — calculate quality score
    const sbSignals = [];
    if (rsi3 < 15) { entryScore += 2; sbSignals.push("RSI extreme"); }
    else if (rsi3 < 20) { entryScore += 1; sbSignals.push("RSI very low"); }
    if (stochRsi?.oversold) { entryScore += 2; sbSignals.push("StochRSI oversold"); }
    if (bb && bb.pct < 0.25) { entryScore += 2; sbSignals.push("BB% near low"); }
    if (divergence) { entryScore += 3; sbSignals.push("divergence!"); }
    console.log(`  ℹ️  Snapback quality score: ${entryScore}/2+ needed — [${sbSignals.join(", ") || "none"}]`);
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

    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    // Neutral bias — allow entry if oversold (RSI < 25)
    if (rsi3 !== null && rsi3 < 25) {
      console.log(`  Bias: NEUTRAL but RSI(3)=${rsi3.toFixed(1)} oversold — snap-back entry\n`);
      check("RSI(3) oversold (< 25) in neutral market", "< 25", rsi3.toFixed(2), true);
    } else {
      console.log("  Bias: NEUTRAL — no clear direction, RSI not oversold enough. No trade.\n");
      results.push({ label: "Market bias", required: "Bullish/bearish or RSI < 15", actual: "Neutral", pass: false });
    }
  }

  const allPass = results.every((r) => r.pass);
  // snap-back = entered below VWAP deliberately; trend-follow = entered above VWAP
  const entryType = (bearishBias && rsi3 < 25) || (!bullishBias && !bearishBias && rsi3 < 25)
    ? "snapback"
    : "trend-follow";
  return { results, allPass, entryType, entryScore };
}

// ─── Exit Conditions ─────────────────────────────────────────────────────────

function checkExitConditions(position, price, ema8, vwap, rsi3, candles = null, stochRsi = null, bb = null, sr = null, macd = null) {
  const reasons = [];
  const pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;

  // Emergency stop — cap any loss at 8% regardless of other conditions
  if (pnlPct <= -8) {
    return { shouldExit: true, reasons: [`Emergency stop — loss exceeded -8% | Actual: ${pnlPct.toFixed(2)}%`], newHigh: position.highWatermark || position.entryPrice };
  }

  // ATR-based trailing stop (1.5x ATR, capped 1.5%–3.5%)
  const atr = candles ? calcATR(candles) : null;
  const newHigh = Math.max(price, position.highWatermark || position.entryPrice);
  const baseTrailPct = atr
    ? Math.min(Math.max(1.5 * atr / newHigh, 0.015), 0.035)
    : 0.025;
  // Stepped profit lock — tighten trail progressively as gains grow
  const trailPct =
    pnlPct >= 4.0 ? Math.min(baseTrailPct, 0.005) :  // +4%: lock to 0.5% trail
    pnlPct >= 2.5 ? Math.min(baseTrailPct, 0.01)  :  // +2.5%: lock to 1% trail
    pnlPct >= 1.5 ? Math.min(baseTrailPct, 0.02)  :  // +1.5%: lock to 2% trail
    baseTrailPct;
  const trailingStop = newHigh * (1 - trailPct);

  // Break-even floor — once up 1.5%, stop floors at entry price
  const breakEvenActive = newHigh >= position.entryPrice * 1.015;
  const effectiveStop = breakEvenActive ? Math.max(trailingStop, position.entryPrice) : trailingStop;

  console.log("\n── Exit Check ───────────────────────────────────────────\n");
  console.log(`  Open LONG from $${position.entryPrice.toFixed(2)} | Now: $${price.toFixed(2)} | P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`);
  console.log(`  Peak: $${newHigh.toFixed(2)} | Stop: $${effectiveStop.toFixed(2)} (ATR ${(trailPct*100).toFixed(1)}%) | ${breakEvenActive ? "🔒 Break-even active" : "⏳ Waiting for +1%"}\n`);

  const check = (label, condition) => {
    console.log(`  ${condition ? "🔴" : "✅"} ${label}`);
    if (condition) reasons.push(label);
  };

  if (position.entryType === "momentum") {
    // ── Momentum exit logic (new listing trades) ──────────────────────────
    // Tight 3% hard stop — new listings can crash fast
    const slPrice = position.entryPrice * 0.97;
    check(`Momentum stop-loss — $${slPrice.toFixed(4)} (-3%)`, price <= slPrice);

    // 10% take profit — capture the pump
    check(`Momentum TP hit — +10%`, pnlPct >= 10);

    // RSI dropped below 50 — momentum has faded, exit
    check(`RSI(3) below 50 — momentum faded`, rsi3 < 50);

    // Volume dried up (< 60% of avg) — pump is over
    if (candles) {
      const vol = calcVolume(candles);
      check(`Volume dried up (< 60% of avg)`, vol.current < vol.avg * 0.6);
    }

    // ATR trailing stop still applies
    check(`ATR stop hit — $${effectiveStop.toFixed(2)} (${breakEvenActive ? "break-even floor" : `${(trailPct*100).toFixed(1)}% trail`})`, price < effectiveStop);
  } else {
    // ── Snap-back / standard exit logic ──────────────────────────────────
    // Per-coin stop-loss from backtest (default 4%)
    const btSl = (typeof BACKTEST !== "undefined") ? BACKTEST[position.symbol || ""] : null;
    const slPct = position.bearMarket ? 0.02 : (btSl?.stopLoss ?? 0.04);
    const slPrice = position.entryPrice * (1 - slPct);
    check(`Stop-loss hit — $${slPrice.toFixed(4)} (-${(slPct*100).toFixed(0)}%${position.bearMarket ? " bear market" : ""})`, price <= slPrice);

    // RSI overbought — exit before momentum fully exhausts (captures more of the move)
    check(`RSI(3) overbought > 80 | Actual: ${rsi3.toFixed(2)}`, rsi3 > 80);
    // StochRSI exit requires confirmation — don't exit on StochRSI alone if P&L < 1% (let winners run)
    if (stochRsi) {
      const stochExitOk = stochRsi.overbought && (pnlPct >= 1.0 || rsi3 > 70 || (sr?.nearResistance ?? false));
      check(`StochRSI overbought > 80 | K=${stochRsi.k.toFixed(1)}${stochRsi.overbought && !stochExitOk ? " (holding — P&L < 1% and not at resistance)" : ""}`, stochExitOk);
    }
    if (bb) check(`BB% > 0.85 (at upper band) | BB%=${bb.pct.toFixed(2)}`, bb.pct > 0.85);
    // Snap-back entries start below VWAP deliberately — "trend reversed" doesn't apply.
    // Dynamic TP: exit RSI threshold shifts based on distance to resistance
    if (position.entryType === "snapback") {
      const distToRes = sr?.distToResistance ?? null;
      let snapRsiExit, snapLabel;
      if (distToRes !== null && distToRes < 1.5) {
        snapRsiExit = 65; snapLabel = `RSI(3) > 65 — near resistance ($${sr.nearestResistance?.toFixed(2)}, ${distToRes.toFixed(1)}% away)`;
      } else if (distToRes !== null && distToRes > 5) {
        snapRsiExit = 70; snapLabel = `RSI(3) > 70 — room to run (resistance ${distToRes.toFixed(1)}% away), holding longer`;
      } else {
        snapRsiExit = 55; snapLabel = `RSI(3) recovered above 55 — snap-back complete`;
      }
      check(snapLabel, rsi3 > snapRsiExit);
    } else {
      // Failed bounce — entered expecting snap-back but price kept falling with bearish momentum
      if (pnlPct < -1.5 && macd && !macd.bullish) {
        check(`Failed bounce — down ${pnlPct.toFixed(2)}% with bearish MACD (cut loss early)`, true);
      }
      // Exit when VWAP is meaningfully breached AND MACD confirms bearish momentum
      // Require >0.2% below VWAP to avoid exiting on a 0.001 tick below VWAP
      const vwapBreachPct = (vwap - price) / vwap * 100;
      const macdBearish = !macd ? vwapBreachPct > 0.5 : macd.histogram < 0;
      check(`Trend reversed — ${vwapBreachPct.toFixed(2)}% below VWAP${macd && macdBearish ? " with bearish MACD" : ""}`, price < vwap && macdBearish && vwapBreachPct > 0.2);
    }
    check(`ATR stop hit — $${effectiveStop.toFixed(2)} (${breakEvenActive ? "break-even floor" : `${(trailPct*100).toFixed(1)}% trail`})`, price < effectiveStop);

    // Max hold time — exit stale trades before they turn into big losses
    if (position.entryTime) {
      const hoursOpen = (Date.now() - new Date(position.entryTime).getTime()) / (1000 * 60 * 60);
      if (hoursOpen > 10) {
        check(`Max hold exceeded — open ${hoursOpen.toFixed(1)}h (limit 10h)`, true);
      } else if (hoursOpen > 4 && pnlPct < 0) {
        check(`Stale trade — open ${hoursOpen.toFixed(1)}h with P&L ${pnlPct.toFixed(2)}%`, true);
      }
    }
  }

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
    .filter(t => t.orderPlaced)
    .slice(-5)
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
  const srLine    = sr    ? `\n- Support:    ${sr.nearestSupport ? `$${sr.nearestSupport.toFixed(2)} (${sr.distToSupport?.toFixed(2)}% below, ${sr.supportConf} TF confluences)${sr.nearSupport ? " ✅ near support" : ""}` : "not found"} | Resistance: ${sr.nearestResistance ? `$${sr.nearestResistance.toFixed(2)} (${sr.distToResistance?.toFixed(2)}% above, ${sr.resistanceConf} TF confluences)${sr.nearResistance ? " ⚠️ near resistance ceiling" : ""}` : "not found"}` : "";
  const trendLine = bullTrend4h !== undefined ? `\n- Trend (1H/4H): ${bullTrend4h ? "✅ Bullish — higher timeframe confirms" : "🔴 Bearish — counter-trend trade, only buy if setup is exceptional (RSI very low, strong volume, clear support). Reduce confidence by 15-20pts if uncertain."}` : "";
  const ema21Line = ema21 ? `\n- EMA(21):    $${ema21.toFixed(2)} (${ema8 > ema21 ? "✅ EMA8 above" : "🔴 EMA8 below"})` : "";
  const volLine   = vol   ? `\n- Volume:     ${vol.aboveAvg ? "✅ above avg" : "⚠️ below avg"} (${(vol.current / vol.avg * 100).toFixed(0)}% of 20-bar avg)` : "";

  const userMessage = `Current snapshot:
- Price:      $${price.toFixed(2)}
- EMA(8):     $${ema8.toFixed(2)} (${distEMA >= 0 ? "+" : ""}${distEMA.toFixed(2)}% vs price)${ema21Line}
- VWAP:       $${vwap.toFixed(2)} (${distVWAP >= 0 ? "+" : ""}${distVWAP.toFixed(2)}% vs price)
- RSI(3):     ${rsi3.toFixed(2)}${macdLine}${bbLine}${adxLine}${patternsLine}${srLine}${trendLine}${volLine}${btLine}${positionLine}${tvLine}${winRateLine}

Recent trade history (last 5 executed):
${recentHistory || "No prior trades recorded."}

${hasPosition ? "EXIT or HOLD?" : "BUY or HOLD?"}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 150,
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

function signBitGetPassphrase() {
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(CONFIG.bitget.passphrase)
    .digest("base64");
}

async function getSpotBalance(coin) {
  const timestamp = Date.now().toString();
  const path = "/api/v2/spot/account/assets";
  const sign = signBitGet(timestamp, "GET", path);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    headers: {
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": sign,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
      "locale": "en-US",
    },
  });
  const data = await res.json();
  const asset = data.data?.find(a => a.coin === coin);
  return parseFloat(asset?.available ?? "0");
}

const _symbolPrecisionCache = {};
async function getQuantityPrecision(symbol) {
  if (_symbolPrecisionCache[symbol] !== undefined) return _symbolPrecisionCache[symbol];
  try {
    const res = await fetch(`${CONFIG.bitget.baseUrl}/api/v2/spot/public/symbols?symbol=${symbol}`);
    const data = await res.json();
    const precision = parseInt(data.data?.[0]?.quantityPrecision ?? "6", 10);
    _symbolPrecisionCache[symbol] = precision;
    return precision;
  } catch {
    return 6;
  }
}

function floorToDecimals(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.floor(value * factor) / factor;
}

async function placeBitGetOrder(symbol, side, sizeUSD, price, quantityOverride = null) {
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/place-order"
      : "/api/v2/mix/order/place-order";

  // Spot market BUY: size = USDT to spend
  // Spot market SELL: size = actual token balance, floored to symbol's quantity precision
  // Futures: use calculated quantity
  let orderSize;
  if (CONFIG.tradeMode === "spot" && side === "buy") {
    orderSize = sizeUSD.toFixed(2);
  } else if (CONFIG.tradeMode === "spot" && side === "sell") {
    const baseCoin = symbol.replace("USDT", "");
    const available = await getSpotBalance(baseCoin);
    if (available <= 0) throw new Error(`No ${baseCoin} balance to sell`);
    const precision = await getQuantityPrecision(symbol);
    const floored = floorToDecimals(available, precision);
    orderSize = floored.toFixed(precision);
  } else {
    orderSize = quantityOverride ?? (sizeUSD / price).toFixed(6);
  }

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    size: orderSize,
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
      "locale": "en-US",
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  // For spot BUY: verify coins actually landed — track incremental gain only (not dust)
  if (CONFIG.tradeMode === "spot" && side === "buy") {
    const baseCoin = symbol.replace("USDT", "");
    const balanceBefore = await getSpotBalance(baseCoin);
    // Retry up to 3 times with increasing delays (some coins settle slowly)
    let received = 0;
    for (const delay of [3000, 4000, 5000]) {
      await new Promise(r => setTimeout(r, delay));
      const balanceAfter = await getSpotBalance(baseCoin);
      received = balanceAfter - balanceBefore;
      if (received > 0) break;
    }
    const minExpected = sizeUSD / price * 0.90; // allow 10% slippage
    if (received < minExpected) {
      // Log the position anyway using estimated qty — don't throw, order was placed
      const estimatedQty = sizeUSD / price;
      console.log(`⚠️  Balance check uncertain — using estimated qty ${estimatedQty.toFixed(6)} ${baseCoin} (received: ${received.toFixed(6)})`);
      return { ...data.data, confirmedQty: estimatedQty };
    }
    console.log(`✅ Balance confirmed: +${received.toFixed(6)} ${baseCoin} received (pre-existing: ${balanceBefore.toFixed(6)})`);
    return { ...data.data, confirmedQty: received };
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
  else console.log(`  Trigger: ⏱ 5-min poll — ${symbol}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));

  // Per-coin timeframe — use backtest optimal TF if available, else global default
  const bt = BACKTEST[symbol];
  const entryTF = bt?.timeframe || CONFIG.timeframe;
  // Bar limits per TF so we always cover ~500 1H-equivalent bars of history
  const TF_LIMITS = { "5m": 2000, "15m": 1000, "30m": 800, "1H": 500, "4H": 200 };
  const entryBars = TF_LIMITS[entryTF] || 500;

  // Load log and check daily limits
  const log = loadLog();

  // Fix 5: Auto-sync portfolio value from real BitGet balance at day start
  if (log._needsPortfolioSync) {
    try {
      const ts = Date.now().toString();
      const syncPath = "/api/v2/spot/account/assets";
      const syncSign = crypto.createHmac("sha256", process.env.BITGET_SECRET_KEY)
        .update(ts + "GET" + syncPath).digest("base64");
      const syncRes = await fetch(`${process.env.BITGET_BASE_URL}${syncPath}`, {
        headers: { "ACCESS-KEY": process.env.BITGET_API_KEY, "ACCESS-SIGN": syncSign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": process.env.BITGET_PASSPHRASE, "locale": "en-US" }
      });
      const syncData = await syncRes.json();
      const usdtBalance = parseFloat(syncData.data?.find(a => a.coin === "USDT")?.available ?? "0");
      if (usdtBalance > 0) {
        log.portfolioValue = usdtBalance;
        log.dayStartValue = usdtBalance;
        log._needsPortfolioSync = false;
        saveLog(log);
        console.log(`\n🔄 Portfolio synced from BitGet: $${usdtBalance.toFixed(4)} USDT`);
      }
    } catch (e) {
      console.log(`\n⚠️  Portfolio sync failed: ${e.message}`);
    }
  }

  const coinRsiThreshold = getCoinRsiThreshold(symbol, log);
  const learnedSource = log?.learnedThresholds?.[symbol]?.basedOnTrades >= 5 ? "live" : "backtest";
  console.log(`\nStrategy: ${rules.strategy.name} v4`);
  console.log(`Symbol: ${symbol} | TF: ${entryTF}${bt ? ` (${learnedSource}: WR ${log?.learnedThresholds?.[symbol]?.winRate ?? bt.winRate}%, RSI gate <${coinRsiThreshold})` : " (default)"}`);
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Daily profit target — lock in gains, stop trading for the day once hit
  const dailyProfit = checkDailyProfitTarget(log);
  console.log(`\n🎯 Daily goal: $${dailyProfit.startValue.toFixed(2)} → $${(dailyProfit.startValue * 1.3).toFixed(2)} (+30%) | Current: $${dailyProfit.currentValue.toFixed(2)} (${dailyProfit.gainPct >= 0 ? "+" : ""}${dailyProfit.gainPct.toFixed(2)}%)`);
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

  // Fetch candle data — entry TF + 15min + 1H + 4H + daily + weekly
  console.log("\n── Fetching market data from BitGet ────────────────────\n");
  const [candles, candles15m, candles1h, candles4h, candlesDay, candlesWeek] = await Promise.all([
    fetchCandles(symbol, entryTF, entryBars),
    fetchCandles(symbol, "15m", 100),
    fetchCandles(symbol, entryTF === "1H" ? "4H" : "1H", 100),
    fetchCandles(symbol, "4H", 100),
    fetchCandles(symbol, "1D", 90),
    fetchCandles(symbol, "1W", 52).catch(() => []),
  ]);
  const closes = candles.map((c) => c.close);
  const closes15m = candles15m.map((c) => c.close);
  const closes1h = candles1h.map((c) => c.close);
  const closes4h = candles4h.map((c) => c.close);
  const closesWeek = candlesWeek.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Entry TF indicators
  const ema8  = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const vwap  = calcVWAP(candles);
  const rsi3  = calcRSI(closes, 3);
  const rsi15m = closes15m.length > 5 ? calcRSI(closes15m, 3) : null;
  const vol   = calcVolume(candles);

  // 1H trend confirmation
  const ema8_1h  = calcEMA(closes1h, 8);
  const ema21_1h = calcEMA(closes1h, 21);
  const bullTrend1h = ema8_1h > ema21_1h;

  // 4H trend confirmation
  const ema8_4h  = calcEMA(closes4h, 8);
  const ema21_4h = calcEMA(closes4h, 21);
  const bullTrend4h = ema8_4h > ema21_4h;

  // Weekly trend — determines if we're in a bull or bear macro phase
  const ema8_week  = closesWeek.length > 10 ? calcEMA(closesWeek, 8) : null;
  const ema21_week = closesWeek.length > 21 ? calcEMA(closesWeek, 21) : null;
  const bullTrendWeekly = ema8_week !== null && ema21_week !== null ? ema8_week > ema21_week : null;

  // 4H must be bullish — higher timeframe context is the strongest filter
  const bullTrendConfirmed = bullTrend4h;

  // Advanced indicators
  const macd       = calcMACD(closes);
  const bb         = calcBollingerBands(closes);
  const adx        = calcADX(candles);
  const patterns   = detectCandlePatterns(candles);
  const sr         = calcSupportResistance(candles, candles4h, candlesDay);
  const stochRsi   = calcStochRSI(closes);
  const divergence = detectBullishDivergence(candles);

  console.log(`  EMA(8):   $${ema8.toFixed(2)} | EMA(21): $${ema21.toFixed(2)} | ${ema8 > ema21 ? "✅ entry TF uptrend" : "🔴 entry TF downtrend"}`);
  console.log(`  1H trend: EMA(8) $${ema8_1h.toFixed(2)} vs EMA(21) $${ema21_1h.toFixed(2)} | ${bullTrend1h ? "✅ 1H uptrend" : "🔴 1H downtrend"}`);
  console.log(`  4H trend: EMA(8) $${ema8_4h.toFixed(2)} vs EMA(21) $${ema21_4h.toFixed(2)} | ${bullTrend4h ? "✅ 4H uptrend" : "🔴 4H downtrend"}`);
  if (bullTrendWeekly !== null) console.log(`  Weekly:   EMA(8) $${ema8_week.toFixed(4)} vs EMA(21) $${ema21_week.toFixed(4)} | ${bullTrendWeekly ? "✅ Weekly bull market" : "🔴 Weekly bear market — stricter filters apply"}`);
  if (rsi15m !== null) console.log(`  RSI(15m): ${rsi15m.toFixed(2)}`);
  console.log(`  VWAP:     $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):   ${rsi3 !== null && rsi3 !== undefined ? rsi3.toFixed(2) : "N/A"}`);
  console.log(`  Volume:   ${vol.aboveAvg ? "✅ above avg" : "⚠️  below avg"} (${(vol.current / vol.avg * 100).toFixed(0)}% of avg)`);
  console.log(`  MACD:     ${macd.bullish ? "✅ bullish" : "🔴 bearish"} | hist ${macd.histogram.toFixed(4)}`);
  console.log(`  Bollinger: BB% ${(bb.pct * 100).toFixed(1)}% | width ${bb.width.toFixed(2)}% | ${bb.pct < 0.2 ? "⬇️ near lower band" : bb.pct > 0.8 ? "⬆️ near upper band" : "↔️ mid-range"}`);
  console.log(`  ADX:      ${adx ? `${adx.adx.toFixed(2)} (${adx.trending ? "✅ trending" : "⚠️ choppy"}) | +DI ${adx.plusDI.toFixed(1)} -DI ${adx.minusDI.toFixed(1)}` : "N/A"}`);
  console.log(`  StochRSI: K=${stochRsi ? stochRsi.k.toFixed(1) : "N/A"} | ${stochRsi?.oversold ? "✅ oversold" : stochRsi?.overbought ? "⚠️ overbought" : "neutral"}`);
  console.log(`  Divergence: ${divergence ? "✅ Bullish divergence detected!" : "none"}`);
  console.log(`  Patterns: ${patterns.length ? patterns.join(", ") : "None detected"}`);
  console.log(`  S/R:      Support $${sr.nearestSupport?.toFixed(2) ?? "?"} (${sr.distToSupport?.toFixed(2) ?? "?"}% below, ${sr.supportConf ?? 0} TF confluences) | Resistance $${sr.nearestResistance?.toFixed(2) ?? "?"} (${sr.distToResistance?.toFixed(2) ?? "?"}% above, ${sr.resistanceConf ?? 0} TF confluences)${sr.nearSupport ? " ✅ near support" : ""}${sr.nearResistance ? " ⚠️ near resistance" : ""}`);

  if (vwap === null || rsi3 === null) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  const currentPortfolio = log.portfolioValue || CONFIG.portfolioValue;
  // Kelly Criterion sizing — optimal fraction based on live win rate + payoff ratio per coin
  const kellySizePct = kellyPositionPct(log, symbol, CONFIG.maxTradeSizePct || 0.25);
  const sizePct = kellySizePct;
  // Scale down as daily losses accumulate
  const drawdownScale = drawdown.drawdownPct > 7 ? 0.30 : drawdown.drawdownPct > 5 ? 0.50 : drawdown.drawdownPct > 3 ? 0.75 : 1.0;
  const rawSize = currentPortfolio * sizePct * adaptive.sizeMultiplier * drawdownScale;
  const tradeSize = CONFIG.maxTradeSizeUSD ? Math.min(rawSize, CONFIG.maxTradeSizeUSD) : rawSize;
  if (drawdownScale < 1.0) console.log(`\n⚠️  Drawdown scaling: ${(drawdownScale * 100).toFixed(0)}% position size (down ${drawdown.drawdownPct.toFixed(1)}% today)`);
  console.log(`\n💰 Portfolio: $${currentPortfolio.toFixed(4)} | Trade size: $${tradeSize.toFixed(4)} (Kelly ${(sizePct * 100).toFixed(0)}%)`);

  const CONFIDENCE_MIN = log.learnedThresholds?._confidenceMin ?? adaptive.confidenceMin;
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
    const { shouldExit, reasons, newHigh } = checkExitConditions(position, price, ema8, vwap, rsi3, candles, stochRsi, bb, sr, macd);
    // Update high watermark for trailing stop
    if (newHigh > (position.highWatermark || 0)) {
      log.positions[symbol] = { ...position, highWatermark: newHigh };
      saveLog(log);
    }

    // TradingView SELL overrides rule check — indicator says exit now
    let finalExit = tvSignal === "SELL" ? true : shouldExit;
    let claudeAnalysis = null;

    // Hard stops are non-negotiable — Claude cannot override these
    const HARD_EXIT_KEYWORDS = ["Stop-loss", "ATR stop", "Emergency", "Max hold", "Stale trade", "Failed bounce", "Momentum stop"];
    const hasHardExit = reasons.some(r => HARD_EXIT_KEYWORDS.some(kw => r.startsWith(kw)));

    if (hasHardExit) {
      finalExit = true;
      console.log(`\n⚠️  Hard stop — Claude analysis skipped (${reasons.filter(r => HARD_EXIT_KEYWORDS.some(kw => r.startsWith(kw))).join(", ")})`);
    } else if (anthropic) {
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

    // Only persist actual exits (order placed) — not hold decisions
    if (logEntry.orderPlaced) {
      log.trades.push(logEntry);
      saveLog(log);
      console.log(`\nDecision log saved → ${LOG_FILE}`);
      writeTradeCsv(logEntry);
      const changed = learnFromTrades(log);
      if (changed) saveLog(log);
    } else {
      saveLog(log); // still save watermark/position updates
    }

  } else {
    // ── ENTRY FLOW ──────────────────────────────────────────────────────────

    // Time-of-day filter — only trade EU + US sessions (08:00–20:00 UTC)
    // Data: 9-12 UTC 8/8 wins, 16 UTC 6/6 wins, 19 UTC 8/8 wins. 20-08 UTC: 0/8 wins avg -1.9%
    const utcHour = new Date().getUTCHours();
    if (utcHour >= 20 || utcHour < 8) {
      console.log(`🚫 OFF-HOURS BLOCK — ${utcHour}:00 UTC is outside 08:00–20:00 UTC trading window (EU + US sessions only).`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Upgrade 1: ETH correlation filter — ETH leads altcoins; if ETH dropped >2% last hour, skip
    try {
      const ethCandles = await fetchCandles("ETHUSDT", "1H", 3);
      if (ethCandles.length >= 2) {
        const ethHourChange = (ethCandles[ethCandles.length - 1].close - ethCandles[ethCandles.length - 2].close) / ethCandles[ethCandles.length - 2].close * 100;
        console.log(`  ETH 1H change: ${ethHourChange >= 0 ? "+" : ""}${ethHourChange.toFixed(2)}%`);
        if (ethHourChange <= -2) {
          console.log(`🚫 ETH CORRELATION BLOCK — ETH dropped ${ethHourChange.toFixed(2)}% in the last hour. Altcoins will follow.`);
          console.log("═══════════════════════════════════════════════════════════\n");
          return;
        }
      }
    } catch { /* non-critical */ }

    // BTC daily RSI — macro sentiment gauge (fear/greed proxy used by top analysts)
    // Below 35 = fear = better buying opportunities. Above 70 = greed = be selective.
    let btcDailyRsi = null;
    try {
      const btcDailyCandles = await fetchCandles("BTCUSDT", "1D", 20);
      btcDailyRsi = calcRSI(btcDailyCandles.map(c => c.close), 14);
      const sentiment = btcDailyRsi < 35 ? "😱 Fear — contrarian opportunity" : btcDailyRsi > 70 ? "🤑 Greed — be selective" : "😐 Neutral";
      console.log(`  BTC daily RSI(14): ${btcDailyRsi.toFixed(1)} — ${sentiment}`);
    } catch { /* non-critical */ }

    // Funding rate — crowd positioning signal for this coin's perp market
    // Very negative: shorts overcrowded → squeeze risk = strong buy. Very positive: longs overcrowded → trap.
    let fundingRate = null;
    try {
      fundingRate = await getFundingRate(symbol);
      if (fundingRate !== null) {
        const frPct = (fundingRate * 100).toFixed(4);
        const frLabel = fundingRate < -0.0003 ? " ✅ shorts overcrowded — squeeze risk" : fundingRate > 0.0005 ? " ⚠️ longs overcrowded — dangerous" : "";
        console.log(`  Funding rate (${symbol}): ${frPct}%${frLabel}`);
        if (fundingRate > 0.0005) {
          console.log(`🚫 FUNDING RATE BLOCK — +${frPct}% means longs are crowded. Price is likely to fall to liquidate them.`);
          console.log("═══════════════════════════════════════════════════════════\n");
          return;
        }
      }
    } catch { /* non-critical */ }

    // Permanent exclusion — coins with proven negative edge across all live trades
    const PERMANENT_EXCLUDE = ["ARBUSDT", "VIRTUALUSDT", "SUIUSDT"];
    if (PERMANENT_EXCLUDE.includes(symbol)) {
      console.log(`🚫 EXCLUDED — ${symbol} has a proven negative edge in live trading. Skipping permanently.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Upgrade 2: Auto-blacklist — skip coins with 2+ losses in the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentLossesOnCoin = log.trades.filter(t =>
      t.type === "exit" && t.symbol === symbol && t.orderPlaced &&
      t.pnlPct !== undefined && t.pnlPct < -0.5 && t.timestamp > sevenDaysAgo
    ).length;
    if (recentLossesOnCoin >= 2) {
      console.log(`🚫 AUTO-BLACKLIST — ${symbol} has ${recentLossesOnCoin} losses (< -0.5%) in the last 7 days. Skipping.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Upgrade 3: Minimum 10min between any entries (no chasing)
    const lastEntry = log.trades.filter(t => t.type === "entry" && t.orderPlaced).slice(-1)[0];
    if (lastEntry) {
      const minsSinceLast = (Date.now() - new Date(lastEntry.timestamp).getTime()) / 60000;
      if (minsSinceLast < 15) {
        console.log(`🚫 ENTRY COOLDOWN — last entry was ${minsSinceLast.toFixed(0)}min ago. Waiting 15min between entries.`);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }
    }

    // VWAP Bounce Mode — price at VWAP support, ready to bounce
    // Pro scalpers BUY AT VWAP, not after it bounces — VWAP is the entry, not the confirmation
    const _vwapPct = (price - vwap) / vwap * 100;
    const _nearVwap = _vwapPct >= -1.5 && _vwapPct <= 2.0; // within 1.5% below or 2% above VWAP
    const vwapBounceMode = _nearVwap && rsi3 < 70;
    if (vwapBounceMode) {
      console.log(`  ✅ VWAP BOUNCE MODE — price $${price.toFixed(4)} is ${_vwapPct.toFixed(2)}% from VWAP $${vwap.toFixed(4)}`);
    }

    // Upgrade 4: Weekly trend filter — in a weekly bear, require RSI < 25 (oversold only)
    // Bypassed in VWAP bounce mode — a VWAP touch is universal support regardless of weekly trend
    if (!vwapBounceMode && bullTrendWeekly === false && rsi3 > 25) {
      console.log(`🚫 WEEKLY BEAR FILTER — weekly trend is bearish and RSI(3)=${rsi3.toFixed(1)} is not low enough (need < 25 in bear market).`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    if (bullTrendWeekly !== null) console.log(`  Weekly trend: ${bullTrendWeekly ? "✅ Bull market — normal filters" : vwapBounceMode ? "⚠️  Bear market — bypassed (VWAP bounce active)" : "⚠️  Bear market — RSI < 25 required"}`);

    // Upgrade 5: Support proximity — only enter within 3% of a key support level
    if (sr.nearestSupport && sr.distToSupport !== null && sr.distToSupport > 4) {
      console.log(`🚫 SUPPORT BLOCK — price is ${sr.distToSupport.toFixed(2)}% above nearest support ($${sr.nearestSupport.toFixed(4)}). Need to be within 4% of support.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    if (sr.nearestSupport) console.log(`  ✅ Near support — $${sr.nearestSupport.toFixed(4)} (${sr.distToSupport?.toFixed(2)}% below price, ${sr.supportConf} TF confluences)`);

    // Fix 4: Max 3 concurrent positions
    const openPositions = Object.entries(log.positions || {}).filter(([,p]) => p && p.open);
    const openCount = openPositions.length;
    if (openCount >= 3) {
      const held = openPositions.map(([s]) => s).join(", ");
      console.log(`🚫 MAX POSITIONS — already holding ${held}. Max 3 positions at a time.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    if (openCount > 0 && openPositions.some(([s]) => s === symbol)) {
      console.log(`🚫 ALREADY HOLDING — already have an open position in ${symbol}.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Fix 3: Consecutive loss streak — 3 losses in a row = 4 hour pause
    const recentExits = log.trades.filter(t => t.type === "exit" && t.orderPlaced && t.pnlPct !== undefined).slice(-3);
    if (recentExits.length === 3 && recentExits.every(t => t.pnlPct < 0)) {
      const lastLoss = new Date(recentExits[recentExits.length - 1].timestamp);
      const hoursSince = (Date.now() - lastLoss.getTime()) / (1000 * 60 * 60);
      if (hoursSince < 4) {
        console.log(`🛑 STREAK PAUSE — 3 losses in a row. Cooling off for 4 hours (${(4 - hoursSince).toFixed(1)}h remaining).`);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }
    }

    // BTC trend filter — don't enter longs when BTC is crashing (>3% down today)
    try {
      const btcRes = await fetch("https://api.bitget.com/api/v2/spot/market/tickers");
      const btcJson = await btcRes.json();
      const btcTicker = btcJson.data?.find(t => t.symbol === "BTCUSDT");
      if (btcTicker) {
        const btcChange = parseFloat(btcTicker.change24h) * 100;
        console.log(`\n₿ BTC 24h: ${btcChange >= 0 ? "+" : ""}${btcChange.toFixed(2)}%`);
        if (btcChange <= -3) {
          console.log(`🛑 BTC TREND BLOCK — BTC is down ${btcChange.toFixed(2)}% today. Skipping new long entries to avoid catching falling knives.`);
          console.log("═══════════════════════════════════════════════════════════\n");
          return;
        }
      }
    } catch { /* non-critical — proceed if fetch fails */ }

    // Detect new listing — if < 168H of candle history, use momentum mode
    const isNewCoin = candles.length < 168;
    if (isNewCoin) {
      console.log(`\n🆕 NEW LISTING DETECTED — ${symbol} has only ${candles.length}H of history. Switching to momentum mode.`);
      console.log(`\n── Momentum Entry Check ─────────────────────────────────\n`);
      const { results: momResults, allPass: momPass } = checkMomentumEntry(price, ema8, candles, vol, rsi3, stochRsi);
      momResults.forEach(r => console.log(`  ${r.pass ? "✅" : "🚫"} ${r.label} (need ${r.required}, got ${r.actual})`));

      if (!momPass) {
        const failed = momResults.filter(r => !r.pass).map(r => r.label);
        console.log(`\n🚫 MOMENTUM BLOCK — conditions not met:\n   ${failed.join("\n   ")}`);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }

      console.log(`\n✅ MOMENTUM ENTRY — all conditions met. Buying ${symbol}.`);
      if (WATCHLIST.includes(symbol)) {
        console.log(`\n🔔🔔🔔 WATCHLIST ALERT — ${symbol} @ ${price.toFixed(4)}`);
        console.log(`🔔🔔🔔\n`);
      }

      // Place order
      const momEntry = {
        timestamp: new Date().toISOString(), type: "entry", symbol,
        timeframe: "1H", price, indicators: { ema8, vwap, rsi3 },
        conditions: momResults, allPass: true, claudeAnalysis: null,
        tradeSize, orderPlaced: false, orderId: null,
        paperTrading: CONFIG.paperTrading,
        limits: { maxTradeSizeUSD: CONFIG.maxTradeSizeUSD, maxTradesPerDay: CONFIG.maxTradesPerDay, tradesToday: countTodaysTrades(log) },
      };
      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER TRADE — would buy ${symbol} ~$${tradeSize.toFixed(2)} at market`);
        momEntry.orderPlaced = true;
        momEntry.orderId = `PAPER-${Date.now()}`;
        log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: (tradeSize / price).toFixed(6), orderId: momEntry.orderId, entryType: "momentum" } };
      } else {
        console.log(`\n🔴 PLACING LIVE MOMENTUM ORDER — $${tradeSize.toFixed(2)} BUY ${symbol}`);
        try {
          const order = await placeBitGetOrder(symbol, "buy", tradeSize, price);
          const actualQty = order.confirmedQty ?? (tradeSize / price);
          momEntry.orderPlaced = true;
          momEntry.orderId = order.orderId;
          log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: actualQty.toFixed(6), orderId: order.orderId, entryType: "momentum" } };
          console.log(`✅ MOMENTUM ORDER PLACED — ${order.orderId} | qty: ${actualQty.toFixed(6)} | stop: -3% | TP: +10%`);
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
          momEntry.error = err.message;
        }
      }
      if (momEntry.orderPlaced) {
        log.trades.push(momEntry);
        saveLog(log);
        writeTradeCsv(momEntry);
      }
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Same-day loss cooldown — block re-entry after 2+ stop-outs on the same coin today
    const today = new Date().toISOString().slice(0, 10);
    const todayLossesOnSymbol = log.trades.filter(t =>
      t.type === "exit" && t.symbol === symbol && t.orderPlaced === true &&
      t.pnlPct !== undefined && t.pnlPct < -1 &&
      t.timestamp?.startsWith(today)
    ).length;
    if (todayLossesOnSymbol >= 2) {
      console.log(`🚫 COOLDOWN — ${symbol} has ${todayLossesOnSymbol} stop-outs today. Skipping until tomorrow.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Upgrade 6: Multi-timeframe RSI — 15min RSI must also be oversold (< 40, or < 65 in VWAP bounce mode)
    const rsi15mLimit = vwapBounceMode ? 65 : 40;
    if (rsi15m !== null && rsi15m > rsi15mLimit) {
      console.log(`🚫 15MIN RSI BLOCK — RSI(15m)=${rsi15m.toFixed(1)} is not low enough (need < ${rsi15mLimit}${vwapBounceMode ? " — VWAP bounce mode" : ". 1H oversold but 15min recovering"}).`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    if (rsi15m !== null) console.log(`  ✅ 15min RSI ${rsi15m.toFixed(1)} confirmed (< ${rsi15mLimit})`);

    // Fix 1: Reversal confirmation — price bouncing right now or last candle showed reversal
    const formingCandle   = candles[candles.length - 1]; // currently forming (real-time price)
    const lastClosedCandle = candles[candles.length - 2];
    const prevCandle       = candles[candles.length - 3];
    const priceBouncing = formingCandle && lastClosedCandle && formingCandle.close > lastClosedCandle.close;
    const isClosingUp   = lastClosedCandle && prevCandle && lastClosedCandle.close > prevCandle.close;
    const isHigherHigh  = lastClosedCandle && prevCandle && lastClosedCandle.high  > prevCandle.high;
    const isHigherLow   = lastClosedCandle && prevCandle && lastClosedCandle.low   > prevCandle.low;
    const hasLongWick   = lastClosedCandle && (lastClosedCandle.high - lastClosedCandle.low) > 0 &&
                          (lastClosedCandle.close - lastClosedCandle.low) / (lastClosedCandle.high - lastClosedCandle.low) > 0.4;
    if (!priceBouncing && !isClosingUp && !isHigherHigh && !isHigherLow && !hasLongWick) {
      console.log(`🚫 REVERSAL BLOCK — price still falling (live:${formingCandle?.close.toFixed(4)} vs last close:${lastClosedCandle?.close.toFixed(4)})`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    const reason = priceBouncing ? `live price bouncing ($${formingCandle?.close.toFixed(4)} > $${lastClosedCandle?.close.toFixed(4)})` : isClosingUp ? "closing above prev close" : isHigherHigh ? "higher high" : isHigherLow ? "higher low" : "long lower wick";
    console.log(`  ✅ Reversal confirmed — ${reason}`);

    // Fix 2: Volume acceleration — buying pressure check
    const curVol  = candles[candles.length - 1].volume;
    const prevVol = candles[candles.length - 2].volume;
    const volAccel = curVol / prevVol;
    if (!vwapBounceMode && volAccel < 0.8) {
      console.log(`🚫 VOLUME BLOCK — volume fading (${volAccel.toFixed(2)}× prev candle). No buying pressure yet.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    console.log(`  ${volAccel >= 0.8 ? "✅" : "⚠️ "} Volume ${volAccel >= 1.2 ? "surging" : volAccel >= 0.8 ? "holding" : "light"} (${volAccel.toFixed(2)}× prev candle)${vwapBounceMode && volAccel < 0.8 ? " — bypassed (VWAP bounce)" : ""}`);

    // Live backtest gate — run fresh 1000-candle backtest before every buy
    console.log(`\n── Live Backtest Gate ───────────────────────────────────\n`);
    let btResult;
    try {
      btResult = await backtestCoin(symbol);
      const icon = btResult.recommendation === "TRADE" ? "✅" : btResult.recommendation === "CAUTION" ? "⚠️ " : "🚫";
      if (btResult.trades > 0) {
        console.log(`  ${icon} ${symbol}: WR ${btResult.winRate}%  n:${btResult.trades}  exp:+${btResult.expectancy}%  RSI<${btResult.rsiThreshold}  TP:${(btResult.takeProfit*100).toFixed(0)}%`);
      } else {
        console.log(`  🚫 ${symbol}: no valid setup found (65%+ WR, 5+ trades)`);
      }
    } catch (e) {
      console.log(`  ⚠️  Backtest failed (${e.message}) — proceeding with caution`);
      btResult = null;
    }
    if (btResult && btResult.recommendation === "SKIP" && !vwapBounceMode) {
      console.log(`🚫 BACKTEST BLOCK — ${symbol} has ${btResult.winRate}% win rate over ${btResult.trades} trades (need 65%+). Skipping.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    if (btResult && btResult.recommendation === "SKIP" && vwapBounceMode) {
      console.log(`  ⚠️  Backtest SKIP bypassed — VWAP bounce is a different setup not covered by historical RSI backtest`);
    }

    // Minimum R:R gate — potential gain must justify the stop loss risk
    if (sr.nearestResistance && sr.distToResistance !== null && !vwapBounceMode && btResult) {
      const slPct = (btResult.stopLoss ?? 0.04) * 100;
      const rr = sr.distToResistance / slPct;
      console.log(`  📐 R:R — resistance ${sr.distToResistance.toFixed(1)}% away | stop ${slPct.toFixed(0)}% | R:R ${rr.toFixed(2)}`);
      if (rr < 1.5) {
        console.log(`🚫 R:R BLOCK — R:R ${rr.toFixed(2)} < 1.5 minimum. Resistance $${sr.nearestResistance.toFixed(2)} too close relative to ${slPct.toFixed(0)}% stop.`);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }
    }

    // Use backtest-optimized threshold when available; adaptive mode threshold only as fallback
    // In VWAP bounce mode, use 65 as threshold (VWAP bounce can fire at mid-RSI)
    const hasBtThreshold = !!BACKTEST[symbol]?.rsiThreshold;
    const effectiveRsiThreshold = vwapBounceMode ? 65 : (hasBtThreshold ? coinRsiThreshold : Math.min(adaptive.rsiThreshold, coinRsiThreshold));
    const { results, allPass: rulesPass, entryType, entryScore: baseEntryScore } = runSafetyCheck(price, ema8, vwap, rsi3, rules, effectiveRsiThreshold, vol, ema21, bullTrendConfirmed, adx, stochRsi, divergence, bb, vwapBounceMode);

    // ── Advanced signal augmentation (ICT, funding rate, macro sentiment) ────
    const liquiditySweep = detectLiquiditySweep(candles);
    let entryScore = baseEntryScore;
    const advSignals = [];
    if (liquiditySweep)                              { entryScore += 3; advSignals.push("🎯 Liquidity sweep (stop hunt reversal)"); }
    if (fundingRate !== null && fundingRate < -0.0003) { entryScore += 2; advSignals.push(`💰 Funding ${(fundingRate*100).toFixed(4)}% — shorts squeezed`); }
    if (btcDailyRsi !== null && btcDailyRsi < 35)   { entryScore += 1; advSignals.push(`😱 BTC fear (RSI ${btcDailyRsi.toFixed(1)})`); }
    if (btcDailyRsi !== null && btcDailyRsi > 70)   { entryScore -= 1; advSignals.push(`🤑 BTC greed (RSI ${btcDailyRsi.toFixed(1)}) — raising bar`); }
    if (advSignals.length > 0) {
      console.log(`\n  ⚡ Advanced signals: ${advSignals.join(" | ")}`);
      console.log(`  Score: ${baseEntryScore} (base) → ${entryScore} (with advanced signals)`);
    }

    // Entry quality gate — trend-follow entries need score >= 3 (RSI extreme + 1 confirming signal)
    if (rulesPass && entryType === "trend-follow" && entryScore < 3 && !vwapBounceMode) {
      console.log(`🚫 ENTRY QUALITY BLOCK — score ${entryScore}/3 needed. Signals: RSI<20, BB%<0.35, StochRSI oversold, vol surge, divergence, liquidity sweep, or negative funding.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    // Snapback quality gate — counter-trend entries need confirmation (StochRSI/BB%/divergence)
    if (rulesPass && entryType === "snapback" && entryScore < 2 && !vwapBounceMode) {
      console.log(`🚫 SNAPBACK QUALITY BLOCK — score ${entryScore}/2 needed. Counter-trend needs: StochRSI oversold, BB% near low, RSI<15, divergence, or liquidity sweep.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // StochRSI entry block — don't buy when momentum is already overbought
    if (rulesPass && stochRsi && stochRsi.k > 75 && !vwapBounceMode) {
      console.log(`🚫 STOCHRSI BLOCK — K=${stochRsi.k.toFixed(1)} already overbought (>75). Wait for pullback before entering.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    let claudeAnalysis = null;
    let allPass = rulesPass;

    // Skip Claude if it said HOLD for this coin within the last 30 minutes
    const CLAUDE_COOLDOWN_MS = 60 * 60 * 1000;
    const lastClaudeEntry = log.trades
      .filter(t => t.symbol === symbol && t.claudeAnalysis)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    const claudeCoolingDown = lastClaudeEntry &&
      (Date.now() - new Date(lastClaudeEntry.timestamp).getTime()) < CLAUDE_COOLDOWN_MS &&
      lastClaudeEntry.claudeAnalysis.action !== "BUY";

    if (claudeCoolingDown) {
      console.log(`\n⏳ Claude cooldown — last said ${lastClaudeEntry.claudeAnalysis.action} ${Math.round((Date.now() - new Date(lastClaudeEntry.timestamp).getTime()) / 60000)}min ago`);
    }

    // Hard cap: max 10 Claude calls per calendar day to limit API spend
    const claudeCallsToday = log.trades.filter(t => t.claudeAnalysis && t.timestamp?.startsWith(today)).length;
    const claudeDailyCapReached = claudeCallsToday >= 10;
    if (claudeDailyCapReached) {
      console.log(`\n💰 Claude daily cap reached (${claudeCallsToday}/10) — using rule-based decision`);
    }

    if (anthropic && rulesPass && !claudeCoolingDown && !claudeDailyCapReached) {
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

      // Upgrade 7: Confidence score — scale position size by how many bonus signals fire
      const bonusSignals = [
        bullTrendWeekly === true,                          // weekly bull market
        sr.nearestSupport && sr.distToSupport < 1.5,      // very close to support
        sr.supportConf >= 2,                              // multi-TF support confluence
        divergence,                                        // bullish RSI divergence
        patterns.length > 0,                              // candle pattern detected
        rsi15m !== null && rsi15m < 20,                   // 15min deeply oversold
        vol.current > vol.avg * 1.5,                      // strong volume surge
        !sr.nearResistance,                               // clear of resistance ceiling
      ].filter(Boolean).length;
      const maxBonus = 8;
      const confidenceMultiplier = bonusSignals >= 6 ? 1.0 : bonusSignals >= 4 ? 0.90 : bonusSignals >= 2 ? 0.75 : 0.60;
      const finalTradeSize = tradeSize * confidenceMultiplier;
      logEntry.tradeSize = finalTradeSize;
      console.log(`\n📊 Confidence score: ${bonusSignals}/${maxBonus} bonus signals → ${(confidenceMultiplier * 100).toFixed(0)}% position size ($${finalTradeSize.toFixed(2)})`);

      // Watchlist alert — prominent console notice so it shows up in pm2 logs
      if (WATCHLIST.includes(symbol)) {
        console.log(`\n🔔🔔🔔 WATCHLIST ALERT — ${symbol} @ $${price.toFixed(4)}`);
        console.log(`   RSI(3):${rsi3.toFixed(1)}  VWAP:${vwap.toFixed(4)}  EMA8:${ema8.toFixed(4)}`);
        console.log(`   Entry type: ${entryType}  — all conditions met, buying now`);
        console.log(`🔔🔔🔔\n`);
      }

      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER TRADE — would buy ${symbol} ~$${finalTradeSize.toFixed(2)} at market`);
        console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-${Date.now()}`;
        log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: (finalTradeSize / price).toFixed(6), orderId: logEntry.orderId, entryType, bearMarket: bullTrendWeekly === false } };
      } else {
        console.log(`\n🔴 PLACING LIVE ORDER — $${finalTradeSize.toFixed(2)} BUY ${symbol}`);
        try {
          const order = await placeBitGetOrder(symbol, "buy", finalTradeSize, price);
          const actualQty = order.confirmedQty ?? (finalTradeSize / price);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: actualQty.toFixed(6), orderId: order.orderId, entryType, bearMarket: bullTrendWeekly === false } };
          console.log(`✅ ORDER PLACED — ${order.orderId} | qty: ${actualQty.toFixed(6)}`);
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
        }
      }
    }

    // Only persist meaningful events: real/paper orders or Claude consultations
    if (logEntry.orderPlaced || claudeAnalysis) {
      log.trades.push(logEntry);
      // Keep log bounded — retain all orderPlaced entries plus last 200 others
      const placed = log.trades.filter(t => t.orderPlaced);
      const unplaced = log.trades.filter(t => !t.orderPlaced).slice(-200);
      log.trades = [...placed, ...unplaced].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      saveLog(log);
      if (logEntry.orderPlaced) {
        console.log(`\nDecision log saved → ${LOG_FILE}`);
        writeTradeCsv(logEntry);
      }
    }
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
        version: "v5-per-coin-adaptive",
        mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
        symbols: CONFIG.symbols,
        coinConfig: CONFIG.symbols.reduce((acc, s) => {
          const b = BACKTEST[s];
          acc[s] = b ? `${b.timeframe} | WR ${b.winRate}% | PF ${b.profitFactor}` : `${CONFIG.timeframe} | no backtest`;
          return acc;
        }, {}),
        portfolio: `$${(log.portfolioValue || CONFIG.portfolioValue).toFixed(4)}`,
        dailyGoal: `$${dailyProfit.startValue.toFixed(2)} → $${(dailyProfit.startValue * 1.3).toFixed(2)} | ${dailyProfit.gainPct >= 0 ? "+" : ""}${dailyProfit.gainPct.toFixed(2)}% ${dailyProfit.targetHit ? "🏆 TARGET HIT" : ""}`,
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
    console.log(`   Polling:     every 5 minutes\n`);

    // Fetch top movers then run first scan
    (async () => {
      await refreshTopMovers();
      for (const sym of CONFIG.symbols) {
        await run(null, sym).catch((err) => console.error(`Startup ${sym} error:`, err));
      }
    })();
  });

  // Swap to fresh top movers every 4 hours
  setInterval(refreshTopMovers, 4 * 60 * 60 * 1000);

  // Check all symbols every 5 minutes
  setInterval(async () => {
    for (const sym of CONFIG.symbols) {
      await run(null, sym).catch((err) => console.error(`Poll ${sym} error:`, err));
    }
  }, 5 * 60 * 1000);
}
