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
import WebSocket from "ws";
import nodemailer from "nodemailer";

// ─── Email notifications ──────────────────────────────────────────────────────

const EMAIL_TO = process.env.NOTIFY_EMAIL || "joshualiversage01@gmail.com";
let _mailer = null;

function getMailer() {
  if (_mailer) return _mailer;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  _mailer = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  return _mailer;
}

async function sendEmail(subject, html) {
  const mailer = getMailer();
  if (!mailer) return;
  try {
    await mailer.sendMail({ from: `"Trading Bot 🤖" <${process.env.GMAIL_USER}>`, to: EMAIL_TO, subject, html });
    console.log(`📧 Email sent: ${subject}`);
  } catch (e) {
    console.log(`📧 Email failed: ${e.message}`);
  }
}

function emailEntry({ symbol, price, tradeSize, orderId }) {
  const coin = symbol.replace("USDT", "");
  return sendEmail(
    `📈 ENTRY — ${coin} @ $${price.toFixed(4)}`,
    `<h2 style="color:#16a34a">📈 New Position Opened</h2>
     <table style="font-size:16px;line-height:1.8">
       <tr><td><b>Coin</b></td><td>${coin}</td></tr>
       <tr><td><b>Entry Price</b></td><td>$${price.toFixed(4)}</td></tr>
       <tr><td><b>Size</b></td><td>$${tradeSize.toFixed(2)}</td></tr>
       <tr><td><b>Order ID</b></td><td>${orderId}</td></tr>
       <tr><td><b>Time</b></td><td>${new Date().toUTCString()}</td></tr>
     </table>`
  );
}

function emailExit({ symbol, price, entryPrice, pnlPct, pnlUSD, reasons, orderId }) {
  const coin = symbol.replace("USDT", "");
  const won = pnlPct >= 0;
  const icon = won ? "✅" : "❌";
  const color = won ? "#16a34a" : "#dc2626";
  return sendEmail(
    `${icon} EXIT — ${coin} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(2)})`,
    `<h2 style="color:${color}">${icon} Position Closed — ${won ? "WIN" : "LOSS"}</h2>
     <table style="font-size:16px;line-height:1.8">
       <tr><td><b>Coin</b></td><td>${coin}</td></tr>
       <tr><td><b>Entry</b></td><td>$${entryPrice.toFixed(4)}</td></tr>
       <tr><td><b>Exit</b></td><td>$${price.toFixed(4)}</td></tr>
       <tr><td><b>P&amp;L</b></td><td style="color:${color}"><b>${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(2)})</b></td></tr>
       <tr><td><b>Reason</b></td><td>${reasons?.join(", ") ?? "—"}</td></tr>
       <tr><td><b>Order ID</b></td><td>${orderId}</td></tr>
       <tr><td><b>Time</b></td><td>${new Date().toUTCString()}</td></tr>
     </table>`
  );
}

async function emailDailySummary(log) {
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades = (log.trades || []).filter(t => t.timestamp?.startsWith(today) && t.orderPlaced);
  const exits = todayTrades.filter(t => t.type === "exit" && t.pnlPct !== undefined);
  const entries = todayTrades.filter(t => t.type === "entry");
  const wins = exits.filter(t => t.pnlPct > 0).length;
  const losses = exits.filter(t => t.pnlPct <= 0).length;
  const totalPnlPct = exits.reduce((s, t) => s + t.pnlPct, 0);
  const totalPnlUSD = exits.reduce((s, t) => s + (t.pnlUSD || 0), 0);
  const portfolioVal = log.portfolioValue || 0;

  const rows = exits.map(t => {
    const won = t.pnlPct >= 0;
    return `<tr>
      <td>${t.symbol?.replace("USDT","")}</td>
      <td style="color:${won?"#16a34a":"#dc2626"}">${t.pnlPct >= 0?"+":""}${t.pnlPct.toFixed(2)}%</td>
      <td style="color:${won?"#16a34a":"#dc2626"}">${t.pnlUSD >= 0?"+":""}$${(t.pnlUSD||0).toFixed(2)}</td>
    </tr>`;
  }).join("");

  await sendEmail(
    `📊 Daily Summary — ${wins}W/${losses}L | ${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}% | $${portfolioVal.toFixed(2)} portfolio`,
    `<h2>📊 Daily Trading Summary — ${today}</h2>
     <table style="font-size:16px;line-height:1.8">
       <tr><td><b>Entries</b></td><td>${entries.length}</td></tr>
       <tr><td><b>Exits</b></td><td>${exits.length} (${wins}W / ${losses}L)</td></tr>
       <tr><td><b>Total P&amp;L</b></td><td style="color:${totalPnlPct>=0?"#16a34a":"#dc2626"}"><b>${totalPnlPct>=0?"+":""}${totalPnlPct.toFixed(2)}%</b></td></tr>
       <tr><td><b>P&amp;L (USD)</b></td><td style="color:${totalPnlUSD>=0?"#16a34a":"#dc2626"}"><b>${totalPnlUSD>=0?"+":""}$${totalPnlUSD.toFixed(2)}</b></td></tr>
       <tr><td><b>Portfolio</b></td><td>$${portfolioVal.toFixed(2)}</td></tr>
     </table>
     ${exits.length > 0 ? `<h3>Trade breakdown</h3>
     <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">
       <tr><th>Coin</th><th>P&amp;L %</th><th>P&amp;L $</th></tr>
       ${rows}
     </table>` : ""}`
  );
}

// Real-time price cache — updated by WebSocket stream, consumed by hard-stop monitor
const livePrices = new Map(); // symbol → { price, timestamp }
let priceStreamWs = null;
const _processingStops = new Set(); // guard against double-exits

// Signal log — ring buffer of last 60 scan decisions shown on dashboard
const signalLog = [];
function pushSignal(symbol, result, reason, indicators = {}) {
  signalLog.push({ time: new Date().toISOString(), symbol, result, reason, indicators });
  if (signalLog.length > 60) signalLog.shift();
}

// Dashboard pause flag — toggled via /api/pause and /api/resume
let _tradingPaused = false;

// Scan tracking — shown on dashboard
let _lastScanTime = null;   // ms epoch when last full cycle finished
let _lastScanCount = 0;     // how many coins were in last cycle
let _lastTradeAt = null;    // ISO timestamp of most recent executed order

// Per-coin latest scan data — shown in dashboard coin detail view
const coinSnapshots = {};

// Top 10 gainers cached from last refreshTopMovers() call
let _topGainers = [];

// Live portfolio value (USDT + open coin positions) — updated by buildStatusData on every dashboard poll
let _livePortfolioValue = null;

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

const SWING_BACKTEST = {}; // in-memory cache, 24h TTL

// ─── Config ────────────────────────────────────────────────────────────────

const WATCHLIST = (process.env.WATCHLIST || process.env.SYMBOLS || "")
  .replace(/^SYMBOLS=/i, "")
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
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "40"),
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

// ─── Multi-account support ────────────────────────────────────────────────────
const ACCOUNTS = [
  {
    id: 1, exchange: "bitget",
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
    portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
    logFile:    "safety-check-log.json",
  },
  ...(process.env.BITGET_API_KEY_2 ? [{
    id: 2, exchange: "bitget",
    apiKey:     process.env.BITGET_API_KEY_2,
    secretKey:  process.env.BITGET_SECRET_KEY_2,
    passphrase: process.env.BITGET_PASSPHRASE_2,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
    portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD_2 || process.env.PORTFOLIO_VALUE_USD || "1000"),
    logFile:    "safety-check-log-2.json",
  }] : []),
  ...(process.env.BITMART_API_KEY && process.env.BITMART_SECRET_KEY && process.env.BITMART_MEMO ? [{
    id: "BM", exchange: "bitmart",
    apiKey:     process.env.BITMART_API_KEY,
    secretKey:  process.env.BITMART_SECRET_KEY,
    memo:       process.env.BITMART_MEMO,
    baseUrl:    "https://api-cloud.bitmart.com",
    portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD_BITMART || process.env.PORTFOLIO_VALUE_USD || "1000"),
    logFile:    "safety-check-log-bitmart.json",
  }] : []),
];

// Active account context — set before each account's operation cycle (sequential, never concurrent)
let _currentAccount = ACCOUNTS[0];
const acct = () => _currentAccount;

// Per-side taker fee rate for the active exchange.
// BitGet spot: 0.10% | BitMart spot: 0.25%
function getFeePct() {
  return acct().exchange === "bitmart" ? 0.0025 : 0.0008;
}

// ─── Swing Trading Config ────────────────────────────────────────────────────
const SWING_ENABLED = process.env.SWING_TRADING !== "false"; // on by default
const SWING = {
  tf: "4H",
  bars: 200,              // ~33 days of 4H bars
  rsi3Gate: 35,           // 4H RSI(3) must be below this
  rsi14Gate: 45,          // OR 4H RSI(14) below this (medium-term oversold)
  takeProfit: 0.08,       // 8% target
  stopLoss: 0.04,         // 4% hard stop
  atrMult: 3.0,           // wider ATR trail than scalp
  partialAt: 0.05,        // take 30% off at +5%
  partialQty: 0.30,
  maxHoldH: 120,          // 5 days max
  sizePct: 0.20,          // 20% of portfolio per swing
  maxOpen: 2,             // max concurrent swing positions
  entryBlockH: [22, 6],   // no entries 22:00–06:00 UTC
};

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(acct().logFile)) return { trades: [], portfolioValue: acct().portfolioValue, dayStartValue: acct().portfolioValue, dayStartDate: new Date().toISOString().slice(0, 10), _needsPortfolioSync: true };
  let raw = readFileSync(acct().logFile);
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) raw = raw.slice(3);
  const log = JSON.parse(raw.toString("utf8"));
  // Reset day start value each new day
  const today = new Date().toISOString().slice(0, 10);
  if (!log.portfolioValue) log.portfolioValue = acct().portfolioValue;
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
  writeFileSync(acct().logFile, JSON.stringify(log, null, 2));
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
  if (recent.length < 3) return null; // not enough history (min 3 trades)
  // Count wins as > 0.25% net — filters out trades that were "positive" but lost money after fees (0.2% round-trip)
  const wins = recent.filter((t) => t.pnlPct > 0.25).length;
  return { winRate: wins / recent.length, sample: recent.length, wins };
}

// Read historical P&L stats from trades.csv — used as fallback when log lacks enough closed trades
function loadCsvStats() {
  try {
    if (!existsSync(CSV_FILE)) return null;
    const pnls = readFileSync(CSV_FILE, "utf8").split("\n")
      .filter(l => l.includes(",SELL,") && l.includes(",LIVE,") && l.includes("P&L:"))
      .map(l => { const m = l.match(/P&L: ([+-]?\d+\.?\d+)%/); return m ? parseFloat(m[1]) : null; })
      .filter(v => v !== null);
    if (pnls.length < 2) return null;
    const wins = pnls.filter(p => p > 0.25);
    const losses = pnls.filter(p => p <= 0.25);
    const wr = wins.length / pnls.length;
    const aw = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : null;
    const al = losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : null;
    return {
      winRatePct: wr * 100,
      winRateStr: `${wins.length}/${pnls.length} (${(wr * 100).toFixed(0)}%)`,
      avgWin: aw != null ? aw.toFixed(2) : null,
      avgLoss: al != null ? al.toFixed(2) : null,
      expectancy: pnls.length >= 2 ? (wr * (aw ?? 0) + (1 - wr) * (al ?? 0)).toFixed(2) : null,
      totalTrades: pnls.length,
      totalWins: wins.length,
    };
  } catch { return null; }
}

// Daily drawdown — sum of realised losses today vs portfolio value
function checkDailyDrawdown(log) {
  const today = new Date().toISOString().slice(0, 10);
  const todayExits = log.trades.filter(
    (t) => t.type === "exit" && t.timestamp.startsWith(today) && t.pnlUSD !== undefined,
  );
  const totalLoss = todayExits.reduce((sum, t) => sum + Math.min(t.pnlUSD, 0), 0);
  const drawdownPct = Math.abs(totalLoss) / (log.portfolioValue || acct().portfolioValue) * 100;
  const limit = 10; // 10% max daily loss
  return { drawdownPct, totalLoss, paused: drawdownPct >= limit, limit };
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

  // Walk-forward backtesting:
  // 1. Optimize parameters on the last 23 days (in-sample)
  // 2. Validate those parameters on the most recent 7 days (out-of-sample)
  // 3. Only trade if the strategy holds on recent market conditions
  // This prevents over-fitting to conditions that no longer exist
  const candles = await fetchCandles(symbol, "1H", 800); // ~33 days of hourly data

  if (candles.length < 200) {
    // Not enough history for walk-forward — use simple backtest
    const result = optimiseCoin(symbol, candles);
    result.symbol = symbol;
    BACKTEST[symbol] = result;
    return result;
  }

  const oosSize = Math.min(7 * 24, Math.floor(candles.length * 0.25)); // 7 days or 25%
  const inSample    = candles.slice(0, candles.length - oosSize);
  const outOfSample = candles.slice(candles.length - oosSize);

  // Optimize on in-sample window
  const inResult = optimiseCoin(symbol, inSample);
  if (inResult.recommendation === "SKIP") {
    BACKTEST[symbol] = { ...inResult, symbol };
    return BACKTEST[symbol];
  }

  // Validate on out-of-sample (most recent 7 days)
  const oosTrades = runBacktestSim(outOfSample, inResult.rsiThreshold, inResult.takeProfit, inResult.stopLoss);
  const oosWins = oosTrades.filter(t => t.win).length;
  const oosWR   = oosTrades.length > 0 ? oosWins / oosTrades.length : 0;
  const oosExp  = oosTrades.length > 0 ? oosTrades.reduce((s, t) => s + t.pct, 0) / oosTrades.length : 0;

  const result = { ...inResult, symbol, oosWinRate: +(oosWR * 100).toFixed(1), oosTrades: oosTrades.length, walkForward: true };

  if (oosTrades.length >= 3 && oosWR < 0.50) {
    // Parameters don't work on recent data — market conditions changed
    result.recommendation = "SKIP";
    console.log(`  🔴 Walk-forward FAILED — ${symbol}: OOS WR ${(oosWR*100).toFixed(0)}% on ${oosTrades.length} recent trades (need 50%+)`);
  } else if (oosTrades.length >= 3 && oosWR < 0.60) {
    result.recommendation = "CAUTION";
    console.log(`  ⚠️  Walk-forward CAUTION — ${symbol}: OOS WR ${(oosWR*100).toFixed(0)}% | exp ${oosExp >= 0 ? "+" : ""}${oosExp.toFixed(2)}%`);
  } else if (oosTrades.length >= 3) {
    console.log(`  ✅ Walk-forward PASSED — ${symbol}: OOS WR ${(oosWR*100).toFixed(0)}% on ${oosTrades.length} recent trades | exp +${oosExp.toFixed(2)}%`);
  } else {
    console.log(`  ℹ️  Walk-forward: only ${oosTrades.length} OOS trades — insufficient for validation`);
  }

  BACKTEST[symbol] = result;
  return result;
}

// ─── Swing Backtest ──────────────────────────────────────────────────────────

function runSwingBacktestSim(candles4h, rsiThreshold, takeProfit = 0.08, stopLoss = 0.04) {
  const closes = candles4h.map(c => c.close);
  const ema8   = calcEMASeries(closes, 8);
  const ema21  = calcEMASeries(closes, 21);
  const rsi3   = calcRSI3Series(closes);
  const vwap   = calcVWAPSeries(candles4h);
  const maxBars = 30; // 30 × 4H = 5 days max hold
  const trades = [];
  let inTrade = false, entry = 0, bar = 0;
  for (let i = 30; i < candles4h.length - 1; i++) {
    if (inTrade) {
      const pct = (candles4h[i].close - entry) / entry;
      if (pct >= takeProfit || pct <= -stopLoss || (i - bar) >= maxBars) {
        trades.push({ pct: pct * 100, win: pct > 0 });
        inTrade = false;
      }
      continue;
    }
    const p = candles4h[i].close, rv = rsi3[i];
    if (rv === null || rv === undefined) continue;
    if (p > vwap[i] && p > ema8[i] && ema8[i] > ema21[i] && rv < rsiThreshold) {
      inTrade = true; entry = candles4h[i + 1].open; bar = i + 1;
    }
  }
  return trades;
}

function optimiseSwingCoin(candles4h) {
  let best = null;
  for (const rsi of [20, 25, 30, 35, 40, 45]) {
    for (const tp of [0.05, 0.06, 0.08, 0.10, 0.12, 0.15]) {
      for (const sl of [0.03, 0.04, 0.05, 0.06]) {
        if (tp / sl < 1.5) continue; // enforce minimum R:R
        const trades = runSwingBacktestSim(candles4h, rsi, tp, sl);
        if (trades.length < 3) continue;
        const wins = trades.filter(t => t.win), losses = trades.filter(t => !t.win);
        const wr  = wins.length / trades.length;
        const aw  = wins.length   > 0 ? wins.reduce((s, t) => s + t.pct, 0)   / wins.length   : 0;
        const al  = losses.length > 0 ? losses.reduce((s, t) => s + t.pct, 0) / losses.length : 0;
        const exp = wr * aw + (1 - wr) * al;
        if (wr < 0.55 || exp <= 0) continue;
        const score = wr * exp;
        if (!best || score > best.score) {
          best = { rsiThreshold: rsi, takeProfit: tp, stopLoss: sl,
            trades: trades.length, winRate: +(wr * 100).toFixed(1),
            expectancy: +exp.toFixed(2), score };
        }
      }
    }
  }
  if (!best) return { trades: 0, winRate: 0, recommendation: "SKIP", rsiThreshold: 35, takeProfit: 0.08, stopLoss: 0.04 };
  return { ...best, recommendation: best.winRate >= 65 ? "TRADE" : "CAUTION" };
}

async function backtestSwingCoin(symbol) {
  const existing = SWING_BACKTEST[symbol];
  if (existing?.testedAt && Date.now() - new Date(existing.testedAt).getTime() < 24 * 60 * 60 * 1000) {
    return existing; // 24h cache — 4H data evolves slowly
  }

  let candles;
  try { candles = await fetchCandles(symbol, "4H", 200); }
  catch { return { recommendation: "SKIP", trades: 0 }; }
  if (!candles || candles.length < 60) return { recommendation: "SKIP", trades: 0 };

  // Walk-forward: last 7 days (42 × 4H bars) as out-of-sample
  const oosSize    = Math.min(42, Math.floor(candles.length * 0.25));
  const inSample   = candles.slice(0, candles.length - oosSize);
  const outSample  = candles.slice(candles.length - oosSize);

  const inResult = optimiseSwingCoin(inSample);
  if (inResult.recommendation === "SKIP") {
    SWING_BACKTEST[symbol] = { ...inResult, symbol, testedAt: new Date().toISOString() };
    return SWING_BACKTEST[symbol];
  }

  const oosTrades = runSwingBacktestSim(outSample, inResult.rsiThreshold, inResult.takeProfit, inResult.stopLoss);
  const oosWins = oosTrades.filter(t => t.win).length;
  const oosWR   = oosTrades.length > 0 ? oosWins / oosTrades.length : 0;
  const oosExp  = oosTrades.length > 0 ? oosTrades.reduce((s, t) => s + t.pct, 0) / oosTrades.length : 0;

  const result = { ...inResult, symbol, oosWinRate: +(oosWR * 100).toFixed(1),
    oosTrades: oosTrades.length, testedAt: new Date().toISOString() };

  if (oosTrades.length >= 2 && oosWR < 0.45) {
    result.recommendation = "SKIP";
    console.log(`  🔴 Swing WF FAILED — ${symbol}: OOS WR ${(oosWR*100).toFixed(0)}% (need 45%+)`);
  } else if (oosTrades.length >= 2 && oosWR < 0.55) {
    result.recommendation = "CAUTION";
    console.log(`  ⚠️  Swing WF CAUTION — ${symbol}: OOS WR ${(oosWR*100).toFixed(0)}%`);
  } else if (oosTrades.length >= 2) {
    console.log(`  ✅ Swing WF PASSED — ${symbol}: OOS WR ${(oosWR*100).toFixed(0)}% | exp +${oosExp.toFixed(2)}%`);
  }

  SWING_BACKTEST[symbol] = result;
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

    // Cache top 20 gainers for dashboard + momentum path
    _topGainers = allCoins
      .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPr), change24h: parseFloat(t.change24h) * 100, vol: parseFloat(t.usdtVolume) }))
      .filter(t => t.change24h > 0)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 20);

    // Score: weighted mix of volume rank + absolute 24h move (big moves = opportunity)
    const totalVol = allCoins.reduce((s, t) => s + parseFloat(t.usdtVolume), 0);
    const scored = allCoins.map(t => {
      const vol = parseFloat(t.usdtVolume);
      const chg = Math.abs(parseFloat(t.change24h)); // big moves (up OR down) = interesting
      const volScore = vol / totalVol * 100;
      const chgScore = Math.min(chg * 100, 30); // cap at 30 so mega-pumps don't dominate
      return { symbol: t.symbol, score: volScore * 0.4 + chgScore * 0.6, vol, chg: parseFloat(t.change24h) };
    }).sort((a, b) => b.score - a.score);

    // Take top 80 by score — broad market coverage: high-volume stalwarts + big movers
    const candidates = scored.slice(0, 80).map(t => t.symbol);
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

    // Add top daily gainers (5%+) directly — they get the momentum path in run(), skip backtest gate
    const bigMovers = _topGainers.filter(t => t.change24h >= 5).map(t => t.symbol);
    if (bigMovers.length > 0) console.log(`\n🚀 Big movers today (5%+): ${bigMovers.join(", ")}`);

    const combined = [...new Set([...qualified, ...heldSymbols, ...WATCHLIST, ...newListings, ...bigMovers])];

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
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
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
  const k = range === 0 ? (window[window.length - 1] >= 70 ? 100 : 0) : ((window[window.length - 1] - minR) / range) * 100;
  return { k, oversold: k < 20, overbought: k > 92 };
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

// OBV (On Balance Volume) — tells you whether real money is flowing in or out.
// Price can be manipulated; volume cannot lie. Rising OBV + rising price = healthy move.
// Divergence: price rising + OBV falling = smart money distributing = avoid entry.
function calcOBV(candles) {
  let obv = 0;
  const series = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i-1].close)      obv += candles[i].volume;
    else if (candles[i].close < candles[i-1].close) obv -= candles[i].volume;
    series.push(obv);
  }
  const recent = series.slice(-10);
  const rising = recent[recent.length - 1] > recent[0];
  // Divergence: price making higher highs but OBV falling = distribution
  const priceLast = candles[candles.length - 1].close;
  const priceFirst = candles[candles.length - 10]?.close ?? priceLast;
  const bearDivergence = priceLast > priceFirst && !rising;
  return { obv, rising, bearDivergence };
}

// Double bottom — price makes two lows at approximately the same level, then reverses.
// One of the most reliable reversal patterns. RSI making a higher low confirms it (divergence).
// Both bottoms must be within 1.5% of each other and separated by at least 5 bars.
function detectDoubleBottom(candles) {
  if (candles.length < 30) return false;
  const recent = candles.slice(-30);
  const lows = recent.map(c => c.low);
  // Find local valleys
  const valleys = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      valleys.push({ idx: i, low: lows[i] });
  }
  if (valleys.length < 2) return false;
  const v1 = valleys[valleys.length - 2];
  const v2 = valleys[valleys.length - 1];
  // Bottoms within 1.5% of each other and separated by at least 5 bars
  const levelMatch = Math.abs(v1.low - v2.low) / v1.low < 0.015;
  const separated  = (v2.idx - v1.idx) >= 5;
  if (!levelMatch || !separated) return false;
  // RSI divergence: RSI(3) at second bottom must be higher than at first bottom
  const closes = recent.map(c => c.close);
  const rsi1 = calcRSI(closes.slice(0, v1.idx + 1), 3);
  const rsi2 = calcRSI(closes.slice(0, v2.idx + 1), 3);
  const rsiDivergence = rsi1 !== null && rsi2 !== null && rsi2 > rsi1;
  // Pattern valid even without RSI divergence, stronger with it
  return { detected: true, strongConfirmation: rsiDivergence, low1: v1.low, low2: v2.low };
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
function kellyPositionPct(log, symbol, fallback = 0.20) {
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

// ─── Ichimoku Cloud ──────────────────────────────────────────────────────────
// The most comprehensive single indicator used by institutional traders.
// Combines trend direction, momentum, and support/resistance in one view.
function calcIchimoku(candles, tenkanP = 9, kijunP = 26, senkouBP = 52) {
  if (candles.length < senkouBP + kijunP) return null;
  const n = candles.length - 1;
  const midHL = (start, end) => {
    let h = -Infinity, l = Infinity;
    for (let i = start; i <= end; i++) { h = Math.max(h, candles[i].high); l = Math.min(l, candles[i].low); }
    return (h + l) / 2;
  };
  const tenkan  = midHL(n - tenkanP  + 1, n);
  const kijun   = midHL(n - kijunP   + 1, n);
  const senkouA = (tenkan + kijun) / 2;
  const senkouB = midHL(n - senkouBP + 1, n);
  const cloudTop    = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);
  const price = candles[n].close;
  return {
    tenkan, kijun, cloudTop, cloudBottom,
    aboveCloud:   price > cloudTop,
    inCloud:      price >= cloudBottom && price <= cloudTop,
    belowCloud:   price < cloudBottom,
    bullishCross: tenkan > kijun,  // tenkan above kijun = bullish momentum
  };
}

// ─── Market Regime Detection ─────────────────────────────────────────────────
// Detects whether the broader market is trending, ranging, or in high volatility.
// Different regimes favour different strategies — routing trades accordingly
// is one of the key edges of professional multi-strategy systems.
const _regimeCache = { value: null, ts: 0 };
async function detectMarketRegime() {
  if (_regimeCache.value && Date.now() - _regimeCache.ts < 10 * 60 * 1000) return _regimeCache.value;
  try {
    const btc = await fetchCandles("BTCUSDT", "4H", 60);
    if (!btc || btc.length < 30) return { regime: "UNKNOWN", btcTrend: "neutral", volatility: "normal" };
    const closes = btc.map(c => c.close);
    const ema8   = calcEMA(closes, 8);
    const ema21  = calcEMA(closes, 21);
    const curATR = calcATR(btc.slice(-14)) ?? 1;
    // Rolling average ATR over prior 30 bars (sample every 3 bars for speed)
    let atrSum = 0, atrCount = 0;
    for (let i = 14; i < btc.length - 14; i += 3) {
      const a = calcATR(btc.slice(i, i + 14));
      if (a) { atrSum += a; atrCount++; }
    }
    const avgATR = atrCount > 0 ? atrSum / atrCount : curATR;
    const volRatio = curATR / avgATR;
    const btcTrend = ema8 > ema21 * 1.005 ? "bull" : ema8 < ema21 * 0.995 ? "bear" : "neutral";
    const volatility = volRatio > 1.8 ? "high" : volRatio < 0.6 ? "low" : "normal";
    // BTC pump bypass — if the last 4H candle surged 2%+, treat as neutral even if EMA says bear.
    // This lets the bot catch breakout moves without waiting for slow EMAs to catch up.
    const last4hChange = (btc[btc.length - 1].close - btc[btc.length - 2].close) / btc[btc.length - 2].close;
    const btcPumping = last4hChange >= 0.02;
    const effectiveTrend = (btcTrend === "bear" && btcPumping) ? "neutral" : btcTrend;
    const regime = volatility === "high" ? "VOLATILE" : effectiveTrend === "bull" ? "TRENDING" : effectiveTrend === "bear" ? "BEAR" : "RANGING";
    if (btcPumping && btcTrend === "bear") console.log(`  ⚡ BTC pump bypass: last 4H +${(last4hChange*100).toFixed(1)}% — treating regime as RANGING despite BEAR EMA`);
    _regimeCache.value = { regime, btcTrend: effectiveTrend, volatility, volRatio: +volRatio.toFixed(2) };
    _regimeCache.ts = Date.now();
    return _regimeCache.value;
  } catch { return { regime: "UNKNOWN", btcTrend: "neutral", volatility: "normal" }; }
}

// ─── Portfolio Heat ───────────────────────────────────────────────────────────
// Tracks total $ at risk across ALL open positions (scalp + swing + breakout).
// Hard cap at 8% — never risk more than this simultaneously.
function calcPortfolioHeat(log, livePortfolioValue = null) {
  const portfolio = livePortfolioValue || log.portfolioValue || acct().portfolioValue;
  let totalRisk = 0;
  const positions = [];
  const addPos = (map, stopPct, type) => {
    for (const [sym, pos] of Object.entries(map || {})) {
      if (!pos?.open) continue;
      const risk = pos.entryPrice * stopPct * parseFloat(pos.quantity || 0);
      totalRisk += risk;
      positions.push({ sym, risk: +risk.toFixed(4), type });
    }
  };
  addPos(log.positions,         0.025, "scalp");    // ~2.5% scalp stop
  addPos(log.swingPositions,    SWING.stopLoss, "swing");
  addPos(log.breakoutPositions, 0.03,  "breakout"); // 3% breakout stop
  const heatPct = portfolio > 0 ? (totalRisk / portfolio) * 100 : 0;
  return { heatPct: +heatPct.toFixed(2), totalRisk, positions, isOverheated: heatPct > 8 };
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
      console.log(`  ℹ️  StochRSI K=${stochRsi.k.toFixed(1)}: ${stochRsi.oversold ? "✅ oversold (<20)" : stochRsi.overbought ? "⚠️ overbought (>88)" : "neutral"}`);
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
    // Neutral bias — allow entry if RSI is oversold (uses same threshold as bullish path)
    if (rsi3 !== null && rsi3 < rsiThreshold) {
      console.log(`  Bias: NEUTRAL but RSI(3)=${rsi3.toFixed(1)} oversold (< ${rsiThreshold}) — snap-back entry\n`);
      check(`RSI(3) oversold (< ${rsiThreshold}) in neutral market`, `< ${rsiThreshold}`, rsi3.toFixed(2), true);
    } else {
      console.log(`  Bias: NEUTRAL — RSI(3)=${rsi3?.toFixed(1)} not low enough (need < ${rsiThreshold}). No trade.\n`);
      results.push({ label: "Market bias", required: `RSI < ${rsiThreshold}`, actual: rsi3?.toFixed(1) ?? "N/A", pass: false });
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
  const breakEvenActive = newHigh >= position.entryPrice * 1.020;
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
    const slPct = position.bearSnapBack ? 0.02 : position.bearMarket ? 0.02 : (btSl?.stopLoss ?? 0.04);
    const slPrice = position.entryPrice * (1 - slPct);
    check(`Stop-loss hit — $${slPrice.toFixed(4)} (-${(slPct*100).toFixed(0)}%${position.bearSnapBack ? " snap-back" : position.bearMarket ? " bear market" : ""})`, price <= slPrice);
    // Bear snap-back: take profit quickly at 3% — don't hold for a full swing in a downtrend
    if (position.bearSnapBack) {
      const snapTpPrice = position.entryPrice * 1.03;
      check(`Bear snap-back TP hit — $${snapTpPrice.toFixed(4)} (+3%)`, price >= snapTpPrice && pnlPct >= 3);
    }

    // Soft exits — fire on real market signals, not arbitrary timers.
    // Rule: if price is STILL above EMA8 AND VWAP, the trend is intact — hold through
    // overbought oscillator readings. Only exit on exhaustion when trend actually weakens.
    // SOFT_MIN = 1.0%: profit must cover fees + buffer before any soft exit fires.
    const SOFT_MIN = 1.0;
    const trendIntact = price > ema8 && price > vwap;
    if (trendIntact) console.log(`  📈 Trend intact (price > EMA8 & VWAP) — holding through overbought signals`);

    // RSI extreme overbought: only exit if trend is weakening (price slipping vs EMA) OR big gain
    check(`RSI(3) overbought > 88 | Actual: ${rsi3.toFixed(2)}`, rsi3 > 88 && pnlPct >= SOFT_MIN && (!trendIntact || pnlPct >= 2.0));
    if (stochRsi) {
      // StochRSI > 92 + trend breaking OR big gain = true exhaustion
      const stochExhausted = stochRsi.overbought && pnlPct >= SOFT_MIN && (!trendIntact || pnlPct >= 2.0 || (rsi3 > 90 && sr?.nearResistance));
      check(`StochRSI overbought > 92 | K=${stochRsi.k.toFixed(1)}${stochRsi.overbought && !stochExhausted ? ` (holding — trend intact or P&L ${pnlPct.toFixed(2)}% < target)` : ""}`, stochExhausted);
    }
    // BB% extreme — price at very top of band AND trend showing signs of reversal
    if (bb) check(`BB% > 0.92 (extreme upper band) | BB%=${bb.pct.toFixed(2)}`, bb.pct > 0.92 && pnlPct >= SOFT_MIN && (!trendIntact || pnlPct >= 2.0));
    // Snap-back entries start below VWAP deliberately — "trend reversed" doesn't apply.
    // Dynamic TP: exit RSI threshold shifts based on distance to resistance
    if (position.entryType === "snapback") {
      const distToRes = sr?.distToResistance ?? null;
      let snapRsiExit, snapLabel;
      if (distToRes !== null && distToRes < 1.5) {
        snapRsiExit = 72; snapLabel = `RSI(3) > 72 — near resistance ($${sr.nearestResistance?.toFixed(2)}, ${distToRes.toFixed(1)}% away)`;
      } else if (distToRes !== null && distToRes > 5) {
        snapRsiExit = 82; snapLabel = `RSI(3) > 82 — room to run (resistance ${distToRes.toFixed(1)}% away), holding longer`;
      } else {
        snapRsiExit = 72; snapLabel = `RSI(3) recovered above 72 — snap-back complete`;
      }
      check(snapLabel, rsi3 > snapRsiExit && pnlPct >= SOFT_MIN && !trendIntact);
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

    // Max hold time — exit stale trades and recycle capital
    if (position.entryTime) {
      const hoursOpen = (Date.now() - new Date(position.entryTime).getTime()) / (1000 * 60 * 60);
      if (hoursOpen > 5) {
        check(`Max hold exceeded — open ${hoursOpen.toFixed(1)}h (limit 5h)`, true);
      } else if (hoursOpen > 2 && pnlPct < -0.5) {
        check(`Stale loser — open ${hoursOpen.toFixed(1)}h with P&L ${pnlPct.toFixed(2)}% (cutting loss)`, true);
      } else if (hoursOpen > 3 && pnlPct < 0.3) {
        check(`Capital stuck — open ${hoursOpen.toFixed(1)}h with only ${pnlPct.toFixed(2)}% gain (recycling)`, true);
      }
    }
  }

  // Fee gate — don't take profit if gain doesn't cover round-trip fee + small buffer.
  // BitGet: 0.10% × 2 + 0.10 buffer = 0.30% | BitMart: 0.25% × 2 + 0.10 = 0.60%
  // Hard stops (stop-loss, ATR trail, max hold) always fire regardless
  const FEE_MIN_PCT = parseFloat((getFeePct() * 2 * 100 + 0.10).toFixed(2));
  if (pnlPct > 0 && pnlPct < FEE_MIN_PCT) {
    const HARD_STOPS = ["Stop-loss", "ATR stop", "Emergency", "Max hold", "Stale trade", "Failed bounce", "Momentum stop"];
    const hardOnly = reasons.filter(r => HARD_STOPS.some(kw => r.startsWith(kw)));
    if (hardOnly.length < reasons.length) {
      console.log(`  ℹ️  Fee gate — holding at +${pnlPct.toFixed(2)}% (need +${FEE_MIN_PCT}% to cover fees)`);
    }
    reasons.splice(0, reasons.length, ...hardOnly);
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
    model: "claude-haiku-4-5-20251001",
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

  const portfolio = log.portfolioValue || acct().portfolioValue;
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
    .createHmac("sha256", acct().secretKey)
    .update(message)
    .digest("base64");
}

function signBitGetPassphrase() {
  return crypto
    .createHmac("sha256", acct().secretKey)
    .update(acct().passphrase)
    .digest("base64");
}

async function getSpotBalance(coin) {
  const timestamp = Date.now().toString();
  const path = "/api/v2/spot/account/assets";
  const sign = signBitGet(timestamp, "GET", path);
  const res = await fetch(`${acct().baseUrl}${path}`, {
    headers: {
      "ACCESS-KEY": acct().apiKey,
      "ACCESS-SIGN": sign,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": acct().passphrase,
      "locale": "en-US",
    },
  });
  const data = await res.json();
  const asset = data.data?.find(a => a.coin === coin);
  return parseFloat(asset?.available ?? "0");
}

// ─── BitMart Exchange ─────────────────────────────────────────────────────────

// BitMart symbols use underscores: BTCUSDT → BTC_USDT
function toBitMartSymbol(symbol) {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) + "_USDT" : symbol;
}

function signBitMart(timestamp, body = "") {
  const message = `${timestamp}#${acct().memo}#${body}`;
  return crypto.createHmac("sha256", acct().secretKey).update(message).digest("hex");
}

async function getBitMartBalance(coin) {
  const timestamp = Date.now().toString();
  const sign = signBitMart(timestamp);
  const res = await fetch(`${acct().baseUrl}/account/v1/wallet`, {
    headers: { "X-BM-KEY": acct().apiKey, "X-BM-SIGN": sign, "X-BM-TIMESTAMP": timestamp },
  });
  const data = await res.json();
  if (data.code !== 1000) throw new Error(`BitMart balance error: ${data.message}`);
  const asset = data.data?.wallet?.find(w => w.id === coin);
  return parseFloat(asset?.available ?? "0");
}

async function placeBitMartOrder(symbol, side, sizeUSD, price, quantityOverride = null) {
  const bmSymbol = toBitMartSymbol(symbol);
  const timestamp = Date.now().toString();

  let bodyObj;
  if (side === "buy") {
    bodyObj = { symbol: bmSymbol, side: "buy", type: "market", notional: sizeUSD.toFixed(2) };
  } else {
    const baseCoin = symbol.replace("USDT", "");
    const qty = quantityOverride ?? await getBitMartBalance(baseCoin);
    if (parseFloat(qty) <= 0) throw new Error(`No ${baseCoin} balance to sell on BitMart`);
    bodyObj = { symbol: bmSymbol, side: "sell", type: "market", size: parseFloat(qty).toFixed(6) };
  }

  const body = JSON.stringify(bodyObj);
  const sign = signBitMart(timestamp, body);
  const res = await fetch(`${acct().baseUrl}/spot/v1/submit_order`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BM-KEY": acct().apiKey, "X-BM-SIGN": sign, "X-BM-TIMESTAMP": timestamp },
    body,
  });
  const data = await res.json();
  if (data.code !== 1000) throw new Error(`BitMart order failed: ${data.message}`);

  if (side === "buy") {
    const baseCoin = symbol.replace("USDT", "");
    const balBefore = await getBitMartBalance(baseCoin);
    let received = 0;
    for (const delay of [3000, 4000, 5000]) {
      await new Promise(r => setTimeout(r, delay));
      received = (await getBitMartBalance(baseCoin)) - balBefore;
      if (received > 0) break;
    }
    const estimatedQty = sizeUSD / price;
    if (received < estimatedQty * 0.90) {
      console.log(`⚠️  BitMart balance uncertain — using estimated qty ${estimatedQty.toFixed(6)} ${baseCoin}`);
      return { orderId: data.data?.order_id, confirmedQty: estimatedQty };
    }
    console.log(`✅ BitMart balance confirmed: +${received.toFixed(6)} ${baseCoin}`);
    return { orderId: data.data?.order_id, confirmedQty: received };
  }
  return { orderId: data.data?.order_id };
}

// ─── Exchange-agnostic wrappers ───────────────────────────────────────────────

async function getBalance(coin) {
  return acct().exchange === "bitmart" ? getBitMartBalance(coin) : getSpotBalance(coin);
}

async function placeOrder(symbol, side, sizeUSD, price, quantityOverride = null) {
  return acct().exchange === "bitmart"
    ? placeBitMartOrder(symbol, side, sizeUSD, price, quantityOverride)
    : placeBitGetOrder(symbol, side, sizeUSD, price, quantityOverride);
}

async function syncPortfolioBalance(log) {
  if (CONFIG.paperTrading) return;
  try {
    const balance = await getBalance("USDT");
    if (balance > 0) {
      log.portfolioValue = balance;
      console.log(`🔄 Portfolio synced from ${acct().exchange}: $${balance.toFixed(4)} USDT`);
    }
  } catch (e) {
    console.log(`⚠️ Balance sync failed: ${e.message}`);
  }
}

// On Railway, the log is wiped on every redeploy. This function re-discovers any
// open positions by comparing actual BitGet balances against the log.
async function reconcilePositions(log) {
  if (CONFIG.paperTrading || acct().exchange !== "bitget") return;
  try {
    const ts = Date.now().toString();
    const path = "/api/v2/spot/account/assets";
    const sign = signBitGet(ts, "GET", path);
    const res = await fetch(`${acct().baseUrl}${path}`, {
      headers: { "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": sign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US" }
    });
    const data = await res.json();
    if (!data.data) return;

    const priceRes = await fetch("https://api.bitget.com/api/v2/spot/market/tickers");
    const priceData = await priceRes.json();
    const prices = Object.fromEntries((priceData.data || []).map(t => [t.symbol, parseFloat(t.lastPr)]));

    if (!log.positions) log.positions = {};
    let found = 0;

    for (const asset of data.data) {
      const qty = parseFloat(asset.available) + parseFloat(asset.frozen || 0);
      if (asset.coin === "USDT" || qty < 0.0001) continue;
      const symbol = asset.coin + "USDT";
      const price = prices[symbol];
      if (!price) continue;
      const usdValue = qty * price;
      if (usdValue < 5) continue; // skip dust < $5

      if (!log.positions[symbol]?.open) {
        console.log(`🔄 Reconcile: ${qty.toFixed(6)} ${asset.coin} ($${usdValue.toFixed(2)}) not in log — tracking as open position`);
        log.positions[symbol] = {
          open: true, side: "long",
          entryPrice: price,
          highWatermark: price,
          entryTime: new Date().toISOString(),
          quantity: qty.toFixed(6),
          orderId: "reconciled",
          entryType: "reconciled",
        };
        found++;
      }
    }
    if (found > 0) { saveLog(log); console.log(`🔄 Reconciled ${found} position(s) from BitGet balances`); }
    else console.log(`🔄 Position reconciliation: log matches BitGet balances`);
  } catch (err) {
    console.log(`⚠️ Position reconciliation failed: ${err.message}`);
  }
}

async function sweepDust(log) {
  if (CONFIG.paperTrading || acct().exchange !== "bitget") return;
  try {
    const ts = Date.now().toString();
    const path = "/api/v2/spot/account/assets";
    const sign = signBitGet(ts, "GET", path);
    const res = await fetch(`${acct().baseUrl}${path}`, {
      headers: { "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": sign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US" }
    });
    const data = await res.json();
    if (!data.data) return;

    const priceRes = await fetch("https://api.bitget.com/api/v2/spot/market/tickers");
    const priceData = await priceRes.json();
    const prices = Object.fromEntries((priceData.data || []).map(t => [t.symbol, parseFloat(t.lastPr)]));

    const trackedCoins = new Set(
      Object.entries(log.positions || {})
        .filter(([, p]) => p && p.open)
        .map(([sym]) => sym.replace("USDT", ""))
    );

    let swept = 0;
    for (const asset of data.data) {
      const coin = asset.coin;
      if (coin === "USDT" || coin === "BGB") continue;
      if (trackedCoins.has(coin)) continue;

      const qty = parseFloat(asset.available);
      if (qty <= 0) continue;
      const symbol = coin + "USDT";
      const price = prices[symbol];
      if (!price) continue;
      const usdValue = qty * price;
      if (usdValue < 0.50 || usdValue >= 10) continue; // only sweep $0.50–$10 dust

      try {
        const precision = await getQuantityPrecision(symbol);
        const floored = floorToDecimals(qty, precision);
        if (floored <= 0) continue;
        const orderSize = floored.toFixed(precision);

        const serverTs = await getBitGetServerTime();
        const orderPath = "/api/v2/spot/trade/place-order";
        const body = JSON.stringify({ symbol, side: "sell", orderType: "market", size: orderSize });
        const sig = signBitGet(serverTs, "POST", orderPath, body);

        const orderRes = await fetch(`${acct().baseUrl}${orderPath}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ACCESS-KEY": acct().apiKey,
            "ACCESS-SIGN": sig,
            "ACCESS-TIMESTAMP": serverTs,
            "ACCESS-PASSPHRASE": acct().passphrase,
            "locale": "en-US",
          },
          body,
        });
        const orderData = await orderRes.json();
        if (orderData.code === "00000") {
          console.log(`🧹 Swept dust: sold ${orderSize} ${coin} (~$${usdValue.toFixed(2)})`);
          swept++;
        } else {
          console.log(`⚠️  Dust sweep ${coin} failed: ${orderData.msg}`);
        }
      } catch (err) {
        console.log(`⚠️  Dust sweep ${coin} error: ${err.message}`);
      }
    }
    if (swept === 0) console.log("🧹 Dust sweep: nothing to sweep");
    else console.log(`🧹 Dust sweep complete: ${swept} coin(s) sold → USDT freed`);
  } catch (err) {
    console.log(`⚠️  Dust sweep failed: ${err.message}`);
  }
}

const _symbolPrecisionCache = {};
async function getQuantityPrecision(symbol) {
  if (acct().exchange === "bitmart") return 6; // BitMart: default precision
  const cacheKey = symbol + acct().id;
  if (_symbolPrecisionCache[cacheKey] !== undefined) return _symbolPrecisionCache[cacheKey];
  try {
    const res = await fetch(`${acct().baseUrl}/api/v2/spot/public/symbols?symbol=${symbol}`);
    const data = await res.json();
    const precision = parseInt(data.data?.[0]?.quantityPrecision ?? "6", 10);
    _symbolPrecisionCache[cacheKey] = precision;
    return precision;
  } catch {
    return 6;
  }
}

function floorToDecimals(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.floor(value * factor) / factor;
}

async function getBitGetServerTime() {
  try {
    const res = await fetch("https://api.bitget.com/api/v2/public/time", { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.data?.serverTime) return data.data.serverTime.toString();
  } catch {}
  return Date.now().toString();
}

async function placeBitGetOrder(symbol, side, sizeUSD, price, quantityOverride = null) {
  const timestamp = await getBitGetServerTime();
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

  const res = await fetch(`${acct().baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": acct().apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": acct().passphrase,
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
      fee = (val * getFeePct()).toFixed(4);
      netAmount = (val - val * getFeePct()).toFixed(2);
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
    acct().exchange === "bitmart" ? "BitMart" : "BitGet",
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

  if (mode === "LIVE") {
    if (side === "BUY") {
      emailEntry({ symbol: logEntry.symbol, price: logEntry.price, tradeSize: logEntry.tradeSize, orderId: logEntry.orderId || "" });
    } else if (side === "SELL" && logEntry.pnlPct !== undefined) {
      emailExit({ symbol: logEntry.symbol, price: logEntry.price, entryPrice: logEntry.entryPrice, pnlPct: logEntry.pnlPct, pnlUSD: logEntry.pnlUSD || 0, reasons: logEntry.exitReasons, orderId: logEntry.orderId || "" });
    }
  }
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

// ─── WebSocket real-time price stream ────────────────────────────────────────

function startPriceStream(symbols) {
  if (priceStreamWs) {
    try { priceStreamWs.terminate(); } catch {}
  }
  const ws = new WebSocket("wss://ws.bitget.com/v2/ws/public");
  priceStreamWs = ws;

  ws.on("open", () => {
    console.log(`\n📡 WebSocket connected — streaming ${symbols.length} symbols`);
    const args = symbols.map(s => ({ instType: "SPOT", channel: "ticker", instId: s }));
    ws.send(JSON.stringify({ op: "subscribe", args }));
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "pong" || msg.op === "pong") return;
      if (msg.data?.[0]?.lastPr && msg.arg?.channel === "ticker") {
        const sym = msg.arg.instId;
        livePrices.set(sym, { price: parseFloat(msg.data[0].lastPr), ts: Date.now() });
      }
    } catch {}
  });

  ws.on("close", () => {
    console.log("⚠️  WebSocket disconnected — reconnecting in 5s");
    setTimeout(() => startPriceStream(CONFIG.symbols), 5000);
  });

  ws.on("error", (err) => console.error("WebSocket error:", err.message));

  // BitGet requires a ping within every 30s or the server closes the connection
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping" }));
    else clearInterval(ping);
  }, 25000);

  return ws;
}

// Hard-stop monitor — checks live prices every 5 seconds.
// Only handles stop-loss and emergency stops (no indicators needed — just price).
// Fires BEFORE the 60-second indicator-based exit check, cutting losses faster.
async function checkLiveHardStops() {
  const log = loadLog();
  const openPositions = Object.entries(log.positions || {}).filter(([, p]) => p?.open);
  if (openPositions.length === 0) return;

  for (const [sym, pos] of openPositions) {
    if (_processingStops.has(sym)) continue;
    const live = livePrices.get(sym);
    if (!live || Date.now() - live.ts > 30000) continue; // stale — skip

    const livePrice = live.price;
    const pnlPct = (livePrice - pos.entryPrice) / pos.entryPrice * 100;
    const slPct = (typeof BACKTEST !== "undefined" && BACKTEST[sym]?.stopLoss) ? BACKTEST[sym].stopLoss : 0.04;
    const slPrice = pos.entryPrice * (1 - slPct);
    const emergencyHit = pnlPct <= -8;
    const slHit = livePrice <= slPrice;

    if (!emergencyHit && !slHit) continue;

    _processingStops.add(sym);
    const reason = emergencyHit ? `Emergency stop ${pnlPct.toFixed(2)}%` : `Stop-loss $${slPrice.toFixed(4)} (${(slPct*100).toFixed(0)}%)`;
    console.log(`\n🚨 LIVE STOP [WebSocket] — ${sym} @ $${livePrice.toFixed(4)} | ${reason}`);

    try {
      const pnlUSD = (livePrice - pos.entryPrice) * parseFloat(pos.quantity);
      if (!CONFIG.paperTrading) {
        const order = await placeOrder(sym, "sell", null, livePrice, pos.quantity);
        console.log(`✅ STOP SELL — ${order.orderId}`);
      } else {
        console.log(`📋 PAPER STOP SELL`);
      }
      log.positions[sym] = null;
      log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
      log.trades.push({
        timestamp: new Date().toISOString(), type: "exit", symbol: sym,
        price: livePrice, entryPrice: pos.entryPrice, pnlPct, pnlUSD,
        indicators: {}, exitReasons: [reason],
        shouldExit: true, quantity: pos.quantity,
        orderPlaced: true, paperTrading: CONFIG.paperTrading,
        wsTriggered: true,
      });
      saveLog(log);
      console.log(`💰 Portfolio: $${log.portfolioValue.toFixed(4)}`);
    } catch (err) {
      console.error(`Stop sell failed for ${sym}: ${err.message}`);
    } finally {
      _processingStops.delete(sym);
    }
  }
}

// ─── Limit order with market fallback ────────────────────────────────────────

// Places a limit buy at the specified price. Polls for fill up to 30s.
// Falls back to market order if not filled (snap-back moves fast — don't miss the entry).
async function placeLimitBuyWithFallback(symbol, sizeUSD, limitPrice) {
  try {
    // Get symbol precision
    const symRes = await fetch(`${acct().baseUrl}/api/v2/spot/public/symbols?symbol=${symbol}`);
    const symData = await symRes.json();
    const pricePrecision = parseInt(symData.data?.[0]?.pricePrecision ?? "4", 10);
    const qtyPrecision   = parseInt(symData.data?.[0]?.quantityPrecision ?? "6", 10);
    const limitPriceStr  = limitPrice.toFixed(pricePrecision);
    const qty = floorToDecimals(sizeUSD / limitPrice, qtyPrecision);
    if (qty <= 0) return null;

    const timestamp = Date.now().toString();
    const path = "/api/v2/spot/trade/place-order";
    const body = JSON.stringify({ symbol, side: "buy", orderType: "limit", force: "gtc", price: limitPriceStr, size: qty.toFixed(qtyPrecision) });
    const signature = signBitGet(timestamp, "POST", path, body);
    const res = await fetch(`${acct().baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": signature, "ACCESS-TIMESTAMP": timestamp, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US" },
      body,
    });
    const orderData = await res.json();
    if (orderData.code !== "00000") throw new Error(orderData.msg);
    const orderId = orderData.data.orderId;
    console.log(`  📋 Limit BUY @ $${limitPriceStr} | id: ${orderId}`);

    // Poll for fill — up to 30 seconds (10 × 3s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const ts2 = Date.now().toString();
      const checkPath = `/api/v2/spot/trade/orderInfo?orderId=${orderId}&symbol=${symbol}`;
      const checkSign = signBitGet(ts2, "GET", checkPath);
      const checkRes = await fetch(`${acct().baseUrl}${checkPath}`, {
        headers: { "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": checkSign, "ACCESS-TIMESTAMP": ts2, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US" },
      });
      const checkData = await checkRes.json();
      const status = checkData.data?.status;
      if (status === "full_fill") {
        const confirmedQty = parseFloat(checkData.data?.baseVolume ?? qty.toFixed(qtyPrecision));
        console.log(`  ✅ Limit filled | qty: ${confirmedQty}`);
        return { orderId, confirmedQty };
      }
      if (status === "cancelled" || status === "cancel") break;
      console.log(`  ⏳ Waiting for fill (${i + 1}/10)...`);
    }

    // Cancel unfilled order
    const cancelTs = Date.now().toString();
    const cancelPath = "/api/v2/spot/trade/cancel-order";
    const cancelBody = JSON.stringify({ symbol, orderId });
    const cancelSign = signBitGet(cancelTs, "POST", cancelPath, cancelBody);
    await fetch(`${acct().baseUrl}${cancelPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": cancelSign, "ACCESS-TIMESTAMP": cancelTs, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US" },
      body: cancelBody,
    });
    console.log(`  ⚠️  Limit not filled — cancelled, falling back to market`);
    return null;
  } catch (err) {
    console.log(`  ⚠️  Limit order error (${err.message}) — falling back to market`);
    return null;
  }
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
  const today = new Date().toISOString().slice(0, 10);

  if (log._needsPortfolioSync) {
    await syncPortfolioBalance(log);
    log._needsPortfolioSync = false;
    saveLog(log);
  }

  const coinRsiThreshold = getCoinRsiThreshold(symbol, log);
  const learnedSource = log?.learnedThresholds?.[symbol]?.basedOnTrades >= 5 ? "live" : "backtest";
  console.log(`\nStrategy: ${rules.strategy.name} v4`);
  console.log(`Symbol: ${symbol} | TF: ${entryTF}${bt ? ` (${learnedSource}: WR ${log?.learnedThresholds?.[symbol]?.winRate ?? bt.winRate}%, RSI gate <${coinRsiThreshold})` : " (default)"}`);
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    pushSignal(symbol, "BLOCKED", "Daily trade limit reached");
    return;
  }

  // Manual pause via dashboard
  if (_tradingPaused && tvSignal !== "SELL") {
    console.log("\n⏸ Trading paused via dashboard — skipping entry");
    pushSignal(symbol, "BLOCKED", "Trading paused via dashboard");
    return;
  }

  // Drawdown stop — pause all trading if down 10% on the day
  const drawdown = checkDailyDrawdown(log);
  if (drawdown.paused) {
    console.log(`\n🛑 DRAWDOWN STOP — down ${drawdown.drawdownPct.toFixed(2)}% today ($${Math.abs(drawdown.totalLoss).toFixed(4)} lost)`);
    console.log(`   Limit: ${drawdown.limit}% per day. Bot paused until tomorrow.`);
    console.log("═══════════════════════════════════════════════════════════\n");
    pushSignal(symbol, "BLOCKED", `Drawdown stop — down ${drawdown.drawdownPct.toFixed(1)}% today`);
    return;
  }
  if (drawdown.drawdownPct > 0) {
    console.log(`\n⚠️  Daily drawdown: ${drawdown.drawdownPct.toFixed(2)}% / ${drawdown.limit}% limit`);
  }

  // Adaptive mode — computed now, early-return check moved to after coinSnapshots
  // so the dashboard always shows live prices/indicators even when trading is paused
  const adaptive = getAdaptiveMode(log.trades);
  console.log(`\n🧠 Strategy mode: ${adaptive.label}`);

  // Market regime + portfolio heat — logged once per scan cycle
  const regime = await detectMarketRegime().catch(() => ({ regime: "UNKNOWN", btcTrend: "neutral", volatility: "normal" }));
  const heat = calcPortfolioHeat(log, _livePortfolioValue);
  console.log(`🌍 Regime: ${regime.regime} (BTC:${regime.btcTrend} Vol:${regime.volatility}) | Portfolio heat: ${heat.heatPct}%/${heat.isOverheated ? "🔴 OVERHEATED" : "8% max"}`);

  // Block new entries when portfolio is overheated — skip candle fetch entirely to save API calls
  // Existing open positions for this symbol are still allowed through for exit management
  const earlyPosition = (log.positions || {})[symbol] || null;
  if (!earlyPosition?.open && heat.isOverheated) {
    console.log(`\n🚫 No new entries — portfolio heat ${heat.heatPct}% exceeds 8% max`);
    pushSignal(symbol, "BLOCKED", `Portfolio heat ${heat.heatPct.toFixed(0)}% > 8% max — waiting for positions to close`);
    return;
  }

  // In BEAR regime: only manage exits on existing positions, skip all new scalp entries
  // In VOLATILE regime: reduce scalp size by 50% (applied in tradeSize calc below)

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
  const stochRsi    = calcStochRSI(closes);
  const divergence  = detectBullishDivergence(candles);
  const obv         = calcOBV(candles);
  const doubleBottom = detectDoubleBottom(candles);

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
  console.log(`  OBV:      ${obv.rising ? "✅ rising (buyers in control)" : "⚠️  falling"} | ${obv.bearDivergence ? "🔴 OBV bear divergence — smart money selling into rally" : "no divergence"}`);
  if (doubleBottom?.detected) console.log(`  Double Bottom: ✅ detected — two lows at $${doubleBottom.low1?.toFixed(2)}/$${doubleBottom.low2?.toFixed(2)}${doubleBottom.strongConfirmation ? " with RSI divergence (STRONG)" : ""}`);
  console.log(`  Patterns: ${patterns.length ? patterns.join(", ") : "None detected"}`);
  console.log(`  S/R:      Support $${sr.nearestSupport?.toFixed(2) ?? "?"} (${sr.distToSupport?.toFixed(2) ?? "?"}% below, ${sr.supportConf ?? 0} TF confluences) | Resistance $${sr.nearestResistance?.toFixed(2) ?? "?"} (${sr.distToResistance?.toFixed(2) ?? "?"}% above, ${sr.resistanceConf ?? 0} TF confluences)${sr.nearSupport ? " ✅ near support" : ""}${sr.nearResistance ? " ⚠️ near resistance" : ""}`);

  if (vwap === null || rsi3 === null) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Store snapshot for dashboard coin detail view
  coinSnapshots[symbol] = {
    symbol, price, updatedAt: new Date().toISOString(),
    rsi3: rsi3?.toFixed(2), rsi15m: rsi15m?.toFixed(2),
    vwap: vwap?.toFixed(4),
    ema8: ema8?.toFixed(4), ema21: ema21?.toFixed(4),
    trend15m: ema8 > ema21 ? "up" : "down",
    trend1h: bullTrend1h ? "up" : "down",
    trend4h: bullTrend4h ? "up" : "down",
    trendWeekly: bullTrendWeekly === null ? null : bullTrendWeekly ? "up" : "down",
    macdBullish: macd.bullish, macdHist: macd.histogram?.toFixed(4),
    bbPct: (bb.pct * 100)?.toFixed(1), bbWidth: bb.width?.toFixed(2),
    adx: adx?.adx?.toFixed(1), adxTrending: adx?.trending,
    stochK: stochRsi?.k?.toFixed(1), stochOversold: stochRsi?.oversold, stochOverbought: stochRsi?.overbought,
    volAboveAvg: vol.aboveAvg, volPct: (vol.current / vol.avg * 100)?.toFixed(0),
    divergence: !!divergence, obvRising: obv.rising,
    support: sr.nearestSupport?.toFixed(4), distToSupport: sr.distToSupport?.toFixed(2), nearSupport: sr.nearSupport,
    resistance: sr.nearestResistance?.toFixed(4), distToResistance: sr.distToResistance?.toFixed(2),
    patterns: patterns.length ? patterns.join(", ") : null,
    doubleBottom: doubleBottom ? { detected: doubleBottom.detected, strongConfirmation: doubleBottom.strongConfirmation } : null,
    regime: regime?.regime,
    lastSignal: signalLog.filter(s => s.symbol === symbol).slice(-1)[0] || null,
  };

  // Adaptive mode adjusts position sizing and RSI thresholds — but never fully pauses.
  // A full pause causes a deadlock (can't trade → can't improve win rate → stays paused forever).
  // Capital is protected by stop-loss, ATR trail, daily drawdown limit, and max positions instead.

  const currentPortfolio = log.portfolioValue || acct().portfolioValue;
  // Kelly Criterion sizing — optimal fraction based on live win rate + payoff ratio per coin
  const kellySizePct = kellyPositionPct(log, symbol, CONFIG.maxTradeSizePct || 0.25);
  const sizePct = kellySizePct;
  // Scale down as daily losses accumulate + volatile regime + bear snap-backs
  const bearSnapBack  = regime.btcTrend === "bear" && rsi3 !== null && rsi3 < 28 && (stochRsi?.oversold === true || macd.bullish === true);
  const regimeScale   = regime.volatility === "high" ? 0.50 : 1.0;
  const drawdownScale = drawdown.drawdownPct > 7 ? 0.30 : drawdown.drawdownPct > 5 ? 0.50 : drawdown.drawdownPct > 3 ? 0.75 : 1.0;
  const bearScale     = bearSnapBack ? 0.40 : 1.0; // bear snap-back = 40% size only
  const rawSize = currentPortfolio * sizePct * adaptive.sizeMultiplier * drawdownScale * regimeScale * bearScale;
  const tradeSize = CONFIG.maxTradeSizeUSD ? Math.min(rawSize, CONFIG.maxTradeSizeUSD) : rawSize;
  if (drawdownScale < 1.0) console.log(`\n⚠️  Drawdown scaling: ${(drawdownScale * 100).toFixed(0)}% position size (down ${drawdown.drawdownPct.toFixed(1)}% today)`);
  if (regimeScale < 1.0)   console.log(`⚠️  Volatile regime: 50% position size`);
  console.log(`\n💰 Portfolio: $${currentPortfolio.toFixed(4)} | Trade size: $${tradeSize.toFixed(4)} (Kelly ${(sizePct * 100).toFixed(0)}%)`);

  const CONFIDENCE_MIN = log.learnedThresholds?._confidenceMin ?? adaptive.confidenceMin;
  let position = (log.positions || {})[symbol] || null;

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
    // ── Partial profit lock (scale-out) ───────────────────────────────────
    // At +1.5%, sell 50% to guarantee a profit even if the trade reverses.
    // The remaining 50% rides with a tight trail to capture larger moves.
    // This is the single most impactful technique for improving R:R ratio.
    const livePnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;
    if (!position.partialExitDone && livePnlPct >= 2.5) {
      const originalQty = parseFloat(position.quantity);
      const halfQty = originalQty * 0.5;
      const partialPnlUSD = (price - position.entryPrice) * halfQty;
      console.log(`\n📊 PARTIAL TP — up ${livePnlPct.toFixed(2)}%, selling 50% to lock gains`);
      console.log(`   Selling ${halfQty.toFixed(6)} ${symbol} | Locking ~$${partialPnlUSD >= 0 ? "+" : ""}${partialPnlUSD.toFixed(4)}`);

      let partialOrderId = null;
      let partialOk = false;
      if (CONFIG.paperTrading) {
        partialOrderId = `PAPER-PARTIAL-${Date.now()}`;
        partialOk = true;
        console.log(`📋 PAPER PARTIAL SELL — ${halfQty.toFixed(6)} @ $${price.toFixed(2)}`);
      } else {
        try {
          const pOrder = await placeOrder(symbol, "sell", null, price, halfQty.toFixed(6));
          partialOrderId = pOrder.orderId;
          partialOk = true;
          console.log(`✅ PARTIAL SELL PLACED — ${pOrder.orderId}`);
        } catch (err) {
          console.log(`⚠️  Partial sell failed: ${err.message} — keeping full position`);
        }
      }

      if (partialOk) {
        log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + partialPnlUSD;
        log.positions[symbol] = { ...position, quantity: halfQty.toFixed(6), partialExitDone: true, partialExitPrice: price };
        position = log.positions[symbol]; // use updated position for the rest of this cycle
        const partialEntry = {
          timestamp: new Date().toISOString(), type: "exit", symbol,
          timeframe: CONFIG.timeframe, price, entryPrice: position.entryPrice,
          pnlPct: livePnlPct, pnlUSD: partialPnlUSD,
          indicators: { ema8, vwap, rsi3 },
          exitReasons: [`Partial TP — locked 50% at +${livePnlPct.toFixed(2)}%`],
          shouldExit: true, quantity: halfQty.toFixed(6),
          tradeSize, orderPlaced: true, orderId: partialOrderId,
          paperTrading: CONFIG.paperTrading, partial: true,
        };
        log.trades.push(partialEntry);
        saveLog(log);
        writeTradeCsv(partialEntry);
        console.log(`💰 Portfolio: $${log.portfolioValue.toFixed(4)} | Remaining: ${halfQty.toFixed(6)} ${symbol}`);
      }
    }

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
    const HARD_EXIT_KEYWORDS = ["Stop-loss", "ATR stop", "Emergency", "Max hold", "Stale trade", "Failed bounce", "Momentum stop", "Trend reversed"];
    const hasHardExit = reasons.some(r => HARD_EXIT_KEYWORDS.some(kw => r.startsWith(kw)));

    // Pre-compute for gate checks
    const _pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;
    const FEE_MIN_EXIT = parseFloat((getFeePct() * 2 * 100 + 0.10).toFixed(2));
    const heldMins = position.entryTime ? (Date.now() - new Date(position.entryTime).getTime()) / 60000 : 999;

    // Fee gate — hard block, Claude cannot override.
    // Exiting a winning trade below fee cost locks in a guaranteed net loss.
    if (!hasHardExit && tvSignal !== "SELL" && _pnlPct > 0 && _pnlPct < FEE_MIN_EXIT) {
      console.log(`\n⛔ Fee gate (hard) — holding at +${_pnlPct.toFixed(2)}% | need +${FEE_MIN_EXIT}% to cover fees. Claude blocked.`);
      finalExit = false;
    // Minimum hold — no profit exit within 5 min of entry. Stops fee-eating micro-flips.
    } else if (!hasHardExit && tvSignal !== "SELL" && _pnlPct > 0 && heldMins < 5) {
      console.log(`\n⏱ Min hold — ${heldMins.toFixed(1)} min old, need 5 min before profit exit. Claude blocked.`);
      finalExit = false;
    // Exit Claude calls: cap at 20/day to control API spend
    } else if (hasHardExit) {
      finalExit = true;
      console.log(`\n⚠️  Hard stop — Claude analysis skipped (${reasons.filter(r => HARD_EXIT_KEYWORDS.some(kw => r.startsWith(kw))).join(", ")})`);
    } else if (anthropic && !((log.trades.filter(t => t.claudeAnalysis && t.type === "exit" && t.timestamp?.startsWith(today)).length) >= 20)) {
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
    } else {
      console.log(`\n💰 Claude exit cap reached (20/day) — using rule-based decision`);
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
        log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
        console.log(`💰 Portfolio updated: $${log.portfolioValue.toFixed(4)} (${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(4)})`);
      } else {
        console.log(`\n🔴 PLACING LIVE SELL — ${position.quantity} ${symbol}`);
        try {
          const order = await placeOrder(symbol, "sell", null, price, position.quantity);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          log.positions = { ...(log.positions || {}), [symbol]: null };
          // Compound portfolio value
          log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
          console.log(`✅ SELL ORDER PLACED — ${order.orderId}`);
          console.log(`💰 Portfolio updated: $${log.portfolioValue.toFixed(4)} (${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(4)})`);
          pushSignal(symbol, pnlPct >= 0 ? "EXIT_WIN" : "EXIT_LOSS", `Sold @ $${price.toFixed(4)} | P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(2)})`);
        } catch (err) {
          console.log(`❌ SELL ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
        }
      }
    }

    // Only persist actual exits (order placed) — not hold decisions
    if (logEntry.orderPlaced) {
      log.trades.push(logEntry);
      // Per-coin loss cooldown: skip re-entering a coin for 2h after a loss
      if (pnlPct < 0) {
        if (!log.coinCooldowns) log.coinCooldowns = {};
        log.coinCooldowns[symbol] = { until: Date.now() + 2 * 60 * 60 * 1000, pnlPct: pnlPct.toFixed(2) };
        console.log(`⏳ Cooldown set for ${symbol} — no re-entry for 2h (loss: ${pnlPct.toFixed(2)}%)`);
      }
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

    // Trading 24/7 — no time block

    // Per-coin cooldown — skip re-entry for 2h after a loss on this coin
    const cooldown = (log.coinCooldowns || {})[symbol];
    if (cooldown && Date.now() < cooldown.until) {
      const minsLeft = Math.ceil((cooldown.until - Date.now()) / 60000);
      console.log(`⏳ COOLDOWN — ${symbol} blocked for ${minsLeft} more min (last loss: ${cooldown.pnlPct}%)`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Coin cooldown — ${minsLeft}min left after loss`);
      return;
    }

    // Daily coin blacklist — after 2 losses on same coin today, skip for the rest of the day
    const todayLosses = log.trades.filter(t =>
      t.type === "exit" && t.orderPlaced &&
      t.symbol === symbol &&
      t.timestamp?.startsWith(today) &&
      (t.pnlPct ?? 0) < 0
    ).length;
    if (todayLosses >= 2) {
      console.log(`🚫 DAILY BLOCK — ${symbol} has lost ${todayLosses}x today. Skipping for rest of day.`);
      pushSignal(symbol, "BLOCKED", `Daily block — lost ${todayLosses}x today`);;
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // ── Big Daily Mover — momentum path (bypasses mean-reversion filters) ────────
    // If a coin is up 5%+ on the day with real volume, trade the momentum instead
    // of waiting for it to become oversold. Different rules, smaller size, tight stop.
    const gainerInfo = _topGainers.find(t => t.symbol === symbol);
    if (gainerInfo && gainerInfo.change24h >= 5 && !(position && position.open)) {
      console.log(`\n🚀 BIG MOVER — ${symbol} +${gainerInfo.change24h.toFixed(1)}% today`);
      const volRatio = vol.current / vol.avg;
      const rsiOk    = rsi3 >= 50 && rsi3 <= 75;           // healthy momentum zone, not exhausted
      const stochOk  = !stochRsi || stochRsi.k < 80;       // not ramping toward top
      const priceOk  = price > ema8;                        // price above fast EMA
      const volOk    = volRatio >= 2.0;                     // real crowd buying, not thin air
      const notTooHot = gainerInfo.change24h <= 40;         // cap at 40% — beyond that is exit liquidity

      console.log(`  Vol: ${volRatio.toFixed(1)}x avg | RSI(3): ${rsi3?.toFixed(1)} | StochRSI K: ${stochRsi?.k?.toFixed(1) ?? "—"} | Above EMA8: ${price > ema8 ? "yes" : "no"}`);

      if (rsiOk && stochOk && priceOk && volOk && notTooHot) {
        console.log(`\n✅ MOMENTUM ENTRY — big mover conditions met. Small position (30% size, 2% SL, 6% TP).`);
        pushSignal(symbol, "ENTRY", `Big mover +${gainerInfo.change24h.toFixed(1)}% — momentum entry`);
        const momSize = Math.min(currentPortfolio * sizePct * 0.30, CONFIG.maxTradeSizeUSD ?? Infinity);
        const momEntry = {
          timestamp: new Date().toISOString(), type: "entry", symbol,
          timeframe: CONFIG.timeframe, price, indicators: { ema8, vwap, rsi3 },
          allPass: true, claudeAnalysis: null, tradeSize: momSize, orderPlaced: false, orderId: null,
          paperTrading: CONFIG.paperTrading,
          limits: { maxTradeSizeUSD: CONFIG.maxTradeSizeUSD, maxTradesPerDay: CONFIG.maxTradesPerDay, tradesToday: countTodaysTrades(log) },
        };
        if (CONFIG.paperTrading) {
          momEntry.orderPlaced = true; momEntry.orderId = `PAPER-${Date.now()}`;
          log.positions[symbol] = { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: (momSize / price).toFixed(6), orderId: momEntry.orderId, entryType: "momentum" };
        } else {
          try {
            const order = await placeOrder(symbol, "buy", momSize, price);
            const qty = order.confirmedQty ?? (momSize / price);
            momEntry.orderPlaced = true; momEntry.orderId = order.orderId;
            log.positions[symbol] = { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: qty.toFixed(6), orderId: order.orderId, entryType: "momentum" };
            await emailEntry({ symbol, price, tradeSize: momSize, orderId: order.orderId });
          } catch(err) {
            console.error(`\n❌ Momentum order failed: ${err.message}`);
            momEntry.notes = `Error: ${err.message}`;
          }
        }
        log.trades.push(momEntry);
        saveLog(log);
        writeTradeCsv(momEntry);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      } else {
        const reasons = [];
        if (!rsiOk)    reasons.push(`RSI ${rsi3?.toFixed(1)} not in 40-82 range`);
        if (!stochOk)  reasons.push(`StochRSI K=${stochRsi?.k?.toFixed(1)} too high (>90)`);
        if (!priceOk)  reasons.push(`price below EMA8`);
        if (!volOk)    reasons.push(`volume only ${volRatio.toFixed(1)}x avg (need 1.5x)`);
        if (!notTooHot) reasons.push(`up ${gainerInfo.change24h.toFixed(0)}% — too extended`);
        console.log(`🚫 MOMENTUM BLOCK — ${reasons.join(", ")}`);
        pushSignal(symbol, "BLOCKED", `Big mover but: ${reasons[0]}`);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }
    }

    // Bear market block — no new scalp entries when BTC macro trend is bearish.
    // Exception: oversold snap-backs (RSI < 28 + StochRSI oversold OR MACD bullish)
    // These are high-probability rubber-band bounces that work even in downtrends.
    if (regime.btcTrend === "bear" && !bearSnapBack) {
      console.log(`🚫 BEAR MARKET BLOCK — BTC regime is BEAR. Scalp entries blocked; exits still monitored.`);
      pushSignal(symbol, "BLOCKED", "Bear market — BTC regime is BEAR");
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    if (bearSnapBack) {
      console.log(`⚡ BEAR SNAP-BACK — RSI(3)=${rsi3.toFixed(1)} + (StochRSI oversold=${stochRsi?.oversold} | MACD bull=${macd.bullish}). Allowing small position (40% size, TP 3%, SL 2%).`);
    }

    // Upgrade 1: ETH correlation filter — ETH leads altcoins; if ETH dropped >2% last hour, skip
    try {
      const ethCandles = await fetchCandles("ETHUSDT", "1H", 3);
      if (ethCandles.length >= 2) {
        const ethHourChange = (ethCandles[ethCandles.length - 1].close - ethCandles[ethCandles.length - 2].close) / ethCandles[ethCandles.length - 2].close * 100;
        console.log(`  ETH 1H change: ${ethHourChange >= 0 ? "+" : ""}${ethHourChange.toFixed(2)}%`);
        if (ethHourChange <= -3) {
          console.log(`🚫 ETH CORRELATION BLOCK — ETH dropped ${ethHourChange.toFixed(2)}% in the last hour. Altcoins will follow.`);
          console.log("═══════════════════════════════════════════════════════════\n");
          pushSignal(symbol, "BLOCKED", `ETH dropped ${ethHourChange.toFixed(1)}% last hour — altcoins will follow`);
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
          pushSignal(symbol, "BLOCKED", `Funding rate +${frPct}% — longs overcrowded`);
          return;
        }
      }
    } catch { /* non-critical */ }

    // Permanent exclusion — coins with proven negative edge across all live trades
    const PERMANENT_EXCLUDE = ["ARBUSDT"];
    if (PERMANENT_EXCLUDE.includes(symbol)) {
      console.log(`🚫 EXCLUDED — ${symbol} has a proven negative edge in live trading. Skipping permanently.`);
      pushSignal(symbol, "BLOCKED", "Permanently excluded — negative edge");;
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Auto-blacklist — only skip a coin if it has BOTH 3+ losses in 7 days AND
    // a win rate below 40% on recent trades. Two losses from normal variance is not enough.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentTradesOnCoin = log.trades.filter(t =>
      t.type === "exit" && t.symbol === symbol && t.orderPlaced && t.pnlPct !== undefined && t.timestamp > sevenDaysAgo
    );
    const recentLossesOnCoin = recentTradesOnCoin.filter(t => t.pnlPct < -0.5).length;
    const recentWinsOnCoin   = recentTradesOnCoin.filter(t => t.pnlPct > 0).length;
    const recentWrOnCoin     = recentTradesOnCoin.length > 0 ? recentWinsOnCoin / recentTradesOnCoin.length : 1;
    if (recentLossesOnCoin >= 3 && recentWrOnCoin < 0.40) {
      console.log(`🚫 AUTO-BLACKLIST — ${symbol}: ${recentLossesOnCoin} losses in 7 days with ${(recentWrOnCoin*100).toFixed(0)}% win rate. Genuinely bad edge — skipping.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Auto-blacklist — ${recentLossesOnCoin} losses in 7 days, ${(recentWrOnCoin*100).toFixed(0)}% WR`);
      return;
    }

    // Upgrade 3: Minimum 10min between any entries (no chasing)
    const lastEntry = log.trades.filter(t => t.type === "entry" && t.orderPlaced).slice(-1)[0];
    if (lastEntry) {
      const minsSinceLast = (Date.now() - new Date(lastEntry.timestamp).getTime()) / 60000;
      if (minsSinceLast < 15) {
        console.log(`🚫 ENTRY COOLDOWN — last entry was ${minsSinceLast.toFixed(0)}min ago. Waiting 15min between entries.`);
        console.log("═══════════════════════════════════════════════════════════\n");
        pushSignal(symbol, "BLOCKED", `Entry cooldown — ${minsSinceLast.toFixed(0)}min since last trade (need 15min)`);
        return;
      }
    }

    // VWAP Bounce Mode — price at VWAP support with RSI not too high (tightened: RSI<50, not 70)
    const _vwapPct = (price - vwap) / vwap * 100;
    const _nearVwap = _vwapPct >= -1.5 && _vwapPct <= 2.0; // within 1.5% below or 2% above VWAP
    const vwapBounceMode = _nearVwap && rsi3 < 50;
    if (vwapBounceMode) {
      console.log(`  ✅ VWAP BOUNCE MODE — price $${price.toFixed(4)} is ${_vwapPct.toFixed(2)}% from VWAP $${vwap.toFixed(4)}`);
    }

    // Weekly trend filter — only strict in confirmed BEAR regime, relaxed in RANGING/TRENDING
    const weeklyBearRsiOk = rsi3 < 40 && (stochRsi?.oversold || macd.bullish || vwapBounceMode);
    const weeklyFilterActive = regime.btcTrend === "bear"; // only hard-block in confirmed bear macro
    if (weeklyFilterActive && !bearSnapBack && bullTrendWeekly === false && !weeklyBearRsiOk) {
      console.log(`🚫 WEEKLY BEAR FILTER — weekly trend is bearish and RSI(3)=${rsi3.toFixed(1)} is not low enough (need < 40 with StochRSI/MACD/VWAP confirmation).`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Weekly bear + RSI ${rsi3.toFixed(1)} not low enough — need <40 with confirmation`);
      return;
    }
    if (bullTrendWeekly !== null) console.log(`  Weekly trend: ${bullTrendWeekly ? "✅ Bull market — normal filters" : weeklyFilterActive ? "⚠️  Weekly bear (BEAR regime) — RSI < 40 required" : "⚠️  Weekly bear — relaxed in RANGING"}`);

    // Support proximity — warn but don't hard-block; ATR trail handles downside
    if (sr.nearestSupport) {
      if (sr.distToSupport > 8) console.log(`  ⚠️  Far from support — $${sr.nearestSupport.toFixed(4)} (${sr.distToSupport?.toFixed(2)}% below price) — buying into air`);
      else console.log(`  ✅ Support ok — $${sr.nearestSupport.toFixed(4)} (${sr.distToSupport?.toFixed(2)}% below price, ${sr.supportConf} TF confluences)`);
    }

    // Max 4 concurrent scalp positions — 4×20% = 80% deployed, 20% buffer for new opportunities
    const openPositions = Object.entries(log.positions || {}).filter(([,p]) => p && p.open);
    const openCount = openPositions.length;
    if (openCount >= 4) {
      const held = openPositions.map(([s]) => s).join(", ");
      console.log(`🚫 MAX POSITIONS — already holding ${held}. Max 4 positions at a time.`);
      pushSignal(symbol, "BLOCKED", `Max positions (4/4) reached`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    if (openCount > 0 && openPositions.some(([s]) => s === symbol)) {
      console.log(`🚫 ALREADY HOLDING — already have an open position in ${symbol}.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", "Already holding this coin");
      return;
    }

    // Cross-strategy dedup — no scalp if swing or breakout already open on same coin
    if ((log.swingPositions || {})[symbol]?.open) {
      console.log(`🚫 CROSS-STRATEGY BLOCK — swing position open on ${symbol}. No simultaneous scalp.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", "Swing position already open — no simultaneous scalp");
      return;
    }
    if ((log.breakoutPositions || {})[symbol]?.open) {
      console.log(`🚫 CROSS-STRATEGY BLOCK — breakout position open on ${symbol}. No simultaneous scalp.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", "Breakout position already open — no simultaneous scalp");
      return;
    }

    // Correlation block — don't hold two coins that move together (doubles risk, not returns)
    // When the market dips, correlated coins all dump simultaneously — max 1 per group
    const CORRELATION_GROUPS = [
      ["BTCUSDT", "ETHUSDT"],
      ["SOLUSDT", "AVAXUSDT", "NEARUSDT", "ADAUSDT", "DOTUSDT", "INJUSDT", "APTUSDT", "OPUSDT"],
      ["LINKUSDT", "UNIUSDT", "AAVEUSDT", "SUSHIUSDT", "LDOUSDT"],
      ["AXSUSDT", "SANDUSDT", "MANAUSDT"],
      ["BNBUSDT", "KAVAUSDT"],
    ];
    const myCorrelGroup = CORRELATION_GROUPS.find(g => g.includes(symbol));
    if (myCorrelGroup) {
      const heldSymbols = openPositions.map(([s]) => s);
      const correlatedHeld = heldSymbols.filter(s => myCorrelGroup.includes(s));
      if (correlatedHeld.length > 0) {
        console.log(`🚫 CORRELATION BLOCK — already holding ${correlatedHeld.join(", ")} (same group as ${symbol}). They move together — max 1 per group.`);
        console.log("═══════════════════════════════════════════════════════════\n");
        pushSignal(symbol, "BLOCKED", `Correlation block — already holding ${correlatedHeld[0]} (same group)`);
        return;
      }
    }

    // Fix 3: Consecutive loss streak — 3 losses in a row = 4 hour pause
    const recentExits = log.trades.filter(t => t.type === "exit" && t.orderPlaced && t.pnlPct !== undefined).slice(-3);
    if (recentExits.length === 3 && recentExits.every(t => t.pnlPct < 0)) {
      const lastLoss = new Date(recentExits[recentExits.length - 1].timestamp);
      const hoursSince = (Date.now() - lastLoss.getTime()) / (1000 * 60 * 60);
      if (hoursSince < 4) {
        console.log(`🛑 STREAK PAUSE — 3 losses in a row. Cooling off for 4 hours (${(4 - hoursSince).toFixed(1)}h remaining).`);
        console.log("═══════════════════════════════════════════════════════════\n");
        pushSignal(symbol, "BLOCKED", `3-loss streak pause — ${(4 - hoursSince).toFixed(1)}h remaining`);
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
          pushSignal(symbol, "BLOCKED", `BTC down ${btcChange.toFixed(1)}% today — no longs in crash`);
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
        pushSignal(symbol, "BLOCKED", `Momentum block — ${failed.slice(0, 2).join(", ")}`);
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
          const order = await placeOrder(symbol, "buy", tradeSize, price);
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
      pushSignal(symbol, "BLOCKED", `${todayLossesOnSymbol} stop-outs today — skipping until tomorrow`);
      return;
    }

    // Upgrade 6: Multi-timeframe RSI — 15min RSI must also be oversold (< 35, or < 55 in VWAP bounce mode)
    const rsi15mLimit = vwapBounceMode ? 55 : 35;
    if (rsi15m !== null && rsi15m > rsi15mLimit) {
      console.log(`🚫 15MIN RSI BLOCK — RSI(15m)=${rsi15m.toFixed(1)} is not low enough (need < ${rsi15mLimit}${vwapBounceMode ? " — VWAP bounce mode" : ". 1H oversold but 15min recovering"}).`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `15min RSI ${rsi15m.toFixed(1)} not low enough — need <${rsi15mLimit}`);
      return;
    }
    if (rsi15m !== null) console.log(`  ✅ 15min RSI ${rsi15m.toFixed(1)} confirmed (< ${rsi15mLimit})`);

    // Fix 1: Reversal confirmation — need at least 2 signals to confirm the turn
    const formingCandle   = candles[candles.length - 1]; // currently forming (real-time price)
    const lastClosedCandle = candles[candles.length - 2];
    const prevCandle       = candles[candles.length - 3];
    const priceBouncing = formingCandle && lastClosedCandle && formingCandle.close > lastClosedCandle.close;
    const isClosingUp   = lastClosedCandle && prevCandle && lastClosedCandle.close > prevCandle.close;
    const isHigherHigh  = lastClosedCandle && prevCandle && lastClosedCandle.high  > prevCandle.high;
    const isHigherLow   = lastClosedCandle && prevCandle && lastClosedCandle.low   > prevCandle.low;
    const hasLongWick   = lastClosedCandle && (lastClosedCandle.high - lastClosedCandle.low) > 0 &&
                          (lastClosedCandle.close - lastClosedCandle.low) / (lastClosedCandle.high - lastClosedCandle.low) > 0.4;
    const reversalSignals = [priceBouncing, isClosingUp, isHigherHigh, isHigherLow, hasLongWick].filter(Boolean).length;
    if (reversalSignals < 2) {
      console.log(`🚫 REVERSAL BLOCK — only ${reversalSignals}/2 reversal signals (live bounce: ${priceBouncing}, closing up: ${isClosingUp}, higher high: ${isHigherHigh}, higher low: ${isHigherLow}, long wick: ${hasLongWick})`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Weak reversal — only ${reversalSignals}/2 signals confirmed`);
      return;
    }
    const reversalReasons = [priceBouncing && "live bounce", isClosingUp && "closing up", isHigherHigh && "higher high", isHigherLow && "higher low", hasLongWick && "long wick"].filter(Boolean);
    console.log(`  ✅ Reversal confirmed — ${reversalReasons.join(" + ")} (${reversalSignals}/5 signals)`);

    // Fix 2: Volume acceleration — require flat-to-rising volume (buyers present, not retreating)
    const curVol  = candles[candles.length - 1].volume;
    const prevVol = candles[candles.length - 2].volume;
    const volAccel = curVol / prevVol;
    if (!vwapBounceMode && volAccel < 1.0) {
      console.log(`🚫 VOLUME BLOCK — volume declining (${volAccel.toFixed(2)}× prev candle). Need flat or rising volume to confirm buying pressure.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Volume declining ${volAccel.toFixed(2)}× — need ≥1.0× for buying pressure`);
      return;
    }
    console.log(`  ${volAccel >= 1.0 ? "✅" : "⚠️ "} Volume ${volAccel >= 1.5 ? "surging" : volAccel >= 1.0 ? "holding/rising" : "light"} (${volAccel.toFixed(2)}× prev candle)${vwapBounceMode && volAccel < 1.0 ? " — bypassed (VWAP bounce)" : ""}`);

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
      pushSignal(symbol, "BLOCKED", `Backtest WR ${btResult.winRate}% across ${btResult.trades} trades — need 65%+`);
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
        pushSignal(symbol, "BLOCKED", `R:R ${rr.toFixed(2)} too low — resistance too close (need 1.5×)`);
        return;
      }
    }

    // Use backtest-optimized threshold when available; adaptive mode threshold only as fallback
    // In VWAP bounce mode, use 65 as threshold (VWAP bounce can fire at mid-RSI)
    const hasBtThreshold = !!BACKTEST[symbol]?.rsiThreshold;
    const effectiveRsiThreshold = vwapBounceMode ? 65 : (hasBtThreshold ? coinRsiThreshold : Math.min(adaptive.rsiThreshold, coinRsiThreshold));
    const { results, allPass: rulesPass, entryType, entryScore: baseEntryScore } = runSafetyCheck(price, ema8, vwap, rsi3, rules, effectiveRsiThreshold, vol, ema21, bullTrendConfirmed, adx, stochRsi, divergence, bb, vwapBounceMode);

    // OBV bear divergence — smart money distributing into price rise = skip entry
    if (obv.bearDivergence) {
      console.log(`🚫 OBV DIVERGENCE BLOCK — price rising but OBV falling. Institutions are selling into this rally.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", "OBV bear divergence — smart money selling into rally");
      return;
    }

    // ── Advanced signal augmentation (ICT, funding rate, macro sentiment, patterns) ────
    const liquiditySweep = detectLiquiditySweep(candles);
    let entryScore = baseEntryScore;
    const advSignals = [];
    if (liquiditySweep)                                  { entryScore += 3; advSignals.push("🎯 Liquidity sweep"); }
    if (doubleBottom?.detected && doubleBottom.strongConfirmation) { entryScore += 3; advSignals.push("📐 Double bottom + RSI div"); }
    else if (doubleBottom?.detected)                     { entryScore += 2; advSignals.push("📐 Double bottom"); }
    if (fundingRate !== null && fundingRate < -0.0003)   { entryScore += 2; advSignals.push(`💰 Funding ${(fundingRate*100).toFixed(4)}%`); }
    if (obv.rising)                                      { entryScore += 1; advSignals.push("📈 OBV rising"); }
    if (btcDailyRsi !== null && btcDailyRsi < 35)        { entryScore += 1; advSignals.push(`😱 BTC fear RSI ${btcDailyRsi.toFixed(1)}`); }
    if (btcDailyRsi !== null && btcDailyRsi > 70)        { entryScore -= 1; advSignals.push(`🤑 BTC greed RSI ${btcDailyRsi.toFixed(1)}`); }
    if (advSignals.length > 0) {
      console.log(`\n  ⚡ Advanced signals: ${advSignals.join(" | ")}`);
      console.log(`  Score: ${baseEntryScore} (base) → ${entryScore} (with advanced signals)`);
    }

    // Entry quality gate — trend-follow entries need score >= 5 (strong confluence required)
    if (rulesPass && entryType === "trend-follow" && entryScore < 5 && !vwapBounceMode) {
      console.log(`🚫 ENTRY QUALITY BLOCK — score ${entryScore}/5 needed. Need strong confluence: RSI<20 (+2), StochRSI oversold (+2), BB%<0.35 (+1), vol surge (+1), divergence (+3), liquidity sweep (+3), neg funding (+2).`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Entry quality ${entryScore}/5 — need stronger confluence (RSI extreme + StochRSI + vol surge)`);
      return;
    }
    // Snapback quality gate — counter-trend entries need strong confirmation
    if (rulesPass && entryType === "snapback" && entryScore < 4 && !vwapBounceMode) {
      console.log(`🚫 SNAPBACK QUALITY BLOCK — score ${entryScore}/4 needed. Counter-trend needs multiple signals: StochRSI oversold, BB% near low, RSI<15, divergence, or liquidity sweep.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Snapback quality ${entryScore}/4 — need StochRSI oversold + another signal`);
      return;
    }

    // StochRSI entry block — don't buy when momentum is already building (tightened from 75 to 65)
    if (rulesPass && stochRsi && stochRsi.k > 65 && !vwapBounceMode) {
      console.log(`🚫 STOCHRSI BLOCK — K=${stochRsi.k.toFixed(1)} already overbought (>65). Wait for pullback before entering.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `StochRSI building K=${stochRsi.k.toFixed(1)} — wait for pullback`);
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
        pushSignal(symbol, "HOLD", `Claude: ${claudeAnalysis.reasoning}`);
      } else {
        const failed = results.filter((r) => !r.pass).map((r) => r.label);
        console.log(`🚫 TRADE BLOCKED`);
        console.log(`   Failed conditions:`);
        failed.forEach((f) => console.log(`   - ${f}`));
        pushSignal(symbol, "BLOCKED", failed.slice(0, 2).join(" · ") || "Conditions not met");
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

      // Slippage guard — re-fetch price right before execution.
      // If market moved >0.3% since we made the decision, the setup has changed — abort.
      let slippageOk = true;
      try {
        const freshCandles = await fetchCandles(symbol, "1m", 2);
        const freshPrice = freshCandles?.[freshCandles.length - 1]?.close ?? price;
        const slippage = Math.abs(freshPrice - price) / price * 100;
        if (slippage > 0.3) {
          console.log(`\n🚫 SLIPPAGE BLOCK — price moved ${slippage.toFixed(2)}% since decision ($${price.toFixed(4)} → $${freshPrice.toFixed(4)}). Setup changed — entry cancelled.`);
          console.log("═══════════════════════════════════════════════════════════\n");
          slippageOk = false;
        } else {
          console.log(`  ✅ Slippage: ${slippage.toFixed(3)}% (< 0.3% — price stable, executing)`);
        }
      } catch { /* non-critical — proceed on fetch failure */ }

      if (slippageOk && CONFIG.paperTrading) {
        console.log(`\n📋 PAPER TRADE — would buy ${symbol} ~$${finalTradeSize.toFixed(2)} at market`);
        console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-${Date.now()}`;
        log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: (finalTradeSize / price).toFixed(6), orderId: logEntry.orderId, entryType, bearMarket: bullTrendWeekly === false, bearSnapBack } };
      } else if (slippageOk) {
        console.log(`\n🔴 PLACING LIVE ORDER — $${finalTradeSize.toFixed(2)} BUY ${symbol}`);
        try {
          // Try limit order first (better fill price, avoids spread cost)
          // Falls back to market after 30s if not filled
          console.log(`  Attempting limit buy @ $${price.toFixed(4)}...`);
          let order = await placeLimitBuyWithFallback(symbol, finalTradeSize, price);
          if (!order) {
            console.log(`  Falling back to market order...`);
            order = await placeOrder(symbol, "buy", finalTradeSize, price);
          }
          const actualQty = order.confirmedQty ?? (finalTradeSize / price);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: actualQty.toFixed(6), orderId: order.orderId, entryType, bearMarket: bullTrendWeekly === false, bearSnapBack } };
          console.log(`✅ ORDER PLACED — ${order.orderId} | qty: ${actualQty.toFixed(6)}`);
          pushSignal(symbol, "ENTRY", `Bought @ $${price.toFixed(4)} — $${finalTradeSize.toFixed(2)}`);
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
          pushSignal(symbol, "ERROR", `Order failed: ${err.message}`);
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

  // ─── Dashboard PIN ───────────────────────────────────────────────────────────
  const BOT_PIN = process.env.BOT_PIN || "2026";

  function checkPin(url) {
    const pin = new URL(url, "http://localhost").searchParams.get("pin");
    return pin === BOT_PIN;
  }

  async function buildStatusData() {
    const log = loadLog();
    const today = new Date().toISOString().slice(0, 10);
    const todayExits = (log.trades || []).filter(t => t.type === "exit" && t.timestamp?.startsWith(today) && t.pnlUSD !== undefined);
    const todayTrades = (log.trades || []).filter(t => t.timestamp?.startsWith(today) && t.orderPlaced);
    const totalPnlUSD = todayExits.reduce((s, t) => s + (t.pnlUSD || 0), 0);
    const winRate = calcWinRate(log.trades || [], 10);
    const drawdown = checkDailyDrawdown(log);
    let usdtBalance = log.portfolioValue || 0;
    let liveAssets = [];
    if (!CONFIG.paperTrading) {
      try {
        const bg = ACCOUNTS.find(a => a.exchange === "bitget");
        if (bg) {
          const ts = Date.now().toString();
          const bPath = "/api/v2/spot/account/assets";
          const bSign = crypto.createHmac("sha256", bg.secretKey).update(ts + "GET" + bPath).digest("base64");
          const bRes = await fetch(`${bg.baseUrl}${bPath}`, { headers: { "ACCESS-KEY": bg.apiKey, "ACCESS-SIGN": bSign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": bg.passphrase, "locale": "en-US" }, signal: AbortSignal.timeout(5000) });
          const bData = await bRes.json();
          liveAssets = bData.data || [];
          const usdt = liveAssets.find(a => a.coin === "USDT");
          if (usdt) usdtBalance = parseFloat(usdt.available) + parseFloat(usdt.frozen || 0);
        }
      } catch {}
    }
    // Build a quick lookup of live BitGet coin qtys (for phantom-position filtering)
    const liveQty = {};
    for (const asset of liveAssets) {
      const qty = parseFloat(asset.available) + parseFloat(asset.frozen || 0);
      if (qty > 0.000001) liveQty[asset.coin] = qty;
    }

    const openPositions = [];
    let openPositionValue = 0;
    const seenSyms = new Set();
    for (const [sym, pos] of Object.entries(log.positions || {})) {
      if (!pos || !pos.open) continue;
      const baseCoin = sym.replace("USDT", "");
      // Skip phantom positions — log says open but coin no longer in BitGet account
      if (liveAssets.length > 0 && !liveQty[baseCoin]) continue;
      const snap = coinSnapshots[sym];
      const price = snap?.price ?? pos.entryPrice ?? 0;
      // Use live qty if available (more accurate than log quantity after partial fills)
      const qty = liveQty[baseCoin] ?? parseFloat(pos.quantity || 0);
      if (qty < 0.000001 || price < 0.000001) continue;
      const usdVal = qty * price;
      if (usdVal < 0.5) continue;
      openPositionValue += usdVal;
      seenSyms.add(sym);
      const pnlPct = pos.entryPrice ? ((price - pos.entryPrice) / pos.entryPrice) * 100 : 0;
      const bt = BACKTEST[sym];
      const slPct = (pos.bearSnapBack || pos.bearMarket) ? 0.02 : (bt?.stopLoss ?? 0.04);
      const tpPct = pos.entryType === "momentum" ? 0.10 : (bt?.takeProfit ?? 0.08);
      const hwm = pos.highWatermark ?? pos.entryPrice;
      const breakEvenActive = hwm >= pos.entryPrice * 1.02;
      const trailStop = breakEvenActive
        ? Math.max(hwm * 0.98, pos.entryPrice)
        : pos.entryPrice * (1 - slPct);
      const minsOpen = pos.entryTime ? Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 60000) : null;
      const pnlUSD = pos.entryPrice ? qty * (price - pos.entryPrice) : 0;
      openPositions.push({ coin: baseCoin, sym, qty, usdVal, price, entryPrice: pos.entryPrice, pnlPct, pnlUSD, slPct, tpPct, trailStop, breakEvenActive, minsOpen, entryType: pos.entryType || "scalp" });
    }
    // Add live BitGet coin holdings not yet tracked in log
    for (const asset of liveAssets) {
      if (asset.coin === "USDT" || asset.coin === "BGB") continue;
      const qty = parseFloat(asset.available) + parseFloat(asset.frozen || 0);
      if (qty < 0.000001) continue;
      const sym = asset.coin + "USDT";
      if (seenSyms.has(sym)) continue;
      const snap = coinSnapshots[sym];
      const price = snap?.price ?? 0;
      if (price < 0.000001) continue;
      const usdVal = qty * price;
      if (usdVal < 5) continue;
      openPositionValue += usdVal;
      openPositions.push({ coin: asset.coin, sym, qty, usdVal, price, entryPrice: null, pnlPct: null, pnlUSD: null, entryType: "untracked" });
    }
    const portfolioValue = usdtBalance + openPositionValue;
    _livePortfolioValue = portfolioValue; // keep heat gate in sync with dashboard
    const regimeMatch = (log.trades || []).slice(-20).reverse().find(t => t.regime);
    const adaptiveMode = getAdaptiveMode(log.trades || []);
    const heat = calcPortfolioHeat(log, portfolioValue);
    const unrealizedPnlUSD = openPositions.reduce((s, p) => s + (p.pnlUSD ?? 0), 0);
    const todayGainUSD = totalPnlUSD + unrealizedPnlUSD;
    const allExits = (log.trades || []).filter(t => t.type === "exit" && t.pnlPct !== undefined && t.orderPlaced);
    const allWins = allExits.filter(t => t.pnlPct > 0);
    const allLosses = allExits.filter(t => t.pnlPct <= 0);
    const avgWin = allWins.length ? allWins.reduce((s,t) => s + t.pnlPct, 0) / allWins.length : null;
    const avgLoss = allLosses.length ? allLosses.reduce((s,t) => s + t.pnlPct, 0) / allLosses.length : null;
    const wrRate = allExits.length ? allWins.length / allExits.length : 0;
    const expectancy = allExits.length >= 2 ? (wrRate * (avgWin ?? 0) + (1 - wrRate) * (avgLoss ?? 0)).toFixed(2) : null;
    // Fall back to CSV history when the in-memory log lacks enough closed trades
    const csvStats = allExits.length < 3 ? loadCsvStats() : null;
    const btcSnap = coinSnapshots["BTCUSDT"] || null;
    const btcPrice = btcSnap?.price ?? (_topGainers.find(t => t.symbol === "BTCUSDT")?.price ?? null);
    const nearEntry = Object.values(coinSnapshots).filter(c => {
      const rsi = parseFloat(c.rsi3 || 50);
      const volPct = parseFloat(c.volPct || 0);
      const gainer = (_topGainers || []).find(t => t.symbol === c.symbol);
      const isMom = gainer && gainer.change24h >= 5;
      if (isMom) return rsi >= 40 && rsi <= 82 && c.trend15m === "up" && volPct >= 150 && parseFloat(c.stochK || 100) < 90;
      const rsiGap = Math.max(0, rsi - 30);
      return (1 - rsiGap / 70) * 0.6 + (c.trend4h === "up" ? 0.2 : 0) + (c.volAboveAvg ? 0.1 : 0) >= 0.75;
    }).length;
    const lastTradeAt = (log.trades || []).filter(t => t.orderPlaced && t.timestamp).slice(-1)[0]?.timestamp || null;
    return {
      portfolioValue, usdtBalance, openPositions,
      regime: regimeMatch?.regime || "RANGING",
      paused: _tradingPaused || drawdown.paused,
      pauseReason: drawdown.paused ? "Drawdown limit hit" : _tradingPaused ? "Manually paused" : null,
      todayTrades: todayTrades.length,
      todayPnlUSD: totalPnlUSD,
      todayGainUSD,
      unrealizedPnlUSD,
      winRate: csvStats ? csvStats.winRateStr : (winRate ? `${winRate.wins}/${winRate.sample} (${(winRate.winRate * 100).toFixed(0)}%)` : "—"),
      winRatePct: csvStats ? csvStats.winRatePct : (winRate ? winRate.winRate * 100 : null),
      avgWin: csvStats ? csvStats.avgWin : (avgWin != null ? avgWin.toFixed(2) : null),
      avgLoss: csvStats ? csvStats.avgLoss : (avgLoss != null ? avgLoss.toFixed(2) : null),
      expectancy: csvStats ? csvStats.expectancy : expectancy,
      totalTrades: csvStats ? csvStats.totalTrades : allExits.length,
      totalWins: csvStats ? csvStats.totalWins : allWins.length,
      drawdownPct: drawdown.drawdownPct, drawdownLimit: drawdown.limit,
      heatPct: heat.heatPct, isOverheated: heat.isOverheated,
      adaptiveLabel: adaptiveMode.label, adaptiveMode: adaptiveMode.mode,
      btcPrice,
      lastScanMs: _lastScanTime,
      scanIntervalMs: 5 * 60 * 1000,
      coinsScanned: _lastScanCount || Object.keys(coinSnapshots).length,
      nearEntry,
      lastTradeAt,
      lastTrades: (log.trades || []).slice(-10).reverse(),
      signals: signalLog.slice(-30).reverse(),
      coins: coinSnapshots,
      topGainers: _topGainers,
      updatedAt: new Date().toLocaleTimeString(),
    };
  }

  function dashboardHTML(d, pin) {
    const pf = d.portfolioValue;
    const pnlColor = d.todayPnlUSD >= 0 ? "#00d4a0" : "#ff4d6a";
    const regColor = d.regime.includes("BEAR") ? "#ff4d6a" : d.regime.includes("BULL") ? "#00d4a0" : "#ffb800";

    const posHTML = d.openPositions.length === 0
      ? `<div style="padding:24px;text-align:center;color:#4a5272;font-size:14px">All cash — no open positions</div>`
      : d.openPositions.map(p => {
          const pc = p.pnlPct != null ? (p.pnlPct >= 0 ? "#00d4a0" : "#ff4d6a") : "#4f8dff";
          const hasEntry = p.entryPrice != null && p.slPct != null && p.tpPct != null;
          const slPct = hasEntry ? p.slPct * 100 : 0;
          const tpPct = hasEntry ? p.tpPct * 100 : 0;
          const slPrice = hasEntry ? (p.entryPrice * (1 - p.slPct)).toFixed(4) : "—";
          const tpPrice = hasEntry ? (p.entryPrice * (1 + p.tpPct)).toFixed(4) : "—";
          const range = hasEntry ? (tpPct + slPct) : 100;
          const progress = hasEntry && p.pnlPct != null ? Math.min(100, Math.max(0, ((p.pnlPct + slPct) / range) * 100)) : 50;
          const barColor = p.pnlPct != null ? (p.pnlPct >= 0 ? "#00d4a0" : "#ff4d6a") : "#4f8dff";
          const timeStr = p.minsOpen != null ? (p.minsOpen >= 60 ? `${Math.floor(p.minsOpen/60)}h ${p.minsOpen%60}m` : `${p.minsOpen}m`) : "—";
          const typeLabel = p.entryType === "momentum" ? "MOMENTUM" : p.entryType === "snapback" ? "SNAP-BACK" : p.entryType === "untracked" ? "LIVE" : "SCALP";
          const stopLabel = p.breakEvenActive ? `Break-even stop $${p.trailStop?.toFixed(4) ?? "—"}` : hasEntry ? `Stop-loss $${slPrice} (-${slPct.toFixed(0)}%)` : "Entry untracked";
          return `<a href="/coin?symbol=${p.sym}&pin=${pin}" style="display:block;padding:16px 18px;border-bottom:1px solid #1a1f2e;text-decoration:none;color:inherit">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
              <div style="display:flex;align-items:center;gap:10px">
                <div style="width:40px;height:40px;border-radius:12px;background:${pc}18;color:${pc};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800">${p.coin.slice(0,3)}</div>
                <div>
                  <div style="font-size:16px;font-weight:700">${p.coin} <span style="font-size:10px;font-weight:600;color:#4f8dff;background:#4f8dff15;padding:2px 6px;border-radius:4px">${typeLabel}</span></div>
                  <div style="font-size:11px;color:#4a5272;margin-top:2px">In ${timeStr} &middot; $${Number(p.usdVal).toFixed(2)}</div>
                </div>
              </div>
              <div style="text-align:right">
                <div style="font-size:20px;font-weight:800;color:${pc}">${p.pnlPct != null ? (p.pnlPct >= 0 ? "+" : "") + Number(p.pnlPct).toFixed(2) + "%" : "—"}</div>
                <div style="font-size:13px;font-weight:600;color:${pc}">${p.pnlUSD != null ? (p.pnlUSD >= 0 ? "+" : "") + "$" + Math.abs(Number(p.pnlUSD)).toFixed(2) : ""}</div>
                <div style="font-size:11px;color:#4a5272">$${Number(p.price).toFixed(4)}</div>
              </div>
            </div>
            <div style="background:#1a1f2e;border-radius:99px;height:6px;overflow:hidden;margin-bottom:8px;position:relative">
              <div style="position:absolute;left:0;top:0;height:100%;width:${progress}%;background:${barColor};border-radius:99px;transition:width .3s"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:#4a5272">
              <span style="color:#ff4d6a">▼ ${stopLabel}</span>
              <span style="color:#00d4a0">▲ ${hasEntry ? `Target +${tpPct.toFixed(0)}% ($${tpPrice})` : "—"}</span>
            </div>
          </a>`;
        }).join("");

    const tradesHTML = d.lastTrades.length === 0
      ? `<div style="padding:24px;text-align:center;color:#4a5272;font-size:14px">No trades yet</div>`
      : d.lastTrades.map(t => {
          const isEntry = t.type === "entry";
          const pv = t.pnlPct != null ? parseFloat(t.pnlPct) : null;
          const pc = pv == null ? "#4a5272" : pv >= 0 ? "#00d4a0" : "#ff4d6a";
          const icon = isEntry ? "↑" : pv != null && pv >= 0 ? "✓" : "↓";
          const iconBg = isEntry ? "#4f8dff18" : pv != null && pv >= 0 ? "#00d4a018" : "#ff4d6a18";
          const iconColor = isEntry ? "#4f8dff" : pv != null && pv >= 0 ? "#00d4a0" : "#ff4d6a";
          return `<div style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1a1f2e">
            <div style="display:flex;align-items:center;gap:12px">
              <div style="width:38px;height:38px;border-radius:12px;background:${iconBg};color:${iconColor};display:flex;align-items:center;justify-content:center;font-size:16px">${icon}</div>
              <div><div style="font-size:15px;font-weight:700">${(t.symbol||"").replace("USDT","")}</div><div style="font-size:12px;color:#4a5272">${isEntry?"Entry":"Exit"} &middot; $${Number(t.price||0).toFixed(4)}</div></div>
            </div>
            <div style="text-align:right"><div style="font-size:14px;font-weight:700;color:${pc}">${t.pnlPct != null ? (t.pnlPct >= 0 ? "+" : "") + Number(t.pnlPct).toFixed(2) + "%" : ""}</div><div style="font-size:12px;color:#4a5272">${(t.timestamp||"").slice(11,16)} UTC</div></div>
          </div>`;
        }).join("");

    const sigHTML = d.signals.length === 0
      ? `<div style="padding:24px;text-align:center;color:#4a5272;font-size:14px">Bot is scanning...</div>`
      : d.signals.map(s => {
          const sc = s.result === "ENTRY" ? "#4f8dff" : s.result === "EXIT_WIN" ? "#00d4a0" : s.result === "EXIT_LOSS" ? "#ff4d6a" : "#4a5272";
          return `<div style="padding:12px 18px;display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #1a1f2e">
            <div style="font-size:12px;color:#94a3b8;max-width:220px;line-height:1.5"><b style="color:#f0f2f7">${(s.symbol||"").replace("USDT","")}</b> ${s.reason||""}</div>
            <div style="text-align:right;flex-shrink:0;margin-left:8px"><div style="font-size:11px;font-weight:700;color:${sc}">${s.result}</div><div style="font-size:10px;color:#4a5272">${(s.time||"").slice(11,16)}</div></div>
          </div>`;
        }).join("");

    // ── Closest to Entry — score every coin by how close it is to a trade ────
    const readiness = Object.entries(d.coins || {}).map(([sym, c]) => {
      const rsi = parseFloat(c.rsi3 || 100);
      const price = parseFloat(c.price || 0);
      const vwap = parseFloat(c.vwap || 0);
      const volPct = parseFloat(c.volPct || 0);
      const gainer = (d.topGainers || []).find(t => t.symbol === sym);
      const isMomentum = gainer && gainer.change24h >= 5 && gainer.change24h <= 40;

      let score, type, label, missing;
      if (isMomentum) {
        const rsiOk = rsi >= 40 && rsi <= 82;
        const aboveEma = c.trend15m === "up";
        const volOk = volPct >= 150;
        const stochOk = parseFloat(c.stochK || 100) < 90;
        score = [rsiOk, aboveEma, volOk, stochOk].filter(Boolean).length / 4;
        type = "momentum";
        label = `+${gainer.change24h.toFixed(1)}% today`;
        missing = [!rsiOk && `RSI ${rsi.toFixed(0)}`, !aboveEma && "Below EMA8", !volOk && `Vol ${volPct}%<150%`, !stochOk && "StochRSI>90"].filter(Boolean);
      } else {
        const rsiGap = Math.max(0, rsi - 30);
        const rsiScore = Math.max(0, 1 - rsiGap / 70);
        const trendOk = c.trend4h === "up";
        const nearVwap = vwap > 0 && Math.abs((price - vwap) / vwap * 100) < 3;
        const volOk = c.volAboveAvg;
        score = rsiScore * 0.6 + (trendOk ? 0.2 : 0) + (nearVwap ? 0.1 : 0) + (volOk ? 0.1 : 0);
        type = "mean-rev";
        label = `RSI ${rsi.toFixed(0)}`;
        missing = [rsiGap > 0 && `RSI ${rsi.toFixed(0)}→<30`, !trendOk && "4H↓", !nearVwap && "Far VWAP", !volOk && "Low vol"].filter(Boolean);
      }
      return { sym, coin: sym.replace("USDT",""), score, type, label, missing };
    }).sort((a, b) => b.score - a.score).slice(0, 8);

    const readinessHTML = readiness.length === 0
      ? `<div style="padding:24px;text-align:center;color:#4a5272;font-size:13px">Waiting for first scan…</div>`
      : readiness.map((r) => {
          const c = d.coins[r.sym] || {};
          const pct = Math.round(r.score * 100);
          const barColor = pct >= 75 ? "#00d4a0" : pct >= 50 ? "#ffb800" : "#4a5272";
          const typeColor = r.type === "momentum" ? "#4f8dff" : "#a78bfa";
          const lastSig = c.lastSignal;
          const lastResult = lastSig?.result || null;
          const lastReason = lastSig?.reason || "";
          const statusColor = lastResult === "ENTRY" ? "#4f8dff" : lastResult === "BLOCKED" ? "#ff4d6a" : lastResult === "HOLD" ? "#ffb800" : pct >= 75 ? "#00d4a0" : "#4a5272";
          const statusLine = lastResult === "ENTRY" ? "✅ Bought — position open"
            : lastResult === "BLOCKED" ? `🚫 ${lastReason.slice(0, 80)}`
            : lastResult === "HOLD" ? `🤖 ${lastReason.slice(0, 80)}`
            : r.missing.length === 0 ? "⏳ Ready — waiting for next scan"
            : `Needs: ${r.missing.join(" · ")}`;

          const rsi = parseFloat(c.rsi3 || 50);
          const price = parseFloat(c.price || 0);
          const vwap = parseFloat(c.vwap || 0);
          const ema8 = parseFloat(c.ema8 || 0);
          const volPct = parseFloat(c.volPct || 0);
          const stochK = parseFloat(c.stochK || 50);
          const priceStr = price < 0.01 ? price.toFixed(6) : price < 1 ? price.toFixed(4) : price.toFixed(2);

          // Per-type condition checks with ✓/✗
          let conditions;
          if (r.type === "momentum") {
            conditions = [
              { label: `RSI ${rsi.toFixed(0)}`, sub: "40–82",     ok: rsi >= 40 && rsi <= 82 },
              { label: `EMA8 ${price > ema8 && ema8 > 0 ? "Above" : "Below"}`, sub: "above",  ok: price > ema8 && ema8 > 0 },
              { label: `Vol ${volPct.toFixed(0)}%`,   sub: ">150%",    ok: volPct >= 150 },
              { label: `StochK ${stochK.toFixed(0)}`, sub: "<90",      ok: stochK < 90 },
              { label: `MACD ${c.macdBullish ? "Bull" : "Bear"}`, sub: "bull", ok: !!c.macdBullish },
              { label: `4H ${c.trend4h === "up" ? "↑" : "↓"}`,   sub: "up",   ok: c.trend4h === "up" },
              { label: `ADX ${c.adx != null ? Number(c.adx).toFixed(0) : "—"}`, sub: ">20",  ok: !!c.adxTrending },
              { label: `VWAP ${price > vwap && vwap > 0 ? "Above" : "Below"}`, sub: "above", ok: price > vwap && vwap > 0 },
            ];
          } else {
            const nearVwap = vwap > 0 && Math.abs((price - vwap) / vwap * 100) < 3;
            conditions = [
              { label: `RSI ${rsi.toFixed(0)}`,        sub: "<30",    ok: rsi < 30 },
              { label: `StochK ${stochK.toFixed(0)}`,  sub: "OS<20",  ok: !!c.stochOversold },
              { label: `MACD ${c.macdBullish ? "Bull" : "Bear"}`, sub: "bull", ok: !!c.macdBullish },
              { label: `4H ${c.trend4h === "up" ? "↑" : "↓"}`,   sub: "up",   ok: c.trend4h === "up" },
              { label: `VWAP ${nearVwap ? "Near" : price > vwap ? "Above" : "Below"}`, sub: "<3%", ok: nearVwap },
              { label: `EMA8 ${price > ema8 && ema8 > 0 ? "Above" : "Below"}`, sub: "above", ok: price > ema8 && ema8 > 0 },
              { label: `Vol ${c.volAboveAvg ? "High" : "Low"}`,  sub: ">avg",  ok: !!c.volAboveAvg },
              { label: `ADX ${c.adx != null ? Number(c.adx).toFixed(0) : "—"}`, sub: ">20",  ok: !!c.adxTrending },
            ];
          }
          const condHTML = conditions.map(cond =>
            `<div style="display:flex;align-items:center;gap:3px;background:${cond.ok ? "#00d4a012" : "#1a1f2e"};border:1px solid ${cond.ok ? "#00d4a035" : "#252a3a"};border-radius:6px;padding:4px 7px">
              <span style="font-size:9px;font-weight:800;color:${cond.ok ? "#00d4a0" : "#ff4d6a"}">${cond.ok ? "✓" : "✗"}</span>
              <span style="font-size:10px;color:${cond.ok ? "#e2f9f5" : "#525870"};white-space:nowrap">${cond.label}</span>
            </div>`).join("");

          // Bonus signals
          const bonus = [];
          if (c.divergence)              bonus.push(`<span style="background:#00d4a012;border:1px solid #00d4a035;border-radius:6px;padding:3px 7px;font-size:10px;color:#00d4a0;font-weight:600">⚡ Divergence</span>`);
          if (c.doubleBottom?.detected && c.doubleBottom.strongConfirmation)
                                         bonus.push(`<span style="background:#4f8dff12;border:1px solid #4f8dff35;border-radius:6px;padding:3px 7px;font-size:10px;color:#4f8dff;font-weight:600">📐 Double Bottom ✓</span>`);
          else if (c.doubleBottom?.detected)
                                         bonus.push(`<span style="background:#4f8dff12;border:1px solid #4f8dff35;border-radius:6px;padding:3px 7px;font-size:10px;color:#4f8dff;font-weight:600">📐 Double Bottom</span>`);
          if (c.obvRising)               bonus.push(`<span style="background:#4f8dff12;border:1px solid #4f8dff35;border-radius:6px;padding:3px 7px;font-size:10px;color:#4f8dff;font-weight:600">📈 OBV Rising</span>`);
          if (c.nearSupport)             bonus.push(`<span style="background:#ffb80012;border:1px solid #ffb80035;border-radius:6px;padding:3px 7px;font-size:10px;color:#ffb800;font-weight:600">🏗️ Near Support</span>`);
          if (c.patterns) String(c.patterns).split(", ").slice(0, 3).forEach(p =>
                                         bonus.push(`<span style="background:#a78bfa12;border:1px solid #a78bfa35;border-radius:6px;padding:3px 7px;font-size:10px;color:#a78bfa;font-weight:600">📊 ${p}</span>`));

          // Trend matrix
          const tc = (t) => t === "up" ? "#00d4a0" : "#ff4d6a";
          const ta = (t) => t === "up" ? "↑" : "↓";
          const trendBar = ["15m","1h","4h","Wk"].map((lbl, i) => {
            const t = [c.trend15m, c.trend1h, c.trend4h, c.trendWeekly][i];
            return `<span style="font-size:10px;color:#4a5272;white-space:nowrap">${lbl}<span style="color:${tc(t)};font-weight:700">${ta(t)}</span></span>`;
          }).join("");

          // S/R distances
          const srParts = [];
          if (c.distToSupport  != null) srParts.push(`<span style="font-size:10px;color:#4a5272">Sup: <span style="color:${c.nearSupport ? "#00d4a0" : "#94a3b8"}">${Number(c.distToSupport).toFixed(1)}% away</span></span>`);
          if (c.distToResistance != null) srParts.push(`<span style="font-size:10px;color:#4a5272">Res: <span style="color:#ff4d6a">${Number(c.distToResistance).toFixed(1)}% away</span></span>`);

          return `<div style="padding:14px 16px;border-bottom:1px solid #1a1f2e">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
              <div style="display:flex;align-items:center;gap:9px">
                <div style="width:34px;height:34px;border-radius:10px;background:${barColor}18;color:${barColor};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;flex-shrink:0">${r.coin.slice(0,4)}</div>
                <div>
                  <div style="font-size:14px;font-weight:700;display:flex;align-items:center;gap:6px">
                    ${r.coin}
                    <span style="font-size:9px;font-weight:700;color:${typeColor};background:${typeColor}18;padding:2px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em">${r.type}</span>
                  </div>
                  <div style="font-size:11px;color:#4a5272">$${priceStr} &nbsp;·&nbsp; ${r.label}</div>
                </div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:20px;font-weight:800;color:${barColor}">${pct}%</div>
                <div style="font-size:9px;color:#4a5272;letter-spacing:.04em">READY</div>
              </div>
            </div>
            <div style="background:#1a1f2e;border-radius:99px;height:4px;overflow:hidden;margin-bottom:8px">
              <div style="width:${pct}%;height:100%;background:${barColor};border-radius:99px"></div>
            </div>
            <div style="font-size:11px;color:${statusColor};margin-bottom:9px;line-height:1.4">${statusLine}</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:7px">${condHTML}</div>
            ${bonus.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:7px">${bonus.join("")}</div>` : ""}
            <div style="margin:0 0 7px">
              <div style="display:flex;justify-content:space-between;font-size:9px;color:#4a5272;margin-bottom:2px">
                <span>RSI 0 (OS)</span><span style="font-weight:600;color:${rsi < 30 ? "#00d4a0" : rsi > 70 ? "#ff4d6a" : "#94a3b8"}">${rsi.toFixed(0)}</span><span>100 (OB)</span>
              </div>
              <div style="position:relative;height:5px;border-radius:3px;overflow:hidden">
                <div style="position:absolute;inset:0;background:linear-gradient(to right,#00d4a0 0%,#00d4a0 28%,#1c2235 30%,#1c2235 68%,#ff4d6a 70%,#ff4d6a 100%)"></div>
                <div style="position:absolute;top:0;left:${Math.min(98,Math.max(2,rsi))}%;width:3px;height:100%;background:#fff;opacity:.9;border-radius:2px;transform:translateX(-50%)"></div>
              </div>
            </div>
            ${c.bbPct != null ? `<div style="margin:0 0 7px">
              <div style="display:flex;justify-content:space-between;font-size:9px;color:#4a5272;margin-bottom:2px">
                <span>BB low</span><span style="font-weight:600;color:${parseFloat(c.bbPct) > 80 ? "#ff4d6a" : parseFloat(c.bbPct) < 20 ? "#00d4a0" : "#94a3b8"}">BB% ${c.bbPct}%</span><span>BB high</span>
              </div>
              <div style="position:relative;height:4px;border-radius:3px;overflow:hidden">
                <div style="position:absolute;inset:0;background:linear-gradient(to right,#00d4a0 0%,#1c2235 20%,#1c2235 80%,#ff4d6a 100%)"></div>
                <div style="position:absolute;top:0;left:${Math.min(98,Math.max(2,parseFloat(c.bbPct||50)))}%;width:3px;height:100%;background:#fff;opacity:.9;border-radius:2px;transform:translateX(-50%)"></div>
              </div>
            </div>` : ""}
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div style="display:flex;gap:8px">${trendBar}</div>
              <div style="display:flex;gap:8px">${srParts.join(" ")}</div>
            </div>
          </div>`;
        }).join("");

    const coinsArr = Object.entries(d.coins || {});
    const coinsHTML = coinsArr.length === 0
      ? `<div style="padding:24px;text-align:center;color:#4a5272;font-size:14px">Waiting for first scan...</div>`
      : coinsArr.map(([sym, c]) => {
          const coin = sym.replace("USDT","");
          const res = c.lastSignal?.result || "—";
          const rc = res === "ENTRY" ? "#4f8dff" : res === "EXIT_WIN" ? "#00d4a0" : res === "EXIT_LOSS" ? "#ff4d6a" : "#4a5272";
          const t15 = c.trend15m === "up" ? "↑" : "↓"; const tc15 = c.trend15m === "up" ? "#00d4a0" : "#ff4d6a";
          const t1h = c.trend1h === "up" ? "↑" : "↓"; const tc1h = c.trend1h === "up" ? "#00d4a0" : "#ff4d6a";
          const t4h = c.trend4h === "up" ? "↑" : "↓"; const tc4h = c.trend4h === "up" ? "#00d4a0" : "#ff4d6a";
          const rsiNum = parseFloat(c.rsi3 || 50);
          const rsiColor = rsiNum < 30 ? "#00d4a0" : rsiNum > 70 ? "#ff4d6a" : "#f0f2f7";
          const macdColor = c.macdBullish ? "#00d4a0" : "#ff4d6a";
          const vwapColor = parseFloat(c.price) > parseFloat(c.vwap || 0) ? "#00d4a0" : "#ff4d6a";
          return `<a href="/coin?symbol=${sym}&pin=${pin}" data-coin="${coin.toLowerCase()}" style="display:block;padding:14px 18px;border-bottom:1px solid #1a1f2e;text-decoration:none;color:inherit">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <div style="display:flex;align-items:center;gap:10px">
                <div style="width:36px;height:36px;border-radius:10px;background:${rc}22;color:${rc};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0">${coin.slice(0,3)}</div>
                <div><div style="font-size:15px;font-weight:700">${coin}</div><div style="font-size:11px;color:#4a5272">$${Number(c.price||0).toFixed(4)} &nbsp;&#x25B8; details</div></div>
              </div>
              <div style="text-align:right"><div style="font-size:13px;font-weight:700;color:${rc}">${res}</div></div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              <span style="background:#1a1f2e;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600;color:${rsiColor}">RSI ${c.rsi3||"—"}</span>
              <span style="background:#1a1f2e;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600;color:${macdColor}">MACD ${c.macdBullish ? "Bull" : "Bear"}</span>
              <span style="background:#1a1f2e;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600;color:${vwapColor}">VWAP ${parseFloat(c.price) > parseFloat(c.vwap||0) ? "Above" : "Below"}</span>
              <span style="background:#1a1f2e;border-radius:6px;padding:3px 8px;font-size:11px;color:#94a3b8">15m<span style="color:${tc15}">${t15}</span> 1H<span style="color:${tc1h}">${t1h}</span> 4H<span style="color:${tc4h}">${t4h}</span></span>
              ${c.stochOversold ? `<span style="background:#00d4a018;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600;color:#00d4a0">StochRSI OS</span>` : ""}
              ${c.adxTrending ? `<span style="background:#4f8dff18;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600;color:#4f8dff">ADX Trend</span>` : ""}
              ${c.divergence ? `<span style="background:#00d4a018;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600;color:#00d4a0">Divergence</span>` : ""}
            </div>
          </a>`;
        }).join("");

    const ddUsed = Math.min(100, (d.drawdownPct / d.drawdownLimit) * 100);
    const ddColor = ddUsed > 70 ? "#ff4d6a" : ddUsed > 40 ? "#ffb800" : "#00d4a0";
    const heatColor = d.heatPct > 6 ? "#ff4d6a" : d.heatPct > 3 ? "#ffb800" : "#00d4a0";
    const modeColor = d.adaptiveMode === "normal" ? "#00d4a0" : d.adaptiveMode === "cautious" ? "#ffb800" : d.adaptiveMode === "defensive" ? "#ff8c42" : "#ff4d6a";
    const modeIcon  = d.adaptiveMode === "normal" ? "✅" : d.adaptiveMode === "cautious" ? "⚠️" : d.adaptiveMode === "defensive" ? "🔴" : "🛑";
    const wrNum = d.winRatePct;
    const wrColor = wrNum === null ? "#4a5272" : wrNum >= 60 ? "#00d4a0" : wrNum >= 40 ? "#ffb800" : "#ff4d6a";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>AlphaBot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#07090f;color:#f0f2f7;max-width:430px;margin:0 auto;padding-bottom:48px}
.sec{margin:14px 16px 0}
.sec-title{font-size:11px;font-weight:700;color:#4a5272;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;padding:0 2px}
.card{background:#0e1117;border:1px solid #1a1f2e;border-radius:18px;overflow:hidden}
.card>*:last-child{border-bottom:none!important}
.row{padding:13px 18px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1a1f2e}
.lbl{font-size:12px;color:#4a5272}
.val{font-size:13px;font-weight:700}
.btn{display:block;width:100%;padding:15px;border-radius:14px;border:none;font-size:15px;font-weight:700;cursor:pointer;text-align:center;font-family:inherit}
.btn-blue{background:linear-gradient(135deg,#4f8dff,#2563eb);color:#fff}
.btn-red{background:linear-gradient(135deg,#ff4d6a,#dc2626);color:#fff}
.btn-grey{background:#0e1117;color:#94a3b8;border:1px solid #1a1f2e}
.chip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600}
.dot{width:6px;height:6px;border-radius:50%;background:#00d4a0;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.bar-track{background:#1a1f2e;border-radius:99px;height:5px;overflow:hidden;margin-top:5px}
.bar-fill{height:100%;border-radius:99px}
</style>
</head>
<body>

<!-- ── HEADER ─────────────────────────────────────────────────── -->
<div style="padding:18px 18px 0;display:flex;align-items:center;justify-content:space-between">
  <div style="display:flex;align-items:center;gap:10px">
    <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#4f8dff,#00d4a0);display:flex;align-items:center;justify-content:center;font-size:18px">📈</div>
    <div>
      <div style="font-size:17px;font-weight:800;letter-spacing:-.3px">AlphaBot</div>
      <div style="font-size:11px;color:#4a5272">Updated ${d.updatedAt}</div>
    </div>
  </div>
  <div style="text-align:right">
    <div style="display:flex;align-items:center;gap:6px;background:#00d4a015;border:1px solid #00d4a030;border-radius:99px;padding:5px 10px;font-size:11px;font-weight:600;color:#00d4a0"><span class="dot"></span>LIVE</div>
    ${d.btcPrice ? `<div style="font-size:11px;color:#4a5272;margin-top:4px;text-align:right">BTC $${Number(d.btcPrice).toLocaleString()}</div>` : ""}
  </div>
</div>

<!-- ── SEARCH ─────────────────────────────────────────────────── -->
<div style="margin:12px 16px 0">
  <form method="GET" action="/coin" onsubmit="var v=this.symbol.value.trim().toUpperCase();if(!v)return false;if(!v.endsWith('USDT'))this.symbol.value=v+'USDT';">
    <input type="hidden" name="pin" value="${pin}">
    <div style="display:flex;gap:8px">
      <input type="text" name="symbol" placeholder="Search any coin — BTC, PEPE, DOGE..." autocomplete="off" autocapitalize="characters" spellcheck="false"
        style="flex:1;background:#0e1117;border:1px solid #1a1f2e;border-radius:12px;padding:12px 16px;color:#f0f2f7;font-size:15px;outline:none;font-family:inherit">
      <button type="submit" style="background:linear-gradient(135deg,#4f8dff,#2563eb);color:#fff;border:none;border-radius:12px;padding:12px 18px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit">Go</button>
    </div>
  </form>
</div>

<!-- ── SCAN PULSE ─────────────────────────────────────────────── -->
<div style="margin:8px 16px 0;padding:9px 14px;background:#0e1117;border:1px solid #1a1f2e;border-radius:12px;display:flex;justify-content:space-between;align-items:center;gap:8px">
  <div style="font-size:11px;color:#4a5272;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <span>Scanned: <span id="last-scan-ago" style="color:#94a3b8">${d.lastScanMs ? "just now" : "starting up…"}</span></span>
    <span style="color:#252a3a">·</span>
    <span>${d.coinsScanned || 0} coins</span>
    <span style="color:#252a3a">·</span>
    <span style="color:${d.nearEntry > 0 ? "#ffb800" : "#4a5272"};font-weight:${d.nearEntry > 0 ? "700" : "400"}">${d.nearEntry} near entry</span>
  </div>
  <div style="font-size:11px;white-space:nowrap;flex-shrink:0">
    <span style="color:#4a5272">Next </span><span id="next-scan" style="color:#4f8dff;font-weight:700">${d.lastScanMs ? "—" : "~5m"}</span>
  </div>
</div>

<!-- ── PORTFOLIO HERO ─────────────────────────────────────────── -->
<div style="margin:14px 16px 0;background:linear-gradient(135deg,#0d1a33,#091020);border:1px solid #1a2a4a;border-radius:22px;padding:22px">
  <div style="font-size:11px;color:#4a5272;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Total Portfolio</div>
  <div style="font-size:44px;font-weight:800;letter-spacing:-2px;line-height:1;margin-bottom:4px">$${Number(pf).toFixed(2)}</div>
  <div style="font-size:13px;font-weight:600;color:${(d.todayGainUSD??0) >= 0 ? "#00d4a0" : "#ff4d6a"};margin-bottom:18px">${(d.todayGainUSD??0) >= 0 ? "+" : ""}$${Math.abs(d.todayGainUSD??0).toFixed(2)} today <span style="font-size:11px;opacity:.7">(open ${(d.unrealizedPnlUSD??0)>=0?"+":""}$${(d.unrealizedPnlUSD??0).toFixed(2)} · closed ${(d.todayPnlUSD??0)>=0?"+":""}$${(d.todayPnlUSD??0).toFixed(2)})</span></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 20px">
    <div><div style="font-size:10px;color:#4a5272;margin-bottom:3px">CASH</div><div style="font-size:14px;font-weight:700">$${Number(d.usdtBalance).toFixed(2)}</div></div>
    <div><div style="font-size:10px;color:#4a5272;margin-bottom:3px">POSITIONS</div><div style="font-size:14px;font-weight:700">${d.openPositions.length} / 4</div></div>
    <div><div style="font-size:10px;color:#4a5272;margin-bottom:3px">TODAY TRADES</div><div style="font-size:14px;font-weight:700">${d.todayTrades}</div></div>
    <div><div style="font-size:10px;color:#4a5272;margin-bottom:3px">LAST TRADE</div><div style="font-size:14px;font-weight:700" id="last-trade-ago">${d.lastTradeAt ? "—" : "—"}</div></div>
  </div>
</div>

<!-- ── DAILY GOAL ──────────────────────────────────────────────── -->
${(() => {
  const goalPct = 3;
  const goalUSD = pf * goalPct / 100;
  const earnedUSD = Math.max(0, d.todayGainUSD || 0);
  const progress = Math.min(100, Math.max(0, (earnedUSD / goalUSD) * 100));
  const remaining = Math.max(0, goalUSD - earnedUSD);
  const goalColor = progress >= 100 ? "#00d4a0" : progress >= 50 ? "#ffb800" : "#4f8dff";
  const goalIcon = progress >= 100 ? "🏆" : progress >= 75 ? "🔥" : progress >= 50 ? "⚡" : "🎯";
  const openGain = d.unrealizedPnlUSD ?? 0;
  const realizedGain = d.todayPnlUSD ?? 0;
  const subLabel = progress >= 100
    ? "Goal hit — bot keeps trading"
    : `+$${earnedUSD.toFixed(2)} of $+${goalUSD.toFixed(2)} (${openGain >= 0 ? "+" : ""}$${openGain.toFixed(2)} open, ${realizedGain >= 0 ? "+" : ""}$${realizedGain.toFixed(2)} closed)`;
  return `<div style="margin:10px 16px 0;background:linear-gradient(135deg,#0d1f0d,#091209);border:1px solid #1a3a1a;border-radius:18px;padding:18px">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
    <div>
      <div style="font-size:10px;color:#4a7a4a;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Daily Progress ${goalIcon}</div>
      <div style="font-size:28px;font-weight:800;letter-spacing:-1px;color:${goalColor}">${progress.toFixed(0)}%</div>
      <div style="font-size:11px;color:#4a7a4a;margin-top:2px;line-height:1.4">${subLabel}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;color:#4a7a4a;margin-bottom:4px">Target +${goalPct}%/day</div>
      <div style="font-size:22px;font-weight:800;color:#00d4a0">+$${goalUSD.toFixed(2)}</div>
      ${remaining > 0 ? `<div style="font-size:11px;color:#4a7a4a">$${remaining.toFixed(2)} to go</div>` : ""}
    </div>
  </div>
  <div style="background:#0a1f0a;border-radius:99px;height:8px;overflow:hidden;margin-bottom:8px">
    <div style="width:${progress}%;height:100%;background:linear-gradient(90deg,#00d4a0,${goalColor});border-radius:99px;transition:width .5s"></div>
  </div>
  <div style="display:flex;justify-content:space-between;font-size:10px;color:#4a7a4a">
    <span>$0</span>
    <span>+$${goalUSD.toFixed(2)}</span>
  </div>
</div>`;
})()}

<!-- ── PERFORMANCE STATS ──────────────────────────────────────── -->
<div style="margin:10px 16px 0;display:grid;grid-template-columns:1fr 1fr;gap:8px">
  <div style="background:#0e1117;border:1px solid #1a1f2e;border-radius:14px;padding:13px">
    <div style="font-size:10px;color:#4a5272;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Win Rate (last 10)</div>
    <div style="font-size:22px;font-weight:800;color:${wrColor}">${wrNum !== null ? wrNum.toFixed(0) + "%" : "—"}</div>
    <div style="font-size:11px;color:#4a5272;margin-top:2px">${d.winRate}</div>
    ${wrNum !== null ? `<div class="bar-track" style="margin-top:8px"><div class="bar-fill" style="width:${wrNum}%;background:${wrColor}"></div></div>` : ""}
  </div>
  <div style="background:#0e1117;border:1px solid #1a1f2e;border-radius:14px;padding:13px">
    <div style="font-size:10px;color:#4a5272;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Expectancy / Trade</div>
    <div style="font-size:22px;font-weight:800;color:${d.expectancy !== null ? parseFloat(d.expectancy) >= 0 ? "#00d4a0" : "#ff4d6a" : "#4a5272"}">${d.expectancy !== null ? (parseFloat(d.expectancy) >= 0 ? "+" : "") + d.expectancy + "%" : "—"}</div>
    <div style="font-size:11px;color:#4a5272;margin-top:2px">${d.totalTrades} total trades</div>
  </div>
</div>
<div style="margin:8px 16px 0;display:grid;grid-template-columns:1fr 1fr;gap:8px">
  <div style="background:#0e1117;border:1px solid #1a1f2e;border-radius:14px;padding:13px">
    <div style="font-size:10px;color:#4a5272;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Avg Win</div>
    <div style="font-size:22px;font-weight:800;color:#00d4a0">${d.avgWin != null ? "+" + d.avgWin + "%" : "—"}</div>
    <div style="font-size:11px;color:#4a5272;margin-top:2px">${d.totalWins} wins</div>
  </div>
  <div style="background:#0e1117;border:1px solid #1a1f2e;border-radius:14px;padding:13px">
    <div style="font-size:10px;color:#4a5272;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Avg Loss</div>
    <div style="font-size:22px;font-weight:800;color:#ff4d6a">${d.avgLoss != null ? d.avgLoss + "%" : "—"}</div>
    <div style="font-size:11px;color:#4a5272;margin-top:2px">${d.totalTrades - d.totalWins} losses</div>
  </div>
</div>

<!-- ── ACCOUNT HEALTH ─────────────────────────────────────────── -->
<div class="sec">
  <div class="sec-title">Account Health</div>
  <div class="card">
    <div class="row">
      <div>
        <div class="lbl">Daily Drawdown</div>
        <div class="bar-track" style="width:140px;margin-top:5px"><div class="bar-fill" style="width:${ddUsed.toFixed(0)}%;background:${ddColor}"></div></div>
      </div>
      <div style="text-align:right">
        <div class="val" style="color:${ddColor}">-${(d.drawdownPct||0).toFixed(2)}%</div>
        <div class="lbl">limit ${d.drawdownLimit}%</div>
      </div>
    </div>
    <div class="row">
      <div>
        <div class="lbl">Portfolio Heat (risk exposure)</div>
        <div class="bar-track" style="width:140px;margin-top:5px"><div class="bar-fill" style="width:${Math.min(100,(d.heatPct/8)*100).toFixed(0)}%;background:${heatColor}"></div></div>
      </div>
      <div style="text-align:right">
        <div class="val" style="color:${heatColor}">${d.heatPct}%</div>
        <div class="lbl">max 8%</div>
      </div>
    </div>
    <div class="row">
      <div class="lbl">Strategy Mode</div>
      <div style="font-size:12px;font-weight:700;color:${modeColor}">${modeIcon} ${d.adaptiveMode?.toUpperCase()}</div>
    </div>
    <div class="row">
      <div class="lbl">Market Regime</div>
      <div style="font-size:12px;font-weight:700;color:${regColor}">${d.regime}</div>
    </div>
    <div class="row">
      <div class="lbl">Bot Status</div>
      <div style="font-size:12px;font-weight:700;color:${d.paused ? "#ffb800" : "#00d4a0"}">${d.paused ? "⚠️ " + (d.pauseReason || "Paused") : "✅ Active — scanning"}</div>
    </div>
  </div>
</div>

<!-- ── TOP MOVERS ─────────────────────────────────────────────── -->
${d.topGainers && d.topGainers.length > 0 ? `
<div class="sec">
  <div class="sec-title">🚀 Top Movers Today</div>
  <div class="card">
    ${d.topGainers.slice(0,10).map((t, i) => {
      const coin = t.symbol.replace("USDT","");
      const vol = t.vol >= 1e9 ? (t.vol/1e9).toFixed(1)+"B" : t.vol >= 1e6 ? (t.vol/1e6).toFixed(0)+"M" : (t.vol/1e3).toFixed(0)+"K";
      return `<a href="/coin?symbol=${t.symbol}&pin=${pin}" style="display:flex;align-items:center;justify-content:space-between;padding:11px 16px;border-bottom:1px solid #1a1f2e;text-decoration:none;color:inherit">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:22px;font-size:11px;color:#4a5272;font-weight:700">${i+1}</div>
          <div style="width:34px;height:34px;border-radius:9px;background:#00d4a018;color:#00d4a0;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800">${coin.slice(0,4)}</div>
          <div><div style="font-size:14px;font-weight:700">${coin}</div><div style="font-size:11px;color:#4a5272">Vol $${vol}</div></div>
        </div>
        <div style="text-align:right">
          <div style="font-size:15px;font-weight:800;color:#00d4a0">+${t.change24h.toFixed(1)}%</div>
          <div style="font-size:11px;color:#4a5272">$${t.price < 0.01 ? t.price.toFixed(6) : t.price < 1 ? t.price.toFixed(4) : t.price.toFixed(2)}</div>
        </div>
      </a>`;
    }).join("")}
  </div>
</div>` : ""}

<!-- ── OPEN POSITIONS ─────────────────────────────────────────── -->
<div class="sec"><div class="sec-title">Open Positions</div><div class="card">${posHTML}</div></div>

<!-- ── CLOSEST TO ENTRY ───────────────────────────────────────── -->
<div class="sec"><div class="sec-title">🎯 Closest to Entry</div><div class="card">${readinessHTML}</div></div>

<!-- ── RECENT TRADES ─────────────────────────────────────────── -->
<div class="sec"><div class="sec-title">Recent Trades</div><div class="card">${tradesHTML}</div></div>

<!-- ── SIGNAL LOG ─────────────────────────────────────────────── -->
<div class="sec"><div class="sec-title">Signal Log</div><div class="card">${sigHTML}</div></div>

<!-- ── ALL COINS WATCHED ──────────────────────────────────────── -->
<div class="sec">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div class="sec-title" style="margin-bottom:0">Coins Being Watched (${coinsArr.length})</div>
    <input id="coin-filter" type="text" placeholder="Filter..." autocomplete="off"
      style="background:#0e1117;border:1px solid #1a1f2e;border-radius:8px;padding:5px 10px;color:#f0f2f7;font-size:12px;outline:none;width:90px;font-family:inherit"
      oninput="filterCoins(this.value)">
  </div>
  <div class="card" id="coins-list">${coinsHTML}</div>
</div>

<!-- ── CONTROLS ───────────────────────────────────────────────── -->
<div class="sec"><div class="sec-title">Controls</div></div>
<div style="margin:0 16px;display:flex;flex-direction:column;gap:8px">
  <form method="POST" action="/action?pin=${pin}&action=scan" style="display:contents"><button class="btn btn-blue" type="submit">⚡ Scan All Coins Now</button></form>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <form method="POST" action="/action?pin=${pin}&action=${d.paused ? "resume" : "pause"}" style="display:contents"><button class="btn btn-grey" type="submit">${d.paused ? "▶ Resume" : "⏸ Pause"}</button></form>
    <form method="POST" action="/action?pin=${pin}&action=sell-all" style="display:contents" onsubmit="return confirm('Sell ALL open positions now?')"><button class="btn btn-red" type="submit">🚨 Sell All</button></form>
  </div>
</div>

<div style="text-align:center;color:#2a2f42;font-size:11px;margin-top:20px">AlphaBot &middot; refreshing in <span id="refresh-in">30s</span></div>

<script>
function filterCoins(q){
  q=q.trim().toLowerCase();
  document.querySelectorAll('#coins-list a[data-coin]').forEach(function(el){
    el.style.display=(!q||el.dataset.coin.includes(q))?'block':'none';
  });
}
// ── Live timers ───────────────────────────────────────────────────
const _LS=${d.lastScanMs || "null"};
const _LI=${d.scanIntervalMs};
const _LT=${d.lastTradeAt ? `"${d.lastTradeAt}"` : "null"};
const _PL=Date.now();
function fmtAgo(ms){
  const s=Math.floor((Date.now()-ms)/1000);
  if(s<5)return'just now';
  if(s<60)return s+'s ago';
  if(s<3600)return Math.floor(s/60)+'m ago';
  return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m ago';
}
function fmtCd(ms){
  if(ms<=0)return'soon';
  const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000);
  return m+':'+String(s).padStart(2,'0');
}
function tick(){
  const el=document.getElementById('last-scan-ago');
  const ni=document.getElementById('next-scan');
  if(_LS){
    if(el)el.textContent=fmtAgo(_LS);
    const nms=Math.max(0,_LI-(Date.now()-_LS));
    if(ni)ni.textContent=fmtCd(nms);
  } else {
    if(el)el.textContent='starting up…';
    if(ni)ni.textContent='~5m';
  }
  if(_LT){
    const el=document.getElementById('last-trade-ago');
    if(el)el.textContent=fmtAgo(new Date(_LT).getTime());
  }
  const ri=document.getElementById('refresh-in');
  const left=Math.max(0,30000-(Date.now()-_PL));
  if(ri)ri.textContent=Math.ceil(left/1000)+'s';
}
setInterval(tick,1000);tick();
// Soft reload every 30s — skip if user is typing
setInterval(function(){
  if(!document.querySelector('input:focus'))location.reload();
},30000);
</script>
</body>
</html>`;
  }

  function coinDetailHTML(sym, c, pin, onWatchlist = false) {
    if (!c) return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AlphaBot</title></head><body style="background:#07090f;color:#f0f2f7;font-family:-apple-system,sans-serif;padding:32px;text-align:center"><p>No data yet for ${sym}</p><a href="/?pin=${pin}" style="color:#4f8dff">Back</a></body></html>`;
    const coin = sym.replace("USDT","");
    const rsiNum = parseFloat(c.rsi3||50);
    const rsiColor = rsiNum < 30 ? "#00d4a0" : rsiNum > 70 ? "#ff4d6a" : "#f0f2f7";
    const row = (label, val, color="#f0f2f7") =>
      `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1a1f2e22"><span style="color:#4a5272;font-size:13px">${label}</span><span style="font-size:13px;font-weight:600;color:${color}">${val}</span></div>`;
    const trend = v => v === "up" ? `<span style="color:#00d4a0">↑ Up</span>` : `<span style="color:#ff4d6a">↓ Down</span>`;
    const lastSigs = signalLog.filter(s => s.symbol === sym).slice(-5).reverse();
    const sigRows = lastSigs.length === 0 ? `<div style="padding:12px 0;color:#4a5272;font-size:13px">No recent signals</div>`
      : lastSigs.map(s => {
          const sc = s.result==="ENTRY"?"#4f8dff":s.result==="EXIT_WIN"?"#00d4a0":s.result==="EXIT_LOSS"?"#ff4d6a":"#4a5272";
          return `<div style="padding:10px 0;border-bottom:1px solid #1a1f2e22;display:flex;justify-content:space-between;align-items:flex-start">
            <div style="font-size:12px;color:#94a3b8;max-width:240px;line-height:1.5">${s.reason||""}</div>
            <div style="text-align:right;flex-shrink:0;margin-left:8px"><div style="font-size:11px;font-weight:700;color:${sc}">${s.result}</div><div style="font-size:10px;color:#4a5272">${(s.time||"").slice(11,16)}</div></div>
          </div>`;
        }).join("");
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${coin} — AlphaBot</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#07090f;color:#f0f2f7;max-width:430px;margin:0 auto;padding-bottom:40px}
.hdr{padding:16px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #1a1f2e}
.back{color:#4f8dff;font-size:14px;text-decoration:none;display:flex;align-items:center;gap:4px}
.sec{margin:16px 20px 0}.sec-title{font-size:11px;font-weight:600;color:#4a5272;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.card{background:#0e1117;border:1px solid #1a1f2e;border-radius:16px;padding:0 16px}
</style></head><body>
<div class="hdr">
  <a class="back" href="/?pin=${pin}">&#8592; Back</a>
  <div style="font-size:18px;font-weight:800">${coin}</div>
  <div style="margin-left:auto;font-size:20px;font-weight:800">$${Number(c.price||0).toFixed(4)}</div>
</div>
${c._live ? `<div style="margin:12px 20px 0;padding:10px 14px;background:#ffb80015;border:1px solid #ffb80030;border-radius:12px;font-size:12px;color:#ffb800">Live lookup — not on watchlist. Bot won't auto-trade this coin.</div>` : ""}

<div class="sec"><div class="sec-title">Price &amp; Trend</div><div class="card">
  ${row("Price", "$"+Number(c.price||0).toFixed(4))}
  ${row("VWAP", "$"+(c.vwap||"—"), parseFloat(c.price)>parseFloat(c.vwap||0)?"#00d4a0":"#ff4d6a")}
  ${row("15m Trend", trend(c.trend15m))}
  ${row("1H Trend", trend(c.trend1h))}
  ${row("4H Trend", trend(c.trend4h))}
  ${c.trendWeekly !== null ? row("Weekly Trend", trend(c.trendWeekly)) : ""}
</div></div>

<div class="sec"><div class="sec-title">Momentum</div><div class="card">
  ${row("RSI(3)", c.rsi3||"—", rsiColor)}
  ${c.rsi15m ? row("RSI(15m)", c.rsi15m, parseFloat(c.rsi15m)<40?"#00d4a0":parseFloat(c.rsi15m)>65?"#ff4d6a":"#f0f2f7") : ""}
  ${row("MACD", c.macdBullish?"Bullish ↑":"Bearish ↓", c.macdBullish?"#00d4a0":"#ff4d6a")}
  ${row("StochRSI K", (c.stochK||"—")+(c.stochOversold?" (oversold)":c.stochOverbought?" (overbought)":""), c.stochOversold?"#00d4a0":c.stochOverbought?"#ff4d6a":"#f0f2f7")}
  ${row("BB%", (c.bbPct||"—")+"%", parseFloat(c.bbPct)<25?"#00d4a0":parseFloat(c.bbPct)>80?"#ff4d6a":"#f0f2f7")}
</div></div>

<div class="sec"><div class="sec-title">Volume &amp; Strength</div><div class="card">
  ${row("ADX", (c.adx||"—")+(c.adxTrending?" (trending)":" (choppy)"), c.adxTrending?"#4f8dff":"#4a5272")}
  ${row("Volume", (c.volPct||"—")+"% of avg", c.volAboveAvg?"#00d4a0":"#4a5272")}
  ${row("OBV", c.obvRising?"Rising ↑":"Falling ↓", c.obvRising?"#00d4a0":"#ff4d6a")}
  ${c.divergence ? row("Divergence", "Bullish detected", "#00d4a0") : ""}
  ${c.doubleBottom ? row("Pattern", "Double Bottom", "#00d4a0") : ""}
</div></div>

<div class="sec"><div class="sec-title">Support &amp; Resistance</div><div class="card">
  ${row("Support", "$"+(c.support||"—")+" ("+(c.distToSupport||"?")+"% below)", c.nearSupport?"#00d4a0":"#f0f2f7")}
  ${row("Resistance", "$"+(c.resistance||"—")+" ("+(c.distToResistance||"?")+"% above)")}
</div></div>

<div class="sec"><div class="sec-title">Recent Signals</div><div class="card" style="padding:0 16px">${sigRows}</div></div>

<div style="margin:20px 20px 0;display:flex;flex-direction:column;gap:10px">
  ${onWatchlist
    ? `<form method="POST" action="/action?pin=${pin}&action=remove-coin&symbol=${sym}" onsubmit="return confirm('Remove ${sym.replace('USDT','')} from watchlist?')">
        <button type="submit" style="width:100%;padding:14px;border-radius:14px;border:none;background:#ff4d6a22;color:#ff4d6a;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;border:1px solid #ff4d6a44">Remove from Watchlist</button>
       </form>`
    : `<form method="POST" action="/action?pin=${pin}&action=add-coin&symbol=${sym}">
        <button type="submit" style="width:100%;padding:14px;border-radius:14px;border:none;background:linear-gradient(135deg,#4f8dff,#3a6fd4);color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit">+ Add to Watchlist</button>
       </form>`
  }
  <a href="/?pin=${pin}" style="display:block;padding:14px;border-radius:14px;background:#0e1117;border:1px solid #1a1f2e;color:#4a5272;text-align:center;text-decoration:none;font-size:14px;font-weight:600">Back to Dashboard</a>
</div>
</body></html>`;
  }

  function _oldDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>AlphaBot</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#07090f;
  --surface:#0e1117;
  --border:#1a1f2e;
  --text:#f0f2f7;
  --muted:#4a5272;
  --green:#00d4a0;
  --green-bg:#00d4a015;
  --red:#ff4d6a;
  --red-bg:#ff4d6a15;
  --blue:#4f8dff;
  --blue-bg:#4f8dff15;
  --yellow:#ffb800;
  --yellow-bg:#ffb80015;
}
html,body{height:100%;background:var(--bg)}
body{font-family:'Inter',system-ui,sans-serif;color:var(--text);padding:0;max-width:430px;margin:0 auto;overflow-x:hidden}

/* PIN SCREEN */
#pin-screen{position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 32px;gap:16px}
.pin-logo{width:72px;height:72px;border-radius:20px;background:linear-gradient(135deg,#4f8dff,#00d4a0);display:flex;align-items:center;justify-content:center;font-size:36px;box-shadow:0 8px 32px #4f8dff44}
.pin-title{font-size:26px;font-weight:800;letter-spacing:-.5px}
.pin-sub{font-size:14px;color:var(--muted);text-align:center;line-height:1.5;margin-bottom:8px}
#pin-input{width:100%;max-width:300px;padding:16px;border-radius:14px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:28px;text-align:center;letter-spacing:6px;font-family:inherit;outline:none;-webkit-appearance:none;appearance:none}
#pin-input:focus{border-color:var(--blue)}
#pin-btn{width:100%;max-width:300px;padding:16px;border-radius:14px;border:none;background:linear-gradient(135deg,#4f8dff,#3a6fd4);color:#fff;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 4px 20px #4f8dff33}
#pin-err{color:var(--red);font-size:13px;font-weight:500;opacity:0;transition:opacity .2s;min-height:20px}
#pin-err.show{opacity:1}

/* MAIN APP */
#main{display:block;min-height:100vh;padding-bottom:32px}
.header{padding:20px 20px 0;display:flex;align-items:center;justify-content:space-between}
.header-left{display:flex;align-items:center;gap:10px}
.header-logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#4f8dff,#00d4a0);display:flex;align-items:center;justify-content:center;font-size:18px}
.header-title{font-size:17px;font-weight:700;letter-spacing:-.3px}
.live-pill{display:flex;align-items:center;gap:6px;background:var(--green-bg);border:1px solid #00d4a030;border-radius:99px;padding:5px 12px;font-size:12px;font-weight:600;color:var(--green)}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.85)}}

/* PORTFOLIO HERO */
.hero{margin:24px 16px 0;background:linear-gradient(135deg,#0e1a35 0%,#0a1628 100%);border:1px solid #1a2a4a;border-radius:24px;padding:28px 24px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-40px;right:-40px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,#4f8dff18 0%,transparent 70%)}
.hero-label{font-size:12px;color:var(--muted);font-weight:500;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px}
.hero-value{font-size:46px;font-weight:800;letter-spacing:-2px;line-height:1;margin-bottom:12px}
.hero-row{display:flex;gap:24px}
.hero-stat{display:flex;flex-direction:column;gap:2px}
.hero-stat-label{font-size:11px;color:var(--muted);font-weight:500}
.hero-stat-value{font-size:15px;font-weight:600}

/* STATS GRID */
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 16px 0}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:16px}
.stat-card-label{font-size:11px;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
.stat-card-value{font-size:20px;font-weight:700;letter-spacing:-.5px}
.stat-card-sub{font-size:11px;color:var(--muted);margin-top:2px}

/* SECTION */
.section{margin:16px 16px 0}
.section-header{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;padding:0 2px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:20px;overflow:hidden}

/* REGIME BAR */
.regime-bar{padding:14px 18px;display:flex;align-items:center;justify-content:space-between}
.regime-label{font-size:13px;color:var(--muted);font-weight:500}
.regime-value{font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px}

/* POSITIONS */
.pos-item{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}
.pos-item:last-child{border-bottom:none}
.pos-icon{width:38px;height:38px;border-radius:12px;background:var(--blue-bg);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:var(--blue);margin-right:12px;flex-shrink:0}
.pos-left{display:flex;align-items:center}
.pos-name{font-size:15px;font-weight:700}
.pos-qty{font-size:12px;color:var(--muted);margin-top:1px}
.pos-right{text-align:right}
.pos-usd{font-size:15px;font-weight:700}
.pos-pnl{font-size:12px;font-weight:600;margin-top:1px}
.empty-state{padding:28px 18px;text-align:center;color:var(--muted);font-size:14px}

/* TRADES */
.trade-item{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}
.trade-item:last-child{border-bottom:none}
.trade-icon{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:14px;margin-right:12px;flex-shrink:0}
.trade-icon.entry{background:var(--blue-bg);color:var(--blue)}
.trade-icon.exit-win{background:var(--green-bg);color:var(--green)}
.trade-icon.exit-loss{background:var(--red-bg);color:var(--red)}
.trade-left{display:flex;align-items:center}
.trade-coin{font-size:15px;font-weight:700}
.trade-meta{font-size:12px;color:var(--muted);margin-top:1px}
.trade-right{text-align:right}
.trade-pnl{font-size:15px;font-weight:700}
.trade-time{font-size:12px;color:var(--muted);margin-top:1px}

/* CONTROLS */
.controls{margin:16px 16px 0;display:flex;flex-direction:column;gap:10px}
.btn{width:100%;padding:17px;border-radius:16px;border:none;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;letter-spacing:-.1px;transition:transform .1s,opacity .1s;display:flex;align-items:center;justify-content:center;gap:8px}
.btn:active{transform:scale(.97);opacity:.85}
.btn-primary{background:linear-gradient(135deg,#4f8dff,#3a6fd4);color:#fff;box-shadow:0 4px 20px #4f8dff33}
.btn-danger{background:linear-gradient(135deg,#ff4d6a,#d43a52);color:#fff;box-shadow:0 4px 20px #ff4d6a33}
.btn-success{background:linear-gradient(135deg,#00d4a0,#00a87d);color:#fff;box-shadow:0 4px 20px #00d4a033}
.btn-outline{background:var(--surface);color:var(--muted);border:1px solid var(--border)}

/* COLORS */
.green{color:var(--green)}.red{color:var(--red)}.blue{color:var(--blue)}.yellow{color:var(--yellow)}.muted{color:var(--muted)}

/* TOAST */
#toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%) translateY(80px);background:#1a1f2e;border:1px solid var(--border);padding:13px 22px;border-radius:14px;font-size:14px;font-weight:500;z-index:999;white-space:nowrap;box-shadow:0 8px 32px #00000088;transition:transform .3s cubic-bezier(.34,1.56,.64,1),opacity .3s;opacity:0}
#toast.show{transform:translateX(-50%) translateY(0);opacity:1}

.updated{text-align:center;color:var(--muted);font-size:11px;margin-top:20px;opacity:.6}
</style>
</head>
<body>


<!-- MAIN DASHBOARD -->
<div id="main">
  <div class="header">
    <div class="header-left">
      <div class="header-logo">📈</div>
      <div class="header-title">AlphaBot</div>
    </div>
    <div class="live-pill"><span class="live-dot"></span>LIVE</div>
  </div>

  <!-- Portfolio Hero -->
  <div class="hero">
    <div class="hero-label">Total Portfolio</div>
    <div class="hero-value" id="total-val">—</div>
    <div class="hero-row">
      <div class="hero-stat">
        <div class="hero-stat-label">Cash (USDT)</div>
        <div class="hero-stat-value" id="usdt-cash">—</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-label">Today's P&amp;L</div>
        <div class="hero-stat-value" id="today-pnl">—</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-label">Win Rate</div>
        <div class="hero-stat-value" id="win-rate">—</div>
      </div>
    </div>
  </div>

  <!-- Stats Grid -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-card-label">Trades Today</div>
      <div class="stat-card-value" id="today-trades">—</div>
      <div class="stat-card-sub">of 20 max</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Market</div>
      <div class="stat-card-value" id="regime-val">—</div>
      <div class="stat-card-sub" id="trading-status">—</div>
    </div>
  </div>

  <!-- Open Positions -->
  <div class="section">
    <div class="section-header">Open Positions</div>
    <div class="card" id="positions-card">
      <div class="empty-state muted">Loading...</div>
    </div>
  </div>

  <!-- Recent Trades -->
  <div class="section">
    <div class="section-header">Recent Trades</div>
    <div class="card" id="trades-card">
      <div class="empty-state muted">Loading...</div>
    </div>
  </div>

  <!-- Coins Being Watched -->
  <div class="section">
    <div class="section-header">Coins Being Watched</div>
    <div class="card" id="coins-card">
      <div class="empty-state muted">Loading...</div>
    </div>
  </div>

  <!-- Signal Log -->
  <div class="section">
    <div class="section-header">Signal Log</div>
    <div class="card" id="signals-card">
      <div class="empty-state muted">Loading signals...</div>
    </div>
  </div>

  <!-- Coin Detail Modal -->
  <div id="modal-overlay" style="display:none;position:fixed;inset:0;background:#000000cc;z-index:200;overflow-y:auto;padding:20px" onclick="closeModal(event)">
    <div id="modal" style="background:#0e1117;border:1px solid #1a1f2e;border-radius:24px;max-width:430px;margin:0 auto;overflow:hidden">
      <div style="padding:20px 20px 0;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:20px;font-weight:800;letter-spacing:-.5px" id="modal-title">—</div>
        <button onclick="closeModal()" style="background:#1a1f2e;border:none;color:#94a3b8;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center">×</button>
      </div>
      <div id="modal-body" style="padding:16px 20px 24px"></div>
    </div>
  </div>

  <!-- Controls -->
  <div class="section">
    <div class="section-header">Controls</div>
  </div>
  <div class="controls">
    <button class="btn btn-primary" onclick="forceCheck()">🔍 &nbsp;Scan All Coins Now</button>
    <button class="btn btn-danger" onclick="confirmSellAll()">🚨 &nbsp;Sell All Positions</button>
    <button class="btn btn-outline" id="pause-btn" onclick="togglePause()">⏸ &nbsp;Pause Trading</button>
  </div>

  <div class="updated" id="updated"></div>
</div>

<div id="toast"></div>

<script>
// PIN is already verified server-side — just read it from URL for API calls
const PIN = new URLSearchParams(location.search).get('pin') || '';
load();
setInterval(load, 30000);

async function apiFetch(path,method='GET'){
  const sep=path.includes('?')?'&':'?';
  const r=await fetch(path+sep+'pin='+PIN,{method});
  return r.json();
}

function toast(msg,dur=3000){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.className='show';
  clearTimeout(t._t);
  t._t=setTimeout(()=>t.className='',dur);
}

async function load(){
  document.getElementById('total-val').textContent='Connecting...';
  try{
    const s=await apiFetch('/api/status');

    const val=Number(s.portfolioValue||0);
    document.getElementById('total-val').textContent='$'+val.toFixed(2);
    document.getElementById('usdt-cash').textContent='$'+Number(s.usdtBalance||0).toFixed(2);

    const pnl=Number(s.todayPnlUSD||0);
    document.getElementById('today-pnl').innerHTML='<span class="'+(pnl>=0?'green':'red')+'">'+(pnl>=0?'+':'')+'$'+pnl.toFixed(2)+'</span>';
    document.getElementById('win-rate').textContent=s.winRate||'—';
    document.getElementById('today-trades').textContent=s.todayTrades||0;

    const regime=s.regime||'RANGING';
    const rc=regime.includes('BEAR')?'red':regime.includes('BULL')?'green':'yellow';
    document.getElementById('regime-val').innerHTML='<span class="'+rc+'">'+regime+'</span>';

    const paused=s.paused;
    document.getElementById('trading-status').innerHTML=paused
      ?'<span class="yellow">⏸ Paused</span>'
      :'<span class="green">▶ Active</span>';
    const pb=document.getElementById('pause-btn');
    pb.textContent=paused?'▶️  Resume Trading':'⏸  Pause Trading';
    pb.className=paused?'btn btn-success':'btn btn-outline';

    // Positions
    const pos=(s.openPositions||[]).filter(p=>p&&p.coin);
    document.getElementById('positions-card').innerHTML=pos.length===0
      ?'<div class="empty-state muted">All cash — no open positions</div>'
      :pos.map(p=>{
        const pc=p.pnlPct!=null?(p.pnlPct>=0?'green':'red'):'muted';
        const initials=p.coin.slice(0,3);
        const entryStr=p.entryPrice!=null?'$'+Number(p.entryPrice).toFixed(4):'untracked';
        const pnlStr=p.pnlPct!=null?(p.pnlPct>=0?'+':'')+p.pnlPct.toFixed(2)+'%':'—';
        return '<div class="pos-item">'+
          '<div class="pos-left">'+
            '<div class="pos-icon">'+initials+'</div>'+
            '<div><div class="pos-name">'+p.coin+'</div><div class="pos-qty">'+Number(p.qty).toFixed(4)+' @ '+entryStr+'</div></div>'+
          '</div>'+
          '<div class="pos-right">'+
            '<div class="pos-usd">$'+Number(p.usdVal).toFixed(2)+'</div>'+
            '<div class="pos-pnl '+pc+'">'+pnlStr+'</div>'+
          '</div>'+
        '</div>';
      }).join('');

    // Trades
    const trades=(s.lastTrades||[]).slice().reverse();
    document.getElementById('trades-card').innerHTML=trades.length===0
      ?'<div class="empty-state muted">No trades yet today</div>'
      :trades.map(t=>{
        const isEntry=t.type==='entry';
        const pv=t.pnlPct!=null?parseFloat(t.pnlPct):null;
        const iconClass=isEntry?'entry':pv!=null&&pv>=0?'exit-win':'exit-loss';
        const icon=isEntry?'↑':pv!=null&&pv>=0?'✓':'↓';
        const pnlColor=pv==null?'muted':pv>=0?'green':'red';
        const pnlText=t.pnl||'';
        return '<div class="trade-item">'+
          '<div class="trade-left">'+
            '<div class="trade-icon '+iconClass+'">'+icon+'</div>'+
            '<div>'+
              '<div class="trade-coin">'+(t.symbol||'').replace('USDT','')+'</div>'+
              '<div class="trade-meta">'+(isEntry?'Entry':'Exit')+' &nbsp;·&nbsp; $'+Number(t.price||0).toFixed(4)+'</div>'+
            '</div>'+
          '</div>'+
          '<div class="trade-right">'+
            '<div class="trade-pnl '+pnlColor+'">'+pnlText+'</div>'+
            '<div class="trade-time">'+((t.time||'').slice(11,16)||'—')+' UTC</div>'+
          '</div>'+
        '</div>';
      }).join('');

    // Signals
    const signals=s.signals||[];
    document.getElementById('signals-card').innerHTML=signals.length===0
      ?'<div class="empty-state muted">No signals yet — bot is scanning</div>'
      :signals.map(sig=>{
        const isEntry=sig.result==='ENTRY';
        const isWin=sig.result==='EXIT_WIN';
        const isLoss=sig.result==='EXIT_LOSS';
        const isHold=sig.result==='HOLD';
        const isError=sig.result==='ERROR';
        const iconClass=isEntry?'entry':isWin?'exit-win':isLoss?'exit-loss':'';
        const icon=isEntry?'↑':isWin?'✓':isLoss?'↓':isHold?'—':'!';
        const dotColor=isEntry?'var(--blue)':isWin?'var(--green)':isLoss?'var(--red)':isHold?'var(--muted)':'var(--yellow)';
        const coin=(sig.symbol||'').replace('USDT','');
        const timeStr=(sig.time||'').slice(11,16);
        return '<div class="trade-item" style="cursor:pointer" onclick="showCoin(\''+sig.symbol+'\')">'+
          '<div class="trade-left">'+
            '<div class="trade-icon '+iconClass+'" style="background:'+dotColor+'22;color:'+dotColor+'">'+icon+'</div>'+
            '<div>'+
              '<div class="trade-coin">'+coin+'</div>'+
              '<div class="trade-meta" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+sig.reason+'</div>'+
            '</div>'+
          '</div>'+
          '<div class="trade-right">'+
            '<div class="trade-pnl" style="color:'+dotColor+';font-size:12px">'+sig.result+'</div>'+
            '<div class="trade-time">'+timeStr+' UTC</div>'+
          '</div>'+
        '</div>';
      }).join('');

    document.getElementById('updated').textContent='Updated '+new Date().toLocaleTimeString();
    loadCoins();
  }catch(e){
    document.getElementById('positions-card').innerHTML='<div style="padding:16px;color:#ff4d6a;font-size:13px">⚠️ '+e.message+'</div>';
    toast('⚠️ '+e.message);
  }
}

// ── Coins watched grid ──
async function loadCoins(){
  try{
    const coins=await apiFetch('/api/coins');
    const syms=Object.keys(coins);
    if(syms.length===0){ document.getElementById('coins-card').innerHTML='<div class="empty-state muted">Waiting for first scan...</div>'; return; }
    document.getElementById('coins-card').innerHTML=syms.map(sym=>{
      const c=coins[sym];
      const coin=sym.replace('USDT','');
      const sig=c.lastSignal;
      const res=sig?sig.result:'—';
      const rc=res==='ENTRY'?'var(--blue)':res==='EXIT_WIN'?'var(--green)':res==='EXIT_LOSS'?'var(--red)':res==='HOLD'?'var(--muted)':'var(--yellow)';
      const t15=c.trend15m==='up'?'↑':'↓'; const tc15=c.trend15m==='up'?'var(--green)':'var(--red)';
      const t1h=c.trend1h==='up'?'↑':'↓'; const tc1h=c.trend1h==='up'?'var(--green)':'var(--red)';
      return '<div class="trade-item" style="cursor:pointer" onclick="showCoin(\''+sym+'\')">'+
        '<div class="trade-left">'+
          '<div class="trade-icon" style="background:'+rc+'22;color:'+rc+';font-size:11px;font-weight:800">'+coin.slice(0,3)+'</div>'+
          '<div>'+
            '<div class="trade-coin">'+coin+'</div>'+
            '<div class="trade-meta">RSI '+c.rsi3+' &nbsp;·&nbsp; <span style="color:'+tc15+'">15m '+t15+'</span> <span style="color:'+tc1h+'">1H '+t1h+'</span></div>'+
          '</div>'+
        '</div>'+
        '<div class="trade-right">'+
          '<div style="font-size:13px;font-weight:700;color:'+rc+'">'+res+'</div>'+
          '<div class="trade-time">$'+Number(c.price).toFixed(3)+'</div>'+
        '</div>'+
      '</div>';
    }).join('');
  }catch(e){}
}

// ── Coin detail modal ──
function ind(label,val,good){
  const color=good===true?'var(--green)':good===false?'var(--red)':'var(--muted)';
  return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1a1f2e22">'+
    '<span style="color:#64748b;font-size:13px">'+label+'</span>'+
    '<span style="font-size:13px;font-weight:600;color:'+color+'">'+val+'</span>'+
  '</div>';
}

async function showCoin(sym){
  document.getElementById('modal-title').textContent=sym.replace('USDT','')+' — Live Analysis';
  document.getElementById('modal-body').innerHTML='<div style="text-align:center;padding:24px;color:#64748b">Loading...</div>';
  document.getElementById('modal-overlay').style.display='block';
  document.body.style.overflow='hidden';
  try{
    const [c, allSigs] = await Promise.all([
      apiFetch('/api/coin?symbol='+sym),
      apiFetch('/api/status'),
    ]);
    if(c.error){ document.getElementById('modal-body').innerHTML='<div style="color:#f87171;padding:16px">'+c.error+'</div>'; return; }
    const coinSigs=(allSigs.signals||[]).filter(s=>s.symbol===sym);
    const lastSig=c.lastSignal;
    const sigColor=lastSig?{ENTRY:'var(--blue)',EXIT_WIN:'var(--green)',EXIT_LOSS:'var(--red)',BLOCKED:'var(--red)',HOLD:'var(--muted)'}[lastSig.result]||'var(--muted)':'var(--muted)';

    let html='';

    // Price + last signal
    html+='<div style="background:#1a1f2e;border-radius:14px;padding:14px;margin-bottom:14px">';
    html+='<div style="font-size:28px;font-weight:800;letter-spacing:-1px">$'+Number(c.price).toFixed(4)+'</div>';
    if(lastSig) html+='<div style="margin-top:4px;font-size:13px;font-weight:600;color:'+sigColor+'">'+lastSig.result+' — '+lastSig.reason+'</div>';
    html+='<div style="font-size:11px;color:#475569;margin-top:4px">Updated '+new Date(c.updatedAt).toLocaleTimeString()+'</div>';
    html+='</div>';

    // Trend section
    html+='<div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px">Trend</div>';
    html+='<div style="background:#0e1117;border:1px solid #1a1f2e;border-radius:14px;padding:0 14px;margin-bottom:14px">';
    html+=ind('15m',c.trend15m==='up'?'↑ Uptrend':'↓ Downtrend',c.trend15m==='up');
    html+=ind('1 Hour',c.trend1h==='up'?'↑ Uptrend':'↓ Downtrend',c.trend1h==='up');
    html+=ind('4 Hour',c.trend4h==='up'?'↑ Uptrend':'↓ Downtrend',c.trend4h==='up');
    if(c.trendWeekly!==null) html+=ind('Weekly',c.trendWeekly==='up'?'↑ Bull Market':'↓ Bear Market',c.trendWeekly==='up');
    html+='</div>';

    // Indicators
    html+='<div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px">Indicators</div>';
    html+='<div style="background:#0e1117;border:1px solid #1a1f2e;border-radius:14px;padding:0 14px;margin-bottom:14px">';
    html+=ind('RSI(3)',c.rsi3, parseFloat(c.rsi3)<30?true:parseFloat(c.rsi3)>70?false:null);
    if(c.rsi15m) html+=ind('RSI(15m)',c.rsi15m,parseFloat(c.rsi15m)<40?true:parseFloat(c.rsi15m)>60?false:null);
    html+=ind('VWAP','$'+c.vwap,parseFloat(c.price)>parseFloat(c.vwap)?true:false);
    html+=ind('MACD',c.macdBullish?'Bullish ↑':'Bearish ↓',c.macdBullish);
    html+=ind('StochRSI','K='+c.stochK+(c.stochOversold?' (oversold)':c.stochOverbought?' (overbought)':''),c.stochOversold?true:c.stochOverbought?false:null);
    html+=ind('BB%',c.bbPct+'%',parseFloat(c.bbPct)<25?true:parseFloat(c.bbPct)>80?false:null);
    html+=ind('ADX',c.adx+(c.adxTrending?' (trending)':' (choppy)'),c.adxTrending);
    html+=ind('Volume',c.volPct+'% of avg',c.volAboveAvg);
    html+=ind('OBV',c.obvRising?'Rising ↑':'Falling ↓',c.obvRising);
    if(c.divergence) html+=ind('Divergence','✅ Bullish detected',true);
    if(c.doubleBottom) html+=ind('Pattern','✅ Double Bottom',true);
    if(c.patterns) html+=ind('Patterns',c.patterns,null);
    html+='</div>';

    // Support & Resistance
    html+='<div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px">Support &amp; Resistance</div>';
    html+='<div style="background:#0e1117;border:1px solid #1a1f2e;border-radius:14px;padding:0 14px;margin-bottom:14px">';
    html+=ind('Support','$'+c.support+' ('+c.distToSupport+'% below)',c.nearSupport?true:null);
    html+=ind('Resistance','$'+c.resistance+' ('+c.distToResistance+'% above)',null);
    html+='</div>';

    // Signal history for this coin
    if(coinSigs.length>0){
      html+='<div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px">Signal History</div>';
      html+='<div style="background:#0e1117;border:1px solid #1a1f2e;border-radius:14px;padding:0 14px;margin-bottom:4px">';
      html+=coinSigs.map(s=>{
        const sc={ENTRY:'var(--blue)',EXIT_WIN:'var(--green)',EXIT_LOSS:'var(--red)',BLOCKED:'var(--red)',HOLD:'var(--muted)'}[s.result]||'var(--muted)';
        return '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid #1a1f2e22">'+
          '<span style="font-size:12px;color:#94a3b8;max-width:220px;line-height:1.4">'+s.reason+'</span>'+
          '<div style="text-align:right;flex-shrink:0;margin-left:8px">'+
            '<div style="font-size:11px;font-weight:700;color:'+sc+'">'+s.result+'</div>'+
            '<div style="font-size:10px;color:#475569">'+s.time.slice(11,16)+' UTC</div>'+
          '</div>'+
        '</div>';
      }).join('');
      html+='</div>';
    }

    document.getElementById('modal-body').innerHTML=html;
  }catch(e){
    document.getElementById('modal-body').innerHTML='<div style="color:#f87171;padding:16px">Failed to load coin data</div>';
  }
}

function closeModal(e){
  if(e&&e.target!==document.getElementById('modal-overlay')&&!e.target.closest('#modal-overlay>:not(#modal)')) return;
  if(e&&document.getElementById('modal').contains(e.target)&&e.target.id!=='modal-overlay') return;
  document.getElementById('modal-overlay').style.display='none';
  document.body.style.overflow='';
}

async function forceCheck(){
  toast('🔍 Scanning all coins...');
  await apiFetch('/api/force-check','POST');
  setTimeout(load,4000);
}

function confirmSellAll(){
  if(confirm('Sell ALL open positions immediately?')) doSellAll();
}

async function doSellAll(){
  toast('🚨 Selling all positions...',6000);
  const r=await apiFetch('/api/sell-all','POST');
  toast(r.message||'Done');
  setTimeout(load,4000);
}

async function togglePause(){
  const s=await apiFetch('/api/status');
  const r=await apiFetch(s.paused?'/api/resume':'/api/pause','POST');
  toast(r.message||'Done');
  load();
}
</script>
</body>
</html>`;
  }

  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, "http://localhost");
    const path = urlObj.pathname;

    // Railway health check — must stay unprotected
    if (req.method === "GET" && (path === "/health")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }

    // Mobile dashboard — server-side rendered, no JS required
    if (req.method === "GET" && path === "/") {
      if (checkPin(req.url)) {
        const pin = urlObj.searchParams.get("pin");
        buildStatusData().then(data => {
          res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate", "Pragma": "no-cache", "Expires": "0" });
          res.end(dashboardHTML(data, pin));
        }).catch(e => { res.writeHead(500); res.end("Dashboard error: " + e.message); });
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AlphaBot</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#07090f;color:#f0f2f7;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:32px;gap:20px}
.logo{width:72px;height:72px;border-radius:20px;background:linear-gradient(135deg,#4f8dff,#00d4a0);display:flex;align-items:center;justify-content:center;font-size:36px}
h1{font-size:26px;font-weight:800}p{color:#64748b;font-size:14px;text-align:center}
input{width:100%;max-width:300px;padding:16px;border-radius:14px;border:1px solid #1a1f2e;background:#0e1117;color:#f0f2f7;font-size:24px;text-align:center;letter-spacing:4px;outline:none}
button{width:100%;max-width:300px;padding:16px;border-radius:14px;border:none;background:linear-gradient(135deg,#4f8dff,#3a6fd4);color:#fff;font-size:16px;font-weight:700;cursor:pointer}
</style></head><body>
<div class="logo">📈</div><h1>AlphaBot</h1><p>Enter your PIN</p>
<form method="GET" action="/">
<input name="pin" type="number" inputmode="numeric" placeholder="2026" autofocus>
<br><br>
<button type="submit">Open Dashboard</button>
</form></body></html>`);
      }
      return;
    }

    // Coin detail page — GET /coin?symbol=BTCUSDT&pin=...
    // Works for any coin on the market, not just watchlist — fetches live Binance data if needed
    if (req.method === "GET" && path === "/coin") {
      if (!checkPin(req.url)) { res.writeHead(302, { Location: "/" }); res.end(); return; }
      let sym = (urlObj.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (sym && !sym.endsWith("USDT")) sym += "USDT";
      const pin = urlObj.searchParams.get("pin");
      if (!sym) { res.writeHead(302, { Location: `/?pin=${pin}` }); res.end(); return; }

      (async () => {
        let snapData = coinSnapshots[sym] || null;
        if (!snapData) {
          try {
            const [c1h, c4h, c15m] = await Promise.all([
              fetchCandles(sym, "1H", 60).catch(() => []),
              fetchCandles(sym, "4H", 30).catch(() => []),
              fetchCandles(sym, "15m", 30).catch(() => []),
            ]);
            if (c1h.length >= 20) {
              const closes1h  = c1h.map(c => c.close);
              const closes4h  = c4h.map(c => c.close);
              const closes15m = c15m.map(c => c.close);
              const price     = closes1h[closes1h.length - 1];
              const ema8_1h   = calcEMA(closes1h, 8);
              const ema21_1h  = calcEMA(closes1h, 21);
              const ema8_4h   = closes4h.length >= 8  ? calcEMA(closes4h,  8)  : null;
              const ema21_4h  = closes4h.length >= 21 ? calcEMA(closes4h,  21) : null;
              const ema8_15m  = closes15m.length >= 8  ? calcEMA(closes15m, 8)  : null;
              const ema21_15m = closes15m.length >= 21 ? calcEMA(closes15m, 21) : null;
              const rsi3val   = calcRSI(closes1h, 3);
              const rsi14val  = calcRSI(closes1h, 14);
              const macdData  = calcMACD(closes1h);
              const vwapVal   = calcVWAP(c1h);
              const stoch     = calcStochRSI(closes1h);
              const stochK    = stoch?.k ?? null;
              snapData = {
                price, vwap: vwapVal,
                rsi3: rsi3val  != null ? rsi3val.toFixed(1)  : null,
                rsi14: rsi14val != null ? rsi14val.toFixed(1) : null,
                macdBullish: macdData?.bullish ?? false,
                stochK: stochK != null ? stochK.toFixed(1) : null,
                stochOversold: stochK != null && stochK < 20,
                trend15m: ema8_15m && ema21_15m ? (ema8_15m > ema21_15m ? "up" : "down") : null,
                trend1h: ema8_1h > ema21_1h ? "up" : "down",
                trend4h: ema8_4h && ema21_4h  ? (ema8_4h  > ema21_4h  ? "up" : "down") : null,
                trendWeekly: null, adxTrending: false, divergence: false,
                bbPct: null, obvTrend: null, nearestSupport: null, nearestResistance: null,
                _live: true,
              };
            }
          } catch(e) { console.error(`[/coin live fetch] ${sym}:`, e.message); }
        }
        const onWatchlist = CONFIG.symbols.includes(sym);
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache, no-store" });
        res.end(coinDetailHTML(sym, snapData, pin, onWatchlist));
      })();
      return;
    }

    // Dashboard button actions — POST /action?pin=...&action=scan|sell-all|pause|resume
    if (req.method === "POST" && path === "/action") {
      if (!checkPin(req.url)) { res.writeHead(302, { Location: "/" }); res.end(); return; }
      const pin = urlObj.searchParams.get("pin");
      const action = urlObj.searchParams.get("action");
      const redirect = () => { res.writeHead(302, { Location: `/?pin=${pin}` }); res.end(); };
      if (action === "pause") { _tradingPaused = true; console.log("⏸ Dashboard: trading paused"); redirect(); }
      else if (action === "resume") { _tradingPaused = false; console.log("▶ Dashboard: trading resumed"); redirect(); }
      else if (action === "scan") {
        redirect();
        (async () => { for (const sym of CONFIG.symbols) await run(null, sym).catch((err) => { console.error(`Webhook scan ${sym}:`, err.message); pushSignal(sym, "BLOCKED", `Scan error: ${err.message?.slice(0, 60)}`); }); })();
      } else if (action === "sell-all") {
        redirect();
        (async () => {
          const log = loadLog();
          const open = Object.entries(log.positions || {}).filter(([, p]) => p && p.open).map(([sym]) => sym);
          console.log(`\n🚨 Dashboard sell-all: ${open.join(", ")}`);
          for (const sym of open) await run("SELL", sym).catch(e => console.error(`Force sell ${sym}:`, e.message));
        })();
      } else if (action === "add-coin") {
        const addSym = (urlObj.searchParams.get("symbol") || "").toUpperCase();
        if (addSym && addSym.endsWith("USDT")) {
          if (!CONFIG.symbols.includes(addSym)) {
            CONFIG.symbols.push(addSym);
            console.log(`\n📋 Dashboard: added ${addSym} to watchlist`);
          }
          // Persist in log so it survives restarts
          const addLog = loadLog();
          addLog.customWatchlist = [...new Set([...(addLog.customWatchlist || []), addSym])];
          saveLog(addLog);
          // Kick off an immediate scan of this coin
          run(null, addSym).catch(() => {});
        }
        res.writeHead(302, { Location: `/coin?symbol=${addSym}&pin=${pin}` }); res.end();
      } else if (action === "remove-coin") {
        const rmSym = (urlObj.searchParams.get("symbol") || "").toUpperCase();
        if (rmSym) {
          const idx = CONFIG.symbols.indexOf(rmSym);
          if (idx !== -1) { CONFIG.symbols.splice(idx, 1); console.log(`\n📋 Dashboard: removed ${rmSym} from watchlist`); }
          // Remove from persisted custom list
          const rmLog = loadLog();
          rmLog.customWatchlist = (rmLog.customWatchlist || []).filter(s => s !== rmSym);
          saveLog(rmLog);
        }
        res.writeHead(302, { Location: `/?pin=${pin}` }); res.end();
      } else { redirect(); }
      return;
    }

    // Live status API — fetches live USDT balance from BitGet for accurate portfolio display
    if (req.method === "GET" && path === "/api/status") {
      if (!checkPin(req.url)) { res.writeHead(401); res.end(JSON.stringify({ error: "Wrong PIN" })); return; }
      (async () => {
        const log = loadLog();
        const today = new Date().toISOString().slice(0, 10);
        const todayTrades = (log.trades || []).filter(t => t.timestamp?.startsWith(today) && t.orderPlaced);
        const todayExits = (log.trades || []).filter(t => t.type === "exit" && t.timestamp?.startsWith(today) && t.pnlUSD !== undefined);
        const totalPnlUSD = todayExits.reduce((s, t) => s + (t.pnlUSD || 0), 0);
        const winRate = calcWinRate(log.trades || [], 10);
        const drawdown = checkDailyDrawdown(log);

        // Fetch live BitGet balances — USDT + all coin holdings for accurate display
        let usdtBalance = log.portfolioValue || 0;
        let liveAssets = [];
        if (!CONFIG.paperTrading) {
          try {
            const bg = ACCOUNTS.find(a => a.exchange === "bitget");
            if (bg) {
              const ts = Date.now().toString();
              const bPath = "/api/v2/spot/account/assets";
              const bSign = crypto.createHmac("sha256", bg.secretKey).update(ts + "GET" + bPath).digest("base64");
              const bRes = await fetch(`${bg.baseUrl}${bPath}`, { headers: { "ACCESS-KEY": bg.apiKey, "ACCESS-SIGN": bSign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": bg.passphrase, "locale": "en-US" }, signal: AbortSignal.timeout(5000) });
              const bData = await bRes.json();
              liveAssets = bData.data || [];
              const usdt = liveAssets.find(a => a.coin === "USDT");
              if (usdt) usdtBalance = parseFloat(usdt.available) + parseFloat(usdt.frozen || 0);
            }
          } catch {}
        }

        // Build live qty lookup for phantom-position filtering
        const liveQty = {};
        for (const asset of liveAssets) {
          const q = parseFloat(asset.available) + parseFloat(asset.frozen || 0);
          if (q > 0.000001) liveQty[asset.coin] = q;
        }

        const openPositions = [];
        let openPositionValue = 0;
        const seenSyms = new Set();

        // Show positions from log, verified against live balance (skip phantoms)
        for (const [sym, pos] of Object.entries(log.positions || {})) {
          if (!pos || !pos.open) continue;
          const baseCoin = sym.replace("USDT", "");
          if (liveAssets.length > 0 && !liveQty[baseCoin]) continue; // phantom — sold but log stale
          const snap = coinSnapshots[sym];
          const price = snap?.price ?? pos.entryPrice ?? 0;
          const qty = liveQty[baseCoin] ?? parseFloat(pos.quantity || 0);
          if (qty < 0.000001 || price < 0.000001) continue;
          const usdVal = qty * price;
          if (usdVal < 0.5) continue;
          openPositionValue += usdVal;
          seenSyms.add(sym);
          const pnlPct = pos.entryPrice ? ((price - pos.entryPrice) / pos.entryPrice) * 100 : 0;
          openPositions.push({ coin: baseCoin, qty, usdVal, entryPrice: pos.entryPrice, pnlPct });
        }

        // Also show live BitGet holdings not in the log
        for (const asset of liveAssets) {
          if (asset.coin === "USDT" || asset.coin === "BGB") continue;
          const qty = liveQty[asset.coin] ?? 0;
          if (qty < 0.000001) continue;
          const sym = asset.coin + "USDT";
          if (seenSyms.has(sym)) continue;
          const snap = coinSnapshots[sym];
          const price = snap?.price ?? 0;
          if (price < 0.000001) continue;
          const usdVal = qty * price;
          if (usdVal < 5) continue;
          openPositionValue += usdVal;
          openPositions.push({ coin: asset.coin, qty, usdVal, entryPrice: null, pnlPct: null });
        }

        const portfolioValue = usdtBalance + openPositionValue;
        const regimeMatch = (log.trades || []).slice(-20).reverse().find(t => t.regime);
        const regime = regimeMatch?.regime || "RANGING";

        const status = {
          time: new Date().toISOString(),
          mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
          paused: _tradingPaused || drawdown.paused,
          regime,
          portfolioValue,
          usdtBalance,
          openPositions,
          todayTrades: todayTrades.length,
          todayPnlUSD: totalPnlUSD,
          winRate: winRate ? `${winRate.wins}/${winRate.sample} (${(winRate.winRate * 100).toFixed(0)}%)` : "not enough data",
          lastTrades: (log.trades || []).slice(-5).map(t => ({
            time: t.timestamp?.slice(0, 16),
            type: t.type,
            symbol: t.symbol,
            price: t.price,
            pnlPct: t.pnlPct,
            pnl: t.pnlPct != null ? `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%` : null,
          })),
          signals: signalLog.slice(-30).reverse(),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
      })().catch(e => {
        console.error("[/api/status]", e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // Coin detail — latest snapshot for a specific coin
    if (req.method === "GET" && path === "/api/coin") {
      if (!checkPin(req.url)) { res.writeHead(401); res.end(JSON.stringify({ error: "Wrong PIN" })); return; }
      const sym = urlObj.searchParams.get("symbol");
      const snap = sym ? coinSnapshots[sym.toUpperCase()] : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snap || { error: "No data yet for " + sym }));
      return;
    }

    // All coin snapshots list
    if (req.method === "GET" && path === "/api/coins") {
      if (!checkPin(req.url)) { res.writeHead(401); res.end(JSON.stringify({ error: "Wrong PIN" })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(coinSnapshots));
      return;
    }

    // Force scan all symbols immediately
    if (req.method === "POST" && path === "/api/force-check") {
      if (!checkPin(req.url)) { res.writeHead(401); res.end(JSON.stringify({ error: "Wrong PIN" })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Scan triggered" }));
      (async () => {
        for (const sym of CONFIG.symbols) {
          await run(null, sym).catch((err) => { console.error(`Action scan ${sym}:`, err.message); pushSignal(sym, "BLOCKED", `Scan error: ${err.message?.slice(0, 60)}`); });
        }
      })();
      return;
    }

    // Sell all open positions
    if (req.method === "POST" && path === "/api/sell-all") {
      if (!checkPin(req.url)) { res.writeHead(401); res.end(JSON.stringify({ error: "Wrong PIN" })); return; }
      (async () => {
        const log = loadLog();
        const open = Object.entries(log.positions || {}).filter(([, p]) => p && p.open).map(([sym]) => sym);
        if (open.length === 0) { res.writeHead(200); res.end(JSON.stringify({ message: "No open positions to sell" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: `Selling ${open.length} position(s)...` }));
        console.log(`\n🚨 Dashboard: force sell-all triggered (${open.join(", ")})`);
        for (const sym of open) {
          await run("SELL", sym).catch(e => console.error(`Force sell ${sym}:`, e.message));
        }
      })().catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    // Pause trading
    if (req.method === "POST" && path === "/api/pause") {
      if (!checkPin(req.url)) { res.writeHead(401); res.end(JSON.stringify({ error: "Wrong PIN" })); return; }
      _tradingPaused = true;
      console.log("⏸ Trading paused via dashboard");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "⏸ Trading paused" }));
      return;
    }

    // Resume trading
    if (req.method === "POST" && path === "/api/resume") {
      if (!checkPin(req.url)) { res.writeHead(401); res.end(JSON.stringify({ error: "Wrong PIN" })); return; }
      _tradingPaused = false;
      console.log("▶ Trading resumed via dashboard");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "▶️ Trading resumed" }));
      return;
    }

    // Legacy status endpoint
    if (req.method === "GET" && path === "/status") {
      const log = loadLog();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ portfolio: log.portfolioValue, positions: log.positions, paused: _tradingPaused }));
      return;
    }

    // TradingView webhook
    if (req.method === "POST" && path === "/webhook") {
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

  // ─── Swing Trading ──────────────────────────────────────────────────────────

  async function runSwing(symbol) {
    if (!SWING_ENABLED) return;

    const PERM_EXCLUDE = ["ARBUSDT", "VIRTUALUSDT", "SUIUSDT"];
    if (PERM_EXCLUDE.includes(symbol)) return;

    const log = loadLog();
    const swingPos = (log.swingPositions || {})[symbol] || null;
    const openSwingCount = Object.values(log.swingPositions || {}).filter(p => p && p.open).length;

    // Fetch all three timeframes in parallel
    let candles, dailyCandles, weeklyCandles;
    try {
      [candles, dailyCandles, weeklyCandles] = await Promise.all([
        fetchCandles(symbol, SWING.tf, SWING.bars),  // 4H — entry timing
        fetchCandles(symbol, "1D", 90),               // Daily — intermediate trend
        fetchCandles(symbol, "1W", 52),               // Weekly — macro direction
      ]);
    } catch { return; }
    if (!candles || candles.length < 50) return;

    // ── 4H indicators ───────────────────────────────────────────────────────
    const closes = candles.map(c => c.close);
    const price   = candles[candles.length - 1].close;
    const rsi3    = calcRSI(closes, 3);
    const rsi14   = calcRSI(closes, 14);
    const vwap    = calcVWAP(candles);
    const ema8    = calcEMA(closes, 8);
    const ema21   = calcEMA(closes, 21);
    const macd    = calcMACD(closes);
    const adx     = calcADX(candles.slice(-30));
    const vol     = calcVolume(candles);
    const obv     = calcOBV(candles);
    const atr     = calcATR(candles.slice(-20));
    const dblBtm  = detectDoubleBottom(candles);

    // ── Daily indicators (intermediate trend) ───────────────────────────────
    let dailyBull = true, dailyDip = true, dailyNotCrashing = true, dailyAbove50 = true, dailyRsi14 = 50;
    if (dailyCandles && dailyCandles.length >= 30) {
      const dc = dailyCandles.map(c => c.close);
      const dEma8  = calcEMA(dc, 8);
      const dEma21 = calcEMA(dc, 21);
      const dEma50 = calcEMA(dc, 50);
      dailyRsi14       = calcRSI(dc, 14) ?? 50;
      const dRsi3      = calcRSI(dc, 3)  ?? 50;
      const dPrice     = dc[dc.length - 1];
      dailyBull        = dEma8 > dEma21;                    // daily uptrend
      dailyDip         = dailyRsi14 < 65 && dRsi3 < 60;    // pulled back from highs
      dailyNotCrashing = dailyRsi14 > 25;                   // not in freefall
      dailyAbove50     = dEma50 !== null && dPrice > dEma50; // above 50-day MA (bull territory)
    }

    // ── Weekly indicators (macro trend) ─────────────────────────────────────
    let weeklyBull = true, weeklyNotOverbought = true, weeklyRsi14 = 50;
    if (weeklyCandles && weeklyCandles.length >= 20) {
      const wc = weeklyCandles.map(c => c.close);
      const wEma8  = calcEMA(wc, 8);
      const wEma21 = calcEMA(wc, 21);
      weeklyRsi14        = calcRSI(wc, 14) ?? 50;
      weeklyBull         = wEma8 > wEma21;      // weekly uptrend (macro bull)
      weeklyNotOverbought = weeklyRsi14 < 75;   // not peaked on weekly
    }

    if (rsi3 === null || vwap === null || atr === null) return;

    // ── Manage open swing position ───────────────────────────────────────────
    if (swingPos && swingPos.open) {
      const pnlPct = ((price - swingPos.entryPrice) / swingPos.entryPrice) * 100;
      const holdH  = (Date.now() - new Date(swingPos.entryTime).getTime()) / 3600000;
      const peak   = Math.max(swingPos.highWatermark || swingPos.entryPrice, price);

      // Update watermark
      if (peak > (swingPos.highWatermark || 0)) {
        swingPos.highWatermark = peak;
        log.swingPositions[symbol] = swingPos;
        saveLog(log);
      }

      // Partial exit at +5%
      if (!swingPos.partialExitDone && pnlPct >= SWING.partialAt * 100) {
        const partialQty = parseFloat(swingPos.quantity) * SWING.partialQty;
        console.log(`\n📈 SWING PARTIAL TP — ${symbol} +${pnlPct.toFixed(2)}% | selling 30%`);
        if (!CONFIG.paperTrading) {
          try { await placeOrder(symbol, "sell", null, price, partialQty.toFixed(6)); }
          catch (e) { console.log(`  ⚠️ Partial failed: ${e.message}`); }
        }
        swingPos.quantity = (parseFloat(swingPos.quantity) - partialQty).toFixed(6);
        swingPos.partialExitDone = true;
        log.swingPositions[symbol] = swingPos;
        saveLog(log);
      }

      // Stepped profit lock on ATR trail
      let trail = peak - SWING.atrMult * atr;
      if (pnlPct >= 12) trail = Math.max(trail, swingPos.entryPrice * 1.08);
      else if (pnlPct >= 8) trail = Math.max(trail, swingPos.entryPrice * 1.05);
      else if (pnlPct >= 5) trail = Math.max(trail, swingPos.entryPrice * 1.02);
      else if (pnlPct >= 3) trail = Math.max(trail, swingPos.entryPrice * 1.00);

      // Use backtest-optimised stop if available
      const btSL = SWING_BACKTEST[symbol]?.stopLoss ?? SWING.stopLoss;
      const exitReasons = [];
      if (pnlPct < -btSL * 100)            exitReasons.push(`Stop-loss ${pnlPct.toFixed(2)}%`);
      if (price < trail && pnlPct > 0)     exitReasons.push(`ATR trail $${trail.toFixed(4)}`);
      if (rsi3 !== null && rsi3 > 80)       exitReasons.push(`RSI(3) overbought ${rsi3.toFixed(1)}`);
      if (holdH > SWING.maxHoldH)           exitReasons.push(`Max hold ${holdH.toFixed(0)}h`);
      if (macd && !macd.bullish && pnlPct > 2) exitReasons.push(`MACD bearish cross at +${pnlPct.toFixed(1)}%`);
      // Daily trend reversal — exit if daily turns bearish while in loss
      if (!dailyBull && pnlPct < -1)        exitReasons.push(`Daily trend reversed at ${pnlPct.toFixed(1)}%`);

      if (exitReasons.length > 0) {
        const pnlUSD = (price - swingPos.entryPrice) * parseFloat(swingPos.quantity);
        console.log(`\n📈 SWING EXIT — ${symbol} | ${exitReasons.join(" | ")}`);
        console.log(`   P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(4)}) | Held ${holdH.toFixed(1)}h`);

        if (!CONFIG.paperTrading) {
          try { await placeOrder(symbol, "sell", null, price, swingPos.quantity); }
          catch (e) { console.log(`❌ SWING SELL FAILED — ${e.message}`); return; }
        } else {
          console.log(`📋 PAPER SWING SELL — ${swingPos.quantity} ${symbol} @ $${price.toFixed(4)}`);
        }

        const exitEntry = {
          timestamp: new Date().toISOString(), type: "exit", symbol,
          timeframe: SWING.tf, price, pnlPct, pnlUSD,
          reasons: exitReasons, orderPlaced: true,
          paperTrading: CONFIG.paperTrading, tradeType: "swing",
        };
        log.swingPositions[symbol] = { ...swingPos, open: false };
        log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
        log.trades.push(exitEntry);
        saveLog(log);
        writeTradeCsv(exitEntry);
      }
      return;
    }

    // ── Entry check ─────────────────────────────────────────────────────────
    if (openSwingCount >= SWING.maxOpen) return;

    // Cross-strategy dedup — don't swing if scalp or breakout already open on same coin
    if ((log.positions || {})[symbol]?.open) return;
    if ((log.breakoutPositions || {})[symbol]?.open) return;

    // Off-hours block
    const utcH = new Date().getUTCHours();
    if (utcH >= SWING.entryBlockH[0] || utcH < SWING.entryBlockH[1]) return;

    // ── Top-down multi-timeframe filter (weekly → daily → 4H) ───────────────
    // Weekly must be bullish — never fight the macro trend
    if (!weeklyBull) return;
    // Daily must not be crashing — no falling knives
    if (!dailyNotCrashing) return;
    // Daily must be in a dip, not already extended (RSI > 65 means too late)
    if (!dailyDip) return;

    // ── 4H entry conditions ──────────────────────────────────────────────────
    const bullish4h  = price > vwap && ema8 > ema21;
    const oversold4h = rsi3 < SWING.rsi3Gate || (rsi14 !== null && rsi14 < SWING.rsi14Gate);
    const noOBVDiv   = !obv.bearDivergence;

    if (!bullish4h || !oversold4h || !noOBVDiv) return;

    // ── Backtest gate ────────────────────────────────────────────────────────
    const btResult = await backtestSwingCoin(symbol);
    if (btResult.recommendation === "SKIP") return;

    // ── Score confirmations ──────────────────────────────────────────────────
    let score = 0;
    if (weeklyNotOverbought)                    score++;  // weekly has room to run
    if (dailyBull)                              score++;  // daily trend still up
    if (dailyAbove50)                           score++;  // above 50-day MA (bull territory)
    if (dailyRsi14 < 45)                        score++;  // genuinely oversold on daily too
    if (adx && adx.adx > 25)                   score++;  // 4H trend strong
    if (vol && vol.aboveAvg)                    score++;  // volume confirms the move
    if (macd && macd.bullish)                   score++;  // 4H momentum intact
    if (dblBtm && dblBtm.detected)             score += dblBtm.strongConfirmation ? 2 : 1;
    if (rsi3 < 20)                              score++;  // extremely oversold on 4H
    if (btResult.recommendation === "TRADE")    score++;  // backtest says go

    if (score < 3) return; // need at least 3 confirmations across all timeframes

    const portfolio  = log.portfolioValue || acct().portfolioValue;
    const swingSize  = portfolio * SWING.sizePct;

    console.log(`\n📈 SWING ENTRY — ${symbol} | Score:${score}/10 | BT:${btResult.recommendation}`);
    console.log(`   Weekly: ${weeklyBull ? "✅ bullish" : "❌"} RSI:${weeklyRsi14.toFixed(0)} | Daily: ${dailyBull ? "✅ uptrend" : "❌"} RSI:${dailyRsi14.toFixed(0)} ${dailyAbove50 ? "above 50MA ✅" : "below 50MA ⚠️"}`);
    console.log(`   4H: RSI(3):${rsi3.toFixed(1)} RSI(14):${rsi14?.toFixed(1)} VWAP:$${vwap.toFixed(4)} EMA8:$${ema8.toFixed(4)}`);
    console.log(`   TP: +${(btResult.takeProfit * 100).toFixed(0)}% | Stop: -${(btResult.stopLoss * 100).toFixed(0)}% | Size: $${swingSize.toFixed(2)}`);
    if (dblBtm?.detected) console.log(`   🔔 Double bottom${dblBtm.strongConfirmation ? " + RSI divergence" : ""}`);

    let qty = swingSize / price;
    let orderId = `PAPER-SWING-${Date.now()}`;

    if (!CONFIG.paperTrading) {
      try {
        let order = acct().exchange === "bitget"
          ? await placeLimitBuyWithFallback(symbol, swingSize, price)
          : null;
        if (!order) order = await placeOrder(symbol, "buy", swingSize, price);
        qty = order.confirmedQty ?? qty;
        orderId = order.orderId;
        console.log(`✅ SWING ORDER PLACED — ${orderId} | qty:${qty.toFixed(6)}`);
      } catch (e) {
        console.log(`❌ SWING ORDER FAILED — ${e.message}`);
        return;
      }
    } else {
      console.log(`📋 PAPER SWING BUY — $${swingSize.toFixed(2)} ${symbol} @ $${price.toFixed(4)}`);
    }

    log.swingPositions = { ...(log.swingPositions || {}), [symbol]: {
      open: true, side: "long", entryPrice: price, highWatermark: price,
      entryTime: new Date().toISOString(), quantity: qty.toFixed(6),
      orderId, tradeType: "swing", partialExitDone: false,
    }};

    const entryLog = {
      timestamp: new Date().toISOString(), type: "entry", symbol,
      timeframe: SWING.tf, price, tradeSize: swingSize,
      indicators: { rsi3, rsi14, vwap, ema8, ema21, adx: adx?.adx },
      score, orderPlaced: true, paperTrading: CONFIG.paperTrading, tradeType: "swing",
    };
    log.trades.push(entryLog);
    saveLog(log);
    writeTradeCsv(entryLog);
  }

  // ─── Breakout Strategy (1H) ──────────────────────────────────────────────────
  // Catches coins breaking out of consolidation with strong volume.
  // Complements scalp (snap-backs) and swing (dip-buying) by covering trending breakouts.

  async function runBreakout(symbol) {
    if (!SWING_ENABLED) return;
    const PERM_EXCLUDE = ["ARBUSDT", "VIRTUALUSDT", "SUIUSDT"];
    if (PERM_EXCLUDE.includes(symbol)) return;

    const log = loadLog();
    const bkPos = (log.breakoutPositions || {})[symbol] || null;

    // Portfolio heat — never open new trade when total risk > 8% of portfolio
    const heat = calcPortfolioHeat(log, _livePortfolioValue);
    if (heat.isOverheated && !bkPos?.open) return;

    let candles;
    try { candles = await fetchCandles(symbol, "1H", 120); }
    catch { return; }
    if (!candles || candles.length < 30) return;

    const closes  = candles.map(c => c.close);
    const price   = candles[candles.length - 1].close;
    const atr     = calcATR(candles.slice(-20));
    const vol     = calcVolume(candles);
    const ema8    = calcEMA(closes, 8);
    const ema21   = calcEMA(closes, 21);
    const ema50   = calcEMA(closes, 50);
    const ichimoku = candles.length >= 78 ? calcIchimoku(candles) : null;
    if (!atr) return;

    // ── Manage open breakout position ────────────────────────────────────────
    if (bkPos && bkPos.open) {
      const pnlPct = ((price - bkPos.entryPrice) / bkPos.entryPrice) * 100;
      const holdH  = (Date.now() - new Date(bkPos.entryTime).getTime()) / 3600000;
      const peak   = Math.max(bkPos.highWatermark || bkPos.entryPrice, price);
      if (peak > (bkPos.highWatermark || 0)) {
        bkPos.highWatermark = peak;
        log.breakoutPositions[symbol] = bkPos;
        saveLog(log);
      }
      // Stepped profit lock + ATR trail
      let trail = peak - 2 * atr;
      if (pnlPct >= 6) trail = Math.max(trail, bkPos.entryPrice * 1.04);
      else if (pnlPct >= 4) trail = Math.max(trail, bkPos.entryPrice * 1.02);
      else if (pnlPct >= 2) trail = Math.max(trail, bkPos.entryPrice * 1.00);

      const exitReasons = [];
      if (pnlPct < -3)                            exitReasons.push(`Stop-loss ${pnlPct.toFixed(2)}%`);
      if (price < bkPos.breakoutLevel && pnlPct < 0) exitReasons.push(`Below breakout level`);
      if (price < trail && pnlPct > 0)            exitReasons.push(`ATR trail $${trail.toFixed(4)}`);
      if (holdH > 48)                             exitReasons.push(`Max hold 48h`);
      if (bkPos.targetPrice && price >= bkPos.targetPrice) exitReasons.push(`Target hit +${pnlPct.toFixed(1)}%`);

      if (exitReasons.length > 0) {
        const pnlUSD = (price - bkPos.entryPrice) * parseFloat(bkPos.quantity);
        console.log(`\n🚀 BREAKOUT EXIT — ${symbol} | ${exitReasons.join(" | ")} | P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`);
        if (!CONFIG.paperTrading) {
          try { await placeOrder(symbol, "sell", null, price, bkPos.quantity); }
          catch (e) { console.log(`❌ BREAKOUT SELL FAILED — ${e.message}`); return; }
        } else {
          console.log(`📋 PAPER BREAKOUT SELL — ${bkPos.quantity} ${symbol} @ $${price.toFixed(4)}`);
        }
        const exitEntry = {
          timestamp: new Date().toISOString(), type: "exit", symbol, timeframe: "1H",
          price, pnlPct, pnlUSD: +pnlUSD.toFixed(4), reasons: exitReasons,
          orderPlaced: true, paperTrading: CONFIG.paperTrading, tradeType: "breakout",
        };
        log.breakoutPositions[symbol] = { ...bkPos, open: false };
        log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
        log.trades.push(exitEntry);
        saveLog(log);
        writeTradeCsv(exitEntry);
      }
      return;
    }

    // ── Entry check ─────────────────────────────────────────────────────────
    const openBreakouts = Object.values(log.breakoutPositions || {}).filter(p => p?.open).length;
    if (openBreakouts >= 2) return;

    // Cross-strategy dedup — don't break out if scalp or swing already open on same coin
    if ((log.positions || {})[symbol]?.open) return;
    if ((log.swingPositions || {})[symbol]?.open) return;

    // Off-hours and bear market block
    const utcH = new Date().getUTCHours();
    if (utcH >= 22 || utcH < 6) return;
    const regime = await detectMarketRegime();
    if (regime.btcTrend === "bear") return;

    // Need uptrend context on 1H
    if (!ema8 || !ema21 || ema8 < ema21) return;
    if (ichimoku && ichimoku.belowCloud) return;

    // Consolidation: 20-bar range must be tight (< 4 × ATR)
    const lookback = candles.slice(-21, -1);
    const rangeHigh = Math.max(...lookback.map(c => c.high));
    const rangeLow  = Math.min(...lookback.map(c => c.low));
    const range = rangeHigh - rangeLow;
    if (range > atr * 4) return; // not consolidating

    // Breakout: close above range high with 0.2% buffer to avoid fakeouts
    if (price < rangeHigh * 1.002) return;

    // Volume surge required — 2× average
    if (!vol || vol.current < vol.avg * 2) return;

    // Ichimoku: must not be breaking out below the cloud
    if (ichimoku && !ichimoku.aboveCloud && !ichimoku.bullishCross) return;

    // R:R check — need at least 2:1
    const targetPrice = price + range; // measured move
    const stopDist = price - rangeHigh; // distance to breakout level
    const reward = targetPrice - price;
    if (stopDist <= 0 || reward / Math.abs(stopDist) < 2) return;

    // Walk-forward backtest gate — same gate as scalp, using 1H candles
    const bkBtResult = await backtestCoin(symbol).catch(() => null);
    if (bkBtResult && bkBtResult.recommendation === "SKIP") {
      console.log(`🚫 BREAKOUT BACKTEST BLOCK — ${symbol} failed walk-forward gate (WR<65%). Skipping.`);
      return;
    }

    const portfolio = log.portfolioValue || acct().portfolioValue;
    const bkSize = portfolio * 0.15;

    console.log(`\n🚀 BREAKOUT ENTRY — ${symbol} | Regime:${regime.regime}`);
    console.log(`   Consolidation: $${rangeLow.toFixed(4)}–$${rangeHigh.toFixed(4)} | Breakout @ $${price.toFixed(4)}`);
    console.log(`   Target: $${targetPrice.toFixed(4)} (+${(reward/price*100).toFixed(1)}%) | Stop: $${rangeHigh.toFixed(4)} (-${(Math.abs(stopDist)/price*100).toFixed(1)}%)`);
    console.log(`   Vol: ${(vol.current/vol.avg*100).toFixed(0)}% of avg | Ichimoku: ${ichimoku ? (ichimoku.aboveCloud ? "above cloud ✅" : "in cloud ⚠️") : "n/a"}`);
    if (heat.heatPct > 0) console.log(`   Portfolio heat: ${heat.heatPct}% of 8% max`);

    let qty = bkSize / price;
    let orderId = `PAPER-BK-${Date.now()}`;
    if (!CONFIG.paperTrading) {
      try {
        let order = acct().exchange === "bitget"
          ? await placeLimitBuyWithFallback(symbol, bkSize, price)
          : null;
        if (!order) order = await placeOrder(symbol, "buy", bkSize, price);
        qty = order.confirmedQty ?? qty;
        orderId = order.orderId;
        console.log(`✅ BREAKOUT ORDER — ${orderId} | qty:${qty.toFixed(6)}`);
      } catch (e) { console.log(`❌ BREAKOUT ORDER FAILED — ${e.message}`); return; }
    } else {
      console.log(`📋 PAPER BREAKOUT BUY — $${bkSize.toFixed(2)} ${symbol} @ $${price.toFixed(4)}`);
    }

    log.breakoutPositions = { ...(log.breakoutPositions || {}), [symbol]: {
      open: true, side: "long", entryPrice: price, highWatermark: price,
      entryTime: new Date().toISOString(), quantity: qty.toFixed(6),
      orderId, tradeType: "breakout", breakoutLevel: rangeHigh,
      targetPrice, rangeLow, rangeHigh,
    }};
    const entryLog = {
      timestamp: new Date().toISOString(), type: "entry", symbol, timeframe: "1H",
      price, tradeSize: bkSize, indicators: { ema8, ema21, range, volRatio: vol.current/vol.avg },
      breakoutLevel: rangeHigh, targetPrice, orderPlaced: true,
      paperTrading: CONFIG.paperTrading, tradeType: "breakout",
    };
    log.trades.push(entryLog);
    saveLog(log);
    writeTradeCsv(entryLog);
  }

  // Merge any coins the user added via the dashboard (persisted in log.customWatchlist)
  function mergeCustomWatchlist() {
    try {
      const log = loadLog();
      const custom = (log.customWatchlist || []).filter(s => typeof s === "string");
      let added = 0;
      for (const sym of custom) {
        if (!CONFIG.symbols.includes(sym)) { CONFIG.symbols.push(sym); added++; }
      }
      if (added > 0) console.log(`\n📋 Loaded ${added} custom watchlist coin(s) from log: ${custom.join(", ")}`);
    } catch {}
  }

  server.listen(PORT, () => {
    console.log(`\n🌐 Webhook server listening on port ${PORT}`);
    mergeCustomWatchlist();
    console.log(`   Symbols:     ${CONFIG.symbols.join(", ")}`);
    console.log(`   Polling:     every 5 minutes\n`);

    // Fetch top movers then run first scan
    (async () => {
      // Log market regime on startup
      const regime = await detectMarketRegime().catch(() => ({ regime: "UNKNOWN" }));
      console.log(`\n🌍 Market regime: ${regime.regime} | BTC trend: ${regime.btcTrend} | Volatility: ${regime.volatility}`);

      // Fire refreshTopMovers in background — don't block the startup scan on 80-coin backtests
      refreshTopMovers().then(() => startPriceStream(CONFIG.symbols)).catch(e => console.error("refreshTopMovers failed:", e.message));
      startPriceStream(CONFIG.symbols);

      for (const account of ACCOUNTS) {
        _currentAccount = account;
        // Startup balance sync + position reconciliation
        // Reconciliation re-discovers open positions after Railway log wipe
        if (!CONFIG.paperTrading) {
          const startLog = loadLog();
          await syncPortfolioBalance(startLog).catch(e => console.error("syncPortfolioBalance failed:", e.message));
          await reconcilePositions(startLog).catch(e => console.error("reconcilePositions failed:", e.message));
          await sweepDust(startLog).catch(e => console.error("sweepDust failed:", e.message));
          saveLog(startLog);
          sendEmail(
            "🤖 Bot Online — Trading Started",
            `<h2>🤖 Bot is now live</h2>
             <p>Started at ${new Date().toUTCString()}</p>
             <p><b>Portfolio:</b> $${(startLog.portfolioValue || 0).toFixed(2)}</p>
             <p><b>Watching:</b> ${CONFIG.symbols.join(", ")}</p>
             <p><b>Mode:</b> LIVE TRADING</p>`
          );
        }
        console.log(`\n👛 Account ${account.id} — initial scan (3 coins at a time)`);
        const startSyms = [...CONFIG.symbols];
        for (let i = 0; i < startSyms.length; i += 3) {
          await Promise.all(startSyms.slice(i, i + 3).map(sym =>
            run(null, sym).catch((err) => { console.error(`Startup ${sym} [acct${account.id}] error:`, err.message); pushSignal(sym, "BLOCKED", `Scan error: ${err.message?.slice(0, 60)}`); })
          ));
        }
        if (SWING_ENABLED) {
          for (const sym of CONFIG.symbols) {
            await runSwing(sym).catch((err) => console.error(`Swing startup ${sym} [acct${account.id}] error:`, err));
          }
          for (const sym of CONFIG.symbols) {
            await runBreakout(sym).catch((err) => console.error(`Breakout startup ${sym} [acct${account.id}] error:`, err));
          }
        }
      }
      _currentAccount = ACCOUNTS[0];
      _lastScanTime = Date.now();
      _lastScanCount = CONFIG.symbols.length;
    })();
  });

  // Swap to fresh top movers every 4 hours (restarts price stream with new symbols)
  setInterval(async () => {
    await refreshTopMovers();
    startPriceStream(CONFIG.symbols);
  }, 4 * 60 * 60 * 1000);

  // Daily summary email — fires at midnight UTC
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      const log = loadLog();
      await emailDailySummary(log);
    }
  }, 5 * 60 * 1000);

  // WebSocket hard-stop checker — fires every 5 seconds using live streamed prices
  setInterval(async () => {
    for (const account of ACCOUNTS) {
      _currentAccount = account;
      await checkLiveHardStops();
    }
    _currentAccount = ACCOUNTS[0];
  }, 5000);

  // Fast exit monitor — check open scalp positions every 60 seconds
  setInterval(async () => {
    for (const account of ACCOUNTS) {
      _currentAccount = account;
      const log = loadLog();
      const openSymbols = Object.entries(log.positions || {})
        .filter(([, p]) => p && p.open)
        .map(([sym]) => sym);
      for (const sym of openSymbols) {
        await run(null, sym).catch((err) => { console.error(`Exit monitor ${sym} [acct${account.id}] error:`, err.message); pushSignal(sym, "BLOCKED", `Scan error: ${err.message?.slice(0, 60)}`); });
      }
    }
    _currentAccount = ACCOUNTS[0];
  }, 60 * 1000);

  // Swing exit monitor — check open swing positions every 30 minutes
  setInterval(async () => {
    if (!SWING_ENABLED) return;
    for (const account of ACCOUNTS) {
      _currentAccount = account;
      const log = loadLog();
      const openSwings = Object.entries(log.swingPositions || {})
        .filter(([, p]) => p && p.open)
        .map(([sym]) => sym);
      if (openSwings.length > 0) {
        console.log(`\n📈 Swing exit check [acct${account.id}] — ${openSwings.join(", ")}`);
        for (const sym of openSwings) {
          await runSwing(sym).catch((err) => console.error(`Swing exit ${sym} [acct${account.id}] error:`, err));
        }
      }
    }
    _currentAccount = ACCOUNTS[0];
  }, 30 * 60 * 1000);

  // Swing entry scan — every 4 hours (aligned with 4H candle closes)
  setInterval(async () => {
    if (!SWING_ENABLED) return;
    for (const account of ACCOUNTS) {
      _currentAccount = account;
      console.log(`\n📈 Swing entry scan [acct${account.id}]...`);
      for (const sym of CONFIG.symbols) {
        await runSwing(sym).catch((err) => console.error(`Swing scan ${sym} [acct${account.id}] error:`, err));
      }
    }
    _currentAccount = ACCOUNTS[0];
  }, 4 * 60 * 60 * 1000);

  // Breakout exit monitor — every 15 minutes (1H candles, faster reaction than swing)
  setInterval(async () => {
    if (!SWING_ENABLED) return;
    for (const account of ACCOUNTS) {
      _currentAccount = account;
      const log = loadLog();
      const openBk = Object.entries(log.breakoutPositions || {})
        .filter(([, p]) => p?.open).map(([s]) => s);
      if (openBk.length > 0) {
        console.log(`\n🚀 Breakout exit check [acct${account.id}] — ${openBk.join(", ")}`);
        for (const sym of openBk) {
          await runBreakout(sym).catch((err) => console.error(`Breakout exit ${sym} [acct${account.id}] error:`, err));
        }
      }
    }
    _currentAccount = ACCOUNTS[0];
  }, 15 * 60 * 1000);

  // Breakout entry scan — every 1 hour
  setInterval(async () => {
    if (!SWING_ENABLED) return;
    for (const account of ACCOUNTS) {
      _currentAccount = account;
      for (const sym of CONFIG.symbols) {
        await runBreakout(sym).catch((err) => console.error(`Breakout scan ${sym} [acct${account.id}] error:`, err));
      }
    }
    _currentAccount = ACCOUNTS[0];
  }, 60 * 60 * 1000);

  // Check all symbols every 5 minutes (scalp entry scan + exit check) — 3 coins at a time
  setInterval(async () => {
    for (const account of ACCOUNTS) {
      _currentAccount = account;
      const pollSyms = [...CONFIG.symbols];
      for (let i = 0; i < pollSyms.length; i += 3) {
        await Promise.all(pollSyms.slice(i, i + 3).map(sym =>
          run(null, sym).catch((err) => { console.error(`Poll ${sym} [acct${account.id}] error:`, err.message); pushSignal(sym, "BLOCKED", `Scan error: ${err.message?.slice(0, 60)}`); })
        ));
      }
    }
    _currentAccount = ACCOUNTS[0];
    _lastScanTime = Date.now();
    _lastScanCount = CONFIG.symbols.length;
  }, 5 * 60 * 1000);
}
