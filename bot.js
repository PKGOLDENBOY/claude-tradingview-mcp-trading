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
import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, mkdirSync } from "fs";
import { AsyncLocalStorage } from "async_hooks";
import crypto from "crypto";
import { execSync } from "child_process";
import WebSocket from "ws";
// ─── Email notifications (Resend — HTTP, no SMTP, works on Railway) ──────────

const EMAIL_TO = process.env.NOTIFY_EMAIL || "joshualiversage01@gmail.com";

async function sendEmail(subject, html) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Trading Bot <onboarding@resend.dev>",
        to: [EMAIL_TO],
        subject,
        html,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || res.statusText);
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
  const allExits  = (log.trades || []).filter(t => t.type === "exit" && t.pnlPct !== undefined && t.orderPlaced);
  const todayExits   = allExits.filter(t => t.timestamp?.startsWith(today));
  const todayEntries = (log.trades || []).filter(t => t.type === "entry" && t.timestamp?.startsWith(today) && t.orderPlaced);

  // Today stats
  const wins   = todayExits.filter(t => t.pnlPct > 0).length;
  const losses = todayExits.filter(t => t.pnlPct <= 0).length;
  const todayPnlPct = todayExits.reduce((s, t) => s + t.pnlPct, 0);
  const todayPnlUSD = todayExits.reduce((s, t) => s + (t.pnlUSD || 0), 0);

  // All-time stats
  const allWins   = allExits.filter(t => t.pnlPct > 0).length;
  const allLosses = allExits.filter(t => t.pnlPct <= 0).length;
  const allWR     = allExits.length > 0 ? (allWins / allExits.length * 100).toFixed(1) : "—";
  const allPnlUSD = allExits.reduce((s, t) => s + (t.pnlUSD || 0), 0);

  // Portfolio
  const portfolioVal = log.portfolioValue || 0;

  // Fetch live prices + open positions
  let livePriceMap = {};
  try {
    const pr = await fetch("https://api.bitget.com/api/v2/spot/market/tickers");
    const pd = await pr.json();
    (pd.data || []).forEach(t => { livePriceMap[t.symbol] = parseFloat(t.lastPr); });
  } catch { /* non-critical */ }

  // BTC regime
  let regimeLabel = "Unknown";
  try {
    const r = await detectMarketRegime();
    regimeLabel = `${r.regime} (BTC: ${r.btcTrend}, vol: ${r.volatility})`;
  } catch { /* non-critical */ }

  // Fear & Greed
  let fgLabel = "";
  try {
    const fg = await fetchFearGreed();
    if (fg) fgLabel = `${fg.value} — ${fg.label}`;
  } catch { /* non-critical */ }

  // Open positions (scalp + swing)
  const openPositions = [];
  for (const [sym, pos] of Object.entries(log.positions || {})) {
    if (!pos.open) continue;
    const livePrice = livePriceMap[sym] || 0;
    const qty = parseFloat(pos.quantity) || 0;
    const entry = parseFloat(pos.entryPrice) || 0;
    const unrealPct = entry > 0 ? (livePrice - entry) / entry * 100 : 0;
    const unrealUSD = qty * (livePrice - entry);
    const slPrice   = entry * (1 - (pos.slPct || 0.04));
    const tpPrice   = entry * (1 + (pos.tpPct || 0.08));
    openPositions.push({ sym, entry, livePrice, qty, unrealPct, unrealUSD, slPrice, tpPrice, type: pos.bearSnapBack ? "snap-back" : pos.entryType || "scalp" });
  }
  for (const [sym, pos] of Object.entries(log.swingPositions || {})) {
    if (!pos.open) continue;
    const livePrice = livePriceMap[sym] || 0;
    const qty = parseFloat(pos.quantity) || 0;
    const entry = parseFloat(pos.entryPrice) || 0;
    const unrealPct = entry > 0 ? (livePrice - entry) / entry * 100 : 0;
    const unrealUSD = qty * (livePrice - entry);
    openPositions.push({ sym, entry, livePrice, qty, unrealPct, unrealUSD, slPrice: entry * 0.95, tpPrice: entry * 1.15, type: "swing" });
  }

  const openPnlUSD  = openPositions.reduce((s, p) => s + p.unrealUSD, 0);
  const openValue   = openPositions.reduce((s, p) => s + p.qty * p.livePrice, 0);
  const usdtFree    = portfolioVal - openValue;

  // Today's trade rows
  const exitRows = todayExits.map(t => {
    const won = t.pnlPct > 0;
    const dur = t.entryTime ? Math.round((new Date(t.timestamp) - new Date(t.entryTime)) / 60000) : "—";
    return `<tr>
      <td><b>${t.symbol?.replace("USDT","")}</b></td>
      <td>${t.strategy || t.timeframe || "scalp"}</td>
      <td style="color:${won?"#16a34a":"#dc2626"};font-weight:bold">${t.pnlPct>=0?"+":""}${t.pnlPct.toFixed(2)}%</td>
      <td style="color:${won?"#16a34a":"#dc2626"};font-weight:bold">${(t.pnlUSD||0)>=0?"+":""}$${(t.pnlUSD||0).toFixed(2)}</td>
      <td style="color:#666;font-size:12px">${typeof dur==="number"?dur+"min":dur}</td>
      <td style="color:#666;font-size:12px">${(t.exitReasons||[]).join(", ").slice(0,40)}</td>
    </tr>`;
  }).join("");

  // Open position rows
  const openRows = openPositions.map(p => {
    const col = p.unrealPct >= 0 ? "#16a34a" : "#dc2626";
    return `<tr>
      <td><b>${p.sym.replace("USDT","")}</b></td>
      <td>${p.type}</td>
      <td>$${p.entry.toFixed(4)}</td>
      <td>$${p.livePrice.toFixed(4)}</td>
      <td style="color:${col};font-weight:bold">${p.unrealPct>=0?"+":""}${p.unrealPct.toFixed(2)}%</td>
      <td style="color:${col};font-weight:bold">${p.unrealUSD>=0?"+":""}$${p.unrealUSD.toFixed(2)}</td>
      <td style="color:#666;font-size:12px">SL $${p.slPrice.toFixed(4)} / TP $${p.tpPrice.toFixed(4)}</td>
    </tr>`;
  }).join("");

  const subjectPnl = todayPnlUSD !== 0 ? `${todayPnlUSD>=0?"+":""}$${todayPnlUSD.toFixed(2)}` : "no closes";
  await sendEmail(
    `📊 Daily Report — ${subjectPnl} | ${wins}W/${losses}L today | $${portfolioVal.toFixed(2)} portfolio`,
    `<div style="font-family:sans-serif;max-width:640px;margin:auto">
    <h2 style="margin-bottom:4px">📊 Daily Bot Report</h2>
    <p style="color:#666;margin-top:0">${new Date().toUTCString()}</p>

    <h3 style="border-bottom:1px solid #eee;padding-bottom:4px">💼 Portfolio</h3>
    <table style="font-size:15px;line-height:2;width:100%">
      <tr><td><b>Total value</b></td><td><b>$${portfolioVal.toFixed(2)}</b></td></tr>
      <tr><td>USDT free</td><td>$${usdtFree.toFixed(2)}</td></tr>
      <tr><td>In positions</td><td>$${openValue.toFixed(2)} (${openPositions.length} open)</td></tr>
      <tr><td>Unrealised P&amp;L</td><td style="color:${openPnlUSD>=0?"#16a34a":"#dc2626"};font-weight:bold">${openPnlUSD>=0?"+":""}$${openPnlUSD.toFixed(2)}</td></tr>
    </table>

    ${openPositions.length > 0 ? `
    <h3 style="border-bottom:1px solid #eee;padding-bottom:4px">📂 Open Positions</h3>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:13px;width:100%">
      <tr style="background:#f5f5f5"><th>Coin</th><th>Type</th><th>Entry</th><th>Now</th><th>Unreal %</th><th>Unreal $</th><th>Levels</th></tr>
      ${openRows}
    </table>` : `<p style="color:#888">No open positions.</p>`}

    <h3 style="border-bottom:1px solid #eee;padding-bottom:4px">📅 Today — ${today}</h3>
    <table style="font-size:15px;line-height:2;width:100%">
      <tr><td>Entries</td><td>${todayEntries.length}</td></tr>
      <tr><td>Exits</td><td>${todayExits.length} (${wins}W / ${losses}L)</td></tr>
      <tr><td>Today P&amp;L %</td><td style="color:${todayPnlPct>=0?"#16a34a":"#dc2626"};font-weight:bold">${todayPnlPct>=0?"+":""}${todayPnlPct.toFixed(2)}%</td></tr>
      <tr><td>Today P&amp;L $</td><td style="color:${todayPnlUSD>=0?"#16a34a":"#dc2626"};font-weight:bold">${todayPnlUSD>=0?"+":""}$${todayPnlUSD.toFixed(2)}</td></tr>
    </table>
    ${todayExits.length > 0 ? `
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:13px;width:100%;margin-top:8px">
      <tr style="background:#f5f5f5"><th>Coin</th><th>Type</th><th>P&amp;L %</th><th>P&amp;L $</th><th>Duration</th><th>Exit reason</th></tr>
      ${exitRows}
    </table>` : ""}

    <h3 style="border-bottom:1px solid #eee;padding-bottom:4px">📈 All-Time Stats</h3>
    <table style="font-size:15px;line-height:2;width:100%">
      <tr><td>Total trades closed</td><td>${allExits.length} (${allWins}W / ${allLosses}L)</td></tr>
      <tr><td>Live win rate</td><td><b>${allWR}%</b></td></tr>
      <tr><td>All-time realised P&amp;L</td><td style="color:${allPnlUSD>=0?"#16a34a":"#dc2626"};font-weight:bold">${allPnlUSD>=0?"+":""}$${allPnlUSD.toFixed(2)}</td></tr>
    </table>

    <h3 style="border-bottom:1px solid #eee;padding-bottom:4px">🌍 Market</h3>
    <table style="font-size:15px;line-height:2;width:100%">
      <tr><td>BTC regime</td><td><b>${regimeLabel}</b></td></tr>
      <tr><td>Fear &amp; Greed</td><td>${fgLabel || "—"}</td></tr>
      <tr><td>Mode</td><td>${CONFIG.paperTrading ? "📋 Paper trading" : "🔴 Live trading"}</td></tr>
    </table>

    <p style="color:#aaa;font-size:12px;margin-top:24px">Claude Trading Bot · Railway · joshualiversage01@gmail.com</p>
    </div>`
  );
}

// Real-time price cache — updated by WebSocket stream, consumed by hard-stop monitor
const livePrices = new Map(); // symbol → { price, timestamp }
let priceStreamWs = null;
const _processingStops = new Set(); // guard against double-exits
const _processingEntries = new Set(); // guard against duplicate concurrent entries

// Claude rate limiting — shared pool across all entry + exit calls
let _claudeCallsToday = 0;
let _claudeDate = "";
let _lastClaudeCallMs = 0;
const CLAUDE_DAILY_CAP = 3;          // max calls per day (entries + exits combined)
const CLAUDE_GLOBAL_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h between any two calls

function claudeAvailable() {
  const today = new Date().toISOString().slice(0, 10);
  if (_claudeDate !== today) { _claudeDate = today; _claudeCallsToday = 0; }
  if (_claudeCallsToday >= CLAUDE_DAILY_CAP) return "daily-cap";
  if (Date.now() - _lastClaudeCallMs < CLAUDE_GLOBAL_COOLDOWN_MS) return "cooldown";
  return "ok";
}

function recordClaudeCall() {
  _claudeCallsToday++;
  _lastClaudeCallMs = Date.now();
}

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

// Per-symbol mutex — prevents duplicate exits when poll + webhook run concurrently
const _runningSymbols = new Set();

// Per-coin latest scan data — shown in dashboard coin detail view
const coinSnapshots = {};

// Top 10 gainers cached from last refreshTopMovers() call
let _topGainers = [];

// Coins that failed "Not enough data" — excluded from scan pool for the process lifetime
const _insufficientHistory = new Set();

// Live portfolio value (USDT + open coin positions) — updated by buildStatusData on every dashboard poll
let _livePortfolioValue = null;

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  // Cloud environments (Railway, etc.) inject vars directly — no .env file needed
  if (missing.length === 0) {
    console.log(`\n📄 Trade log: ${CSV_FILE}`);
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
  console.log(`\n📄 Trade log: ${CSV_FILE}`);
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

// ─── Long-Term Portfolio Config ───────────────────────────────────────────────
// Based on BitcoinTAF $25K portfolio strategy: buy a diversified basket and
// hold until the profit target is reached. Runs independently of scalp/swing.
const LT_ENABLED    = process.env.LT_ENABLED !== "false";                       // disable via env if needed
const LT_TRADE_SIZE = parseFloat(process.env.LT_TRADE_SIZE_USD  || "5");        // $ invested per coin
const LT_TARGET_PCT = parseFloat(process.env.LT_TARGET_PCT      || "100");      // exit at +100% (2×)
const LT_RESERVE    = parseFloat(process.env.LT_USDT_RESERVE    || "20");       // keep this much free for scalp
const LT_COINS = [
  // BitcoinTAF $25K Long Term Portfolio 2026 — matched to BitGet USDT pairs
  "ETHUSDT","ADAUSDT","AXSUSDT","AVAXUSDT","DOGEUSDT","ETCUSDT","FETUSDT",
  "FILUSDT","GALAUSDT","HBARUSDT","ICPUSDT","LINKUSDT","LTCUSDT","LUNCUSDT",
  "MANAUSDT","PEPEUSDT","SEIUSDT","SLPUSDT","SUIUSDT","THETAUSDT","VIRTUALUSDT",
  "VRAUSDT","XRPUSDT","ARKMUSDT","STRKUSDT","CHRUSDT","PHBUSDT","ZILUSDT",
  "EGLDUSDT","IOTAUSDT","INJUSDT","DOTUSDT","JASMYUSDT","RUNEUSDT","ALICEUSDT",
  "ORAIUSDT","ORDIUSDT","NEOUSDT","XLMUSDT","COTIUSDT","1INCHUSDT","COMPUSDT",
  "FLOWUSDT","KAVAUSDT","PAALUSDT","MERLUSDT",
];

const BASE_WATCHLIST = ["ATOMUSDT","GOMININGUSDT","AXSUSDT","KAVAUSDT","SOLUSDT","XLMUSDT"];
const WATCHLIST = [...new Set([
  ...BASE_WATCHLIST,
  ...(process.env.WATCHLIST || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
])];

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

const LOG_FILE = process.env.STATE_FILE || "safety-check-log.json";
const LOG_VERBOSE = process.env.LOG_VERBOSE === "true"; // set to "true" to restore full indicator dumps

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

// Account context — AsyncLocalStorage carries the active account through every await in a call chain.
// Replaces the old global _currentAccount which was susceptible to race conditions when multiple
// setInterval callbacks interleaved at await points and corrupted each other's account context.
const _accountStore = new AsyncLocalStorage();
const acct = () => _accountStore.getStore() ?? ACCOUNTS[0];

// Per-side taker fee rate for the active exchange.
// BitGet spot with BGB deduction: 0.064% | BitMart spot: 0.25%
function getFeePct() {
  return acct().exchange === "bitmart" ? 0.0025 : 0.00064;
}

// ─── Swing Trading Config ────────────────────────────────────────────────────
const SWING_ENABLED = process.env.SWING_TRADING !== "false"; // on by default
const SWING = {
  tf: "4H",
  bars: 200,              // ~33 days of 4H bars
  rsi3Gate: 40,           // 4H RSI(3) < 40 (backtest winner: 69% WR OOS)
  rsi14Gate: 50,          // OR 4H RSI(14) below this (medium-term oversold)
  takeProfit: 0.10,       // 10% target (backtest winner)
  stopLoss: 0.05,         // 5% hard stop (wider for 4H swings)
  atrMult: 3.0,           // wider ATR trail than scalp
  partialAt: 0.06,        // take 30% off at +6%
  partialQty: 0.30,
  maxHoldH: 192,          // 8 days (48 × 4H bars — backtest winner)
  rsiOverboughtExit: 85,  // exit when RSI(3) > 85 on 4H (backtest winner)
  sizePct: 0.20,          // 20% of portfolio per swing
  maxOpen: 5,             // max concurrent swing positions
  entryBlockH: [22, 6],   // no entries 22:00–06:00 UTC
};

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  const fresh = () => ({ trades: [], portfolioValue: acct().portfolioValue, dayStartValue: acct().portfolioValue, dayStartDate: new Date().toISOString().slice(0, 10), _needsPortfolioSync: true });
  if (!existsSync(acct().logFile)) return fresh();
  let raw;
  try {
    raw = readFileSync(acct().logFile);
    if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) raw = raw.slice(3);
    const log = JSON.parse(raw.toString("utf8"));
    const today = new Date().toISOString().slice(0, 10);
    if (!log.portfolioValue) log.portfolioValue = acct().portfolioValue;
    if (log.dayStartDate !== today) {
      log.dayStartDate = today;
      log._needsPortfolioSync = true;
      log.dayStartValue = log.portfolioValue;
    }
    if (!log.dayStartValue) log.dayStartValue = log.portfolioValue;
    return log;
  } catch (e) {
    // Corrupted log (e.g. process killed mid-write) — back it up and start fresh
    console.error(`⚠️ loadLog: JSON parse failed (${e.message}) — backing up corrupted file and starting fresh`);
    try { renameSync(acct().logFile, acct().logFile + ".bak." + Date.now()); } catch {}
    return fresh();
  }
}

function saveLog(log) {
  // Atomic write: write to temp file then rename so a mid-write kill never corrupts the log
  const tmp = acct().logFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(log, null, 2));
  renameSync(tmp, acct().logFile);
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

// Read historical P&L stats from trades.csv — last 20 closed trades only.
// All-time stats unfairly penalise the current strategy for exits made under old code.
function loadCsvStats() {
  try {
    if (!existsSync(CSV_FILE)) return null;
    const allPnls = readFileSync(CSV_FILE, "utf8").split("\n")
      .filter(l => l.includes(",SELL,") && l.includes(",LIVE,") && l.includes("P&L:") && !l.includes("[SNIPER]"))
      .map(l => { const m = l.match(/P&L: ([+-]?\d+\.?\d+)%/); return m ? parseFloat(m[1]) : null; })
      .filter(v => v !== null);
    // Use only the most recent 20 trades — reflects current strategy quality
    const pnls = allPnls.slice(-20);
    if (pnls.length < 2) return null;
    const wins = pnls.filter(p => p > 0.25);
    const losses = pnls.filter(p => p <= 0.25);
    const wr = wins.length / pnls.length;
    const aw = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : null;
    const al = losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : null;
    return {
      winRatePct: wr * 100,
      winRateStr: `${wins.length}/${pnls.length} (${(wr * 100).toFixed(0)}%) last 20`,
      avgWin: aw != null ? aw.toFixed(2) : null,
      avgLoss: al != null ? al.toFixed(2) : null,
      expectancy: pnls.length >= 2 ? (wr * (aw ?? 0) + (1 - wr) * (al ?? 0)).toFixed(2) : null,
      totalTrades: allPnls.length,
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
  if (!wr) return { mode: "normal", label: "📊 Normal — not enough history yet", rsiThreshold: 38, confidenceMin: 0, sizeMultiplier: 1.0 };
  if (wr.winRate >= 0.65) return { mode: "normal",    label: `✅ Normal — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample})`,    rsiThreshold: 38, confidenceMin: 70, sizeMultiplier: 1.0 };
  if (wr.winRate >= 0.45) return { mode: "cautious",  label: `⚠️  Cautious — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample})`,  rsiThreshold: 25, confidenceMin: 80, sizeMultiplier: 0.75 };
  if (wr.winRate >= 0.35) return { mode: "defensive", label: `🔴 Defensive — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample})`, rsiThreshold: 20, confidenceMin: 85, sizeMultiplier: 0.5 };
  return { mode: "paused", label: `🛑 Paused — win rate ${(wr.winRate*100).toFixed(0)}% (${wr.wins}/${wr.sample}) too low`, rsiThreshold: 20, confidenceMin: 90, sizeMultiplier: 0.10 };
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
    for (const tp of [0.03, 0.04, 0.05, 0.06, 0.08, 0.10]) { // extended to 10% (mega-backtest winner)
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

function runSwingBacktestSim(candles4h, rsiThreshold, takeProfit = 0.10, stopLoss = 0.05) {
  // Mega-backtest validated signal: dip-buy below VWAP in uptrend (69% OOS WR)
  const closes = candles4h.map(c => c.close);
  const ema8   = calcEMASeries(closes, 8);
  const ema21  = calcEMASeries(closes, 21);
  const rsi3   = calcRSI3Series(closes);
  const vwap   = calcVWAPSeries(candles4h);
  const maxBars = 48; // 48 × 4H = 8 days (mega-backtest winner)
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
    // Buy the dip: price at/below VWAP + uptrend (EMA8 > EMA21) + RSI oversold
    if (p <= vwap[i] * 1.01 && ema8[i] > ema21[i] && rv < rsiThreshold) {
      inTrade = true; entry = candles4h[i + 1].open; bar = i + 1;
    }
  }
  return trades;
}

function optimiseSwingCoin(candles4h) {
  let best = null;
  for (const rsi of [25, 30, 35, 40, 45]) { // mega-backtest winner: 40
    for (const tp of [0.08, 0.10, 0.12, 0.15, 0.20]) { // mega-backtest winner: 10%
      for (const sl of [0.04, 0.05, 0.06]) { // mega-backtest winner: 5%
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
      parseFloat(t.usdtVolume) > 20_000_000 &&  // $20M+ — new coins below this gap through stops
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
    // Never trade exchange tokens, stablecoins, or leveraged tokens
    const NEVER_TRADE = new Set(["BGBUSDT","BSVUSDT","WBTCUSDT","STETHUSDT","CBETHUSDT","BETHUSDT"]);
    const allCoins = (json.data || []).filter(t =>
      t.symbol.endsWith("USDT") &&
      !NEVER_TRADE.has(t.symbol) &&
      !_insufficientHistory.has(t.symbol) &&
      !/UP|DOWN|BEAR|BULL|USDC|TUSD|BUSD|DAI|USD1|FDUSD|RLUSD|PAXG|XAUT/.test(t.symbol) &&
      parseFloat(t.lastPr) >= 0.001 &&
      parseFloat(t.usdtVolume) > 5_000_000   // $5M+ volume — filters illiquid coins that gap through stops
    );

    // Cache top 20 gainers for dashboard + momentum path
    _topGainers = allCoins
      .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPr), change24h: parseFloat(t.change24h) * 100, vol: parseFloat(t.usdtVolume) }))
      .filter(t => t.change24h > 0 && t.vol >= 10_000_000)  // $10M+ for momentum path only
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 20);

    // Score: volume rank + 24h move magnitude + sweet-spot bonus for 2–10% movers
    const totalVol = allCoins.reduce((s, t) => s + parseFloat(t.usdtVolume), 0);
    const scored = allCoins.map(t => {
      const vol = parseFloat(t.usdtVolume);
      const chg = parseFloat(t.change24h) * 100; // in percent
      const absChg = Math.abs(chg);
      const volScore = vol / totalVol * 100;
      const baseChgScore = Math.min(absChg, 30); // cap at 30 so mega-pumps don't dominate
      // Sweet-spot bonus: coins up 2–12% are ideal — enough momentum, not extended yet
      const sweetSpot = absChg >= 2 && absChg <= 12 && chg > 0;
      const chgScore = sweetSpot ? baseChgScore * 1.4 : baseChgScore;
      return { symbol: t.symbol, score: volScore * 0.35 + chgScore * 0.65, vol, chg };
    }).sort((a, b) => b.score - a.score);

    // Top 100 candidates — wider net finds more coins that pass the 70% backtest gate
    const candidates = scored.slice(0, 100).map(t => t.symbol);
    console.log(`\n🌐 Full market scan — ${allCoins.length} liquid coins → top ${candidates.length} candidates (sweet-spot scoring)`);

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

    // Add top daily gainers (1.5%+) directly — they get the momentum path in run(), skip backtest gate
    const bigMovers = _topGainers.filter(t => t.change24h >= 1.5).map(t => t.symbol);
    if (bigMovers.length > 0) console.log(`\n🚀 Big movers today (3%+): ${bigMovers.join(", ")}`);

    const combined = [...new Set([...qualified, ...heldSymbols, ...WATCHLIST, ...newListings, ...bigMovers])]
      .filter(s => !_insufficientHistory.has(s));

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

// ─── Strategy scorer — picks scalp vs swing based on multi-TF alignment ─────
// Swing targets 8% over 1-5 days; scalp targets 1% over 1-6h.
// When multiple timeframes align bullishly AND the coin is genuinely oversold
// on the 4H, swing almost always returns more than scalp.
function scoreSwingSetup(closes4h, closesDay, closesWeek, bullTrend4h, rsi14_1h, adx, vol) {
  let score = 0;
  const reasons = [];

  // 4H trend (EMA8 > EMA21) — base requirement for any swing
  if (bullTrend4h) { score++; reasons.push("4H uptrend"); }

  // 4H RSI(14) — is the medium-term trend actually pulling back to a buyable level?
  const rsi14_4h = closes4h.length > 20 ? calcRSI(closes4h, 14) : null;
  if (rsi14_4h !== null && rsi14_4h < 40)      { score += 2; reasons.push(`4H RSI(14)=${rsi14_4h.toFixed(0)} deeply OS`); }
  else if (rsi14_4h !== null && rsi14_4h < 50)  { score++;   reasons.push(`4H RSI(14)=${rsi14_4h.toFixed(0)} pulling back`); }

  // 1H RSI(14) also oversold — TF alignment confirms the dip is real
  if (rsi14_1h !== null && rsi14_1h < 45) { score++; reasons.push(`1H RSI(14)=${rsi14_1h.toFixed(0)} OS`); }

  // Daily trend — the bigger trend is up (not fighting a daily downtrend)
  if (closesDay.length >= 30) {
    const dEma8  = calcEMA(closesDay, 8);
    const dEma21 = calcEMA(closesDay, 21);
    const dRsi14 = calcRSI(closesDay, 14);
    if (dEma8 > dEma21)                                    { score++; reasons.push("Daily uptrend"); }
    if (dRsi14 !== null && dRsi14 > 30 && dRsi14 < 60)    { score++; reasons.push(`Daily RSI=${dRsi14.toFixed(0)} — room`); }
  }

  // Weekly bullish — macro not fighting the trade
  if (closesWeek.length >= 20) {
    const wEma8  = calcEMA(closesWeek, 8);
    const wEma21 = calcEMA(closesWeek, 21);
    if (wEma8 > wEma21) { score++; reasons.push("Weekly bull"); }
  }

  // ADX > 20 on 4H — directional trend, not chop
  if (adx && adx.adx > 20) { score++; reasons.push(`ADX=${adx.adx.toFixed(0)}`); }

  return { score, reasons, maxScore: 9 };
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

// ─── Fear & Greed Index ──────────────────────────────────────────────────────
// Free API from alternative.me — composite sentiment gauge (0=Extreme Fear, 100=Extreme Greed)
// Components: Volatility 25%, Momentum/Volume 25%, Social 15%, BTC Dominance 10%, Google Trends 10%, Surveys 15%
// Edge: F&G <20 → 90-day median +48.5% return; F&G >80 → reduces position size (Nov 2021 = 84 → 65% crash)
const _fearGreedCache = { value: null, ts: 0 };
async function fetchFearGreed() {
  if (_fearGreedCache.value && Date.now() - _fearGreedCache.ts < 60 * 60 * 1000) return _fearGreedCache.value;
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.data?.[0];
    if (!d) return null;
    const value = parseInt(d.value);
    const label = d.value_classification;
    _fearGreedCache.value = { value, label };
    _fearGreedCache.ts = Date.now();
    return _fearGreedCache.value;
  } catch { return null; }
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
  addPos(log.sniperPositions,   0.08, "sniper"); // SNIPER.stopLossPct — constant can't cross block scope
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
  const vol3 = candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
  // Guard against zero-avg coins (new listings / missing data) — NaN would bypass the vol3Ratio gate
  const safeAvg = avg > 0 ? avg : 1;
  return { current, avg, aboveAvg: current > avg, vol3, vol3Ratio: vol3 / safeAvg };
}

// Supertrend — ATR-based trend direction (period 10, multiplier 2.0 per crypto backtests)
// Documented 58-62% win rate standalone; 65-70% combined with RSI
function calcSupertrend(candles, period = 10, multiplier = 2.0) {
  if (candles.length < period + 5) return null;
  let direction = 1;
  let prevSupertrend = null;
  for (let i = period; i < candles.length; i++) {
    const atr = calcATR(candles.slice(i - period, i + 1));
    if (!atr) continue;
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    const upper = hl2 + multiplier * atr;
    const lower = hl2 - multiplier * atr;
    let st;
    if (prevSupertrend === null) {
      st = c.close > lower ? lower : upper;
      direction = c.close > lower ? 1 : -1;
    } else if (direction === 1) {
      st = Math.max(lower, prevSupertrend);
      if (c.close < st) { direction = -1; st = upper; }
    } else {
      st = Math.min(upper, prevSupertrend);
      if (c.close > st) { direction = 1; st = lower; }
    }
    prevSupertrend = st;
  }
  return { bullish: direction === 1, level: prevSupertrend };
}

// Fair Value Gap — unfilled imbalance between c1's high and c3's low after a large bullish impulse
// FVGs fill ~70% of the time; price entering a bullish FVG = high-probability long
function detectFVG(candles) {
  const n = candles.length;
  if (n < 3) return null;
  for (let i = n - 3; i >= Math.max(0, n - 10); i--) {
    const [c1, c2, c3] = [candles[i], candles[i + 1], candles[i + 2]];
    if (!c1 || !c2 || !c3) continue;
    if (c3.low > c1.high && c2.close > c2.open) {
      const price = candles[n - 1].close;
      const inFVG = price >= c1.high && price <= c3.low;
      return { bullish: true, fvgLow: c1.high, fvgHigh: c3.low, inFVG, age: n - 1 - (i + 1) };
    }
  }
  return null;
}

// Z-score — standard deviations from 20-bar mean; Z < -2 = statistically oversold
// ±2 sigma is the classic mean-reversion entry threshold with ~65% reversion rate
function calcZScore(candles, period = 20) {
  if (candles.length < period) return null;
  const prices = candles.slice(-period).map(c => c.close);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const stdDev = Math.sqrt(prices.reduce((s, c) => s + (c - mean) ** 2, 0) / prices.length);
  if (stdDev === 0) return null;
  return (candles[candles.length - 1].close - mean) / stdDev;
}

// Volume Profile — Full (POC + Value Area High/Low)
// POC = Point of Control: price bin with highest traded volume — 60-75% magnet rate
// VAH/VAL = Value Area: where 70% of volume traded. VAL = institutional support, VAH = resistance.
function calcVolumeProfileFull(candles, bins = 40) {
  if (candles.length < 10) return null;
  const prices = candles.flatMap(c => [c.high, c.low]);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  if (maxP === minP) return null;
  const binSize = (maxP - minP) / bins;
  const volByBin = new Array(bins).fill(0);
  for (const c of candles) {
    const bin = Math.min(Math.floor((c.close - minP) / binSize), bins - 1);
    volByBin[bin] += c.volume;
  }
  const totalVol  = volByBin.reduce((a, b) => a + b, 0);
  const pocBin    = volByBin.indexOf(Math.max(...volByBin));
  const poc       = minP + pocBin * binSize + binSize / 2;
  let vahBin = pocBin, valBin = pocBin, areaVol = volByBin[pocBin];
  const target = totalVol * 0.70;
  while (areaVol < target) {
    const upVol   = vahBin + 1 < bins ? volByBin[vahBin + 1] : 0;
    const downVol = valBin - 1 >= 0  ? volByBin[valBin - 1] : 0;
    if (upVol >= downVol && vahBin + 1 < bins) { vahBin++; areaVol += upVol; }
    else if (valBin - 1 >= 0)                   { valBin--; areaVol += downVol; }
    else break;
  }
  const vah = minP + vahBin * binSize + binSize / 2;
  const val = minP + valBin * binSize + binSize / 2;
  const p   = candles[candles.length - 1].close;
  return {
    poc, vah, val,
    distToPOC:   Math.abs((p - poc) / poc * 100),
    atPOC:       Math.abs((p - poc) / poc * 100) < 0.5,
    aboveVAH:    p > vah,
    belowVAL:    p < val,
    inValueArea: p >= val && p <= vah,
    atVAH:       Math.abs((p - vah) / vah * 100) < 0.5,
    atVAL:       Math.abs((p - val) / val * 100) < 0.5,
  };
}
// Keep alias so any existing callers still work
const calcVolumeProfilePOC = calcVolumeProfileFull;

// ─── Bearish RSI Divergence ───────────────────────────────────────────────────
// Price making higher highs, RSI making lower highs = momentum exhausting.
// Entry filter: don't buy into a rally where momentum is fading (60-65% reversal prob).
function detectBearishDivergence(candles) {
  if (candles.length < 15) return false;
  const recent = candles.slice(-20);
  const highs  = recent.map(c => c.high);
  const closes = recent.map(c => c.close);
  const peaks  = [];
  for (let i = 1; i < recent.length - 1; i++) {
    if (highs[i] >= highs[i - 1] && highs[i] >= highs[i + 1]) peaks.push(i);
  }
  if (peaks.length < 2) return false;
  const p1 = peaks[peaks.length - 2], p2 = peaks[peaks.length - 1];
  if (highs[p2] <= highs[p1] * 1.003) return false; // need clear higher high in price
  const rsi1 = calcRSI(closes.slice(0, p1 + 1), 3);
  const rsi2 = calcRSI(closes.slice(0, p2 + 1), 3);
  return rsi1 !== null && rsi2 !== null && rsi2 < rsi1 * 0.97; // RSI clearly lower = divergence
}

// ─── Order Block (Smart Money Concept / ICT) ─────────────────────────────────
// Large bearish institutional candle → followed by a significant rally → becomes a bullish OB.
// When price returns to this zone, institutions reload positions → 65-70% bounce probability.
function detectOrderBlock(candles, lookback = 25) {
  const n = candles.length;
  if (n < lookback + 3) return null;
  const window  = candles.slice(-lookback);
  const avgBody = window.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / window.length;
  const price   = candles[n - 1].close;
  for (let i = window.length - 4; i >= 2; i--) {
    const c    = window[i];
    const body = c.open - c.close; // bearish: open > close, so body is positive
    if (body > avgBody * 1.5 && c.close < c.open) {
      const obHigh = c.open, obLow = c.close;
      const subsequentHigh = Math.max(...window.slice(i + 1).map(c => c.high));
      if (subsequentHigh > obHigh * 1.01) { // confirmed by at least 1% move above OB
        const inOB    = price >= obLow * 0.99 && price <= obHigh * 1.005;
        const distToOB = price < obLow ? (obLow - price) / obLow * 100 :
                         price > obHigh ? (price - obHigh) / obHigh * 100 : 0;
        return { obHigh, obLow, inOB, distToOB, age: window.length - 1 - i };
      }
    }
  }
  return null;
}

// ─── Market Structure (BOS / ChoCH) ─────────────────────────────────────────
// Tracks Higher Highs / Higher Lows for trend identification.
// Break of Structure (BOS) = new HH = trend continuation signal (+2 score).
// Change of Character (ChoCH) = lower high after uptrend = early reversal warning (-1).
function analyzeMarketStructure(candles, lookback = 30) {
  if (candles.length < lookback) return null;
  const window     = candles.slice(-lookback);
  const swingHighs = [], swingLows = [];
  for (let i = 1; i < window.length - 1; i++) {
    if (window[i].high > window[i - 1].high && window[i].high > window[i + 1].high)
      swingHighs.push({ idx: i, price: window[i].high });
    if (window[i].low < window[i - 1].low && window[i].low < window[i + 1].low)
      swingLows.push({ idx: i, price: window[i].low });
  }
  if (swingHighs.length < 2 || swingLows.length < 2) return { trend: "unclear" };
  const lastHigh = swingHighs[swingHighs.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const lastLow  = swingLows[swingLows.length - 1];
  const prevLow  = swingLows[swingLows.length - 2];
  const price    = candles[candles.length - 1].close;
  const higherHigh = lastHigh.price > prevHigh.price * 1.002;
  const higherLow  = lastLow.price  > prevLow.price  * 1.002;
  const lowerHigh  = lastHigh.price < prevHigh.price * 0.998;
  const lowerLow   = lastLow.price  < prevLow.price  * 0.998;
  const bos   = higherHigh && price > lastHigh.price * 0.999; // bullish BOS = price breaking above last swing high
  const choch = lowerHigh && higherLow; // was rising, now LH = potential trend flip
  const trend = (higherHigh && higherLow) ? "uptrend" :
                (lowerHigh  && lowerLow)  ? "downtrend" : "ranging";
  return { trend, bos, choch, higherHigh, higherLow, lowerHigh, lowerLow };
}

// ─── ICT Kill Zones ───────────────────────────────────────────────────────────
// Institutions operate on schedules. 70%+ of major crypto moves initiate in 3 windows.
// London Open (07-09 UTC), NY Open (13-15 UTC), NY Close (20-21 UTC).
// Dead zone (03-07 UTC, 21+ UTC): thin liquidity, high fakeout rate → reduce position.
function getKillZone() {
  const t = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  if (t >= 7  && t <= 9)  return { zone: "London Open", score:  2 };
  if (t >= 13 && t <= 15) return { zone: "NY Open",     score:  2 };
  if (t >= 20 && t <= 21) return { zone: "NY Close",    score:  1 };
  if (t >= 0  && t <= 3)  return { zone: "Asia",        score:  0 };
  return { zone: "Dead Zone", score: -1 }; // 03-07 and 21-24 UTC — institutional desks closed
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules, rsiThreshold = 30, vol = null, ema21 = null, bullTrend4h = null, adx = null, stochRsi = null, divergence = false, bb = null, vwapBounce = false) {
  const results = [];
  let entryScore = 0;

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    if (LOG_VERBOSE) {
      const icon = pass ? "✅" : "🚫";
      console.log(`  ${icon} ${label}`);
      console.log(`     Required: ${required} | Actual: ${actual}`);
    }
  };

  if (LOG_VERBOSE) console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
  const atVwap = distFromVWAP < 0.5; // within 0.5% = essentially at VWAP
  const bullishBias = (price > vwap || atVwap) && price > ema8;
  const bearishBias = price < vwap && !atVwap && price < ema8;

  if (bullishBias) {
    if (LOG_VERBOSE) console.log("  Bias: BULLISH — checking long entry conditions\n");

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
      if (LOG_VERBOSE) console.log(`  ℹ️  Trend context (not a hard gate): ${bullTrend4h ? "✅ bullish" : "⚠️  bearish — Claude must be 90%+ confident"}`);
    }

    // 7. Volume — hard gate: don't enter when volume is below average (no crowd participation)
    if (vol && !vwapBounce) {
      const volRatio = (vol.current / vol.avg).toFixed(1);
      if (!vol.aboveAvg) {
        check(`Volume above average (${volRatio}x avg) — need crowd participation`, "> 1.0x avg", `${volRatio}x avg`, false);
      } else {
        console.log(`  ✅ Volume above avg (${volRatio}x avg)`);
      }
    }

    // 8. ADX — hard gate: block entries when market has no trend at all (pure chop)
    if (adx !== null && !vwapBounce) {
      if (adx.adx < 15) {
        check(`ADX > 15 (some directional movement)`, "> 15", adx.adx.toFixed(1), false);
      } else {
        console.log(`  ✅ ADX ${adx.adx.toFixed(1)} (${adx.trending ? "trending" : "weak trend — ok"})`);
      }
    }

    // 9. StochRSI — v2 confirmation signal
    if (stochRsi !== null) {
      if (LOG_VERBOSE) console.log(`  ℹ️  StochRSI K=${stochRsi.k.toFixed(1)}: ${stochRsi.oversold ? "✅ oversold (<20)" : stochRsi.overbought ? "⚠️ overbought (>88)" : "neutral"}`);
    }

    // 10. Bullish divergence
    if (divergence) {
      if (LOG_VERBOSE) console.log(`  ✅ Bullish divergence detected — price lower low, RSI higher low`);
    }

    // 11. BB position — block entries above midpoint (backtest: BB% < 35% best, < 70% acceptable)
    if (bb !== null) {
      if (bb.pct > 0.70 && !vwapBounce) {
        check(`BB% below 70% (not overextended in BB range)`, "< 70%", `${(bb.pct * 100).toFixed(0)}%`, false);
      } else {
        if (LOG_VERBOSE) console.log(`  ℹ️  BB%: ${(bb.pct*100).toFixed(0)}% (${bb.pct < 0.20 ? "✅ near lower band" : bb.pct < 0.35 ? "✅ low — strong signal" : bb.pct > 0.70 ? "⚠️ upper range" : "mid-range"})`);
      }
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
    if (LOG_VERBOSE) console.log(`  ℹ️  v2 Entry Score: ${score}/3+ needed — [${scoreSignals.join(", ") || "none"}]`);
  } else if (bearishBias && rsi3 !== null && rsi3 < 25) {
    // Oversold in downtrend — snap-back long entry
    if (LOG_VERBOSE) console.log(`  Bias: BEARISH but RSI(3)=${rsi3.toFixed(1)} — oversold snap-back, treating as long entry\n`);
    check("RSI(3) oversold (< 25) — snap-back in downtrend", "< 25", rsi3.toFixed(2), true);
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", distFromVWAP.toFixed(2) + "%", distFromVWAP < 1.5);
    // Counter-trend entries need confirmation — calculate quality score
    const sbSignals = [];
    if (rsi3 < 15) { entryScore += 2; sbSignals.push("RSI extreme"); }
    else if (rsi3 < 20) { entryScore += 1; sbSignals.push("RSI very low"); }
    if (stochRsi?.oversold) { entryScore += 2; sbSignals.push("StochRSI oversold"); }
    if (bb && bb.pct < 0.25) { entryScore += 2; sbSignals.push("BB% near low"); }
    if (divergence) { entryScore += 3; sbSignals.push("divergence!"); }
    if (LOG_VERBOSE) console.log(`  ℹ️  Snapback quality score: ${entryScore}/2+ needed — [${sbSignals.join(", ") || "none"}]`);
  } else if (bearishBias) {
    if (LOG_VERBOSE) console.log("  Bias: BEARISH — checking short entry conditions\n");

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
      if (LOG_VERBOSE) console.log(`  Bias: NEUTRAL but RSI(3)=${rsi3.toFixed(1)} oversold (< ${rsiThreshold}) — snap-back entry\n`);
      check(`RSI(3) oversold (< ${rsiThreshold}) in neutral market`, `< ${rsiThreshold}`, rsi3.toFixed(2), true);
    } else {
      if (LOG_VERBOSE) console.log(`  Bias: NEUTRAL — RSI(3)=${rsi3?.toFixed(1)} not low enough (need < ${rsiThreshold}). No trade.\n`);
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
  const minsOpen = position.entryTime ? (Date.now() - new Date(position.entryTime).getTime()) / 60000 : 999;

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
  // Stepped profit lock — wide trail so winners can run to 50%+, tighten only near the top
  const trailPct =
    pnlPct >= 20 ? Math.min(baseTrailPct, 0.06) :  // +20%+: 6% trail — protect monster gains
    pnlPct >= 10 ? Math.min(baseTrailPct, 0.08) :  // +10%:  8% trail — big swing breathing room
    pnlPct >= 5  ? Math.min(baseTrailPct, 0.10) :  // +5%:   10% trail — give the move room
    pnlPct >= 2.5? Math.min(baseTrailPct, 0.015):  // +2.5%: 1.5% — near break-even
    pnlPct >= 1.5? Math.min(baseTrailPct, 0.025):  // +1.5%: 2.5% trail
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

    // 25% take profit — let momentum coins run; ATR trail and RSI/volume exits handle early reversals
    check(`Momentum TP hit — +25%`, pnlPct >= 25);

    // RSI dropped below 35 AND held 30+ min — momentum truly dead. 20 min was too short; coins
    // frequently dip below 40 briefly then recover within the same 30-min candle.
    check(`RSI(3) below 35 — momentum faded`, minsOpen > 30 && rsi3 < 35);

    // Volume dried up — require 30+ min hold AND severe collapse AND price below VWAP
    // One quiet candle right after entry is normal; need sustained evidence the pump is over
    if (candles) {
      const vol = calcVolume(candles);
      // Only cut on volume dry-up if losing — green trades hold for the StochRSI target
      check(`Volume dried up (< 40% of avg, 30min+, below VWAP, losing)`, minsOpen > 30 && vol.current < vol.avg * 0.4 && price < vwap && pnlPct < 0);
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
      // Failed bounce — 20 min minimum so normal entry volatility doesn't trigger this.
      // The first 20 min of a trade often dips before recovering — cutting at minute 5 is noise, not signal.
      if (minsOpen > 20 && pnlPct < -1.5 && macd && !macd.bullish) {
        check(`Failed bounce — down ${pnlPct.toFixed(2)}% with bearish MACD (cut loss early)`, true);
      }
      // Trend reversed — 20 min minimum for the same reason. VWAP can breach briefly on entry noise.
      const vwapBreachPct = (vwap - price) / vwap * 100;
      const macdBearish = !macd ? vwapBreachPct > 0.5 : macd.histogram < 0;
      check(`Trend reversed — ${vwapBreachPct.toFixed(2)}% below VWAP${macd && macdBearish ? " with bearish MACD" : ""}`, minsOpen > 20 && price < vwap && macdBearish && vwapBreachPct > 1.5 && pnlPct < -0.5);
    }
    check(`ATR stop hit — $${effectiveStop.toFixed(2)} (${breakEvenActive ? "break-even floor" : `${(trailPct*100).toFixed(1)}% trail`})`, price < effectiveStop);

    // Max hold time — winners get 10h to run, losers cut at 6h, deeply underwater cut at 2h
    if (position.entryTime) {
      const hoursOpen = (Date.now() - new Date(position.entryTime).getTime()) / (1000 * 60 * 60);
      const maxHold = pnlPct > 0 ? 10.0 : 6.0; // let profitable positions breathe longer
      if (hoursOpen > maxHold) {
        check(`Max hold exceeded — open ${hoursOpen.toFixed(1)}h (limit ${maxHold}h)`, true);
      } else if (hoursOpen > 2.0 && pnlPct < -2.0) {
        check(`Stale trade — ${hoursOpen.toFixed(1)}h, down ${pnlPct.toFixed(2)}% (cutting loss)`, true);
      }
    }
  }

  // Fee gate — require meaningful profit before soft exits fire.
  // Fees are 0.2% round-trip; add 0.5% buffer so every exit has real P&L after costs.
  // Hard stops (stop-loss, ATR trail, max hold) always fire regardless.
  const FEE_MIN_PCT = parseFloat((getFeePct() * 2 * 100 + 0.50).toFixed(2));
  if (pnlPct > 0 && pnlPct < FEE_MIN_PCT) {
    const HARD_STOPS = ["Stop-loss", "ATR stop", "Emergency", "Max hold", "Stale trade", "Failed bounce", "Momentum stop"];
    const hardOnly = reasons.filter(r => HARD_STOPS.some(kw => r.startsWith(kw)));
    if (hardOnly.length < reasons.length) {
      if (LOG_VERBOSE) console.log(`  ℹ️  Fee gate — holding at +${pnlPct.toFixed(2)}% (need +${FEE_MIN_PCT}% to cover fees)`);
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
- Max position ~$40 USD (20% Kelly) | Max 40 trades/day | Portfolio ~$190 USD

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
    max_tokens: 400,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = response.content[0].text.trim();
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  // Robust JSON extraction — find the outermost { } block in case of extra text
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Claude returned non-JSON: ${text.slice(0, 80)}`);
  }
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

async function getSpotBalanceTotal(coin) {
  const timestamp = Date.now().toString();
  const path = "/api/v2/spot/account/assets";
  const sign = signBitGet(timestamp, "GET", path);
  const res = await fetch(`${acct().baseUrl}${path}`, {
    headers: {
      "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": sign,
      "ACCESS-TIMESTAMP": timestamp, "ACCESS-PASSPHRASE": acct().passphrase,
      "locale": "en-US",
    },
  });
  const data = await res.json();
  const asset = data.data?.find(a => a.coin === coin);
  return parseFloat(asset?.available ?? "0") + parseFloat(asset?.frozen ?? "0");
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
    const ts = Date.now().toString();
    const path = "/api/v2/spot/account/assets";
    const sign = signBitGet(ts, "GET", path);
    const res = await fetch(`${acct().baseUrl}${path}`, {
      headers: { "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": sign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US" },
    });
    const data = await res.json();
    if (!data.data) throw new Error("No asset data");

    const priceRes = await fetch("https://api.bitget.com/api/v2/spot/market/tickers");
    const prices = Object.fromEntries(((await priceRes.json()).data || []).map(t => [t.symbol, parseFloat(t.lastPr)]));

    const SKIP = ["USDT", "BGB", "USDC"];
    let total = 0;
    for (const asset of data.data) {
      const qty = parseFloat(asset.available) + parseFloat(asset.frozen || 0);
      if (qty <= 0) continue;
      if (asset.coin === "USDT") { total += qty; continue; }
      if (SKIP.includes(asset.coin)) continue;
      const price = prices[asset.coin + "USDT"] ?? 0;
      total += qty * price;
    }

    if (total > 0) {
      log.portfolioValue = total;
      console.log(`🔄 Portfolio synced: $${total.toFixed(2)} total (USDT + held coins)`);
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
    let found = 0, pruned = 0;

    // Build a lookup of actual Bitget balances by symbol for pruning below
    const bitgetBalances = {};
    for (const asset of data.data) {
      const qty = parseFloat(asset.available) + parseFloat(asset.frozen || 0);
      if (asset.coin === "USDT" || qty < 0.0001) continue;
      const symbol = asset.coin + "USDT";
      const price = prices[symbol];
      if (!price) continue;
      bitgetBalances[symbol] = qty * price;
    }

    // Prune ghost positions across all stores — log says open but Bitget balance is dust (already stopped/sold)
    for (const store of ["positions", "swingPositions", "breakoutPositions", "sniperPositions"]) {
      if (!log[store]) continue;
      for (const [symbol, pos] of Object.entries(log[store])) {
        if (!pos?.open) continue;
        const actualUSD = bitgetBalances[symbol] ?? 0;
        if (actualUSD < 2.0) {
          delete log[store][symbol];
          if (!log.coinCooldowns) log.coinCooldowns = {};
          if (!log.coinCooldowns[symbol]) log.coinCooldowns[symbol] = {};
          log.coinCooldowns[symbol].scalp = { until: Date.now() + 2 * 60 * 60 * 1000, pnlPct: "ghost" };
          console.log(`🗑️  Ghost prune [${store}] — ${symbol} shows open but Bitget balance $${actualUSD.toFixed(4)} — removing`);
          pruned++;
        }
      }
    }

    for (const asset of data.data) {
      const qty = parseFloat(asset.available) + parseFloat(asset.frozen || 0);
      if (asset.coin === "USDT" || qty < 0.0001) continue;
      const symbol = asset.coin + "USDT";
      const price = prices[symbol];
      if (!price) continue;
      const usdValue = qty * price;
      if (usdValue < 5) continue; // skip dust < $5

      // Skip coins recently sold by the bot — reconciliation would re-add dust as a position
      const recentlySold = (log.trades || []).slice(-50).some(t =>
        t.type === "exit" && t.symbol === symbol && t.orderPlaced &&
        Date.now() - new Date(t.timestamp).getTime() < 4 * 60 * 60 * 1000
      );
      if (recentlySold) continue;

      if (!log.positions[symbol]?.open) {
        // Use original entry price from trade history if available — avoids wrong P&L and stop-loss on reconciled positions
        const originalEntry = (log.trades || []).filter(t => t.type === "entry" && t.symbol === symbol && t.orderPlaced).slice(-1)[0];
        const entryPrice = originalEntry?.price ?? price;
        const entryTime  = originalEntry?.timestamp ?? new Date().toISOString();
        console.log(`🔄 Reconcile: ${qty.toFixed(6)} ${asset.coin} ($${usdValue.toFixed(2)}) not in log — tracking @ $${entryPrice.toFixed(4)} entry${originalEntry ? " (from history)" : " (current price — no history)"}`);
        log.positions[symbol] = {
          open: true, side: "long",
          entryPrice,
          highWatermark: Math.max(price, entryPrice),
          entryTime,
          quantity: qty.toFixed(6),
          orderId: "reconciled",
          entryType: "reconciled",
          slPct: 0.04, tpPct: 0.08,
        };
        found++;
      }
    }
    if (found > 0 || pruned > 0) { saveLog(log); console.log(`🔄 Reconciled ${found} position(s) from BitGet | Pruned ${pruned} ghost(s)`); }
    else console.log(`🔄 Position reconciliation: log matches BitGet balances`);
  } catch (err) {
    console.log(`⚠️ Position reconciliation failed: ${err.message}`);
  }
}

// ─── Long-Term Portfolio ──────────────────────────────────────────────────────
// Buy a diversified basket of altcoins and hold until the profit target is hit.
// Runs on startup and every 6 hours. One new coin purchased per run to avoid
// dumping all capital at once. Scalp/swing bot skips coins held here.
// Shared helper — builds the ladder object attached to every new LT position
function makeLtLadder(price, qty, orderId) {
  return {
    entry: [
      { n: 1, sizePct: 50, filled: true,  price, qty: String(qty), orderId },
      { n: 2, sizePct: 50, filled: false, triggerDropPct: 8 },  // buy T2 if price dips 8%
    ],
    exit: [
      { n: 1, holdPct: 25, targetPct: 30,  sold: false },         // take 25% at +30%
      { n: 2, holdPct: 25, targetPct: 60,  sold: false },         // take 25% at +60%
      { n: 3, holdPct: 25, targetPct: 100, sold: false },         // take 25% at +100%
      { n: 4, holdPct: 25, trailing: true, trailActivatePct: 100, trailPct: 10, peak: null, sold: false },
    ],
  };
}

async function ltWebhookBuy(sym, source) {
  if (!LT_ENABLED || CONFIG.paperTrading) return;
  const log = loadLog();
  if (!log.ltPositions) log.ltPositions = {};

  if (log.ltPositions[sym]?.open) {
    console.log(`  💎 LT already holding ${sym} — ignoring BUY signal`); return;
  }
  if ((log.positions || {})[sym]?.open || (log.swingPositions || {})[sym]?.open) {
    console.log(`  💎 LT skip ${sym} — already in scalp/swing position`); return;
  }

  let usdtBalance = 0;
  try { usdtBalance = await getBalance("USDT"); } catch (e) {
    console.log(`⚠️ LT webhook: balance fetch failed — ${e.message}`); return;
  }
  const t1Size = LT_TRADE_SIZE * 0.5;
  if (usdtBalance - LT_RESERVE < t1Size) {
    console.log(`  ⚠️ LT webhook: USDT too low ($${usdtBalance.toFixed(2)}) — skipping ${sym}`); return;
  }

  let price = 0;
  try {
    const res  = await fetch(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}`);
    const data = await res.json();
    price = parseFloat(data.data?.[0]?.lastPr ?? 0);
  } catch (e) { console.log(`⚠️ LT webhook: price fetch failed ${sym} — ${e.message}`); return; }
  if (!price) { console.log(`⚠️ LT webhook: no price for ${sym}`); return; }

  try {
    console.log(`  💎 LT WEBHOOK BUY T1 — ${sym} $${t1Size} @ $${price.toFixed(6)} [${source}]`);
    const order = await placeOrder(sym, "buy", t1Size, price);
    const qty   = order.confirmedQty ?? (t1Size / price);
    const freshLog = loadLog();
    if (!freshLog.ltPositions) freshLog.ltPositions = {};
    freshLog.ltPositions[sym] = {
      open: true, symbol: sym, avgEntryPrice: price,
      quantity: String(qty), remainingQty: String(qty),
      entryTime: new Date().toISOString(), targetPct: LT_TARGET_PCT,
      tradeType: "longterm", source,
      ladder: makeLtLadder(price, qty, order.orderId),
    };
    writeTradeCsv({ timestamp: new Date().toISOString(), type: "entry", symbol: sym, price, tradeSize: t1Size, orderPlaced: true, tradeType: "longterm", orderId: order.orderId, notes: `LT signal T1 [${source}] — ladder exits: +30/60/100/trail` });
    saveLog(freshLog);
    console.log(`  ✅ LT BOUGHT T1 — ${sym} qty:${qty} | T2 triggers at $${(price * 0.92).toFixed(6)} (-8%)`);
    sendEmail(`💎 LT BUY — ${sym.replace("USDT","")} T1 @ $${price.toFixed(6)}`,
      `<h2>💎 Long-Term Buy — Tranche 1 of 2</h2><table style="font-size:16px;line-height:1.8">
       <tr><td><b>Symbol</b></td><td>${sym}</td></tr>
       <tr><td><b>Price</b></td><td>$${price.toFixed(6)}</td></tr>
       <tr><td><b>Size</b></td><td>$${t1Size} (T1) — T2 buys if price drops 8%</td></tr>
       <tr><td><b>Signal</b></td><td>${source}</td></tr>
       <tr><td><b>Exit ladder</b></td><td>25% @ +30% | 25% @ +60% | 25% @ +100% | 25% trailing</td></tr></table>`);
  } catch (e) { console.log(`  ❌ LT webhook buy failed ${sym}: ${e.message}`); }
}

async function ltWebhookSell(sym, source) {
  if (!LT_ENABLED || CONFIG.paperTrading) return;
  const log = loadLog();
  const pos = log.ltPositions?.[sym];
  if (!pos?.open) {
    console.log(`  💎 LT not holding ${sym} — ignoring SELL signal`); return;
  }

  let price = 0;
  try {
    const res  = await fetch(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}`);
    const data = await res.json();
    price = parseFloat(data.data?.[0]?.lastPr ?? 0);
  } catch (e) { console.log(`⚠️ LT webhook: price fetch failed ${sym} — ${e.message}`); return; }
  if (!price) return;

  const pnlPct = (price - pos.entryPrice) / pos.entryPrice * 100;
  try {
    console.log(`  💎 LT WEBHOOK SELL — ${sym} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% [${source}]`);
    await placeOrder(sym, "sell", null, price, pos.quantity);
    const pnlUSD = (price - pos.entryPrice) * parseFloat(pos.quantity);
    const freshLog = loadLog();
    if (freshLog.ltPositions?.[sym]) freshLog.ltPositions[sym] = { ...pos, open: false, exitPrice: price, exitTime: new Date().toISOString(), pnlPct, pnlUSD };
    writeTradeCsv({ timestamp: new Date().toISOString(), type: "exit", symbol: sym, price, pnlPct, pnlUSD, orderPlaced: true, tradeType: "longterm", notes: `LT signal sell [${source}]` });
    saveLog(freshLog);
    console.log(`  ✅ LT SOLD — ${sym} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(2)})`);
    sendEmail(`${pnlUSD >= 0 ? "💰" : "🔴"} LT SELL — ${sym.replace("USDT","")} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
      `<h2>${pnlUSD >= 0 ? "💰 LT Profit" : "🔴 LT Exit"}</h2><table style="font-size:16px;line-height:1.8">
       <tr><td><b>Symbol</b></td><td>${sym}</td></tr>
       <tr><td><b>P&L</b></td><td>${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)</td></tr>
       <tr><td><b>Signal</b></td><td>${source}</td></tr></table>`);
  } catch (e) { console.log(`  ❌ LT webhook sell failed ${sym}: ${e.message}`); }
}

// Runs 8 multi-timeframe indicator conditions on a coin — mirrors HODLFIRE/DETONATOR logic
// Weekly: macro trend structure | Daily: entry timing + volume
async function checkLtEntry(sym) {
  let weekly, daily;
  try {
    [weekly, daily] = await Promise.all([
      fetchCandles(sym, "1W", 52),
      fetchCandles(sym, "1D", 200),
    ]);
  } catch (e) {
    return { pass: false, sym, passed: 0, total: 8, reason: e.message };
  }

  if (!weekly || weekly.length < 15 || !daily || daily.length < 55) {
    return { pass: false, sym, passed: 0, total: 8, reason: "insufficient candle data" };
  }

  const wCloses = weekly.map(c => c.close);
  const dCloses = daily.map(c => c.close);
  const wPrice  = wCloses[wCloses.length - 1];
  const dPrice  = dCloses[dCloses.length - 1];

  // Dead coin filter: skip if price is below 30% of 52-week high (down 70%+, no recovery)
  const w52High = Math.max(...wCloses.slice(-52));
  if (wPrice < w52High * 0.30) {
    return { pass: false, sym, passed: 0, total: 11, reason: `dead coin — ${((wPrice/w52High)*100).toFixed(0)}% of 52W high` };
  }

  // Weekly indicators — macro picture
  const wEma10 = calcEMA(wCloses, 10);
  const wEma20 = calcEMA(wCloses, 20);
  const wRsi   = calcRSI(wCloses, 14);
  const wMacd  = calcMACD(wCloses);

  // Daily indicators — entry timing
  const dEma21 = calcEMA(dCloses, 21);
  const dEma50 = calcEMA(dCloses, 50);
  const dRsi   = calcRSI(dCloses, 14);
  const dMacd  = calcMACD(dCloses);
  const dVol   = calcVolume(daily);

  // HODLNATOR additions: Bollinger Bands, Ichimoku, golden cross (SMA50)
  const dBB     = calcBollingerBands(dCloses, 20, 2);
  const dIchi   = calcIchimoku(daily);
  const dSma50  = dCloses.slice(-50).reduce((a, b) => a + b, 0) / 50;

  // ── 11 Conditions ─────────────────────────────────────────────────────────
  // Weekly (macro): confirms we're in a bull structure — don't buy into freefall
  const c1 = wPrice > wEma10;                                    // price above 10W EMA (uptrend)
  const c2 = wEma10 > wEma20;                                    // EMA stack bullish (10W > 20W)
  const c3 = wRsi >= 40 && wRsi <= 75;                           // weekly RSI healthy, not overbought
  const c4 = wMacd.histogram > 0 || wMacd.macdLine > wMacd.signal * 0.97; // weekly MACD bullish/recovering

  // Daily (entry timing): buy the pullback, not the top
  const c5 = dRsi >= 30 && dRsi <= 65;                           // RSI pulled back — not extended
  const c6 = dPrice > dEma50 || dPrice > dEma21;                // above medium-term support
  const c7 = dMacd.histogram > 0;                               // daily momentum positive
  const c8 = dVol.vol3Ratio >= 0.65;                            // volume not dead

  // HODLNATOR (Bollinger Bands + Ichimoku + golden cross)
  const c9  = dEma21 > dSma50;                                   // golden cross — EMA21 above SMA50
  const c10 = dBB.pct <= 0.65;                                   // BB position — not at upper extension
  const c11 = dIchi ? (dIchi.aboveCloud || dIchi.bullishCross) : false; // Ichimoku bullish

  const checks = { c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11 };
  const labels = [
    `W price>EMA10 ${c1 ? "✓" : "✗"}`,
    `W EMA10>EMA20 ${c2 ? "✓" : "✗"}`,
    `W RSI ${wRsi.toFixed(0)} ${c3 ? "✓" : "✗"}`,
    `W MACD ${c4 ? "✓" : "✗"}`,
    `D RSI ${dRsi.toFixed(0)} ${c5 ? "✓" : "✗"}`,
    `D>EMA ${c6 ? "✓" : "✗"}`,
    `D MACD ${c7 ? "✓" : "✗"}`,
    `D vol ${(dVol.vol3Ratio * 100).toFixed(0)}% ${c8 ? "✓" : "✗"}`,
    `D golden cross ${c9 ? "✓" : "✗"}`,
    `D BB pos ${(dBB.pct * 100).toFixed(0)}% ${c10 ? "✓" : "✗"}`,
    `D Ichimoku ${c11 ? "✓" : "✗"}`,
  ];

  const passed = Object.values(checks).filter(Boolean).length;
  const total  = 11;

  // Hard gates: catch extreme overextension on either timeframe
  const hardPass  = wRsi < 80 && dRsi < 72;
  // Score gate: 7 of 11 conditions (~63%) — same ratio as original 5/8
  const scorePass = passed >= 6;
  const pass      = hardPass && scorePass;

  return { pass, sym, passed, total, checks, labels, wRsi, dRsi, dPrice, dEma50, wEma10 };
}

async function _runLtPortfolioLegacy() {
  if (!LT_ENABLED || CONFIG.paperTrading) return;
  console.log(`\n💎 ── Long-Term Portfolio ──────────────────────────────────`);

  // Fetch all prices in one call
  let prices = {};
  try {
    const res  = await fetch("https://api.bitget.com/api/v2/spot/market/tickers");
    const data = await res.json();
    prices = Object.fromEntries((data.data || []).map(t => [t.symbol, parseFloat(t.lastPr)]));
  } catch (e) {
    console.log(`⚠️ LT: price fetch failed — ${e.message}`); return;
  }

  const log = loadLog();
  if (!log.ltPositions) log.ltPositions = {};
  let changed = false;

  // ── Check exits on held positions ─────────────────────────────────────────
  for (const [sym, pos] of Object.entries(log.ltPositions)) {
    if (!pos?.open) continue;
    const price = prices[sym];
    if (!price) continue;
    const pnlPct  = (price - pos.entryPrice) / pos.entryPrice * 100;
    const holdDays = (Date.now() - new Date(pos.entryTime).getTime()) / 86400000;
    const qty     = parseFloat(pos.quantity);

    // Track peak PnL for trailing stop
    const peakPct = Math.max(pos.peakPct ?? 0, pnlPct);
    if (peakPct > (pos.peakPct ?? 0)) { pos.peakPct = peakPct; changed = true; }

    const halfTag = pos.halfSold ? " [half remaining]" : "";
    console.log(`  💎 ${sym.replace("USDT","").padEnd(8)} entry $${pos.entryPrice.toFixed(6)} | now $${price.toFixed(6)} | ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% | peak +${peakPct.toFixed(0)}% | ${holdDays.toFixed(0)}d${halfTag}`);

    const target = pos.targetPct ?? LT_TARGET_PCT;

    if (pnlPct >= target) {
      // Full exit — target hit
      console.log(`  🎯 TARGET HIT — selling ${sym} at +${pnlPct.toFixed(2)}%`);
      try {
        await placeOrder(sym, "sell", null, price, pos.quantity);
        const pnlUSD = (price - pos.entryPrice) * qty;
        log.ltPositions[sym] = { ...pos, open: false, exitPrice: price, exitTime: new Date().toISOString(), pnlPct, pnlUSD };
        log.portfolioValue = (log.portfolioValue || 0) + pnlUSD;
        writeTradeCsv({ timestamp: new Date().toISOString(), type: "exit", symbol: sym, price, pnlPct, pnlUSD, orderPlaced: true, tradeType: "longterm", notes: `LT target +${pnlPct.toFixed(1)}%` });
        changed = true;
        console.log(`  ✅ LT SOLD — ${sym} +${pnlPct.toFixed(2)}% ($+${pnlUSD.toFixed(2)})`);
      } catch (e) { console.log(`  ❌ LT sell failed ${sym}: ${e.message}`); }

    } else if (pnlPct >= 50 && !pos.halfSold) {
      // Partial exit — sell half at +50%, let the other half run to target
      const halfQty = qty / 2;
      console.log(`  📤 PARTIAL EXIT — selling half of ${sym} at +${pnlPct.toFixed(2)}%`);
      try {
        await placeOrder(sym, "sell", null, price, String(halfQty));
        const pnlUSD = (price - pos.entryPrice) * halfQty;
        pos.quantity    = String(halfQty);
        pos.halfSold    = true;
        pos.halfSoldPct = pnlPct;
        log.portfolioValue = (log.portfolioValue || 0) + pnlUSD;
        writeTradeCsv({ timestamp: new Date().toISOString(), type: "exit", symbol: sym, price, pnlPct, pnlUSD, orderPlaced: true, tradeType: "longterm", notes: `LT partial exit at +${pnlPct.toFixed(1)}% — half remains` });
        changed = true;
        console.log(`  ✅ LT PARTIAL SOLD — ${sym} half at +${pnlPct.toFixed(2)}% ($+${pnlUSD.toFixed(2)}) — other half runs to +${target}%`);
      } catch (e) { console.log(`  ❌ LT partial sell failed ${sym}: ${e.message}`); }

    } else if (peakPct >= 30 && pnlPct < 10) {
      // Trailing stop — was up 30%+, gave back too much
      console.log(`  🔒 TRAILING STOP — ${sym} peaked +${peakPct.toFixed(1)}%, now +${pnlPct.toFixed(2)}% (below +10% floor)`);
      try {
        await placeOrder(sym, "sell", null, price, pos.quantity);
        const pnlUSD = (price - pos.entryPrice) * qty;
        log.ltPositions[sym] = { ...pos, open: false, exitPrice: price, exitTime: new Date().toISOString(), pnlPct, pnlUSD };
        log.portfolioValue = (log.portfolioValue || 0) + pnlUSD;
        writeTradeCsv({ timestamp: new Date().toISOString(), type: "exit", symbol: sym, price, pnlPct, pnlUSD, orderPlaced: true, tradeType: "longterm", notes: `LT trailing stop — peaked +${peakPct.toFixed(1)}%, exited +${pnlPct.toFixed(1)}%` });
        changed = true;
        console.log(`  ✅ LT TRAILING STOP — ${sym} locked in +${pnlPct.toFixed(2)}% ($${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(2)})`);
      } catch (e) { console.log(`  ❌ LT trailing stop sell failed ${sym}: ${e.message}`); }

    } else if (pnlPct <= -40 && holdDays >= 30) {
      // Hard stop-loss — deep loss after 30 days
      console.log(`  🛑 STOP-LOSS — ${sym} at ${pnlPct.toFixed(2)}% after ${holdDays.toFixed(0)}d`);
      try {
        await placeOrder(sym, "sell", null, price, pos.quantity);
        const pnlUSD = (price - pos.entryPrice) * qty;
        log.ltPositions[sym] = { ...pos, open: false, exitPrice: price, exitTime: new Date().toISOString(), pnlPct, pnlUSD };
        log.portfolioValue = (log.portfolioValue || 0) + pnlUSD;
        writeTradeCsv({ timestamp: new Date().toISOString(), type: "exit", symbol: sym, price, pnlPct, pnlUSD, orderPlaced: true, tradeType: "longterm", notes: `LT stop-loss ${pnlPct.toFixed(1)}% after ${holdDays.toFixed(0)}d` });
        changed = true;
        console.log(`  ✅ LT STOPPED OUT — ${sym} ${pnlPct.toFixed(2)}% ($${pnlUSD.toFixed(2)})`);
      } catch (e) { console.log(`  ❌ LT stop-loss sell failed ${sym}: ${e.message}`); }
    }
  }

  // ── Scan missing coins with indicator check ────────────────────────────────
  let usdtBalance = 0;
  try { usdtBalance = await getBalance("USDT"); } catch (e) {
    console.log(`⚠️ LT: balance fetch failed — ${e.message}`);
    if (changed) saveLog(log); return;
  }

  const available = usdtBalance - LT_RESERVE;
  const minLtSize = 3;
  if (available < minLtSize) {
    console.log(`  ⚠️ LT: USDT too low ($${usdtBalance.toFixed(2)}) — need at least $${(minLtSize + LT_RESERVE).toFixed(2)} to buy`);
  } else {
    const missing = LT_COINS.filter(sym =>
      !log.ltPositions[sym]?.open &&
      !(log.positions || {})[sym]?.open &&
      !(log.swingPositions || {})[sym]?.open &&
      prices[sym] > 0
    );

    console.log(`  💎 Scanning ${missing.length} unacquired coin(s) for entry signal...`);

    // Check each missing coin — stagger requests to avoid hammering the API
    const results = [];
    for (const sym of missing) {
      const r = await checkLtEntry(sym).catch(e => ({ pass: false, sym, passed: 0, total: 8, reason: e.message }));
      results.push(r);
      await new Promise(res => setTimeout(res, 150));
    }

    const qualified = results.filter(r => r.pass).sort((a, b) => b.passed - a.passed);
    const notReady  = results.filter(r => !r.pass).sort((a, b) => b.passed - a.passed);

    if (qualified.length > 0) {
      console.log(`  ✅ ${qualified.length} coin(s) ready for entry:`);
      for (const r of qualified) {
        console.log(`     ${r.sym.padEnd(14)} ${r.passed}/${r.total} — ${r.labels?.join(" | ")}`);
      }
    }
    if (notReady.length > 0) {
      const top5 = notReady.slice(0, 5);
      console.log(`  ⏳ Not yet ready (top ${top5.length}): ${top5.map(r => `${r.sym.replace("USDT","")} ${r.passed}/${r.total}`).join(", ")}`);
    }

    if (qualified.length === 0) {
      console.log(`  ⏳ No coins meet entry criteria this run — next check in 6h`);
    } else {
      let remainingUsdt = available;
      for (const best of qualified.slice(0, 3)) {
        const dynamicSize = Math.min(50, Math.max(3, usdtBalance * 0.025));
        if (remainingUsdt < dynamicSize) break;
        const price = prices[best.sym];
        try {
          console.log(`  💎 LT BUY — ${best.sym} $${dynamicSize.toFixed(2)} @ $${price.toFixed(6)} [score ${best.passed}/${best.total}]`);
          const order = await placeOrder(best.sym, "buy", dynamicSize, price);
          const qty   = order.confirmedQty ?? (dynamicSize / price);
          const freshLog = loadLog();
          if (!freshLog.ltPositions) freshLog.ltPositions = {};
          freshLog.ltPositions[best.sym] = {
            open: true, symbol: best.sym, entryPrice: price, quantity: String(qty),
            entryTime: new Date().toISOString(), orderId: order.orderId,
            targetPct: LT_TARGET_PCT, tradeType: "longterm",
            entryScore: `${best.passed}/${best.total}`,
          };
          writeTradeCsv({ timestamp: new Date().toISOString(), type: "entry", symbol: best.sym, price, tradeSize: dynamicSize, orderPlaced: true, tradeType: "longterm", orderId: order.orderId, notes: `LT hold — target +${LT_TARGET_PCT}% | score ${best.passed}/${best.total}` });
          saveLog(freshLog);
          changed = false;
          remainingUsdt -= dynamicSize;
          console.log(`  ✅ LT BOUGHT — ${best.sym} qty:${qty} | USDT left: $${remainingUsdt.toFixed(2)}`);
          sendEmail(
            `💎 LT BUY — ${best.sym.replace("USDT","")} @ $${price.toFixed(6)}`,
            `<h2>💎 Long-Term Buy</h2><table style="font-size:16px;line-height:1.8">
             <tr><td><b>Symbol</b></td><td>${best.sym}</td></tr>
             <tr><td><b>Price</b></td><td>$${price.toFixed(6)}</td></tr>
             <tr><td><b>Size</b></td><td>$${dynamicSize.toFixed(2)}</td></tr>
             <tr><td><b>Score</b></td><td>${best.passed}/${best.total} conditions</td></tr>
             <tr><td><b>Conditions</b></td><td>${best.labels?.join("<br>")}</td></tr>
             <tr><td><b>Target</b></td><td>+${LT_TARGET_PCT}%</td></tr></table>`
          );
          await new Promise(r => setTimeout(r, 500));
        } catch (e) { console.log(`  ❌ LT buy failed ${best.sym}: ${e.message}`); }
      }
    }
  }

  if (changed) saveLog(log);
  const openCount  = Object.values(log.ltPositions).filter(p => p?.open).length;
  const remaining  = LT_COINS.filter(s => !log.ltPositions[s]?.open).length;
  console.log(`  💎 Portfolio: ${openCount}/${LT_COINS.length} held | ${remaining} still to acquire`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

async function runLongTermPortfolio() {
  if (!LT_ENABLED || CONFIG.paperTrading) return;
  console.log(`\n💎 ── Long-Term Portfolio ──────────────────────────────────`);

  let prices = {};
  try {
    const res  = await fetch("https://api.bitget.com/api/v2/spot/market/tickers");
    const data = await res.json();
    prices = Object.fromEntries((data.data || []).map(t => [t.symbol, parseFloat(t.lastPr)]));
  } catch (e) {
    console.log(`⚠️ LT: price fetch failed — ${e.message}`); return;
  }

  const log = loadLog();
  if (!log.ltPositions) log.ltPositions = {};
  let changed = false;

  // ── Manage held positions ──────────────────────────────────────────────────
  for (const [sym, pos] of Object.entries(log.ltPositions)) {
    if (!pos?.open) continue;
    const price = prices[sym];
    if (!price) continue;

    const avgEntry = pos.avgEntryPrice ?? pos.entryPrice;
    const pnlPct   = (price - avgEntry) / avgEntry * 100;
    const holdDays = (Date.now() - new Date(pos.entryTime).getTime()) / 86400000;
    const remQty   = parseFloat(pos.remainingQty ?? pos.quantity);
    console.log(`  💎 ${sym.replace("USDT","").padEnd(8)} avg $${avgEntry.toFixed(6)} | $${price.toFixed(6)} | ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% | ${holdDays.toFixed(0)}d | rem:${remQty.toFixed(4)}`);

    // ── Legacy position (no ladder): single exit ───────────────────────────
    if (!pos.ladder) {
      if (pnlPct >= (pos.targetPct ?? LT_TARGET_PCT)) {
        try {
          await placeOrder(sym, "sell", null, price, pos.quantity);
          const pnlUSD = (price - avgEntry) * parseFloat(pos.quantity);
          log.ltPositions[sym] = { ...pos, open: false, exitPrice: price, exitTime: new Date().toISOString(), pnlPct, pnlUSD };
          writeTradeCsv({ timestamp: new Date().toISOString(), type: "exit", symbol: sym, price, pnlPct, pnlUSD, orderPlaced: true, tradeType: "longterm", notes: `LT legacy exit +${pnlPct.toFixed(1)}%` });
          changed = true;
          console.log(`  ✅ LT SOLD (legacy) — ${sym} +${pnlPct.toFixed(2)}%`);
        } catch (e) { console.log(`  ❌ LT sell failed ${sym}: ${e.message}`); }
      }
      continue;
    }

    const totalQty = parseFloat(pos.quantity);
    let remQtyMut  = remQty;

    // ── Entry tranche 2 — DCA in if price dipped 8% from first entry ───────
    const e2 = pos.ladder.entry?.[1];
    if (e2 && !e2.filled) {
      const t1Price = pos.ladder.entry[0].price;
      const dropPct = (t1Price - price) / t1Price * 100;
      if (dropPct >= (e2.triggerDropPct ?? 8)) {
        const t2Size  = LT_TRADE_SIZE * 0.5;
        const usdtBal = await getBalance("USDT").catch(() => 0);
        if (usdtBal - LT_RESERVE >= t2Size) {
          try {
            console.log(`  💎 LT DCA — ${sym} T2 @ $${price.toFixed(6)} (dipped ${dropPct.toFixed(1)}% from T1)`);
            const ord2   = await placeOrder(sym, "buy", t2Size, price);
            const qty2   = ord2.confirmedQty ?? (t2Size / price);
            const qty1   = parseFloat(pos.ladder.entry[0].qty);
            const newQty = qty1 + qty2;
            const newAvg = (qty1 * t1Price + qty2 * price) / newQty;
            pos.avgEntryPrice   = newAvg;
            pos.quantity        = String(newQty);
            pos.remainingQty    = String(remQtyMut + qty2);
            pos.ladder.entry[1] = { ...e2, filled: true, price, qty: String(qty2), orderId: ord2.orderId };
            remQtyMut          += qty2;
            writeTradeCsv({ timestamp: new Date().toISOString(), type: "entry", symbol: sym, price, tradeSize: t2Size, orderPlaced: true, tradeType: "longterm", orderId: ord2.orderId, notes: `LT DCA T2 — avg entry now $${newAvg.toFixed(6)}` });
            changed = true;
            console.log(`  ✅ LT DCA T2 — ${sym} qty:${qty2} | new avg:$${newAvg.toFixed(6)}`);
          } catch (e) { console.log(`  ❌ LT DCA failed ${sym}: ${e.message}`); }
        }
      }
    }

    // ── Exit tranches ──────────────────────────────────────────────────────
    let allDone = true;
    for (const t of pos.ladder.exit) {
      if (t.sold) continue;
      allDone = false;

      if (t.trailing) {
        // Update high watermark whenever price rises
        if (!t.peak || price > t.peak) { t.peak = price; changed = true; }
        const activated    = pnlPct >= (t.trailActivatePct ?? 100);
        const drawFromPeak = t.peak ? (t.peak - price) / t.peak * 100 : 0;
        if (activated && drawFromPeak >= (t.trailPct ?? 20)) {
          try {
            console.log(`  🎯 LT TRAIL T${t.n} — ${sym} sell ${remQtyMut.toFixed(6)} | peaked $${t.peak.toFixed(6)}, drew ${drawFromPeak.toFixed(1)}%`);
            await placeOrder(sym, "sell", null, price, String(remQtyMut));
            const pnlUSD = (price - avgEntry) * remQtyMut;
            t.sold = true; t.soldAt = price; t.soldPnl = pnlPct;
            pos.remainingQty = "0";
            writeTradeCsv({ timestamp: new Date().toISOString(), type: "exit", symbol: sym, price, pnlPct, pnlUSD, orderPlaced: true, tradeType: "longterm", notes: `LT trail stop T${t.n} — peak $${t.peak.toFixed(6)} drew ${drawFromPeak.toFixed(1)}%` });
            changed = true;
            console.log(`  ✅ LT TRAIL SOLD T${t.n} — ${sym} +${pnlPct.toFixed(2)}% ($+${pnlUSD.toFixed(2)})`);
            sendEmail(`💰 LT TRAIL EXIT — ${sym.replace("USDT","")} +${pnlPct.toFixed(1)}%`,
              `<h2>💰 LT Trailing Stop Exit</h2><table style="font-size:16px;line-height:1.8">
               <tr><td><b>Symbol</b></td><td>${sym}</td></tr>
               <tr><td><b>P&L</b></td><td>+$${pnlUSD.toFixed(2)} (+${pnlPct.toFixed(2)}%)</td></tr>
               <tr><td><b>Peak</b></td><td>$${t.peak.toFixed(6)}</td></tr>
               <tr><td><b>Drawdown from peak</b></td><td>${drawFromPeak.toFixed(1)}%</td></tr></table>`);
          } catch (e) { console.log(`  ❌ LT trail sell failed ${sym}: ${e.message}`); }
        }
        continue;
      }

      // Fixed-target tranche
      if (pnlPct >= t.targetPct) {
        const sellQty = Math.min(parseFloat((totalQty * t.holdPct / 100).toFixed(8)), remQtyMut);
        if (sellQty <= 0) { t.sold = true; changed = true; continue; }
        try {
          console.log(`  🎯 LT LADDER T${t.n} — ${sym} sell ${sellQty.toFixed(6)} @ +${pnlPct.toFixed(1)}% (target +${t.targetPct}%)`);
          await placeOrder(sym, "sell", null, price, String(sellQty));
          const pnlUSD = (price - avgEntry) * sellQty;
          t.sold = true; t.soldAt = price; t.soldPnl = pnlPct;
          remQtyMut        -= sellQty;
          pos.remainingQty  = String(Math.max(0, remQtyMut));
          writeTradeCsv({ timestamp: new Date().toISOString(), type: "exit", symbol: sym, price, pnlPct, pnlUSD, orderPlaced: true, tradeType: "longterm", notes: `LT ladder T${t.n} — target +${t.targetPct}%` });
          changed = true;
          console.log(`  ✅ LT LADDER T${t.n} — ${sym} +${pnlPct.toFixed(2)}% ($+${pnlUSD.toFixed(2)}) | rem:${remQtyMut.toFixed(4)}`);
          sendEmail(`💰 LT LADDER T${t.n} — ${sym.replace("USDT","")} +${pnlPct.toFixed(1)}%`,
            `<h2>💰 LT Ladder Exit — Tranche ${t.n}</h2><table style="font-size:16px;line-height:1.8">
             <tr><td><b>Symbol</b></td><td>${sym}</td></tr>
             <tr><td><b>P&L this tranche</b></td><td>+$${pnlUSD.toFixed(2)} (+${pnlPct.toFixed(2)}%)</td></tr>
             <tr><td><b>Sold</b></td><td>${t.holdPct}% of position at +${t.targetPct}% target</td></tr>
             <tr><td><b>Remaining</b></td><td>${remQtyMut.toFixed(6)} ${sym.replace("USDT","")}</td></tr></table>`);
        } catch (e) { console.log(`  ❌ LT ladder sell failed ${sym} T${t.n}: ${e.message}`); }
      }
    }

    if (allDone || parseFloat(pos.remainingQty ?? 1) <= 0) {
      pos.open = false; pos.exitTime = new Date().toISOString();
      changed = true;
      console.log(`  ✅ LT POSITION CLOSED — ${sym} all tranches exited`);
    }
  }

  // ── Scan and buy best qualifying coin ─────────────────────────────────────
  let usdtBalance = 0;
  try { usdtBalance = await getBalance("USDT"); } catch (e) {
    console.log(`⚠️ LT: balance fetch failed — ${e.message}`);
    if (changed) saveLog(log); return;
  }

  const t1Size    = LT_TRADE_SIZE * 0.5;
  const available = usdtBalance - LT_RESERVE;
  if (available < t1Size) {
    console.log(`  ⚠️ LT: USDT too low ($${usdtBalance.toFixed(2)}) — need $${(t1Size + LT_RESERVE).toFixed(2)} for first tranche`);
  } else {
    const missing = LT_COINS.filter(sym =>
      !log.ltPositions[sym]?.open &&
      !(log.positions || {})[sym]?.open &&
      !(log.swingPositions || {})[sym]?.open &&
      prices[sym] > 0
    );

    console.log(`  💎 Scanning ${missing.length} unacquired coin(s) for entry signal...`);

    const missingFiltered = missing.filter(sym => {
      const cd = (log.coinCooldowns || {})[sym]?.lt;
      return !(cd && Date.now() < cd.until);
    });

    const results = [];
    for (const sym of missingFiltered) {
      const r = await checkLtEntry(sym).catch(e => ({ pass: false, sym, passed: 0, total: 11, reason: e.message }));
      results.push(r);
      await new Promise(r => setTimeout(r, 150));
    }

    const qualified = results.filter(r => r.pass).sort((a, b) => b.passed - a.passed);
    const notReady  = results.filter(r => !r.pass).sort((a, b) => b.passed - a.passed);

    if (qualified.length > 0) {
      console.log(`  ✅ ${qualified.length} coin(s) ready for entry:`);
      for (const r of qualified) console.log(`     ${r.sym.padEnd(14)} ${r.passed}/${r.total} — ${r.labels?.join(" | ")}`);
    }
    if (notReady.length > 0) {
      const top5 = notReady.slice(0, 5);
      console.log(`  ⏳ Not ready (top ${top5.length}): ${top5.map(r => `${r.sym.replace("USDT","")} ${r.passed}/${r.total}`).join(", ")}`);
    }

    const best = qualified[0];
    if (best) {
      const price = prices[best.sym];
      try {
        console.log(`  💎 LT BUY T1 — ${best.sym} $${t1Size} @ $${price.toFixed(6)} [${best.passed}/${best.total}]`);
        const order = await placeOrder(best.sym, "buy", t1Size, price);
        const qty   = order.confirmedQty ?? (t1Size / price);
        const freshLog = loadLog();
        if (!freshLog.ltPositions) freshLog.ltPositions = {};
        freshLog.ltPositions[best.sym] = {
          open: true, symbol: best.sym, avgEntryPrice: price,
          quantity: String(qty), remainingQty: String(qty),
          entryTime: new Date().toISOString(), targetPct: LT_TARGET_PCT,
          tradeType: "longterm", entryScore: `${best.passed}/${best.total}`,
          ladder: makeLtLadder(price, qty, order.orderId),
        };
        writeTradeCsv({ timestamp: new Date().toISOString(), type: "entry", symbol: best.sym, price, tradeSize: t1Size, orderPlaced: true, tradeType: "longterm", orderId: order.orderId, notes: `LT T1 score ${best.passed}/${best.total} — exits: +30/60/100/trail` });
        saveLog(freshLog);
        changed = false;
        console.log(`  ✅ LT BOUGHT T1 — ${best.sym} qty:${qty} | T2 if drops 8% ($${(price * 0.92).toFixed(6)})`);
        sendEmail(
          `💎 LT BUY — ${best.sym.replace("USDT","")} T1 @ $${price.toFixed(6)}`,
          `<h2>💎 Long-Term Buy — Tranche 1 of 2</h2><table style="font-size:16px;line-height:1.8">
           <tr><td><b>Symbol</b></td><td>${best.sym}</td></tr>
           <tr><td><b>Price</b></td><td>$${price.toFixed(6)}</td></tr>
           <tr><td><b>Size</b></td><td>$${t1Size} (T1) — T2 buys $${t1Size} more if -8%</td></tr>
           <tr><td><b>Score</b></td><td>${best.passed}/${best.total} conditions</td></tr>
           <tr><td><b>Conditions</b></td><td>${best.labels?.join("<br>")}</td></tr>
           <tr><td><b>Exit ladder</b></td><td>25% @ +30% | 25% @ +60% | 25% @ +100% | 25% trailing (-20% from peak)</td></tr></table>`
        );
      } catch (e) { console.log(`  ❌ LT buy failed ${best.sym}: ${e.message}`); }
    } else {
      console.log(`  ⏳ No coins meet entry criteria this run — next check in 6h`);
    }
  }

  if (changed) saveLog(log);
  const openCount = Object.values(log.ltPositions).filter(p => p?.open).length;
  const remaining = LT_COINS.filter(s => !log.ltPositions[s]?.open).length;
  console.log(`  💎 Portfolio: ${openCount}/${LT_COINS.length} held | ${remaining} still to acquire`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
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

    const trackedCoins = new Set([
      ...Object.entries(log.positions || {})
        .filter(([, p]) => p && p.open)
        .map(([sym]) => sym.replace("USDT", "")),
      ...Object.entries(log.sniperPositions || {})
        .filter(([, p]) => p && p.open)
        .map(([sym]) => sym.replace("USDT", "")),
    ]);

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
      if (usdValue < 1.00 || usdValue >= 10) continue; // only sweep $1–$10 dust (BitGet min order ~$1)

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
    if (available <= 0) throw new Error(`DUST:No ${baseCoin} balance to sell`);
    const valueUSD = available * (price || 1);
    if (valueUSD < 1.0) throw new Error(`DUST:Position too small — $${valueUSD.toFixed(4)} remaining (below $1 minimum)`);
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

// Resolve persistent CSV path. Priority:
//   1. STATE_FILE env var (legacy) → swap filename to trades.csv
//   2. /data/trades.csv — create /data if it doesn't exist yet (Railway volume or ephemeral)
//   3. trades.csv relative (local dev)
function resolveCSVPath() {
  if (process.env.STATE_FILE) {
    return process.env.STATE_FILE.replace(/[^/\\]+$/, "trades.csv");
  }
  try {
    // mkdirSync is a no-op if /data already exists; creates it if not.
    // On Railway with a mounted volume /data is persistent; without one it's ephemeral but at
    // least consistent across the process lifetime (won't silently write to /app/).
    mkdirSync("/data", { recursive: true });
    return "/data/trades.csv";
  } catch {
    return "trades.csv";
  }
}
const CSV_FILE = resolveCSVPath();

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

  if (logEntry.tradeType === "sniper") {
    const pnlStr = logEntry.pnlPct !== undefined
      ? ` P&L: ${logEntry.pnlPct >= 0 ? "+" : ""}${logEntry.pnlPct.toFixed(2)}%`
      : "";
    if (logEntry.type === "exit") {
      const val = (parseFloat(logEntry.quantity || 0) * logEntry.price);
      side = "SELL";
      quantity = logEntry.quantity != null ? String(logEntry.quantity) : "";
      totalUSD = val > 0 ? val.toFixed(2) : "";
      fee = val > 0 ? (val * getFeePct()).toFixed(4) : "";
      netAmount = val > 0 ? (val - val * getFeePct()).toFixed(2) : "";
      orderId = logEntry.orderId || "";
      mode = "LIVE";
      notes = `[SNIPER] Exit: ${logEntry.exitReasons?.join("; ")}${pnlStr}`;
    } else {
      side = "BUY";
      quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
      totalUSD = logEntry.tradeSize.toFixed(2);
      fee = (logEntry.tradeSize * getFeePct()).toFixed(4);
      netAmount = (logEntry.tradeSize - logEntry.tradeSize * getFeePct()).toFixed(2);
      orderId = logEntry.orderId || "";
      mode = "LIVE";
      notes = `[SNIPER] Entry: Trail +${(SNIPER.trailActivatePct * 100).toFixed(0)}%/${(SNIPER.trailPct * 100).toFixed(0)}% | SL -${(SNIPER.stopLossPct * 100).toFixed(0)}% | ${SNIPER.maxHoldMin}min`;
    }
  } else if (logEntry.type === "exit") {
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
  } else if (!logEntry.allPass && Array.isArray(logEntry.conditions)) {
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

let _wsGeneration = 0; // incremented on every intentional restart; stale close handlers bail out

function startPriceStream(symbols) {
  const generation = ++_wsGeneration;
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
    if (generation !== _wsGeneration) return; // intentionally replaced — don't reconnect
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
  // Snapshot open positions once — but reload fresh log inside each iteration so that
  // if two stops fire in the same 5s cycle, the second save doesn't revert the first deletion.
  const snap = loadLog();
  const scalpOpen   = Object.entries(snap.positions         || {}).filter(([, p]) => p?.open).map(([s, p]) => [s, p, "positions"]);
  const swingOpen   = Object.entries(snap.swingPositions    || {}).filter(([, p]) => p?.open).map(([s, p]) => [s, p, "swingPositions"]);
  const breakoutOpen = Object.entries(snap.breakoutPositions|| {}).filter(([, p]) => p?.open).map(([s, p]) => [s, p, "breakoutPositions"]);
  const openPositions = [...scalpOpen, ...swingOpen, ...breakoutOpen];
  if (openPositions.length === 0) return;

  for (const [sym, pos, posStore] of openPositions) {
    if (_processingStops.has(sym)) continue;
    // Skip if main scan's run() is already processing this symbol — avoids concurrent sell + log-clobber race
    if (_runningSymbols.has(sym)) continue;
    const live = livePrices.get(sym);
    if (!live || Date.now() - live.ts > 30000) continue; // stale — skip

    const livePrice = live.price;
    const pnlPct = (livePrice - pos.entryPrice) / pos.entryPrice * 100;
    const defaultSl = posStore === "swingPositions" ? (SWING.stopLoss ?? 0.05) : posStore === "breakoutPositions" ? 0.03 : 0.04;
    const slPct = pos.slPct ?? ((typeof BACKTEST !== "undefined" && BACKTEST[sym]?.stopLoss) ? BACKTEST[sym].stopLoss : defaultSl);
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
        if (pos.tpOrderId) {
          await cancelOrder(sym, pos.tpOrderId);
          console.log(`  📌 Cancelled resting TP ${pos.tpOrderId} before stop sell`);
        }
        const order = await placeOrder(sym, "sell", null, livePrice, pos.quantity);
        console.log(`✅ STOP SELL — ${order.orderId}`);
      } else {
        console.log(`📋 PAPER STOP SELL`);
      }
      // Reload fresh so concurrent stops don't clobber each other's saves
      const log = loadLog();
      if (log[posStore]) delete log[posStore][sym];
      log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
      log.trades.push({
        timestamp: new Date().toISOString(), type: "exit", symbol: sym,
        price: livePrice, entryPrice: pos.entryPrice, pnlPct, pnlUSD,
        indicators: {}, exitReasons: [reason],
        shouldExit: true, quantity: pos.quantity,
        orderPlaced: true, paperTrading: CONFIG.paperTrading,
        wsTriggered: true,
      });
      // Hard stops are always losses — 2h cooldown prevents immediate re-entry after stop-loss
      if (!log.coinCooldowns) log.coinCooldowns = {};
      if (!log.coinCooldowns[sym]) log.coinCooldowns[sym] = {};
      log.coinCooldowns[sym].scalp = { until: Date.now() + 2 * 60 * 60 * 1000, pnlPct: pnlPct.toFixed(2) };
      learnFromTrades(log);
      saveLog(log);
      writeTradeCsv(log.trades[log.trades.length - 1]);
      await syncPortfolioBalance(log).catch(() => {});
      console.log(`⏳ Hard stop cooldown — ${sym} blocked for 2h (P&L: ${pnlPct.toFixed(2)}%)`);
      console.log(`💰 Portfolio: $${log.portfolioValue.toFixed(4)}`);
    } catch (err) {
      console.error(`Stop sell failed for ${sym}: ${err.message}`);
      const isDust = err.message.startsWith("DUST:") || err.message.includes("Parameter verification exception size");
      if (isDust) {
        // The DUST error already proves the sellable balance is < $1 — no need for an extra API call
        // that can return a stale/frozen balance and block cleanup. Remove immediately.
        const freshLog = loadLog();
        if (freshLog[posStore]?.[sym]) delete freshLog[posStore][sym];
        if (!freshLog.coinCooldowns) freshLog.coinCooldowns = {};
        if (!freshLog.coinCooldowns[sym]) freshLog.coinCooldowns[sym] = {};
        freshLog.coinCooldowns[sym].scalp = { until: Date.now() + 2 * 60 * 60 * 1000, pnlPct: pnlPct.toFixed(2) };
        saveLog(freshLog);
        console.log(`🗑️  Dust cleanup [hard stop] — ${sym} unsellable, removed from log (P&L: ${pnlPct.toFixed(2)}%)`);
      }
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

// ─── Resting TP helpers ───────────────────────────────────────────────────────

async function placeLimitSell(symbol, qty, limitPrice) {
  try {
    const symRes = await fetch(`${acct().baseUrl}/api/v2/spot/public/symbols?symbol=${symbol}`);
    const symData = await symRes.json();
    const pricePrecision = parseInt(symData.data?.[0]?.pricePrecision ?? "4", 10);
    const qtyPrecision   = parseInt(symData.data?.[0]?.quantityPrecision ?? "6", 10);
    const limitPriceStr  = limitPrice.toFixed(pricePrecision);
    const qtyStr = parseFloat(qty).toFixed(qtyPrecision);
    if (parseFloat(qtyStr) <= 0) return null;
    const timestamp = Date.now().toString();
    const path = "/api/v2/spot/trade/place-order";
    const body = JSON.stringify({ symbol, side: "sell", orderType: "limit", force: "gtc", price: limitPriceStr, size: qtyStr });
    const signature = signBitGet(timestamp, "POST", path, body);
    const res = await fetch(`${acct().baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": signature, "ACCESS-TIMESTAMP": timestamp, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US" },
      body,
    });
    const data = await res.json();
    if (data.code !== "00000") throw new Error(data.msg);
    console.log(`  📌 Resting TP SELL @ $${limitPriceStr} | id: ${data.data.orderId}`);
    return data.data.orderId;
  } catch (err) {
    console.log(`  ⚠️  Resting TP order failed (${err.message}) — poll-based exit still active`);
    return null;
  }
}

async function cancelOrder(symbol, orderId) {
  try {
    const ts = Date.now().toString();
    const path = "/api/v2/spot/trade/cancel-order";
    const body = JSON.stringify({ symbol, orderId });
    const sign = signBitGet(ts, "POST", path, body);
    await fetch(`${acct().baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": sign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US" },
      body,
    });
  } catch (err) {
    console.log(`  ⚠️  Cancel order ${orderId} failed: ${err.message}`);
  }
}

async function cancelAllSymbolOrders(symbol) {
  try {
    // Fetch open orders then cancel individually (bulk cancel endpoint is not available)
    const ts = Date.now().toString();
    const listPath = `/api/v2/spot/trade/unfilled-orders?symbol=${symbol}&limit=20`;
    const listSign = signBitGet(ts, "GET", listPath);
    const listRes = await fetch(`${acct().baseUrl}${listPath}`, {
      headers: { "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": listSign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US" },
    });
    const listData = await listRes.json();
    const orders = listData.data || [];
    console.log(`  🗑️  Found ${orders.length} open orders for ${symbol}`);
    for (const o of orders) {
      await cancelOrder(symbol, o.orderId);
    }
  } catch (err) {
    console.log(`  ⚠️  cancelAllSymbolOrders(${symbol}) failed: ${err.message}`);
  }
}

async function getOrderStatus(symbol, orderId) {
  try {
    const ts = Date.now().toString();
    const path = `/api/v2/spot/trade/orderInfo?orderId=${orderId}&symbol=${symbol}`;
    const sign = signBitGet(ts, "GET", path);
    const res = await fetch(`${acct().baseUrl}${path}`, {
      headers: { "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": sign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US" },
    });
    const data = await res.json();
    return data.data ?? null;
  } catch {
    return null;
  }
}

async function checkTpOrders() {
  const log = loadLog();
  const scalp   = Object.entries(log.positions          || {}).filter(([, p]) => p?.open && p?.tpOrderId).map(([s, p]) => [s, p, "positions"]);
  const swing   = Object.entries(log.swingPositions     || {}).filter(([, p]) => p?.open && p?.tpOrderId).map(([s, p]) => [s, p, "swingPositions"]);
  const breakout = Object.entries(log.breakoutPositions || {}).filter(([, p]) => p?.open && p?.tpOrderId).map(([s, p]) => [s, p, "breakoutPositions"]);
  const openWithTp = [...scalp, ...swing, ...breakout];
  if (openWithTp.length === 0) return;

  for (const [sym, pos, posStore] of openWithTp) {
    if (_processingStops.has(sym) || _runningSymbols.has(sym)) continue;
    const orderData = await getOrderStatus(sym, pos.tpOrderId);
    if (!orderData) continue;
    // Treat partial fills that left dust as full exits — remaining $<1 is unsellable anyway
    const isFull = orderData.status === "full_fill";
    const isPartialDust = orderData.status === "partial_fill" && parseFloat(orderData.priceAvg || 0) > 0 &&
      (parseFloat(pos.quantity) * parseFloat(orderData.priceAvg || 0) - parseFloat(orderData.accBaseVolume || 0) * parseFloat(orderData.priceAvg || 0)) < 1.0;
    if (!isFull && !isPartialDust) continue;

    _processingStops.add(sym);
    try {
      const fillPrice = parseFloat(orderData.priceAvg || orderData.price || pos.entryPrice * (1 + (pos.tpPct || 0.08)));
      const qty = parseFloat(pos.quantity);
      const pnlPct = (fillPrice - pos.entryPrice) / pos.entryPrice * 100;
      const pnlUSD = (fillPrice - pos.entryPrice) * qty;
      console.log(`\n🎯 RESTING TP FILLED [exchange] — ${sym} @ $${fillPrice.toFixed(4)} | +${pnlPct.toFixed(2)}% | $${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(2)}`);

      const freshLog = loadLog();
      if (freshLog[posStore]) delete freshLog[posStore][sym];
      freshLog.portfolioValue = (freshLog.portfolioValue || acct().portfolioValue) + pnlUSD;
      const tradeRecord = {
        timestamp: new Date().toISOString(), type: "exit", symbol: sym,
        price: fillPrice, entryPrice: pos.entryPrice, pnlPct, pnlUSD,
        indicators: {}, exitReasons: [`Resting TP filled @ $${fillPrice.toFixed(4)} (+${pnlPct.toFixed(2)}%)`],
        shouldExit: true, quantity: pos.quantity,
        orderPlaced: true, orderId: pos.tpOrderId,
        paperTrading: false, tpOrderFill: true, tradeType: posStore === "positions" ? "scalp" : posStore.replace("Positions",""),
      };
      freshLog.trades.push(tradeRecord);
      if (!freshLog.coinCooldowns) freshLog.coinCooldowns = {};
      if (!freshLog.coinCooldowns[sym]) freshLog.coinCooldowns[sym] = {};
      freshLog.coinCooldowns[sym].scalp = { until: Date.now() + 30 * 60 * 1000, pnlPct: pnlPct.toFixed(2) };
      const _ltChanged = learnFromTrades(freshLog);
      saveLog(freshLog);
      if (_ltChanged) saveLog(freshLog);
      writeTradeCsv(tradeRecord);
      await syncPortfolioBalance(freshLog).catch(() => {});
      pushSignal(sym, "EXIT_WIN", `TP filled @ $${fillPrice.toFixed(4)} | +${pnlPct.toFixed(2)}%`);
      await emailExit({ symbol: sym, price: fillPrice, entryPrice: pos.entryPrice, pnlPct, pnlUSD, reasons: [`Resting TP order filled`], orderId: pos.tpOrderId }).catch(() => {});
    } catch (err) {
      console.error(`checkTpOrders failed for ${sym}: ${err.message}`);
    } finally {
      _processingStops.delete(sym);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run(tvSignal = null, symbol = null) {
  symbol = (symbol || CONFIG.symbols[0]).toUpperCase();
  if (_runningSymbols.has(symbol)) {
    console.log(`⏳ ${symbol} already being processed — skipping concurrent call`);
    return;
  }
  _runningSymbols.add(symbol);
  try {
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

  // Market regime + portfolio heat + Fear & Greed sentiment
  const regime   = await detectMarketRegime().catch(() => ({ regime: "UNKNOWN", btcTrend: "neutral", volatility: "normal" }));
  const heat     = calcPortfolioHeat(log, _livePortfolioValue);
  const fearGreed = await fetchFearGreed().catch(() => null);
  const fgLabel   = fearGreed ? `F&G:${fearGreed.value}(${fearGreed.label})` : "F&G:n/a";
  const fgEmoji   = fearGreed ? (fearGreed.value <= 20 ? "😱" : fearGreed.value <= 40 ? "😟" : fearGreed.value <= 60 ? "😐" : fearGreed.value <= 80 ? "😏" : "🤑") : "";
  console.log(`🌍 Regime: ${regime.regime} (BTC:${regime.btcTrend} Vol:${regime.volatility}) | ${fgEmoji} ${fgLabel} | Portfolio heat: ${heat.heatPct}%/${heat.isOverheated ? "🔴 OVERHEATED" : "8% max"}`);

  // Block new entries when portfolio is overheated — skip candle fetch entirely to save API calls
  // Existing open positions for this symbol are still allowed through for exit management
  const earlyPosition = (log.positions || {})[symbol] || null;
  if (!earlyPosition?.open && heat.isOverheated) {
    console.log(`\n🚫 No new entries — portfolio heat ${heat.heatPct}% exceeds 8% max`);
    pushSignal(symbol, "BLOCKED", `Portfolio heat ${heat.heatPct.toFixed(0)}% > 8% max — waiting for positions to close`);
    return;
  }

  // Session gate removed — momentum path has its own safety gates (price > EMA8, vol > 1.2x, RSI 45-90)
  // that already prevent chasing dead pumps regardless of time of day

  // In BEAR regime: only manage exits on existing positions, skip all new scalp entries
  // In VOLATILE regime: reduce scalp size by 50% (applied in tradeSize calc below)

  // Fetch candle data — entry TF + 15min + 1H + 4H + daily + weekly
  if (LOG_VERBOSE) console.log("\n── Fetching market data from BitGet ────────────────────\n");
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
  const rsi14_1h = calcRSI(closes1h, 14);

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
  const supertrend   = calcSupertrend(candles);
  const fvg          = detectFVG(candles);
  const zScore       = calcZScore(candles);
  const vpoc         = calcVolumeProfileFull(candles);  // POC + VAH/VAL
  const bearDiv      = detectBearishDivergence(candles);
  const orderBlock   = detectOrderBlock(candles);
  const mktStructure = analyzeMarketStructure(candles);
  const killZone     = getKillZone();
  // Ichimoku on the scalp timeframe — cloud = strongest S/R zone; TK cross = momentum signal
  // Needs 78+ candles for Senkou B (52-period). Above cloud = bullish bias; kijun = key baseline S/R
  const ichi         = candles.length >= 78 ? calcIchimoku(candles) : null;
  // Ichimoku on 4H — higher-timeframe cloud tells you the macro trend direction
  const ichi4h       = candles4h && candles4h.length >= 78 ? calcIchimoku(candles4h) : null;

  // Compact one-liner always shown — full dump only in verbose mode
  console.log(`  ${symbol} $${price.toFixed(4)} | RSI ${rsi3 !== null ? rsi3.toFixed(1) : "N/A"} | BB% ${(bb.pct*100).toFixed(0)}% | Vol ${(vol.current/vol.avg).toFixed(1)}x | ${bullTrend4h ? "4H↑" : "4H↓"} ${bullTrend1h ? "1H↑" : "1H↓"} | VWAP $${vwap ? vwap.toFixed(4) : "N/A"}`);
  if (LOG_VERBOSE) {
    console.log(`  EMA(8):   $${ema8.toFixed(2)} | EMA(21): $${ema21.toFixed(2)} | ${ema8 > ema21 ? "✅ entry TF uptrend" : "🔴 entry TF downtrend"}`);
    console.log(`  1H trend: EMA(8) $${ema8_1h.toFixed(2)} vs EMA(21) $${ema21_1h.toFixed(2)} | ${bullTrend1h ? "✅ 1H uptrend" : "🔴 1H downtrend"} | RSI(14): ${rsi14_1h !== null ? rsi14_1h.toFixed(1) : "N/A"}${rsi14_1h !== null && rsi14_1h < 50 ? " ⚠️ bearish zone" : ""}`);
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
  }

  if (vwap === null || rsi3 === null) {
    console.log("\n⚠️  Not enough data to calculate indicators. Removing from scan pool.");
    _insufficientHistory.add(symbol);
    CONFIG.symbols = CONFIG.symbols.filter(s => s !== symbol);
    return;
  }

  // Data quality gate — coins with zero volume history have no tradeable market
  // vol.avg=0 means the 20-bar average is literally zero (dead coin / data gap)
  // RSI=0 with zero volume is a data artefact, not a real signal
  if (vol.avg === 0 || (rsi3 === 0 && vol.current === 0)) {
    console.log(`\n⚠️  Zero volume data — ${vol.avg === 0 ? "no volume history" : "RSI=0 + zero current volume"}. Removing from scan pool.`);
    _insufficientHistory.add(symbol);
    CONFIG.symbols = CONFIG.symbols.filter(s => s !== symbol);
    return;
  }

  // Store snapshot for dashboard coin detail view
  coinSnapshots[symbol] = {
    symbol, price, updatedAt: new Date().toISOString(),
    rsi3: rsi3?.toFixed(2), rsi15m: rsi15m?.toFixed(2),
    vwap: vwap?.toFixed(4),
    ema8: ema8?.toFixed(4), ema21: ema21?.toFixed(4),
    trend15m: ema8 > ema21 ? "up" : "down",
    trend1h: bullTrend1h ? "up" : "down", rsi14_1h: rsi14_1h?.toFixed(1),
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
  const bearSnapBack  = regime.btcTrend === "bear" && rsi3 !== null && rsi3 < 25 && (stochRsi?.oversold === true || macd.bullish === true);
  const regimeScale   = regime.volatility === "high" ? 0.50 : 1.0;
  const drawdownScale = drawdown.drawdownPct > 7 ? 0.30 : drawdown.drawdownPct > 5 ? 0.50 : drawdown.drawdownPct > 3 ? 0.75 : 1.0;
  const bearScale     = bearSnapBack ? 0.40 : 1.0; // bear snap-back = 40% size only
  // ATR volatility scale — reduce size when coin is 2x+ more volatile than its norm (research: 28% better risk-adjusted returns)
  const curATRpct = adx ? (calcATR(candles.slice(-14)) ?? 0) / price : 0;
  const avgATRpct = adx ? (calcATR(candles.slice(-40, -14)) ?? curATRpct) / price : curATRpct;
  const atrRatio  = avgATRpct > 0 ? curATRpct / avgATRpct : 1;
  const atrScale  = atrRatio > 2.0 ? 0.50 : atrRatio > 1.5 ? 0.75 : 1.0;
  if (atrScale < 1.0) console.log(`⚡ ATR volatility scale: ${(atrScale*100).toFixed(0)}% position size (ATR ${atrRatio.toFixed(1)}x above avg — inverse sizing)`);
  // Greed scale — Extreme Greed (>80) means market is euphoric; smaller bets, tighter stops
  // Research: F&G >80 preceded major reversals (Nov 2021 ATH → 65% crash, Dec 2024 peak)
  const fgValue  = fearGreed?.value ?? 50;
  // Greed scale: reduce size in euphoria, BOOST in extreme fear (contrarian edge)
  // F&G ≤ 10: +30% size — historic capitulation levels (once-in-months opportunity)
  // F&G ≤ 20: +20% size — extreme fear, 90-day median +48.5% from here
  // F&G > 70: -25% | F&G > 80: -50% (euphoria = high reversal risk)
  const greedScale = fgValue <= 10 ? 1.30 : fgValue <= 20 ? 1.20 : fgValue > 80 ? 0.50 : fgValue > 70 ? 0.75 : 1.0;
  if (greedScale > 1.0) console.log(`😱 Fear boost: ${(greedScale*100).toFixed(0)}% position size (F&G=${fgValue} — Extreme Fear contrarian opportunity)`);
  if (greedScale < 1.0) console.log(`🤑 Greed scale: ${(greedScale*100).toFixed(0)}% position size (F&G=${fgValue} — market euphoric, risk reduced)`);
  // Overconfidence guard — after 3+ consecutive wins, humans (and bots) get cocky and overtrade
  // Psychology: λ=2 loss aversion means wins create false confidence → reduce size to stay disciplined
  const recentResults = (log.trades || []).filter(t => t.type === "exit" && t.orderPlaced && t.pnlPct !== undefined).slice(-5);
  const consecutiveWins = recentResults.length >= 3 && recentResults.slice(-3).every(t => t.pnlPct > 0) ? 3 : 0;
  const overconfidenceScale = consecutiveWins >= 3 ? 0.80 : 1.0;
  if (overconfidenceScale < 1.0) console.log(`🎯 Overconfidence guard: ${(overconfidenceScale*100).toFixed(0)}% size after ${consecutiveWins} consecutive wins — staying disciplined`);
  // Profit-lock scale — protect daily gains by reducing new bets as the day goes well
  const todayPnlPct = log.dayStartValue > 0 ? (currentPortfolio - log.dayStartValue) / log.dayStartValue * 100 : 0;
  const profitLockScale = todayPnlPct > 5 ? 0.40 : todayPnlPct > 3 ? 0.60 : todayPnlPct > 1.5 ? 0.80 : 1.0;
  if (profitLockScale < 1.0) console.log(`🔒 Profit lock: ${(profitLockScale*100).toFixed(0)}% position size (up ${todayPnlPct.toFixed(1)}% today — protecting gains)`);
  const rawSize = currentPortfolio * sizePct * adaptive.sizeMultiplier * drawdownScale * regimeScale * bearScale * atrScale * greedScale * overconfidenceScale * profitLockScale;
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
        // Reload fresh to prevent concurrent writes clobbering other positions
        try { const _fp = loadLog(); log.positions = { ...(_fp.positions || {}), [symbol]: { ...(_fp.positions?.[symbol] || position), quantity: halfQty.toFixed(6), partialExitDone: true, partialExitPrice: price } }; } catch { log.positions[symbol] = { ...position, quantity: halfQty.toFixed(6), partialExitDone: true, partialExitPrice: price }; }
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
        // Replace full-qty resting TP with half-qty TP for remaining position
        if (!CONFIG.paperTrading && position.tpOrderId) {
          await cancelOrder(symbol, position.tpOrderId);
          const newTpPrice = position.entryPrice * (1 + (position.tpPct || 0.08));
          const newTpOrderId = await placeLimitSell(symbol, halfQty.toFixed(6), newTpPrice);
          if (newTpOrderId) {
            const _freshLog = (() => { try { return loadLog(); } catch { return log; } })();
            if (_freshLog.positions?.[symbol]) { _freshLog.positions[symbol].tpOrderId = newTpOrderId; saveLog(_freshLog); log.positions = _freshLog.positions; position = _freshLog.positions[symbol]; }
          }
        }
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
    // Hard exits: Claude cannot override these — capital protection is non-negotiable.
    // "Failed bounce" and "Trend reversed" are intentionally excluded: they now have 20-min
    // minimums and Claude should be able to override if the bigger picture is bullish.
    const HARD_EXIT_KEYWORDS = ["Stop-loss", "ATR stop", "Emergency", "Max hold", "Stale trade", "Momentum stop"];
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
    } else if (hasHardExit) {
      finalExit = true;
      console.log(`\n⚠️  Hard stop — Claude analysis skipped (${reasons.filter(r => HARD_EXIT_KEYWORDS.some(kw => r.startsWith(kw))).join(", ")})`);
    } else {
      // Use Claude for ambiguous soft exits — only if pool allows
      const exitClaudeStatus = claudeAvailable();
      if (anthropic && exitClaudeStatus === "ok") {
        console.log("\n── Claude AI Analysis ───────────────────────────────────\n");
        try {
          claudeAnalysis = await analyzeWithClaude(price, ema8, vwap, rsi3, log.trades, position, tvSignal, { ema21, macd, bb, adx, patterns, sr, bullTrend4h: bullTrendConfirmed, vol }, symbol);
          recordClaudeCall();
          finalExit = claudeAnalysis.action === "EXIT";
          console.log(`  Decision:   ${claudeAnalysis.action} (${claudeAnalysis.confidence}% confidence) [${_claudeCallsToday}/${CLAUDE_DAILY_CAP} today]`);
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
        console.log(`\n💰 Claude skipped — ${exitClaudeStatus === "daily-cap" ? `daily cap (${_claudeCallsToday}/${CLAUDE_DAILY_CAP})` : `global cooldown (${Math.round((CLAUDE_GLOBAL_COOLDOWN_MS - (Date.now() - _lastClaudeCallMs)) / 60000)}min left)`}`);
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
      entryType: position.entryType || "scalp",
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
        delete (log.positions || {})[symbol]; log.positions = { ...(log.positions || {}) };
        // Compound portfolio value
        log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
        console.log(`💰 Portfolio updated: $${log.portfolioValue.toFixed(4)} (${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(4)})`);
      } else {
        console.log(`\n🔴 PLACING LIVE SELL — ${position.quantity} ${symbol}`);
        try {
          // Cancel known TP order + any unknown resting orders (reconciled positions have no tpOrderId)
          if (position.tpOrderId) {
            await cancelOrder(symbol, position.tpOrderId);
            console.log(`  📌 Cancelled resting TP ${position.tpOrderId}`);
          } else {
            await cancelAllSymbolOrders(symbol);
          }
          const order = await placeOrder(symbol, "sell", null, price, position.quantity);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          delete (log.positions || {})[symbol]; log.positions = { ...(log.positions || {}) };
          // Compound portfolio value
          log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
          console.log(`✅ SELL ORDER PLACED — ${order.orderId}`);
          console.log(`💰 Portfolio updated: $${log.portfolioValue.toFixed(4)} (${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(4)})`);
          pushSignal(symbol, pnlPct >= 0 ? "EXIT_WIN" : "EXIT_LOSS", `Sold @ $${price.toFixed(4)} | P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(2)})`);
        } catch (err) {
          const isSizeError = err.message.startsWith("DUST:") || err.message.includes("Parameter verification exception size");
          console.log(`❌ SELL ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
          if (isSizeError) {
            const baseCoin = symbol.replace("USDT", "");
            const totalBal = await getSpotBalanceTotal(baseCoin).catch(() => 0);
            const totalUSD = totalBal * price;
            if (totalUSD >= 2.0) {
              // Coins still frozen — cancel ALL open orders then force-sell whatever is available
              console.log(`⚠️  Sell failed, $${totalUSD.toFixed(2)} of ${baseCoin} frozen — cancelling all orders and retrying`);
              await cancelAllSymbolOrders(symbol);
              await new Promise(r => setTimeout(r, 2000)); // wait for cancel to settle
              try {
                const freshBal = await getSpotBalance(baseCoin).catch(() => 0); // available only
                if (freshBal * price >= 1.0) {
                  // Try decreasing precision until BitGet accepts (handles coins like KAS that need integer qty)
                  let retryOrder;
                  for (const scale of [6, 4, 2, 1, 0]) {
                    const factor = Math.pow(10, scale);
                    const retryQty = (Math.floor(freshBal * 0.999 * factor) / factor).toFixed(scale);
                    try { retryOrder = await placeOrder(symbol, "sell", null, price, retryQty); break; }
                    catch (precErr) { if (scale === 0) throw precErr; }
                  }
                  logEntry.orderPlaced = true;
                  logEntry.orderId = retryOrder.orderId;
                  delete (log.positions || {})[symbol]; log.positions = { ...(log.positions || {}) };
                  log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
                  console.log(`✅ RETRY SELL PLACED — ${retryOrder.orderId}`);
                } else {
                  console.log(`🗑️  After cancel, balance still dust — removing from log`);
                  delete (log.positions || {})[symbol]; log.positions = { ...(log.positions || {}) };
                  logEntry.orderPlaced = true; logEntry.orderId = "DUST-CLEANUP";
                }
              } catch (retryErr) {
                console.log(`❌ Retry sell also failed: ${retryErr.message}`);
              }
            } else {
              console.log(`🗑️  Dust cleanup — ${symbol} total balance $${totalUSD.toFixed(4)} is unsellable, removing from log`);
              delete (log.positions || {})[symbol];
              log.positions = { ...(log.positions || {}) };
              logEntry.orderPlaced = true;
              logEntry.orderId = "DUST-CLEANUP";
            }
          }
        }
      }
    }

    // Only persist actual exits (order placed) — not hold decisions
    if (logEntry.orderPlaced) {
      log.trades.push(logEntry);
      // Per-coin per-strategy cooldown: only blocks scalp re-entry, not swing/LT
      if (!log.coinCooldowns) log.coinCooldowns = {};
      if (!log.coinCooldowns[symbol]) log.coinCooldowns[symbol] = {};
      const cooldownMs = pnlPct < 0 ? 2 * 60 * 60 * 1000 : 30 * 60 * 1000;
      log.coinCooldowns[symbol].scalp = { until: Date.now() + cooldownMs, pnlPct: pnlPct.toFixed(2) };
      console.log(`⏳ Scalp cooldown set for ${symbol} — no scalp re-entry for ${pnlPct < 0 ? "2h (loss)" : "30min (exit)"} (P&L: ${pnlPct.toFixed(2)}%)`);
      saveLog(log);
      console.log(`\nDecision log saved → ${LOG_FILE}`);
      writeTradeCsv(logEntry);
      const changed = learnFromTrades(log);
      if (changed) saveLog(log);
      // Sync real USDT balance after every exit so position sizing stays accurate
      if (!CONFIG.paperTrading) {
        await syncPortfolioBalance(log).catch(e => console.log(`⚠️ Post-exit balance sync failed: ${e.message}`));
        saveLog(log);
      }
    } else {
      saveLog(log); // still save watermark/position updates
    }

  } else {
    // ── ENTRY FLOW ──────────────────────────────────────────────────────────

    // Hard block — never trade exchange tokens or wrapped assets
    if (["BGBUSDT","BSVUSDT","WBTCUSDT","STETHUSDT"].includes(symbol)) {
      console.log(`🚫 NEVER_TRADE block — ${symbol} is an exchange token / wrapped asset`);
      return;
    }

    // Concurrent entry guard — if another async call is already processing an entry
    // for this symbol, bail out immediately before touching the log.
    if (_processingEntries.has(symbol)) {
      console.log(`⏳ ENTRY LOCK — another scan is already processing ${symbol}. Skipping.`);
      return;
    }
    _processingEntries.add(symbol);

    try {

    // Trading 24/7 — no time block

    // Prune expired coinCooldowns to keep the log compact
    if (log.coinCooldowns) {
      const now = Date.now();
      for (const s of Object.keys(log.coinCooldowns)) {
        const entry = log.coinCooldowns[s];
        if (entry && typeof entry === "object" && !("until" in entry)) {
          // Per-strategy format: { scalp: { until }, swing: { until }, ... }
          for (const strat of Object.keys(entry)) {
            if ((entry[strat]?.until ?? 0) < now) delete entry[strat];
          }
          if (Object.keys(entry).length === 0) delete log.coinCooldowns[s];
        } else if ((entry?.until ?? 0) < now) {
          delete log.coinCooldowns[s];
        }
      }
    }

    // Per-coin scalp cooldown — only blocks scalp re-entry, not swing/LT
    const cooldown = (log.coinCooldowns || {})[symbol]?.scalp;
    if (cooldown && Date.now() < cooldown.until) {
      const minsLeft = Math.ceil((cooldown.until - Date.now()) / 60000);
      const pnl = parseFloat(cooldown.pnlPct);
      console.log(`⏳ SCALP COOLDOWN — ${symbol} blocked for ${minsLeft} more min (last P&L: ${pnl >= 0 ? "+" : ""}${cooldown.pnlPct}%)`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Scalp cooldown — ${minsLeft}min left`);
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

    // Skip scalp entries for coins held in long-term portfolio
    if (LT_ENABLED && (log.ltPositions || {})[symbol]?.open) {
      console.log(`💎 LT HOLD — ${symbol} is in long-term portfolio. Skipping scalp entry.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Skip scalp entries for coins the sniper is currently holding — avoids double-buying
    if ((log.sniperPositions || {})[symbol]?.open) {
      console.log(`🎯 SNIPER OPEN — ${symbol} already in sniper position. Skipping scalp entry.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // ── Big Daily Mover — momentum path (bypasses mean-reversion filters) ────────
    // If a coin is up 3%+ on the day with real volume, trade the momentum instead
    // of waiting for it to become oversold. Different rules, smaller size, tight stop.
    const gainerInfo = _topGainers.find(t => t.symbol === symbol);
    if (gainerInfo && gainerInfo.change24h >= 1.5 && !(position && position.open)) {
      console.log(`\n🚀 MOVER — ${symbol} +${gainerInfo.change24h.toFixed(1)}% today`);
      const volRatio = vol.current / vol.avg;
      // Fast pumps (40%+ on the day) already look overbought on RSI(3) — allow slightly more headroom
      const rsiCeil  = gainerInfo.change24h >= 40 ? 90 : 85;
      const rsiOk    = rsi3 >= 45 && rsi3 <= rsiCeil;
      const stochOk  = !stochRsi || stochRsi.k < 92;       // slightly looser for fast movers
      const priceOk  = price > ema8;                        // price above fast EMA
      const volOk    = volRatio >= 2.0;                     // real momentum needs real volume
      const notTooHot = gainerInfo.change24h <= 75;         // raised from 40% — still skip the 100%+ blowoffs

      const trendOk  = bullTrend1h;                             // 1H uptrend — momentum trades in downtrends fail
      // In bear regime, require 15%+ move — small pumps (1-5%) reverse fast in bear, big pumps have real momentum
      const bearMoveMin = 15;
      const regimeOk = regime.btcTrend !== "bear" || gainerInfo.change24h >= bearMoveMin;
      console.log(`  Vol: ${volRatio.toFixed(1)}x avg | RSI(3): ${rsi3?.toFixed(1)} (ceil ${rsiCeil}) | StochRSI K: ${stochRsi?.k?.toFixed(1) ?? "—"} | Above EMA8: ${price > ema8 ? "yes" : "no"} | 1H trend: ${bullTrend1h ? "✅ up" : "🔴 down"} | BTC regime: ${regime.btcTrend}${regime.btcTrend === "bear" ? ` (need ${bearMoveMin}%+ move, got ${gainerInfo.change24h.toFixed(1)}%)` : ""}`);

      if (!regimeOk) {
        console.log(`🚫 MOMENTUM BLOCK — BTC bear regime, move only +${gainerInfo.change24h.toFixed(1)}% (need ${bearMoveMin}%+ to trade against the bear).`);
      } else if (rsiOk && stochOk && priceOk && volOk && notTooHot && trendOk) {
        console.log(`\n✅ MOMENTUM ENTRY — big mover conditions met. Position (40% size, 2% SL, trailing stop).`);
        pushSignal(symbol, "ENTRY", `Big mover +${gainerInfo.change24h.toFixed(1)}% — momentum entry`);
        const momSize = Math.min(currentPortfolio * sizePct * 0.40, CONFIG.maxTradeSizeUSD ?? Infinity);
        const momEntry = {
          timestamp: new Date().toISOString(), type: "entry", symbol,
          timeframe: CONFIG.timeframe, price, indicators: { ema8, vwap, rsi3 },
          allPass: true, claudeAnalysis: null, tradeSize: momSize, orderPlaced: false, orderId: null,
          entryType: "momentum", entryConfidence: Math.min(100, Math.round((vol.current / vol.avg) / 5 * 100)),
          paperTrading: CONFIG.paperTrading,
          limits: { maxTradeSizeUSD: CONFIG.maxTradeSizeUSD, maxTradesPerDay: CONFIG.maxTradesPerDay, tradesToday: countTodaysTrades(log) },
        };
        const momTpPct = 0.10;
        const momSlPct = 0.04;
        if (CONFIG.paperTrading) {
          momEntry.orderPlaced = true; momEntry.orderId = `PAPER-${Date.now()}`;
          try { log.positions = { ...(loadLog().positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: (momSize / price).toFixed(6), orderId: momEntry.orderId, entryType: "momentum", tpPct: momTpPct, slPct: momSlPct } }; } catch { log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: (momSize / price).toFixed(6), orderId: momEntry.orderId, entryType: "momentum", tpPct: momTpPct, slPct: momSlPct } }; }
        } else {
          try {
            const order = await placeOrder(symbol, "buy", momSize, price);
            const qty = order.confirmedQty ?? (momSize / price);
            momEntry.orderPlaced = true; momEntry.orderId = order.orderId;
            // Reload fresh before writing position — prevents stale log overwriting concurrent writes
            try { log.positions = { ...(loadLog().positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: qty.toFixed(6), orderId: order.orderId, entryType: "momentum", tpPct: momTpPct, slPct: momSlPct } }; } catch { log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: qty.toFixed(6), orderId: order.orderId, entryType: "momentum", tpPct: momTpPct, slPct: momSlPct } }; }
            const tpOrderId = await placeLimitSell(symbol, qty.toFixed(6), price * (1 + momTpPct));
            if (tpOrderId) {
              const _tpLog = (() => { try { return loadLog(); } catch { return log; } })();
              if (_tpLog.positions?.[symbol]) { _tpLog.positions[symbol].tpOrderId = tpOrderId; saveLog(_tpLog); log.positions = _tpLog.positions; }
            }
            await emailEntry({ symbol, price, tradeSize: momSize, orderId: order.orderId });
          } catch(err) {
            console.error(`\n❌ Momentum order failed: ${err.message}`);
            momEntry.notes = `Error: ${err.message}`;
          }
        }
        if (momEntry.orderPlaced) {
          const freshLog = (() => { try { return loadLog(); } catch { return log; } })();
          if (log.positions?.[symbol]) freshLog.positions = { ...(freshLog.positions || {}), [symbol]: log.positions[symbol] };
          if (!freshLog.coinCooldowns) freshLog.coinCooldowns = {};
          if (!freshLog.coinCooldowns[symbol]) freshLog.coinCooldowns[symbol] = {};
          freshLog.coinCooldowns[symbol].scalp = { until: Date.now() + 6 * 60 * 60 * 1000, pnlPct: "0.00", justBought: true };
          freshLog.trades.push(momEntry);
          saveLog(freshLog);
          writeTradeCsv(momEntry);
        }
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      } else if (rsi3 !== null && rsi3 < 35) {
        // Big mover pulled back to oversold — fall through to mean-reversion path
        console.log(`  📉 Big mover but RSI=${rsi3.toFixed(1)} pulled back to oversold — continuing to mean-reversion path\n`);
      } else {
        const reasons = [];
        if (!rsiOk)    reasons.push(`RSI ${rsi3?.toFixed(1)} not in 45-${rsiCeil} range`);
        if (!stochOk)  reasons.push(`StochRSI K=${stochRsi?.k?.toFixed(1)} exhausted (>92)`);
        if (!priceOk)  reasons.push(`price below EMA8`);
        if (!volOk)    reasons.push(`volume only ${volRatio.toFixed(1)}x avg (need 1.2x)`);
        if (!notTooHot) reasons.push(`up ${gainerInfo.change24h.toFixed(0)}% — too extended (>75%)`);
        if (!trendOk)  reasons.push(`1H downtrend — EMA8 < EMA21 on 1H, momentum in downtrend fails`);
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

    // Minimum 24h USDT volume — block illiquid/junk coins with no real market
    const coinInfo = _topGainers.find(t => t.symbol === symbol);
    if (coinInfo && coinInfo.vol < 1_000_000) {
      console.log(`🚫 LIQUIDITY BLOCK — ${symbol} only $${Math.round(coinInfo.vol / 1000)}K 24h volume (need $1M+). Too illiquid.`);
      pushSignal(symbol, "BLOCKED", `Only $${Math.round(coinInfo.vol/1000)}K 24h vol — too illiquid`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Auto-blacklist — skip a coin if it has 3+ real losses AND <40% WR in the past 2 days.
    // Resets automatically after 2 days so coins get a fresh chance.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const recentTradesOnCoin = log.trades.filter(t =>
      t.type === "exit" && t.symbol === symbol && t.orderPlaced && t.pnlPct !== undefined && t.timestamp > twoDaysAgo
    );
    const recentLossesOnCoin = recentTradesOnCoin.filter(t => t.pnlPct < -0.5).length;
    const recentWinsOnCoin   = recentTradesOnCoin.filter(t => t.pnlPct > 0).length;
    const recentWrOnCoin     = recentTradesOnCoin.length > 0 ? recentWinsOnCoin / recentTradesOnCoin.length : 1;
    if (recentLossesOnCoin >= 3 && recentWrOnCoin < 0.40) {
      console.log(`🚫 AUTO-BLACKLIST — ${symbol}: ${recentLossesOnCoin} losses in 2 days with ${(recentWrOnCoin*100).toFixed(0)}% win rate. Cooling off — resets in 2 days.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Auto-blacklist — ${recentLossesOnCoin} losses in 2 days, ${(recentWrOnCoin*100).toFixed(0)}% WR (resets in 2d)`);
      return;
    }

    // Per-symbol entry gap — no chasing the same coin twice quickly
    // (Global cooldown removed: it blocked other coins when one coin exited)
    const lastSymEntry = log.trades.filter(t => t.type === "entry" && t.orderPlaced && t.symbol === symbol).slice(-1)[0];
    if (lastSymEntry) {
      const minsSinceLast = (Date.now() - new Date(lastSymEntry.timestamp).getTime()) / 60000;
      if (minsSinceLast < 20) {
        console.log(`🚫 ENTRY COOLDOWN — ${symbol} entered ${minsSinceLast.toFixed(0)}min ago. Need 20min between same-coin entries.`);
        console.log("═══════════════════════════════════════════════════════════\n");
        pushSignal(symbol, "BLOCKED", `Entry cooldown — ${minsSinceLast.toFixed(0)}min since last ${symbol} entry (need 15min)`);
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

    // Max 5 concurrent scalp positions
    const openPositions = Object.entries(log.positions || {}).filter(([,p]) => p && p.open);
    const openCount = openPositions.length;
    if (openCount >= 10) {
      const held = openPositions.map(([s]) => s).join(", ");
      console.log(`🚫 MAX POSITIONS — already holding ${held}. Max 10 positions at a time.`);
      pushSignal(symbol, "BLOCKED", `Max positions (10/10) reached`);
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

    // BTC trend filter — two-layer block so a midnight reset can't unlock a week-long downtrend
    try {
      const btcRes = await fetch("https://api.bitget.com/api/v2/spot/market/tickers");
      const btcJson = await btcRes.json();
      const btcTicker = btcJson.data?.find(t => t.symbol === "BTCUSDT");
      if (btcTicker) {
        const btcChange = parseFloat(btcTicker.change24h) * 100;
        const btcPrice  = parseFloat(btcTicker.lastPr);

        // Layer 2: 3-day rolling change + 4H EMA — survives the midnight candle reset
        // Default to WORST CASE (assume bear) so a fetch failure doesn't silently disable the block
        let btc3dayChange = -999, btc4hBearish = true, layer2DataOk = false;
        try {
          const [dRes, h4Res] = await Promise.all([
            fetch("https://api.bitget.com/api/v2/spot/market/candles?symbol=BTCUSDT&granularity=1day&limit=5"),
            fetch("https://api.bitget.com/api/v2/spot/market/candles?symbol=BTCUSDT&granularity=4h&limit=30"),
          ]);
          const dData  = (await dRes.json()).data  || [];
          const h4Data = (await h4Res.json()).data || [];
          if (dData.length >= 4) {
            const open3d   = parseFloat(dData[dData.length - 4][1]);
            btc3dayChange  = (btcPrice - open3d) / open3d * 100;
            layer2DataOk   = true;
          }
          if (h4Data.length >= 21) {
            const h4Closes = h4Data.map(c => parseFloat(c[4])).filter(v => !isNaN(v));
            const ema = (arr, p) => arr.length ? arr.reduce((e,c,i) => i===0?c : c*(2/(p+1))+e*(1-2/(p+1))) : null;
            const e8 = ema(h4Closes.slice(-8), 8), e21 = ema(h4Closes.slice(-21), 21);
            if (e8 !== null && e21 !== null) btc4hBearish = e8 < e21;
          }
        } catch { console.log(`  ⚠️  Layer 2 data fetch failed — defaulting to bear (safe side)`); }

        console.log(`\n₿ BTC 24h: ${btcChange >= 0 ? "+" : ""}${btcChange.toFixed(2)}% | 3-day: ${btc3dayChange >= 0 ? "+" : ""}${btc3dayChange.toFixed(2)}% | 4H EMA: ${btc4hBearish ? "🔴 bear" : "✅ bull"}`);

        // Layer 1: today's crash (same as before)
        // Exception: bearSnapBack — extreme oversold bounces are specifically for crash days
        if (btcChange <= -3 && !bearSnapBack) {
          console.log(`🛑 BTC TREND BLOCK — BTC down ${btcChange.toFixed(2)}% today. Skipping new long entries.`);
          console.log("═══════════════════════════════════════════════════════════\n");
          pushSignal(symbol, "BLOCKED", `BTC down ${btcChange.toFixed(1)}% today — no longs in crash`);
          return;
        }
        // Layer 2: sustained multi-day downtrend — persists through the midnight reset
        // Fires when BTC is down >6% over 3 rolling days AND 4H structure is bearish.
        // No snap-back exception — during a sustained crash, oversold keeps going lower.
        // Data shows snap-back entries during -6%+ crashes produce outsized losses.
        if (btc3dayChange <= -6 && btc4hBearish) {
          console.log(`🛑 MULTI-DAY BEAR BLOCK — BTC down ${btc3dayChange.toFixed(2)}% over 3 days + 4H bearish. All entries blocked including snap-backs.`);
          console.log("═══════════════════════════════════════════════════════════\n");
          pushSignal(symbol, "BLOCKED", `Multi-day bear — BTC ${btc3dayChange.toFixed(1)}% over 3 days + 4H bearish`);
          return;
        }
      }
    } catch { /* non-critical — proceed if fetch fails */ }

    // Detect new listing — if < 168H of candle history, use momentum mode
    const isNewCoin = candles.length < 168;
    if (isNewCoin) {
      if (position && position.open) {
        console.log(`🚫 NEW COIN — already holding ${symbol}. Skipping re-entry.`);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }
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
        entryType: "momentum", entryConfidence: Math.round(momResults.filter(r => r.pass).length / momResults.length * 100),
        tradeSize, orderPlaced: false, orderId: null,
        paperTrading: CONFIG.paperTrading,
        limits: { maxTradeSizeUSD: CONFIG.maxTradeSizeUSD, maxTradesPerDay: CONFIG.maxTradesPerDay, tradesToday: countTodaysTrades(log) },
      };
      const listingTpPct = 0.10;
      const listingSlPct = 0.04;
      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER TRADE — would buy ${symbol} ~$${tradeSize.toFixed(2)} at market`);
        momEntry.orderPlaced = true;
        momEntry.orderId = `PAPER-${Date.now()}`;
        log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: (tradeSize / price).toFixed(6), orderId: momEntry.orderId, entryType: "momentum", tpPct: listingTpPct, slPct: listingSlPct } };
      } else {
        console.log(`\n🔴 PLACING LIVE MOMENTUM ORDER — $${tradeSize.toFixed(2)} BUY ${symbol}`);
        try {
          const order = await placeOrder(symbol, "buy", tradeSize, price);
          const actualQty = order.confirmedQty ?? (tradeSize / price);
          momEntry.orderPlaced = true;
          momEntry.orderId = order.orderId;
          log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: actualQty.toFixed(6), orderId: order.orderId, entryType: "momentum", tpPct: listingTpPct, slPct: listingSlPct } };
          const tpOrderId = await placeLimitSell(symbol, actualQty.toFixed(6), price * (1 + listingTpPct));
          if (tpOrderId) {
            const _tpLog = (() => { try { return loadLog(); } catch { return log; } })();
            if (_tpLog.positions?.[symbol]) { _tpLog.positions[symbol].tpOrderId = tpOrderId; saveLog(_tpLog); log.positions = _tpLog.positions; }
          }
          console.log(`✅ MOMENTUM ORDER PLACED — ${order.orderId} | qty: ${actualQty.toFixed(6)} | stop: -4% | TP: +10%`);
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
          momEntry.error = err.message;
        }
      }
      if (momEntry.orderPlaced) {
        const freshLog = (() => { try { return loadLog(); } catch { return log; } })();
        if (log.positions?.[symbol]) freshLog.positions = { ...(freshLog.positions || {}), [symbol]: log.positions[symbol] };
        if (!freshLog.coinCooldowns) freshLog.coinCooldowns = {};
        if (!freshLog.coinCooldowns[symbol]) freshLog.coinCooldowns[symbol] = {};
        freshLog.coinCooldowns[symbol].scalp = { until: Date.now() + 6 * 60 * 60 * 1000, pnlPct: "0.00", justBought: true };
        freshLog.trades.push(momEntry);
        saveLog(freshLog);
        writeTradeCsv(momEntry);
      }
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Same-day loss block — any losing exit on this coin today = no re-entry until tomorrow
    const todayDate = new Date().toISOString().slice(0, 10);
    const todayLossesOnSymbol = log.trades.filter(t =>
      t.type === "exit" && t.symbol === symbol && t.orderPlaced === true &&
      t.pnlPct !== undefined && t.pnlPct < 0 &&
      t.timestamp?.startsWith(todayDate)
    ).length;
    if (todayLossesOnSymbol >= 1) {
      console.log(`🚫 LOSS BLOCK — ${symbol} already lost today. No re-entry until tomorrow.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Lost on ${symbol} today — skipping until tomorrow`);
      return;
    }

    // ── Strategy selector — pick the approach with the highest expected return ──
    // Uses already-fetched candle data; zero extra API calls.
    // Swing (8% target, 1-5 days) beats scalp (1% target, 1-6h) when:
    //   • multiple timeframes align bullishly, AND
    //   • coin is genuinely oversold on 4H (not just a short-term noise dip)
    const openSwingCount = Object.values(log.swingPositions || {}).filter(p => p && p.open).length;
    const utcHour = new Date().getUTCHours();
    const swingOffHours = utcHour >= SWING.entryBlockH[0] || utcHour < SWING.entryBlockH[1]; // 22:00–06:00 UTC
    const weeklyOkForSwing = bullTrendWeekly !== false; // null = unknown (new coin) = allow; false = weekly bearish = block

    if (swingOffHours)       console.log(`  📊 Strategy: SCALP — swing off-hours (22:00–06:00 UTC)`);
    else if (!weeklyOkForSwing) console.log(`  📊 Strategy: SCALP — weekly trend bearish, no swing`);
    else if (openSwingCount >= SWING.maxOpen) console.log(`  📊 Strategy: SCALP — max swing positions (${SWING.maxOpen}) already open`);

    if (!vwapBounceMode && !(log.swingPositions || {})[symbol]?.open &&
        openSwingCount < SWING.maxOpen && !swingOffHours && weeklyOkForSwing) {
      const swingSetup = scoreSwingSetup(
        closes4h, candlesDay.map(c => c.close), closesWeek,
        bullTrend4h, rsi14_1h, adx, vol
      );
      const swingLabel = `Swing score ${swingSetup.score}/9: ${swingSetup.reasons.join(" | ") || "conditions not met"}`;
      console.log(`\n  📊 ${swingSetup.score >= 5 ? "🔄 SWING" : "📉 SCALP"} selected — ${swingLabel}`);

      if (swingSetup.score >= 5) {
        console.log(`   Swing targets +${(SWING.takeProfit * 100).toFixed(0)}% over 1-5 days vs scalp's +1% — better R:R here`);
        const swingSize = (log.portfolioValue || acct().portfolioValue) * SWING.sizePct;
        let qty = swingSize / price;
        let orderId = `PAPER-SWING-${Date.now()}`;

        if (!CONFIG.paperTrading) {
          try {
            const order = await placeOrder(symbol, "buy", swingSize, price);
            qty = order.confirmedQty ?? qty;
            orderId = order.orderId;
            console.log(`✅ SWING ORDER — ${orderId} | qty:${qty.toFixed(6)}`);
            emailEntry({ symbol, price, tradeSize: swingSize, orderId });
          } catch (e) {
            console.log(`❌ SWING ORDER FAILED — ${e.message}`);
            console.log("═══════════════════════════════════════════════════════════\n");
            return;
          }
        } else {
          console.log(`📋 PAPER SWING — $${swingSize.toFixed(2)} ${symbol} @ $${price.toFixed(4)} | TP:+${(SWING.takeProfit*100).toFixed(0)}% SL:-${(SWING.stopLoss*100).toFixed(0)}%`);
        }

        // Reload fresh to prevent concurrent writes clobbering other swing positions
        try { log.swingPositions = { ...(loadLog().swingPositions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: qty.toFixed(6), orderId, tradeType: "swing", partialExitDone: false, tpPct: SWING.takeProfit, slPct: SWING.stopLoss } }; } catch { log.swingPositions = { ...(log.swingPositions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: qty.toFixed(6), orderId, tradeType: "swing", partialExitDone: false, tpPct: SWING.takeProfit, slPct: SWING.stopLoss } }; }
        if (!CONFIG.paperTrading) {
          const tpOrderId = await placeLimitSell(symbol, qty.toFixed(6), price * (1 + SWING.takeProfit));
          if (tpOrderId) {
            const _tpLog = (() => { try { return loadLog(); } catch { return log; } })();
            if (_tpLog.swingPositions?.[symbol]) { _tpLog.swingPositions[symbol].tpOrderId = tpOrderId; saveLog(_tpLog); log.swingPositions = _tpLog.swingPositions; }
          }
        }
        const swingLog = {
          timestamp: new Date().toISOString(), type: "entry", symbol,
          timeframe: "4H", price, strategy: "swing", swingScore: swingSetup.score,
          tradeSize: swingSize, orderPlaced: true, orderId,
          paperTrading: CONFIG.paperTrading,
        };
        log.trades.push(swingLog);
        saveLog(log);
        writeTradeCsv(swingLog);
        pushSignal(symbol, "SWING ENTRY", `Score ${swingSetup.score}/9 — TP +${(SWING.takeProfit*100).toFixed(0)}% | ${swingSetup.reasons.slice(0, 2).join(", ")}`);
        _processingEntries.delete(symbol);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }
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

    // Reversal confirmation — need at least 3 signals to confirm the turn is real
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
    if (reversalSignals < 3 && !vwapBounceMode && !bearSnapBack) {
      console.log(`🚫 REVERSAL BLOCK — only ${reversalSignals}/3 reversal signals (live bounce: ${priceBouncing}, closing up: ${isClosingUp}, higher high: ${isHigherHigh}, higher low: ${isHigherLow}, long wick: ${hasLongWick})`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Weak reversal — only ${reversalSignals}/3 signals confirmed`);
      return;
    }
    const reversalReasons = [priceBouncing && "live bounce", isClosingUp && "closing up", isHigherHigh && "higher high", isHigherLow && "higher low", hasLongWick && "long wick"].filter(Boolean);
    const reversalBypassed = (vwapBounceMode || bearSnapBack) && reversalSignals < 3;
    console.log(`  ${reversalBypassed ? "⚡" : "✅"} Reversal ${reversalBypassed ? `bypassed (${vwapBounceMode ? "VWAP bounce" : "bear snap-back"}) — ${reversalSignals}/5 signals` : `confirmed — ${reversalReasons.join(" + ")} (${reversalSignals}/5 signals)`}`);

    // 1H RSI(14) trend gate — hourly trend must be at least neutral for any dip-buy entry
    // bearSnapBack exempt: in a crash 1H RSI will be 25-35 by design — that's the setup
    if (rsi14_1h !== null && rsi14_1h < 50 && !vwapBounceMode && !bearSnapBack) {
      console.log(`🚫 1H TREND BLOCK — 1H RSI(14)=${rsi14_1h.toFixed(1)} < 50. Hourly trend is bearish — buying a dip in a downtrend. Wait for 1H RSI to recover above 50.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `1H RSI(14) ${rsi14_1h.toFixed(1)} < 50 — hourly downtrend, no entry`);
      return;
    }
    if (rsi14_1h !== null) console.log(`  ✅ 1H RSI(14) ${rsi14_1h.toFixed(1)} ≥ 50 — hourly trend ok${bearSnapBack ? " (bypassed — bear snap-back)" : ""}`);

    // 4H trend hard gate — medium-term trend must be bullish to scalp bounces
    // bearSnapBack exempt: regime.btcTrend==="bear" implies 4H is bearish — this gate would always fire
    if (!bullTrend4h && !vwapBounceMode && !bearSnapBack) {
      console.log(`🚫 4H TREND BLOCK — 4H EMA(8) < EMA(21). Medium-term downtrend. Scalp bounces in a 4H downtrend fail. Wait for 4H to turn bullish.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `4H downtrend — EMA8 < EMA21, no scalp entries`);
      return;
    }
    if (bullTrend4h) console.log(`  ✅ 4H trend bullish — EMA(8) > EMA(21)`);
    else if (bearSnapBack) console.log(`  ⚡ 4H trend bearish — bypassed (bear snap-back)`);

    // MACD momentum gate — histogram must be improving; snap-back entries (below VWAP + RSI<25) need full bullish
    const macdPrev = calcMACD(closes.slice(0, -1));
    const macdImproving = macd.histogram > macdPrev.histogram;
    const isSnapBackEntry = vwap && price < vwap && rsi3 !== null && rsi3 < 25;
    if (!vwapBounceMode && !macd.bullish && (!macdImproving || isSnapBackEntry)) {
      if (isSnapBackEntry && macdImproving) {
        console.log(`🚫 MACD SNAP-BACK BLOCK — histogram ${macd.histogram.toFixed(4)} improving but still bearish. Below-VWAP snap-back entries require fully bullish MACD (histogram > 0).`);
        pushSignal(symbol, "BLOCKED", `MACD bearish (snap-back needs histogram > 0, got ${macd.histogram.toFixed(4)})`);
      } else {
        console.log(`🚫 MACD MOMENTUM BLOCK — histogram ${macd.histogram.toFixed(4)} ≤ prev ${macdPrev.histogram.toFixed(4)}. Momentum still falling — not safe to buy.`);
        pushSignal(symbol, "BLOCKED", `MACD momentum falling — wait for histogram to turn up`);
      }
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
    console.log(`  ${macdImproving ? "✅" : "⚠️ "} MACD histogram ${macd.histogram.toFixed(4)} ${macdImproving ? "improving ↑" : "(bullish — ok)"}`);

    // Fix 2: Volume acceleration — require flat-to-rising volume (buyers present, not retreating)
    const curVol  = candles[candles.length - 1].volume;
    const prevVol = candles[candles.length - 2].volume;
    const volAccel = curVol / prevVol;
    if (!vwapBounceMode && !bearSnapBack && volAccel < 1.0) {
      console.log(`🚫 VOLUME BLOCK — volume declining (${volAccel.toFixed(2)}× prev candle). Need flat or rising volume to confirm buying pressure.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Volume declining ${volAccel.toFixed(2)}× — need ≥1.0× for buying pressure`);
      return;
    }
    console.log(`  ${volAccel >= 1.0 ? "✅" : "⚠️ "} Volume ${volAccel >= 1.5 ? "surging" : volAccel >= 1.0 ? "holding/rising" : "light"} (${volAccel.toFixed(2)}× prev candle)${(vwapBounceMode || bearSnapBack) && volAccel < 1.0 ? " — bypassed (VWAP bounce / snap-back)" : ""}`);

    // Sustained volume gate — 3-bar average must be ≥ 100% of 20-bar avg.
    // bearSnapBack uses 50% threshold: crash dump candles inflate the 20-bar avg, so bounce candles
    // will always look thin by comparison. Require some volume but not full avg.
    const volThreshold = bearSnapBack ? 0.50 : 1.00;
    if (vol && vol.vol3Ratio < volThreshold) {
      console.log(`🚫 VOLUME GATE — 3-bar avg volume only ${(vol.vol3Ratio * 100).toFixed(0)}% of 20-bar avg (need ${(volThreshold * 100).toFixed(0)}%+). Volume not sustained.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Thin volume — 3-bar avg ${(vol.vol3Ratio * 100).toFixed(0)}% of avg (need ${(volThreshold * 100).toFixed(0)}%)`);
      return;
    }
    if (vol) console.log(`  ✅ Volume sustained — 3-bar avg ${(vol.vol3Ratio * 100).toFixed(0)}% of 20-bar avg (threshold ${(volThreshold * 100).toFixed(0)}%)`);

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
    if (btResult && btResult.recommendation === "SKIP") {
      console.log(`🚫 BACKTEST BLOCK — ${symbol} has ${btResult.winRate}% win rate over ${btResult.trades} trades (need 65%+). Skipping.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Backtest WR ${btResult.winRate}% across ${btResult.trades} trades — need 65%+`);
      return;
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
    const hasBtThreshold = !!BACKTEST[symbol]?.rsiThreshold;
    const effectiveRsiThreshold = hasBtThreshold ? coinRsiThreshold : Math.min(adaptive.rsiThreshold, coinRsiThreshold);
    const { results, allPass: rulesPass, entryType, entryScore: baseEntryScore } = runSafetyCheck(price, ema8, vwap, rsi3, rules, effectiveRsiThreshold, vol, ema21, bullTrendConfirmed, adx, stochRsi, divergence, bb, vwapBounceMode);

    // OBV bear divergence — smart money distributing into price rise = skip entry
    // bearSnapBack exempt: during capitulation, institutions sell into ANY bounce by definition
    if (obv.bearDivergence && !bearSnapBack) {
      console.log(`🚫 OBV DIVERGENCE BLOCK — price rising but OBV falling. Institutions are selling into this rally.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", "OBV bear divergence — smart money selling into rally");
      return;
    }

    // ── Advanced signal augmentation (ICT, SMC, Wyckoff, funding rate, macro sentiment) ────
    const liquiditySweep = detectLiquiditySweep(candles);
    let entryScore = baseEntryScore;
    const advSignals = [];

    // ── Patterns ──
    if (liquiditySweep)                                  { entryScore += 3; advSignals.push("🎯 Liquidity sweep"); }
    if (doubleBottom?.detected && doubleBottom.strongConfirmation) { entryScore += 3; advSignals.push("📐 Double bottom + RSI div"); }
    else if (doubleBottom?.detected)                     { entryScore += 2; advSignals.push("📐 Double bottom"); }
    if (bearDiv)                                         { entryScore -= 3; advSignals.push("⚠️  Bearish RSI divergence — momentum exhausting"); }

    // ── Funding + OBV ──
    if (fundingRate !== null && fundingRate < -0.0003)   { entryScore += 2; advSignals.push(`💰 Funding ${(fundingRate*100).toFixed(4)}% (shorts overloaded)`); }
    if (obv.rising)                                      { entryScore += 1; advSignals.push("📈 OBV rising"); }

    // ── BTC macro sentiment ──
    if (btcDailyRsi !== null && btcDailyRsi < 35)        { entryScore += 1; advSignals.push(`😱 BTC fear RSI ${btcDailyRsi.toFixed(1)}`); }
    if (btcDailyRsi !== null && btcDailyRsi > 70)        { entryScore -= 1; advSignals.push(`🤑 BTC greed RSI ${btcDailyRsi.toFixed(1)}`); }
    // Relative strength vs BTC: coin RSI > BTC RSI = outperforming = alpha signal
    if (btcDailyRsi !== null && rsi3 > btcDailyRsi + 10) { entryScore += 1; advSignals.push(`💪 Relative strength (RSI ${rsi3.toFixed(0)} vs BTC ${btcDailyRsi.toFixed(0)})`); }

    // ── Research-backed indicators ──
    // Supertrend 58-62% WR | FVG fills 70% | Z-score ±2σ mean reversion
    if (supertrend?.bullish)                             { entryScore += 2; advSignals.push("📈 Supertrend bullish"); }
    if (!supertrend?.bullish && supertrend !== null)     { entryScore -= 1; advSignals.push("📉 Supertrend bearish"); }
    if (fvg?.inFVG)                                      { entryScore += 3; advSignals.push(`📊 In bullish FVG ($${fvg.fvgLow.toFixed(4)}–$${fvg.fvgHigh.toFixed(4)})`); }
    else if (fvg?.bullish && fvg.age <= 4)               { entryScore += 1; advSignals.push("📊 Recent FVG above"); }
    if (zScore !== null && zScore < -2.0)                { entryScore += 2; advSignals.push(`📉 Z-score ${zScore.toFixed(2)}σ (statistically oversold)`); }
    else if (zScore !== null && zScore < -1.5)           { entryScore += 1; advSignals.push(`📉 Z-score ${zScore.toFixed(2)}σ`); }

    // ── Volume Profile (POC + Value Area) ──
    if (vpoc !== null) {
      if (vpoc.atVAL)   { entryScore += 2; advSignals.push(`📊 At Value Area Low $${vpoc.val.toFixed(4)} — institutional support`); }
      else if (vpoc.belowVAL) { entryScore += 1; advSignals.push(`📊 Below Value Area — deep discount zone`); }
      if (vpoc.atPOC)   { entryScore += 1; advSignals.push(`🎯 At Volume POC $${vpoc.poc.toFixed(4)}`); }
      if (vpoc.atVAH)   { entryScore -= 1; advSignals.push(`📊 At Value Area High $${vpoc.vah.toFixed(4)} — resistance zone`); }
    }

    // ── Order Block (SMC) — institutional buying zone retest ──
    if (orderBlock?.inOB)                                { entryScore += 3; advSignals.push(`🏦 At Order Block ($${orderBlock.obLow.toFixed(4)}–$${orderBlock.obHigh.toFixed(4)})`); }
    else if (orderBlock && orderBlock.distToOB < 0.5)   { entryScore += 1; advSignals.push(`🏦 Near Order Block ($${orderBlock.distToOB.toFixed(2)}% away)`); }

    // ── Market Structure (BOS / ChoCH) ──
    if (mktStructure) {
      if (mktStructure.trend === "uptrend")              { entryScore += 2; advSignals.push(`📊 Market structure: uptrend (HH+HL)`); }
      if (mktStructure.trend === "downtrend")            { entryScore -= 2; advSignals.push(`📊 Market structure: downtrend (LH+LL)`); }
      if (mktStructure.bos)                              { entryScore += 2; advSignals.push(`🔥 Break of Structure (BOS) — trend continuation`); }
      if (mktStructure.choch)                            { entryScore -= 1; advSignals.push(`⚠️  Change of Character (ChoCH) — trend shift warning`); }
    }

    // ── ICT Kill Zone — skip dead zone penalty during extreme fear (panic ignores the clock) ──
    const extremeFear = fearGreed && fearGreed.value <= 20;
    if (killZone.score > 0)                              { entryScore += killZone.score; advSignals.push(`⏰ ${killZone.zone} kill zone (+${killZone.score})`); }
    if (killZone.score < 0 && !extremeFear)              { entryScore += killZone.score; advSignals.push(`💤 ${killZone.zone} — low institutional liquidity (-1)`); }
    if (killZone.score < 0 && extremeFear)               { advSignals.push(`💤 ${killZone.zone} — penalty waived (Extreme Fear overrides session timing)`); }

    // ── Ichimoku Cloud signals — scalp TF + 4H confirmation ──
    if (ichi) {
      if (ichi.aboveCloud && ichi.bullishCross)          { entryScore += 3; advSignals.push("☁️  Above cloud + TK cross"); }
      else if (ichi.aboveCloud)                          { entryScore += 2; advSignals.push("☁️  Above Ichimoku cloud"); }
      else if (ichi.bullishCross)                        { entryScore += 1; advSignals.push("☁️  TK cross (tenkan > kijun)"); }
      else if (ichi.belowCloud)                          { entryScore -= 1; advSignals.push("☁️  Below cloud — bearish bias"); }
      // Kijun as dynamic support — price near kijun is a high-probability bounce zone
      const distToKijun = Math.abs((price - ichi.kijun) / ichi.kijun * 100);
      if (distToKijun < 0.5)                            { entryScore += 1; advSignals.push(`☁️  At Kijun support $${ichi.kijun.toFixed(4)}`); }
    }
    if (ichi4h) {
      if (ichi4h.aboveCloud)                            { entryScore += 2; advSignals.push("☁️  4H above cloud (macro bull)"); }
      else if (ichi4h.belowCloud)                       { entryScore -= 2; advSignals.push("☁️  4H below cloud (macro bear)"); }
    }

    // ── Fear & Greed + Capitulation ──
    // Extreme Fear (<20): 90-day median +48.5% return | Extreme Greed (>80): high crash risk
    if (fearGreed) {
      const fg = fearGreed.value;
      if (fg <= 20)       { entryScore += 3; advSignals.push(`😱 Extreme Fear F&G=${fg} — contrarian buy (90d median +48%)`); }
      else if (fg <= 35)  { entryScore += 2; advSignals.push(`😟 Fear F&G=${fg} — market pessimistic, good entry zone`); }
      else if (fg >= 80)  { entryScore -= 3; advSignals.push(`🤑 Extreme Greed F&G=${fg} — euphoria, high reversal risk`); }
      else if (fg >= 65)  { entryScore -= 1; advSignals.push(`😏 Greed F&G=${fg} — cautious`); }
      // Capitulation setup: Extreme Fear + RSI extreme + volume spike = high-probability bottom
      const volRatioNow = vol ? vol.current / vol.avg : 0;
      if (fg <= 20 && rsi3 < 20 && volRatioNow >= 2.0) {
        entryScore += 3;
        advSignals.push(`🎰 CAPITULATION SIGNAL — F&G=${fg} + RSI=${rsi3.toFixed(1)} + Vol=${volRatioNow.toFixed(1)}x (panic bottom setup)`);
      }
    }
    if (advSignals.length > 0) {
      console.log(`\n  ⚡ Advanced signals: ${advSignals.join(" | ")}`);
      console.log(`  Score: ${baseEntryScore} (base) → ${entryScore} (with advanced signals)`);
    }

    // Entry quality gate — thresholds adapt to Fear & Greed sentiment
    // Normal: trend-follow needs 8, snapback needs 7 (raised from 7/6 — more signals now available)
    // Extreme Fear (F&G ≤ 20): lower by 2 — historically 90-day median +48.5% from these levels
    // Extreme Fear (F&G ≤ 10): lower by 3 — maximum contrarian signal, highest base rate
    const fgNow = fearGreed?.value ?? 50;
    const fearDiscount = fgNow <= 10 ? 3 : fgNow <= 20 ? 2 : 0;
    const tfThreshold   = 8 - fearDiscount;
    const snapThreshold = 7 - fearDiscount;
    if (fearDiscount > 0) console.log(`\n😱 FEAR BOUNCE MODE — F&G=${fgNow} (Extreme Fear). Entry thresholds lowered by ${fearDiscount} (trend-follow: ${tfThreshold}, snapback: ${snapThreshold}).`);
    if (rulesPass && entryType === "trend-follow" && entryScore < tfThreshold && !vwapBounceMode) {
      console.log(`🚫 ENTRY QUALITY BLOCK — score ${entryScore}/${tfThreshold} needed.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Entry quality ${entryScore}/${tfThreshold} — need stronger confluence`);
      return;
    }
    if (rulesPass && entryType === "snapback" && entryScore < snapThreshold && !vwapBounceMode) {
      console.log(`🚫 SNAPBACK QUALITY BLOCK — score ${entryScore}/${snapThreshold} needed.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `Snapback quality ${entryScore}/${snapThreshold} — need StochRSI + BB% + more`);
      return;
    }

    // StochRSI entry gate — must be genuinely oversold to enter (K < 40)
    // Entering at K=50 leaves only 38 points to the exit target (K=88); entering at K=20 leaves 68.
    // Less room to bounce = lower win rate. Require oversold zone for reliable exits.
    if (rulesPass && stochRsi && stochRsi.k > 40 && !vwapBounceMode && !bearSnapBack) {
      console.log(`🚫 STOCHRSI BLOCK — K=${stochRsi.k.toFixed(1)} not deeply oversold (need < 40). Bounce has less room to develop.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      pushSignal(symbol, "BLOCKED", `StochRSI K=${stochRsi.k.toFixed(1)} — need <40 for reliable bounce`);
      return;
    }

    let claudeAnalysis = null;
    let allPass = rulesPass;

    // Only spend a Claude call on very high-conviction entries:
    // RSI(3) must be deeply oversold (<30) and volume above avg (if known)
    const highConviction = rsi3 < 30 && (vol ? vol.aboveAvg : true);

    const claudeStatus = claudeAvailable();
    if (claudeStatus !== "ok") {
      console.log(`\n💰 Claude skipped — ${claudeStatus === "daily-cap" ? `daily cap (${_claudeCallsToday}/${CLAUDE_DAILY_CAP})` : `global cooldown (${Math.round((CLAUDE_GLOBAL_COOLDOWN_MS - (Date.now() - _lastClaudeCallMs)) / 60000)}min left)`}`);
      // Synthetic confidence gate — prevents weak entries slipping through without AI validation.
      // Scores RSI depth, volume surge, trend alignment, MACD. Requires ≥65/100 to proceed.
      if (rulesPass) {
        const rsiScore     = rsi3 < 15 ? 35 : rsi3 < 20 ? 25 : rsi3 < 25 ? 15 : rsi3 < 30 ? 5 : 0;
        const volRatioNow  = vol ? vol.current / vol.avg : 0;
        const volScore     = volRatioNow >= 2.0 ? 25 : volRatioNow >= 1.5 ? 15 : (vol?.aboveAvg ? 5 : 0);
        const trendScore   = (bullTrendConfirmed ? 15 : 0) + (bullTrend1h ? 10 : 0);
        const macdScore    = macd.bullish ? 10 : 0;
        const zScoreScore  = zScore !== null ? (zScore < -2.5 ? 15 : zScore < -2.0 ? 10 : zScore < -1.5 ? 5 : 0) : 0;
        const stScore      = supertrend?.bullish ? 5 : 0;
        const fvgScore     = fvg?.inFVG ? 5 : 0;
        const ichiScore    = ichi ? (ichi.aboveCloud && ichi.bullishCross ? 10 : ichi.aboveCloud ? 7 : ichi.bullishCross ? 4 : ichi.belowCloud ? -5 : 0) : 0;
        const ichi4hScore  = ichi4h ? (ichi4h.aboveCloud ? 5 : ichi4h.belowCloud ? -5 : 0) : 0;
        const obScore      = orderBlock?.inOB ? 8 : 0;
        const msScore      = mktStructure ? ((mktStructure.trend === "uptrend" ? 8 : mktStructure.trend === "downtrend" ? -8 : 0) + (mktStructure.bos ? 5 : 0) + (mktStructure.choch ? -3 : 0)) : 0;
        const kzScore      = (killZone.score || 0) * 3; // London/NY = +6, Dead zone = -3
        const vaScore      = vpoc ? (vpoc.atVAL ? 5 : vpoc.belowVAL ? 3 : vpoc.atVAH ? -3 : 0) : 0;
        const bearDivScore = bearDiv ? -10 : 0;
        const syntheticConf = rsiScore + volScore + trendScore + macdScore + zScoreScore + stScore + fvgScore + ichiScore + ichi4hScore + obScore + msScore + kzScore + vaScore + bearDivScore;
        // Threshold adapts to Fear & Greed — same logic as entry score gates above
        const fgNowSC = fearGreed?.value ?? 50;
        const fearDiscountSC = fgNowSC <= 10 ? 15 : fgNowSC <= 20 ? 10 : 0;
        const confThreshold = 65 - fearDiscountSC;
        console.log(`\n🧠 SYNTHETIC CONFIDENCE — RSI ${rsiScore} + Vol ${volScore} + Trend ${trendScore} + MACD ${macdScore} + Z ${zScoreScore} + ST ${stScore} + FVG ${fvgScore} + Ichi ${ichiScore + ichi4hScore} + OB ${obScore} + MS ${msScore} + KZ ${kzScore} + VA ${vaScore} + BearDiv ${bearDivScore} = ${syntheticConf} (need ${confThreshold})`);
        if (syntheticConf < confThreshold) {
          console.log(`🚫 CONFIDENCE GATE — score ${syntheticConf}/${confThreshold} too low. Blocking entry (Claude unavailable).`);
          allPass = false;
        } else {
          console.log(`✅ CONFIDENCE GATE — score ${syntheticConf}/${confThreshold} clears threshold. Proceeding without Claude.`);
        }
      }
    } else if (!highConviction) {
      console.log(`\n⏩ Claude skipped — setup not high-conviction enough (RSI ${rsi3.toFixed(1)}${vol ? `, vol ${vol.aboveAvg ? "✅" : "⚠️"}` : ""})`);
    }

    if (anthropic && rulesPass && highConviction && claudeStatus === "ok") {
      console.log("\n── Claude AI Analysis ───────────────────────────────────\n");
      try {
        claudeAnalysis = await analyzeWithClaude(price, ema8, vwap, rsi3, log.trades, null, tvSignal, { ema21, macd, bb, adx, patterns, sr, bullTrend4h: bullTrendConfirmed, vol }, symbol);
        recordClaudeCall();
        const meetsConfidence = claudeAnalysis.confidence >= CONFIDENCE_MIN;
        allPass = claudeAnalysis.action === "BUY" && meetsConfidence;
        console.log(`  Decision:   ${claudeAnalysis.action} (${claudeAnalysis.confidence}% confidence) [${_claudeCallsToday}/${CLAUDE_DAILY_CAP} today]`);
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
      logEntry.entryConfidence = claudeAnalysis?.confidence ?? Math.round(confidenceMultiplier * 100);
      console.log(`\n📊 Confidence score: ${bonusSignals}/${maxBonus} bonus signals → ${(confidenceMultiplier * 100).toFixed(0)}% position size ($${finalTradeSize.toFixed(2)})`);

      // Watchlist alert — prominent console notice so it shows up in pm2 logs
      if (WATCHLIST.includes(symbol)) {
        console.log(`\n🔔🔔🔔 WATCHLIST ALERT — ${symbol} @ $${price.toFixed(4)}`);
        console.log(`   RSI(3):${rsi3.toFixed(1)}  VWAP:${vwap.toFixed(4)}  EMA8:${ema8.toFixed(4)}`);
        console.log(`   Entry type: ${entryType}  — all conditions met, buying now`);
        console.log(`🔔🔔🔔\n`);
      }

      // NaN guard — if any scaling factor produced NaN, abort before touching exchange
      if (!finalTradeSize || isNaN(finalTradeSize) || finalTradeSize < 1) {
        console.log(`\n🚫 SIZE GUARD — finalTradeSize=${finalTradeSize} is invalid (NaN/zero/too small). Skipping entry.`);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
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

      const posTpPct = bearSnapBack ? 0.03 : entryType === "momentum" ? 0.10 : (btResult?.takeProfit ?? 0.08);
      const posSlPct = bearSnapBack ? 0.02 : (btResult?.stopLoss ?? 0.04);

      if (slippageOk && CONFIG.paperTrading) {
        console.log(`\n📋 PAPER TRADE — would buy ${symbol} ~$${finalTradeSize.toFixed(2)} at market`);
        console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-${Date.now()}`;
        log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: (finalTradeSize / price).toFixed(6), orderId: logEntry.orderId, entryType, bearMarket: bullTrendWeekly === false, bearSnapBack, tpPct: posTpPct, slPct: posSlPct } };
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
          // Reload fresh to prevent concurrent writes from clobbering other positions
          try { log.positions = { ...(loadLog().positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: actualQty.toFixed(6), orderId: order.orderId, entryType, bearMarket: bullTrendWeekly === false, bearSnapBack, tpPct: posTpPct, slPct: posSlPct } }; } catch { log.positions = { ...(log.positions || {}), [symbol]: { open: true, side: "long", entryPrice: price, highWatermark: price, entryTime: new Date().toISOString(), quantity: actualQty.toFixed(6), orderId: order.orderId, entryType, bearMarket: bullTrendWeekly === false, bearSnapBack, tpPct: posTpPct, slPct: posSlPct } }; }
          console.log(`✅ ORDER PLACED — ${order.orderId} | qty: ${actualQty.toFixed(6)}`);
          // Place resting GTC limit sell at TP price — exchange executes to the millisecond
          const tpLimitPrice = price * (1 + posTpPct);
          const tpOrderId = await placeLimitSell(symbol, actualQty.toFixed(6), tpLimitPrice);
          if (tpOrderId) {
            const _tpLog = (() => { try { return loadLog(); } catch { return log; } })();
            if (_tpLog.positions?.[symbol]) { _tpLog.positions[symbol].tpOrderId = tpOrderId; saveLog(_tpLog); log.positions = _tpLog.positions; }
          }
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
      if (logEntry.orderPlaced && logEntry.type === "entry") {
        // Atomic read-modify-write — reload from disk so concurrent symbol saves
        // don't overwrite each other's positions or cooldowns.
        const freshLog = (() => { try { return loadLog(); } catch { return log; } })();
        if (log.positions?.[symbol]) freshLog.positions = { ...(freshLog.positions || {}), [symbol]: log.positions[symbol] };
        if (!freshLog.coinCooldowns) freshLog.coinCooldowns = {};
        if (!freshLog.coinCooldowns[symbol]) freshLog.coinCooldowns[symbol] = {};
        freshLog.coinCooldowns[symbol].scalp = { until: Date.now() + 6 * 60 * 60 * 1000, pnlPct: "0.00", justBought: true };
        freshLog.trades.push(logEntry);
        const placed = freshLog.trades.filter(t => t.orderPlaced);
        const unplaced = freshLog.trades.filter(t => !t.orderPlaced).slice(-200);
        freshLog.trades = [...placed, ...unplaced].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        saveLog(freshLog);
      } else {
        log.trades.push(logEntry);
        const placed = log.trades.filter(t => t.orderPlaced);
        const unplaced = log.trades.filter(t => !t.orderPlaced).slice(-200);
        log.trades = [...placed, ...unplaced].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        saveLog(log);
      }
      if (logEntry.orderPlaced) {
        console.log(`\nDecision log saved → ${LOG_FILE}`);
        writeTradeCsv(logEntry);
      }
    }

    } finally {
      _processingEntries.delete(symbol);
    }
  }

  console.log("═══════════════════════════════════════════════════════════\n");
  } finally {
    _runningSymbols.delete(symbol);
  }
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
    const winRate = calcWinRate(log.trades || [], 10); // used for adaptive mode decisions
    // Display win rate: last 20 trades within the past 7 days — reflects current strategy, not old code
    const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent7d = (log.trades || []).filter(t =>
      t.type === "exit" && t.pnlPct !== undefined && t.orderPlaced === true &&
      (t.timestamp || "") >= cutoff7d
    ).slice(-20);
    const displayWinRate = recent7d.length >= 2 ? (() => {
      const w = recent7d.filter(t => t.pnlPct > 0.25).length;
      return { wins: w, sample: recent7d.length, winRate: w / recent7d.length };
    })() : winRate;
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
    // Build a price fallback from _topGainers for coins not in coinSnapshots (e.g. LT positions)
    const tickerPrices = Object.fromEntries((_topGainers || []).map(t => [t.symbol, t.price]));
    // Add live BitGet coin holdings not yet tracked in log
    for (const asset of liveAssets) {
      if (asset.coin === "USDT" || asset.coin === "BGB" || asset.coin === "USDC") continue;
      const qty = parseFloat(asset.available) + parseFloat(asset.frozen || 0);
      if (qty < 0.000001) continue;
      const sym = asset.coin + "USDT";
      if (seenSyms.has(sym)) continue;
      const snap = coinSnapshots[sym];
      const price = snap?.price ?? tickerPrices[sym] ?? 0;
      if (price < 0.000001) continue;
      const usdVal = qty * price;
      if (usdVal < 1) continue;
      openPositionValue += usdVal;
      // Check if this is an LT or swing position
      const ltPos = (log.ltPositions || {})[sym];
      const swingPos = (log.swingPositions || {})[sym];
      const trackedPos = ltPos?.open ? ltPos : swingPos?.open ? swingPos : null;
      const entryPrice = trackedPos?.entryPrice ?? trackedPos?.avgEntry ?? null;
      const pnlPct = entryPrice ? ((price - entryPrice) / entryPrice) * 100 : null;
      const pnlUSD = entryPrice ? qty * (price - entryPrice) : null;
      const entryType = ltPos?.open ? "lt" : swingPos?.open ? "swing" : "untracked";
      seenSyms.add(sym);
      openPositions.push({ coin: asset.coin, sym, qty, usdVal, price, entryPrice, pnlPct, pnlUSD, entryType });
    }
    // Add open sniper positions
    for (const [sym, pos] of Object.entries(log.sniperPositions || {})) {
      if (!pos?.open) continue;
      if (seenSyms.has(sym)) continue;
      seenSyms.add(sym);
      const baseCoin = sym.replace("USDT", "");
      const snapPrice = coinSnapshots[sym]?.price ?? 0;
      const qty = parseFloat(pos.quantity || 0);
      if (qty < 0.000001 || snapPrice < 0.000001) continue;
      const usdVal = qty * snapPrice;
      const pnlPct = pos.entryPrice ? ((snapPrice - pos.entryPrice) / pos.entryPrice) * 100 : null;
      const pnlUSD = pos.entryPrice ? qty * (snapPrice - pos.entryPrice) : null;
      const minsOpen = pos.entryTime ? Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 60000) : null;
      const minsLeft = pos.maxHoldUntil ? Math.max(0, Math.round((new Date(pos.maxHoldUntil).getTime() - Date.now()) / 60000)) : null;
      const hwm = pos.highWatermark ?? pos.entryPrice;
      const trailActive = hwm >= pos.entryPrice * (1 + SNIPER.trailActivatePct);
      const trailStop = trailActive ? hwm * (1 - SNIPER.trailPct) : null;
      openPositions.push({ coin: baseCoin, sym, qty, usdVal, price: snapPrice, entryPrice: pos.entryPrice, pnlPct, pnlUSD, minsOpen, entryType: "sniper", minsLeft, trailActive, trailStop, slPct: SNIPER.stopLossPct });
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

    // Per-strategy stats — classify each closed trade by how it was entered
    const allEntries = (log.trades || []).filter(t => t.type === "entry" && t.orderPlaced);
    function stratStats(exits, entries) {
      if (!exits.length) return null;
      const w = exits.filter(t => t.pnlPct > 0.25).length;
      const l = exits.length - w;
      const wr = w / exits.length;
      const avgW = w ? exits.filter(t => t.pnlPct > 0.25).reduce((s,t) => s + t.pnlPct, 0) / w : null;
      const avgL = l ? exits.filter(t => t.pnlPct <= 0.25).reduce((s,t) => s + t.pnlPct, 0) / l : null;
      const exp = exits.length >= 2 ? (wr*(avgW??0) + (1-wr)*(avgL??0)) : null;
      // Avg entry confidence — uses entryConfidence field (stored at entry time for all strategies)
      // or falls back to claudeAnalysis.confidence for older scalp entries
      const confVals = (entries || []).map(e => e.entryConfidence ?? e.claudeAnalysis?.confidence).filter(c => c != null);
      const avgConf = confVals.length ? Math.round(confVals.reduce((s,c) => s+c, 0) / confVals.length) : null;
      return { wins: w, losses: l, total: exits.length, wrPct: +(wr*100).toFixed(0),
               avgWin: avgW!=null?+avgW.toFixed(2):null, avgLoss: avgL!=null?+avgL.toFixed(2):null,
               expectancy: exp!=null?+exp.toFixed(2):null, avgConf };
    }
    const strats = {
      scalp:    stratStats(allExits.filter(t => !t.tradeType && (t.entryType==="scalp"||t.entryType==="snapback"||t.entryType==="trend-follow"||!t.entryType)), allEntries.filter(t => !t.tradeType && (t.entryType==="scalp"||t.entryType==="snapback"||t.entryType==="trend-follow"||!t.entryType))),
      momentum: stratStats(allExits.filter(t => t.entryType==="momentum"), allEntries.filter(t => t.entryType==="momentum")),
      sniper:   stratStats(allExits.filter(t => t.tradeType==="sniper"), allEntries.filter(t => t.tradeType==="sniper")),
      swing:    stratStats(allExits.filter(t => t.tradeType==="swing"), allEntries.filter(t => t.tradeType==="swing")),
      lt:       stratStats(allExits.filter(t => t.tradeType==="longterm"), allEntries.filter(t => t.tradeType==="longterm")),
    };
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
      winRate: csvStats ? csvStats.winRateStr : (displayWinRate ? `${displayWinRate.wins}/${displayWinRate.sample} (${(displayWinRate.winRate * 100).toFixed(0)}%) 7d` : "—"),
      winRatePct: csvStats ? csvStats.winRatePct : (displayWinRate ? displayWinRate.winRate * 100 : null),
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
      lastTrades: (log.trades || []).slice(-20).reverse(),
      totalFeesPaid: (() => {
        if (!existsSync(CSV_FILE)) return 0;
        return readFileSync(CSV_FILE, "utf8").split("\n")
          .filter(l => l.includes(",LIVE,"))
          .reduce((s, l) => { const f = parseFloat(l.split(",")[8]); return s + (isNaN(f) ? 0 : f); }, 0);
      })(),
      strats,
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
    // ── tab helper ──────────────────────────────────────────────────
    // (full tabbed UI built below — legacy variables kept for shared HTML fragments)

    const posHTML = d.openPositions.length === 0
      ? `<div style="padding:28px 16px;text-align:center;color:#8B8FA8;font-size:13px">All cash — no open positions</div>`
      : d.openPositions.map(p => {
          const pc = p.pnlPct != null ? (p.pnlPct >= 0 ? "#26D9A4" : "#F04D4D") : "#2F7EFF";
          const hasEntry = p.entryPrice != null && p.slPct != null && p.tpPct != null;
          const slPct = hasEntry ? p.slPct * 100 : 0;
          const tpPct = hasEntry ? p.tpPct * 100 : 0;
          const slPrice = hasEntry ? (p.entryPrice * (1 - p.slPct)).toFixed(4) : "—";
          const tpPrice = hasEntry ? (p.entryPrice * (1 + p.tpPct)).toFixed(4) : "—";
          const range = hasEntry ? (tpPct + slPct) : 100;
          const progress = hasEntry && p.pnlPct != null ? Math.min(100, Math.max(0, ((p.pnlPct + slPct) / range) * 100)) : 50;
          const timeStr = p.minsOpen != null ? (p.minsOpen >= 60 ? `${Math.floor(p.minsOpen/60)}h ${p.minsOpen%60}m` : `${p.minsOpen}m`) : "—";
          const typeLabel = p.entryType === "sniper" ? "SNIPER" : p.entryType === "momentum" ? "MOMENTUM" : p.entryType === "snapback" ? "SNAP-BACK" : p.entryType === "lt" ? "LONG-TERM" : p.entryType === "swing" ? "SWING" : p.entryType === "untracked" ? "LIVE" : "SCALP";
          const typeBg = p.entryType === "sniper" ? "rgba(247,181,0,.12)" : p.entryType === "momentum" ? "rgba(47,126,255,.12)" : p.entryType === "lt" ? "rgba(167,139,250,.12)" : p.entryType === "swing" ? "rgba(255,184,0,.12)" : "rgba(38,217,164,.12)";
          const typeClr = p.entryType === "sniper" ? "#F7B500" : p.entryType === "momentum" ? "#2F7EFF" : p.entryType === "lt" ? "#a78bfa" : p.entryType === "swing" ? "#FFB800" : "#26D9A4";
          const stopLabel = p.entryType === "sniper"
            ? (p.trailActive ? `Trail $${p.trailStop?.toFixed(4) ?? "—"}` : `Trail activates +${(SNIPER.trailActivatePct*100).toFixed(0)}%`)
            : p.breakEvenActive ? `BE stop $${p.trailStop?.toFixed(4) ?? "—"}` : hasEntry ? `SL $${slPrice}` : "—";
          return `<a href="/coin?symbol=${p.sym}&pin=${pin}" style="display:block;padding:16px;border-bottom:1px solid rgba(255,255,255,0.05);text-decoration:none;color:inherit">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <div style="display:flex;align-items:center;gap:12px">
                <div style="width:42px;height:42px;border-radius:50%;background:${pc}18;color:${pc};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0">${p.coin.slice(0,3)}</div>
                <div>
                  <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                    <span style="font-size:15px;font-weight:700">${p.coin}</span>
                    <span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;background:${typeBg};color:${typeClr}">${typeLabel}</span>
                  </div>
                  <div style="font-size:11px;color:#8B8FA8">${timeStr} &middot; $${Number(p.usdVal).toFixed(2)} &middot; $${Number(p.price).toFixed(4)}</div>
                </div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:18px;font-weight:700;color:${pc}">${p.pnlPct != null ? (p.pnlPct >= 0 ? "+" : "") + Number(p.pnlPct).toFixed(2) + "%" : "—"}</div>
                <div style="font-size:12px;font-weight:600;color:${pc}">${p.pnlUSD != null ? (p.pnlUSD >= 0 ? "+" : "") + "$" + Math.abs(Number(p.pnlUSD)).toFixed(2) : ""}</div>
              </div>
            </div>
            <div style="background:rgba(255,255,255,0.07);border-radius:99px;height:4px;overflow:hidden;margin-bottom:8px">
              <div style="height:100%;width:${progress}%;background:${pc};border-radius:99px;transition:width .3s"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px">
              <span style="color:#F04D4D">▼ ${stopLabel}</span>
              <span style="color:#26D9A4">▲ ${hasEntry ? `TP +${tpPct.toFixed(0)}% ($${tpPrice})` : "—"}</span>
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

    // ── Daily goal block (reusable) ──────────────────────────────
    const goalPct = 3;
    const goalUSD = pf * goalPct / 100;
    const earnedUSD = Math.max(0, d.todayGainUSD || 0);
    const goalProgress = Math.min(100, Math.max(0, (earnedUSD / goalUSD) * 100));
    const goalRemaining = Math.max(0, goalUSD - earnedUSD);
    const goalColor = goalProgress >= 100 ? "#00d4a0" : goalProgress >= 50 ? "#ffb800" : "#4f8dff";
    const goalIcon = goalProgress >= 100 ? "🏆" : goalProgress >= 75 ? "🔥" : goalProgress >= 50 ? "⚡" : "🎯";
    const openGain = d.unrealizedPnlUSD ?? 0;
    const realizedGain = d.todayPnlUSD ?? 0;
    const goalSubLabel = goalProgress >= 100
      ? "Goal hit — bot keeps trading"
      : `+$${earnedUSD.toFixed(2)} of +$${goalUSD.toFixed(2)} · open ${openGain>=0?"+":""}$${openGain.toFixed(2)} · closed ${realizedGain>=0?"+":""}$${realizedGain.toFixed(2)}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>AlphaBot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif;background:#0B0E14;color:#E8ECF0;max-width:430px;margin:0 auto;display:flex;flex-direction:column;height:100%}
/* ── Tabs ── */
.tab-content{display:none;flex:1;overflow-y:auto;padding-bottom:72px}
.tab-content.active{display:block}
/* ── Bottom nav ── */
#bottom-nav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:#131928;border-top:1px solid rgba(255,255,255,0.06);display:flex;z-index:100;padding-bottom:env(safe-area-inset-bottom,0)}
.nav-btn{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:9px 0 7px;cursor:pointer;border:none;background:transparent;color:#5B6478;font-family:inherit;font-size:10px;font-weight:600;letter-spacing:.01em;gap:4px;transition:color .15s}
.nav-btn svg{width:20px;height:20px;stroke-width:1.8;fill:none;stroke:currentColor}
.nav-btn.active{color:#26D9A4}
.nav-btn.active svg{stroke:#26D9A4}
/* ── Cards / rows ── */
.sec{margin:14px 14px 0}
.sec-title{font-size:11px;font-weight:600;color:#8B8FA8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
.card{background:#151C2D;border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden}
.card>*:last-child{border-bottom:none!important}
.row{padding:14px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.05)}
.lbl{font-size:12px;color:#8B8FA8}
.val{font-size:13px;font-weight:600;color:#E8ECF0}
.btn{display:block;width:100%;padding:14px;border-radius:10px;border:none;font-size:15px;font-weight:700;cursor:pointer;text-align:center;font-family:inherit}
.btn-blue{background:#26D9A4;color:#0B0E14}
.btn-red{background:#F04D4D;color:#fff}
.btn-grey{background:#151C2D;color:#8B8FA8;border:1px solid rgba(255,255,255,0.08)}
.dot{width:6px;height:6px;border-radius:50%;display:inline-block;background:#26D9A4;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.bar-track{background:rgba(255,255,255,0.07);border-radius:99px;height:4px;overflow:hidden;margin-top:6px}
.bar-fill{height:100%;border-radius:99px}
/* ── Stat grid ── */
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 14px 0}
.stat-card{background:#151C2D;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:14px}
.stat-label{font-size:10px;color:#8B8FA8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.stat-val{font-size:22px;font-weight:700;letter-spacing:-.5px}
.stat-sub{font-size:11px;color:#8B8FA8;margin-top:3px}
/* ── Change pill ── */
.chg{padding:3px 8px;border-radius:4px;font-size:12px;font-weight:700}
.chg-up{background:rgba(38,217,164,.15);color:#26D9A4}
.chg-dn{background:rgba(240,77,77,.15);color:#F04D4D}
.chg-flat{background:rgba(91,100,120,.15);color:#8B8FA8}
</style>
</head>
<body>

<!-- ══════════════ TAB: PORTFOLIO ══════════════ -->
<div id="tab-portfolio" class="tab-content active">

<!-- Header -->
<div style="padding:16px 16px 0;display:flex;align-items:center;justify-content:space-between">
  <div>
    <div style="font-size:18px;font-weight:700;letter-spacing:-.3px;color:#E8ECF0">Assets</div>
    <div style="font-size:11px;color:#8B8FA8;margin-top:1px">${d.updatedAt}</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px">
    ${d.btcPrice ? `<div style="font-size:12px;color:#8B8FA8">BTC <span style="color:#E8ECF0;font-weight:600">$${Number(d.btcPrice).toLocaleString()}</span></div>` : ""}
    <div style="display:flex;align-items:center;gap:4px;background:rgba(38,217,164,.1);border:1px solid rgba(38,217,164,.25);border-radius:99px;padding:4px 10px;font-size:10px;font-weight:700;color:#26D9A4"><span class="dot"></span>LIVE</div>
  </div>
</div>

<!-- Portfolio hero -->
<div style="margin:14px 14px 0;background:#151C2D;border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:20px">
  <div style="font-size:11px;color:#8B8FA8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Total Assets</div>
  <div style="font-size:38px;font-weight:700;letter-spacing:-1.5px;line-height:1">$${Number(pf).toFixed(2)}</div>
  <div style="margin:10px 0 18px;display:flex;align-items:center;gap:8px">
    <span style="font-size:13px;font-weight:700;color:${(d.todayGainUSD??0)>=0?"#26D9A4":"#F04D4D"}">${(d.todayGainUSD??0)>=0?"+":""}$${Math.abs(d.todayGainUSD??0).toFixed(2)}</span>
    <span style="font-size:11px;padding:2px 7px;border-radius:4px;font-weight:700;background:${(d.todayGainUSD??0)>=0?"rgba(38,217,164,.12)":"rgba(240,77,77,.12)"};color:${(d.todayGainUSD??0)>=0?"#26D9A4":"#F04D4D"}">Today</span>
    <span style="font-size:11px;color:#8B8FA8">open ${openGain>=0?"+":""}$${openGain.toFixed(2)} · closed ${realizedGain>=0?"+":""}$${realizedGain.toFixed(2)}</span>
  </div>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06)">
    <div><div style="font-size:9px;color:#8B8FA8;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Cash</div><div style="font-size:14px;font-weight:700">$${Number(d.usdtBalance).toFixed(2)}</div></div>
    <div><div style="font-size:9px;color:#8B8FA8;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Open</div><div style="font-size:14px;font-weight:700">${d.openPositions.length}/4</div></div>
    <div><div style="font-size:9px;color:#8B8FA8;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Trades</div><div style="font-size:14px;font-weight:700">${d.todayTrades}</div></div>
    <div><div style="font-size:9px;color:#8B8FA8;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Last</div><div style="font-size:14px;font-weight:700" id="last-trade-ago">—</div></div>
  </div>
</div>

<!-- Daily goal -->
<div style="margin:8px 14px 0;background:#151C2D;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div>
      <div style="font-size:10px;color:#8B8FA8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Daily Goal ${goalIcon}</div>
      <div style="font-size:26px;font-weight:700;letter-spacing:-.5px;color:${goalColor}">${goalProgress.toFixed(0)}%</div>
      <div style="font-size:11px;color:#8B8FA8;margin-top:3px">${goalSubLabel}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:10px;color:#8B8FA8;margin-bottom:4px">Target +${goalPct}%</div>
      <div style="font-size:20px;font-weight:700;color:#26D9A4">+$${goalUSD.toFixed(2)}</div>
      ${goalRemaining>0?`<div style="font-size:11px;color:#8B8FA8;margin-top:2px">$${goalRemaining.toFixed(2)} remaining</div>`:""}
    </div>
  </div>
  <div style="background:rgba(255,255,255,0.07);border-radius:99px;height:5px;overflow:hidden">
    <div style="width:${goalProgress}%;height:100%;background:${goalColor};border-radius:99px;transition:width .3s"></div>
  </div>
</div>

<!-- Scan pulse -->
<div style="margin:8px 14px 0;padding:10px 14px;background:#151C2D;border:1px solid rgba(255,255,255,0.06);border-radius:10px;display:flex;justify-content:space-between;align-items:center">
  <div style="font-size:11px;color:#8B8FA8;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <span>Scanned <span id="last-scan-ago" style="color:#E8ECF0">${d.lastScanMs?"just now":"starting…"}</span></span>
    <span style="color:rgba(255,255,255,0.15)">·</span><span>${d.coinsScanned||0} coins</span>
    ${d.nearEntry>0?`<span style="color:rgba(255,255,255,0.15)">·</span><span style="color:#F7B500;font-weight:700">${d.nearEntry} near entry</span>`:""}
  </div>
  <div style="font-size:11px;color:#8B8FA8;white-space:nowrap;flex-shrink:0">Next <span id="next-scan" style="color:#26D9A4;font-weight:700">${d.lastScanMs?"—":"~5m"}</span></div>
</div>

<!-- Open positions -->
<div class="sec"><div class="sec-title">Open Positions</div><div class="card">${posHTML}</div></div>

<!-- Stats grid -->
<div class="stat-grid">
  <div class="stat-card">
    <div class="stat-label">Win Rate (10)</div>
    <div class="stat-val" style="color:${wrColor}">${wrNum!==null?wrNum.toFixed(0)+"%":"—"}</div>
    <div class="stat-sub">${d.winRate}</div>
    ${wrNum!==null?`<div class="bar-track" style="margin-top:8px"><div class="bar-fill" style="width:${wrNum}%;background:${wrColor}"></div></div>`:""}
  </div>
  <div class="stat-card">
    <div class="stat-label">Expectancy</div>
    <div class="stat-val" style="color:${d.expectancy!==null?parseFloat(d.expectancy)>=0?"#00d4a0":"#ff4d6a":"#4a5272"}">${d.expectancy!==null?(parseFloat(d.expectancy)>=0?"+":"")+d.expectancy+"%":"—"}</div>
    <div class="stat-sub">${d.totalTrades} total trades</div>
  </div>
</div>
<div class="stat-grid">
  <div class="stat-card">
    <div class="stat-label">Avg Win</div>
    <div class="stat-val" style="color:#00d4a0">${d.avgWin!=null?"+"+d.avgWin+"%":"—"}</div>
    <div class="stat-sub">${d.totalWins} wins</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Avg Loss</div>
    <div class="stat-val" style="color:#ff4d6a">${d.avgLoss!=null?d.avgLoss+"%":"—"}</div>
    <div class="stat-sub">${d.totalTrades-d.totalWins} losses</div>
  </div>
</div>

<!-- Account health -->
<div class="sec">
  <div class="sec-title">Account Health</div>
  <div class="card">
    <div class="row">
      <div class="lbl">Fees Paid (live trades)</div>
      <div style="text-align:right"><div class="val" style="color:#ffb800">$${(d.totalFeesPaid||0).toFixed(4)}</div><div class="lbl">0.064% per side (BGB)</div></div>
    </div>
    <div class="row">
      <div><div class="lbl">Daily Drawdown</div><div class="bar-track" style="width:140px"><div class="bar-fill" style="width:${ddUsed.toFixed(0)}%;background:${ddColor}"></div></div></div>
      <div style="text-align:right"><div class="val" style="color:${ddColor}">-${(d.drawdownPct||0).toFixed(2)}%</div><div class="lbl">limit ${d.drawdownLimit}%</div></div>
    </div>
    <div class="row">
      <div><div class="lbl">Portfolio Heat</div><div class="bar-track" style="width:140px"><div class="bar-fill" style="width:${Math.min(100,(d.heatPct/8)*100).toFixed(0)}%;background:${heatColor}"></div></div></div>
      <div style="text-align:right"><div class="val" style="color:${heatColor}">${d.heatPct}%</div><div class="lbl">max 8%</div></div>
    </div>
    <div class="row"><div class="lbl">Strategy Mode</div><div style="font-size:12px;font-weight:700;color:${modeColor}">${modeIcon} ${d.adaptiveMode?.toUpperCase()}</div></div>
    <div class="row"><div class="lbl">Market Regime</div><div style="font-size:12px;font-weight:700;color:${regColor}">${d.regime}</div></div>
    <div class="row"><div class="lbl">Bot Status</div><div style="font-size:12px;font-weight:700;color:${d.paused?"#ffb800":"#00d4a0"}">${d.paused?"⚠️ "+(d.pauseReason||"Paused"):"✅ Active — scanning"}</div></div>
    <div class="row">
      <div class="lbl">Claude AI</div>
      <div style="text-align:right">
        ${_claudeCallsToday >= CLAUDE_DAILY_CAP
          ? `<div style="font-size:12px;font-weight:700;color:#ffb800">⚠️ Cap reached (${_claudeCallsToday}/${CLAUDE_DAILY_CAP})</div><div style="font-size:10px;color:#4a5272">Resets at midnight UTC</div>`
          : `<div style="font-size:12px;font-weight:700;color:#00d4a0">✅ ${_claudeCallsToday}/${CLAUDE_DAILY_CAP} calls used</div><div style="font-size:10px;color:#4a5272">${Date.now()-_lastClaudeCallMs < CLAUDE_GLOBAL_COOLDOWN_MS ? Math.round((CLAUDE_GLOBAL_COOLDOWN_MS-(Date.now()-_lastClaudeCallMs))/60000)+"min cooldown" : "Ready"}</div>`
        }
      </div>
    </div>
  </div>
</div>

<!-- Controls -->
<div class="sec"><div class="sec-title">Controls</div></div>
<div style="margin:0 14px;display:flex;flex-direction:column;gap:8px">
  <form method="POST" action="/action?pin=${pin}&action=scan" style="display:contents"><button class="btn btn-blue" type="submit">⚡ Scan All Coins Now</button></form>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <form method="POST" action="/action?pin=${pin}&action=${d.paused?"resume":"pause"}" style="display:contents"><button class="btn btn-grey" type="submit">${d.paused?"▶ Resume":"⏸ Pause"}</button></form>
    <form method="POST" action="/action?pin=${pin}&action=sell-all" style="display:contents" onsubmit="return confirm('Sell ALL open positions now?')"><button class="btn btn-red" type="submit">🚨 Sell All</button></form>
  </div>
</div>
<div style="text-align:center;color:#5B6478;font-size:11px;margin:18px 0 4px">Refreshing in <span id="refresh-in">15s</span></div>
</div><!-- /tab-portfolio -->


<!-- ══════════════ TAB: MARKETS ══════════════ -->
<div id="tab-markets" class="tab-content">

<!-- Search -->
<div style="padding:16px 14px 0">
  <form method="GET" action="/coin" onsubmit="var v=this.symbol.value.trim().toUpperCase();if(!v)return false;if(!v.endsWith('USDT'))this.symbol.value=v+'USDT';">
    <input type="hidden" name="pin" value="${pin}">
    <div style="display:flex;gap:8px">
      <input type="text" name="symbol" placeholder="Search any coin — BTC, PEPE, WLD..." autocomplete="off" autocapitalize="characters" spellcheck="false"
        style="flex:1;background:#151C2D;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px 14px;color:#E8ECF0;font-size:14px;outline:none;font-family:inherit">
      <button type="submit" style="background:#26D9A4;color:#0B0E14;border:none;border-radius:10px;padding:12px 16px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">Go</button>
    </div>
  </form>
</div>

<!-- Top movers -->
${d.topGainers&&d.topGainers.length>0?`
<div class="sec">
  <div class="sec-title">🚀 Top Movers Today</div>
  <div class="card">
    ${d.topGainers.slice(0,10).map((t,i)=>{
      const coin=t.symbol.replace("USDT","");
      const vol=t.vol>=1e9?(t.vol/1e9).toFixed(1)+"B":t.vol>=1e6?(t.vol/1e6).toFixed(0)+"M":(t.vol/1e3).toFixed(0)+"K";
      return `<a href="/coin?symbol=${t.symbol}&pin=${pin}" style="display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,0.05);text-decoration:none;color:inherit">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:18px;font-size:11px;color:#8B8FA8;font-weight:600;text-align:right">${i+1}</div>
          <div style="width:38px;height:38px;border-radius:50%;background:rgba(38,217,164,.12);color:#26D9A4;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0">${coin.slice(0,4)}</div>
          <div><div style="font-size:14px;font-weight:700">${coin}</div><div style="font-size:11px;color:#8B8FA8">Vol $${vol}</div></div>
        </div>
        <div style="text-align:right">
          <div style="font-size:13px;font-weight:700;padding:3px 8px;border-radius:4px;background:rgba(38,217,164,.15);color:#26D9A4">+${t.change24h.toFixed(1)}%</div>
          <div style="font-size:11px;color:#8B8FA8;margin-top:4px">$${t.price<0.01?t.price.toFixed(6):t.price<1?t.price.toFixed(4):t.price.toFixed(2)}</div>
        </div>
      </a>`;
    }).join("")}
  </div>
</div>`:""}

<!-- Closest to entry -->
<div class="sec"><div class="sec-title">🎯 Closest to Entry</div><div class="card">${readinessHTML}</div></div>

<!-- All coins -->
<div class="sec">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div class="sec-title" style="margin-bottom:0">Watching (${coinsArr.length})</div>
    <input id="coin-filter" type="text" placeholder="Filter..." autocomplete="off"
      style="background:#0e1117;border:1px solid #1a1f2e;border-radius:8px;padding:5px 10px;color:#f0f2f7;font-size:12px;outline:none;width:90px;font-family:inherit"
      oninput="filterCoins(this.value)">
  </div>
  <div class="card" id="coins-list">${coinsHTML}</div>
</div>

</div><!-- /tab-markets -->


<!-- ══════════════ TAB: TRADES ══════════════ -->
<div id="tab-trades" class="tab-content">

<!-- Today summary bar -->
<div style="padding:16px 14px 0">
  <div style="background:#151C2D;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center">
    <div>
      <div style="font-size:9px;color:#8B8FA8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Today P&L</div>
      <div style="font-size:18px;font-weight:700;color:${(d.todayGainUSD??0)>=0?"#26D9A4":"#F04D4D"}">${(d.todayGainUSD??0)>=0?"+":""}$${Math.abs(d.todayGainUSD??0).toFixed(2)}</div>
    </div>
    <div style="border-left:1px solid rgba(255,255,255,0.06);border-right:1px solid rgba(255,255,255,0.06)">
      <div style="font-size:9px;color:#8B8FA8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Win Rate</div>
      <div style="font-size:18px;font-weight:700;color:${wrColor}">${wrNum!==null?wrNum.toFixed(0)+"%":"—"}</div>
    </div>
    <div>
      <div style="font-size:9px;color:#8B8FA8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Trades</div>
      <div style="font-size:18px;font-weight:700">${d.todayTrades}</div>
    </div>
  </div>
</div>

<!-- Strategy breakdown -->
<div class="sec"><div class="sec-title">Strategy Breakdown</div></div>
<div style="margin:0 14px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
${[["Scalp","scalp","⚡"],["Momentum","momentum","🚀"],["Sniper","sniper","🎯"],["Swing","swing","🌊"],["Long-Term","lt","💎"]].map(([label,key,icon])=>{
  const s = d.strats?.[key];
  if(!s) return `<div style="background:#151C2D;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:14px;opacity:.5"><div style="font-size:11px;color:#8B8FA8;margin-bottom:8px">${icon} ${label}</div><div style="font-size:20px;font-weight:700;color:#8B8FA8">—</div><div style="font-size:10px;color:#8B8FA8;margin-top:4px">No trades yet</div></div>`;
  const wrColor = s.wrPct>=60?"#26D9A4":s.wrPct>=45?"#F7B500":"#F04D4D";
  const confColor = s.avgConf!=null ? (s.avgConf>=75?"#26D9A4":s.avgConf>=60?"#F7B500":"#F04D4D") : "#8B8FA8";
  return `<div style="background:#151C2D;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:14px">
    <div style="font-size:11px;color:#8B8FA8;margin-bottom:8px">${icon} ${label}</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6px">
      <div>
        <div style="font-size:9px;color:#8B8FA8;margin-bottom:2px">WIN RATE</div>
        <div style="font-size:22px;font-weight:700;color:${wrColor};letter-spacing:-.5px">${s.wrPct}%</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:9px;color:#8B8FA8;margin-bottom:2px">${s.avgConf!=null?"AI CONF":"ENTRY"}</div>
        <div style="font-size:22px;font-weight:700;color:${confColor};letter-spacing:-.5px">${s.avgConf!=null?s.avgConf+"%":"Rule"}</div>
      </div>
    </div>
    <div style="display:flex;gap:4px;margin-bottom:8px">
      <div style="flex:1">
        <div style="background:rgba(255,255,255,0.07);border-radius:99px;height:3px">
          <div style="width:${s.wrPct}%;height:100%;background:${wrColor};border-radius:99px"></div>
        </div>
      </div>
      <div style="flex:1">
        <div style="background:rgba(255,255,255,0.07);border-radius:99px;height:3px">
          <div style="width:${s.avgConf??0}%;height:100%;background:${confColor};border-radius:99px"></div>
        </div>
      </div>
    </div>
    <div style="font-size:10px;color:#8B8FA8">${s.wins}W / ${s.losses}L · ${s.total} trades</div>
    ${s.expectancy!=null?`<div style="font-size:10px;margin-top:4px;color:${s.expectancy>=0?"#26D9A4":"#F04D4D"}">Exp ${s.expectancy>=0?"+":""}${s.expectancy}%</div>`:""}
    ${s.avgWin!=null?`<div style="font-size:9px;color:#8B8FA8;margin-top:3px">Avg W +${s.avgWin}% / L ${s.avgLoss}%</div>`:""}
  </div>`;
}).join("")}
</div>

<div class="sec"><div class="sec-title">Recent Trades</div></div>
<div class="card" style="margin:0 14px">
${d.lastTrades.length===0
  ? `<div style="padding:28px;text-align:center;color:#8B8FA8;font-size:13px">No trades yet</div>`
  : d.lastTrades.map(t => {
      const isEntry = t.type === "entry";
      const pv = t.pnlPct != null ? parseFloat(t.pnlPct) : null;
      const pc = pv == null ? "#8B8FA8" : pv >= 0 ? "#26D9A4" : "#F04D4D";
      const icon = isEntry ? "B" : pv != null && pv >= 0 ? "S" : "S";
      const iconBg = isEntry ? "rgba(47,126,255,.15)" : pv != null && pv >= 0 ? "rgba(38,217,164,.15)" : "rgba(240,77,77,.15)";
      const iconColor = isEntry ? "#2F7EFF" : pv != null && pv >= 0 ? "#26D9A4" : "#F04D4D";
      const isLive = t.paperTrading === false || t.orderPlaced === true;
      const modeBadge = isLive
        ? `<span style="font-size:9px;font-weight:700;color:#26D9A4;background:rgba(38,217,164,.12);padding:2px 6px;border-radius:3px">LIVE</span>`
        : `<span style="font-size:9px;font-weight:700;color:#8B8FA8;background:rgba(255,255,255,.07);padding:2px 6px;border-radius:3px">PAPER</span>`;
      return `<div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.05)">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:38px;height:38px;border-radius:50%;background:${iconBg};color:${iconColor};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;flex-shrink:0">${icon}</div>
          <div>
            <div style="font-size:14px;font-weight:700;display:flex;align-items:center;gap:6px;margin-bottom:3px">${(t.symbol||"").replace("USDT","")} ${modeBadge}</div>
            <div style="font-size:11px;color:#8B8FA8">${isEntry?"Buy":"Sell"} · $${Number(t.price||0).toFixed(4)}</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:14px;font-weight:700;color:${pc}">${t.pnlPct != null ? (t.pnlPct >= 0 ? "+" : "") + Number(t.pnlPct).toFixed(2) + "%" : "—"}</div>
          <div style="font-size:11px;color:#8B8FA8;margin-top:3px">${(t.timestamp||"").slice(11,16)} UTC</div>
        </div>
      </div>`;
    }).join("")
}
</div>

</div><!-- /tab-trades -->


<!-- ══════════════ TAB: SIGNALS ══════════════ -->
<div id="tab-signals" class="tab-content">

<div style="padding:16px 16px 0;display:flex;justify-content:space-between;align-items:center">
  <div style="font-size:15px;font-weight:800">Signal Log</div>
  <div style="font-size:11px;color:#4a5272">${d.coinsScanned||0} coins · <span id="sig-scan-ago">${d.lastScanMs?"just now":"starting…"}</span></div>
</div>

<div class="sec" style="margin-top:10px"><div class="card">${sigHTML}</div></div>

</div><!-- /tab-signals -->


<!-- ══════════════ BOTTOM NAV ══════════════ -->
<nav id="bottom-nav">
  <button class="nav-btn active" id="nav-portfolio" onclick="switchTab('portfolio')">
    <svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    Assets
  </button>
  <button class="nav-btn" id="nav-markets" onclick="switchTab('markets')">
    <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
    Markets
  </button>
  <button class="nav-btn" id="nav-trades" onclick="switchTab('trades')">
    <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
    Trades
  </button>
  <button class="nav-btn" id="nav-signals" onclick="switchTab('signals')">
    <svg viewBox="0 0 24 24"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
    Signals
  </button>
</nav>

<script>
// ── Tab switching ────────────────────────────────────────────────
function switchTab(name){
  document.querySelectorAll('.tab-content').forEach(function(el){el.classList.remove('active')});
  document.querySelectorAll('.nav-btn').forEach(function(el){el.classList.remove('active')});
  document.getElementById('tab-'+name).classList.add('active');
  document.getElementById('nav-'+name).classList.add('active');
  sessionStorage.setItem('activeTab',name);
}
// Restore last tab on reload
(function(){
  const t=sessionStorage.getItem('activeTab');
  if(t)switchTab(t);
})();

// ── Coin filter (Markets tab) ────────────────────────────────────
function filterCoins(q){
  q=q.trim().toLowerCase();
  document.querySelectorAll('#coins-list a[data-coin]').forEach(function(el){
    el.style.display=(!q||el.dataset.coin.includes(q))?'block':'none';
  });
}

// ── Live timers ──────────────────────────────────────────────────
const _LS=${d.lastScanMs||"null"};
const _LI=${d.scanIntervalMs};
const _LT=${d.lastTradeAt?`"${d.lastTradeAt}"`:"null"};
const _PL=Date.now();
function fmtAgo(ms){
  const s=Math.floor((Date.now()-ms)/1000);
  if(s<5)return'just now';if(s<60)return s+'s ago';
  if(s<3600)return Math.floor(s/60)+'m ago';
  return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m ago';
}
function fmtCd(ms){
  if(ms<=0)return'soon';
  const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000);
  return m+':'+String(s).padStart(2,'0');
}
function tick(){
  if(_LS){
    ['last-scan-ago','sig-scan-ago'].forEach(function(id){const el=document.getElementById(id);if(el)el.textContent=fmtAgo(_LS);});
    const nms=Math.max(0,_LI-(Date.now()-_LS));
    const ni=document.getElementById('next-scan');if(ni)ni.textContent=fmtCd(nms);
  }
  if(_LT){const el=document.getElementById('last-trade-ago');if(el)el.textContent=fmtAgo(new Date(_LT).getTime());}
  const ri=document.getElementById('refresh-in');
  if(ri)ri.textContent=Math.ceil(Math.max(0,15000-(Date.now()-_PL))/1000)+'s';
}
setInterval(tick,1000);tick();
// Soft reload every 15s
setInterval(function(){if(!document.querySelector('input:focus'))location.reload();},15000);
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
setInterval(load, 15000);

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
      } else if (action === "clear-position") {
        // Remove a stale position from the log without placing a sell order
        const cpSym = (urlObj.searchParams.get("symbol") || "").toUpperCase();
        if (cpSym) {
          const cpLog = loadLog();
          let cleared = false;
          if (cpLog.positions?.[cpSym]) { delete cpLog.positions[cpSym]; cleared = true; }
          if (cpLog.swingPositions?.[cpSym]) { delete cpLog.swingPositions[cpSym]; cleared = true; }
          if (cpLog.breakoutPositions?.[cpSym]) { delete cpLog.breakoutPositions[cpSym]; cleared = true; }
          if (cpLog.sniperPositions?.[cpSym]) { delete cpLog.sniperPositions[cpSym]; cleared = true; }
          if (cleared) { saveLog(cpLog); console.log(`\n🗑️  Dashboard: cleared stale position ${cpSym} from log`); }
          else { console.log(`\n⚠️  Dashboard: no position found for ${cpSym}`); }
        }
        redirect();
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

    // Trades CSV download — lets you pull the full Railway trade history locally
    if (req.method === "GET" && path === "/api/trades") {
      if (!checkPin(req.url)) { res.writeHead(401); res.end(JSON.stringify({ error: "Wrong PIN" })); return; }
      try {
        const csv = readFileSync(CSV_FILE, "utf8");
        res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=trades.csv" });
        res.end(csv);
      } catch (e) {
        res.writeHead(404); res.end("trades.csv not found");
      }
      return;
    }

    // Status endpoint — also prints to Railway logs so you can read it there
    if (req.method === "GET" && path === "/status") {
      const log = loadLog();
      const openPositions = Object.entries(log.positions || {}).filter(([, p]) => p?.open);
      const positionSummary = openPositions.map(([sym, p]) => {
        const live = livePrices.get(sym);
        const livePrice = live?.price ?? null;
        const pnlPct = livePrice ? ((livePrice - p.entryPrice) / p.entryPrice * 100) : null;
        const pnlUSD = livePrice ? (livePrice - p.entryPrice) * parseFloat(p.quantity) : null;
        return { sym, entryPrice: p.entryPrice, livePrice, pnlPct: pnlPct?.toFixed(2), pnlUSD: pnlUSD?.toFixed(2), qty: p.quantity, tpPct: p.tpPct, slPct: p.slPct, tpOrderId: p.tpOrderId ?? null };
      });

      const btcLive = livePrices.get("BTCUSDT");
      const statusOut = {
        time: new Date().toISOString(),
        portfolio: log.portfolioValue?.toFixed(2),
        paused: _tradingPaused,
        openCount: openPositions.length,
        positions: positionSummary,
        btcPrice: btcLive?.price ?? null,
        lastScan: _lastScanTime ? new Date(_lastScanTime).toISOString() : null,
      };

      // Print to Railway logs so it's visible without hitting the URL
      console.log(`\n📊 STATUS — ${statusOut.time}`);
      console.log(`  Portfolio: $${statusOut.portfolio} | Paused: ${statusOut.paused} | Open: ${statusOut.openCount}`);
      positionSummary.forEach(p => console.log(`  ${p.sym}: entry $${p.entryPrice} | live $${p.livePrice ?? "—"} | P&L ${p.pnlPct ?? "—"}% ($${p.pnlUSD ?? "—"}) | TP: ${p.tpOrderId ? "resting ✅" : "poll 🔄"}`));
      console.log(`  BTC: $${statusOut.btcPrice ?? "—"} | Last scan: ${statusOut.lastScan ?? "—"}\n`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(statusOut));
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

    // LT portfolio webhook — receives buy/sell signals from NeonGreenHF / DETONATOR A/B/C
    if (req.method === "POST" && path === "/lt-webhook") {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const action  = (payload.action || "").toUpperCase();
          const sym     = (payload.symbol || "").toUpperCase().replace(/[^A-Z]/g, "");
          const source  = payload.source || "indicator";

          if (!["BUY", "SELL"].includes(action)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "action must be BUY or SELL" })); return;
          }
          if (!LT_COINS.includes(sym)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `${sym} not in LT coin list` })); return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ received: true, action, symbol: sym, source }));
          console.log(`\n📡 LT webhook: ${action} ${sym} [${source}]`);

          if (action === "BUY") {
            ltWebhookBuy(sym, source).catch(e => console.error(`LT webhook buy error ${sym}:`, e.message));
          } else {
            ltWebhookSell(sym, source).catch(e => console.error(`LT webhook sell error ${sym}:`, e.message));
          }
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

    // Share the symbol mutex with run() — prevents swing exit and scalp entry racing on the same log
    if (_runningSymbols.has(symbol)) {
      console.log(`⏳ ${symbol} in use by scalp cycle — skipping swing tick`);
      return;
    }
    _runningSymbols.add(symbol);

    try {

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
    const bb      = calcBollingerBands(closes);
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
      if (rsi3 !== null && rsi3 > SWING.rsiOverboughtExit) exitReasons.push(`RSI(3) overbought ${rsi3.toFixed(1)}`);
      // Neon Candle exit — backtest-validated: 2×+ volume candle while in profit = take it
      // Rationale: extreme volume at profit marks institutional profit-taking (local top)
      if (vol && pnlPct > 1.0 && vol.current > vol.avg * 2.0) exitReasons.push(`Neon Candle exit — ${(vol.current/vol.avg).toFixed(1)}x volume spike at +${pnlPct.toFixed(1)}%`);
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
        if (!CONFIG.paperTrading && swingPos.tpOrderId) {
          await cancelOrder(symbol, swingPos.tpOrderId);
          console.log(`  📌 Cancelled resting swing TP ${swingPos.tpOrderId}`);
        }
        log.swingPositions[symbol] = { ...swingPos, open: false };
        log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
        log.trades.push(exitEntry);
        if (!log.coinCooldowns) log.coinCooldowns = {};
        if (!log.coinCooldowns[symbol]) log.coinCooldowns[symbol] = {};
        const swingCooldownMs = pnlPct < 0 ? 2 * 60 * 60 * 1000 : 30 * 60 * 1000;
        log.coinCooldowns[symbol].swing = { until: Date.now() + swingCooldownMs, pnlPct: pnlPct.toFixed(2) };
        learnFromTrades(log);
        saveLog(log);
        writeTradeCsv(exitEntry);
        await syncPortfolioBalance(log).catch(() => {});
        await emailExit({ symbol, price, entryPrice: swingPos.entryPrice, pnlPct, pnlUSD, reasons: exitReasons, orderId: swingPos.orderId }).catch(() => {});
      }
      return;
    }

    // ── Entry check ─────────────────────────────────────────────────────────
    if (openSwingCount >= SWING.maxOpen) return;

    // Cross-strategy dedup — don't swing if scalp or breakout already open on same coin
    if ((log.positions || {})[symbol]?.open) return;
    if ((log.breakoutPositions || {})[symbol]?.open) return;

    // Cooldown — respect same cross-strategy cooldown set by scalp/breakout exits
    const swingEntryCooldown = (log.coinCooldowns || {})[symbol]?.swing;
    if (swingEntryCooldown && Date.now() < swingEntryCooldown.until) {
      const minsLeft = Math.ceil((swingEntryCooldown.until - Date.now()) / 60000);
      console.log(`⏳ SWING COOLDOWN — ${symbol} blocked ${minsLeft}min (last P&L: ${swingEntryCooldown.pnlPct}%)`);
      return;
    }

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

    // ── 4H entry conditions — backtest-validated dip-buy (69% OOS WR) ─────────
    // Buy the dip: price at/below VWAP + uptrend intact (EMA8 > EMA21) + RSI oversold + BB low
    const trendUp    = ema8 > ema21;                // uptrend: EMA8(4H) > EMA21(4H)
    const atDiscount = price <= vwap * 1.01;        // at or below VWAP (buying dip vs fair value)
    const oversold4h = rsi3 < SWING.rsi3Gate;       // RSI(3) oversold (< 40)
    const bbAtLow    = !bb || bb.pct < 0.35;        // at/near lower Bollinger Band
    const noOBVDiv   = !obv.bearDivergence;

    if (!trendUp || !atDiscount || !oversold4h || !bbAtLow || !noOBVDiv) return;

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
    if (bbAtLow && bb && bb.pct < 0.25)        score++;  // at/below lower BB (strong dip signal)
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
      tpPct: btResult.takeProfit, slPct: btResult.stopLoss,
    }};
    if (!CONFIG.paperTrading) {
      const tpOrderId = await placeLimitSell(symbol, qty.toFixed(6), price * (1 + btResult.takeProfit));
      if (tpOrderId) {
        const _tpLog = (() => { try { return loadLog(); } catch { return log; } })();
        if (_tpLog.swingPositions?.[symbol]) { _tpLog.swingPositions[symbol].tpOrderId = tpOrderId; saveLog(_tpLog); log.swingPositions = _tpLog.swingPositions; }
      }
    }

    const entryLog = {
      timestamp: new Date().toISOString(), type: "entry", symbol,
      timeframe: SWING.tf, price, tradeSize: swingSize,
      indicators: { rsi3, rsi14, vwap, ema8, ema21, adx: adx?.adx },
      score, entryConfidence: Math.round(Math.min(score, 9) / 9 * 100),
      orderPlaced: true, paperTrading: CONFIG.paperTrading, tradeType: "swing",
    };
    log.trades.push(entryLog);
    saveLog(log);
    writeTradeCsv(entryLog);
    await emailEntry({ symbol, price, tradeSize: swingSize, orderId });

    } finally {
      _runningSymbols.delete(symbol);
    }
  }

  // ─── Breakout Strategy (1H) ──────────────────────────────────────────────────
  // Catches coins breaking out of consolidation with strong volume.
  // Complements scalp (snap-backs) and swing (dip-buying) by covering trending breakouts.

  async function runBreakout(symbol) {
    if (!SWING_ENABLED) return;
    const PERM_EXCLUDE = ["ARBUSDT", "VIRTUALUSDT", "SUIUSDT"];
    if (PERM_EXCLUDE.includes(symbol)) return;

    // Share the symbol mutex with run() and runSwing() — prevents concurrent log writes
    if (_runningSymbols.has(symbol)) {
      console.log(`⏳ ${symbol} in use — skipping breakout tick`);
      return;
    }
    _runningSymbols.add(symbol);

    try {

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
        if (!CONFIG.paperTrading && bkPos.tpOrderId) {
          await cancelOrder(symbol, bkPos.tpOrderId);
          console.log(`  📌 Cancelled resting breakout TP ${bkPos.tpOrderId}`);
        }
        log.breakoutPositions[symbol] = { ...bkPos, open: false };
        log.portfolioValue = (log.portfolioValue || acct().portfolioValue) + pnlUSD;
        log.trades.push(exitEntry);
        if (!log.coinCooldowns) log.coinCooldowns = {};
        if (!log.coinCooldowns[symbol]) log.coinCooldowns[symbol] = {};
        const bkCooldownMs = pnlPct < 0 ? 2 * 60 * 60 * 1000 : 30 * 60 * 1000;
        log.coinCooldowns[symbol].breakout = { until: Date.now() + bkCooldownMs, pnlPct: pnlPct.toFixed(2) };
        learnFromTrades(log);
        saveLog(log);
        writeTradeCsv(exitEntry);
        await syncPortfolioBalance(log).catch(() => {});
        await emailExit({ symbol, price, entryPrice: bkPos.entryPrice, pnlPct, pnlUSD, reasons: exitReasons, orderId: bkPos.orderId }).catch(() => {});
      }
      return;
    }

    // ── Entry check ─────────────────────────────────────────────────────────
    const openBreakouts = Object.values(log.breakoutPositions || {}).filter(p => p?.open).length;
    if (openBreakouts >= 5) return;

    // Cross-strategy dedup — don't break out if scalp or swing already open on same coin
    if ((log.positions || {})[symbol]?.open) return;
    if ((log.swingPositions || {})[symbol]?.open) return;

    // Cooldown — respect cross-strategy cooldown set by scalp/swing exits
    const bkEntryCooldown = (log.coinCooldowns || {})[symbol]?.breakout;
    if (bkEntryCooldown && Date.now() < bkEntryCooldown.until) {
      const minsLeft = Math.ceil((bkEntryCooldown.until - Date.now()) / 60000);
      console.log(`⏳ BREAKOUT COOLDOWN — ${symbol} blocked ${minsLeft}min (last P&L: ${bkEntryCooldown.pnlPct}%)`);
      return;
    }

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

    const bkTpPct = (targetPrice - price) / price;
    const bkSlPct = 0.03;
    log.breakoutPositions = { ...(log.breakoutPositions || {}), [symbol]: {
      open: true, side: "long", entryPrice: price, highWatermark: price,
      entryTime: new Date().toISOString(), quantity: qty.toFixed(6),
      orderId, tradeType: "breakout", breakoutLevel: rangeHigh,
      targetPrice, rangeLow, rangeHigh, tpPct: bkTpPct, slPct: bkSlPct,
    }};
    if (!CONFIG.paperTrading) {
      const tpOrderId = await placeLimitSell(symbol, qty.toFixed(6), targetPrice);
      if (tpOrderId) {
        const _tpLog = (() => { try { return loadLog(); } catch { return log; } })();
        if (_tpLog.breakoutPositions?.[symbol]) { _tpLog.breakoutPositions[symbol].tpOrderId = tpOrderId; saveLog(_tpLog); log.breakoutPositions = _tpLog.breakoutPositions; }
      }
    }
    const entryLog = {
      timestamp: new Date().toISOString(), type: "entry", symbol, timeframe: "1H",
      price, tradeSize: bkSize, indicators: { ema8, ema21, range, volRatio: vol.current/vol.avg },
      breakoutLevel: rangeHigh, targetPrice, orderPlaced: true,
      paperTrading: CONFIG.paperTrading, tradeType: "breakout",
    };
    log.trades.push(entryLog);
    saveLog(log);
    writeTradeCsv(entryLog);
    await emailEntry({ symbol, price, tradeSize: bkSize, orderId });

    } finally {
      _runningSymbols.delete(symbol);
    }
  }

// ─── New Listing Sniper ──────────────────────────────────────────────────────
// Polls BitGet every 10s for newly listed USDT pairs. Buys immediately,
// uses a trailing stop to capture moonshots: -8% hard SL from entry, then
// once up 20%+ activates a 15%-below-peak trailing stop. 25min hard timeout.

let _sniperKnownSymbols = null;
const _scheduledSnipes = {}; // symbol → ISO listing time from announcements

const SNIPER = {
  portfolioPct:      0.10,  // 10% of portfolio per snipe
  maxSizeUSD:        30,    // hard cap $30 per trade
  stopLossPct:       0.08,  // -8% hard stop from entry
  trailActivatePct:  0.20,  // start trailing once up 20%
  trailPct:          0.15,  // trail 15% below the peak price
  maxHoldMin:        25,    // kill after 25 min regardless
  maxPositions:      2,     // max 2 sniper positions concurrently
  maxPumpPct:        0.80,  // skip if already pumped 80%+
  minUsdtNeeded:     15,    // need at least $15 USDT free
};

async function initSniperSymbols() {
  try {
    const res = await fetch("https://api.bitget.com/api/v2/spot/public/symbols");
    const data = await res.json();
    const now = Date.now();
    _sniperKnownSymbols = new Set(
      (data.data || [])
        .filter(s => s.symbol.endsWith("USDT") && s.status === "online")
        .map(s => s.symbol)
    );
    // Pre-load any coins that have a future openTime — arm the sniper immediately
    const upcoming = (data.data || []).filter(s =>
      s.symbol.endsWith("USDT") &&
      !/UP|DOWN|BEAR|BULL|USDC|TUSD|BUSD|DAI/.test(s.symbol) &&
      parseInt(s.openTime || 0) > now
    );
    for (const s of upcoming) {
      const t = new Date(parseInt(s.openTime));
      _scheduledSnipes[s.symbol] = t.toISOString();
      const mins = Math.round((t - now) / 60000);
      console.log(`📅 Pre-armed: ${s.symbol} lists in ${mins}min at ${t.toUTCString()}`);
    }
    console.log(`🎯 Listing sniper ready — watching ${_sniperKnownSymbols.size} symbols${upcoming.length ? `, ${upcoming.length} pre-armed` : ""}`);
  } catch (e) {
    console.log(`⚠️  Sniper init failed: ${e.message}`);
  }
}

async function checkNewListings() {
  if (CONFIG.paperTrading || !_sniperKnownSymbols || acct().exchange !== "bitget") return;

  // Fire any pre-announced snipes whose time has arrived
  const now = Date.now();
  for (const [symbol, timeStr] of Object.entries(_scheduledSnipes)) {
    const t = new Date(timeStr).getTime();
    if (now >= t && now - t < 10 * 60 * 1000) {
      console.log(`\n⏰ SCHEDULED SNIPE FIRING — ${symbol}`);
      delete _scheduledSnipes[symbol];
      _sniperKnownSymbols?.add(symbol); // prevent re-detection on next poll
      await sniperBuy(symbol).catch(e => console.log(`⚠️  Scheduled snipe ${symbol} failed: ${e.message}`));
    } else if (now - t > 10 * 60 * 1000) {
      delete _scheduledSnipes[symbol];
    }
  }

  try {
    const res = await fetch("https://api.bitget.com/api/v2/spot/public/symbols", { signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    const allSymbols = (data.data || []).filter(s =>
      s.symbol.endsWith("USDT") &&
      !/UP|DOWN|BEAR|BULL|USDC|TUSD|BUSD|DAI|USD1|FDUSD|RLUSD|PAXG|XAUT/.test(s.symbol)
    );
    // Detect coins with future openTime — pre-arm before they go live
    const nowMs = Date.now();
    for (const s of allSymbols) {
      const openMs = parseInt(s.openTime || 0);
      if (openMs > nowMs && !_sniperKnownSymbols.has(s.symbol) && !_scheduledSnipes[s.symbol]) {
        const t = new Date(openMs);
        _scheduledSnipes[s.symbol] = t.toISOString();
        const mins = Math.round((openMs - nowMs) / 60000);
        console.log(`📅 NEW PRE-LISTING: ${s.symbol} — opens in ${mins}min at ${t.toUTCString()}`);
        pushSignal(s.symbol, "BLOCKED", `📅 Pre-listed — sniper fires in ${mins}min`);
      }
    }
    const current = allSymbols.filter(s => s.status === "online");
    const newListings = current.filter(s => !_sniperKnownSymbols.has(s.symbol));
    current.forEach(s => _sniperKnownSymbols.add(s.symbol));

    if (newListings.length > 0) {
      console.log(`\n🆕 ${newListings.length} NEW LISTING(S) DETECTED: ${newListings.map(s => s.symbol).join(", ")}`);
      // Each sniperBuy loads its own fresh log — safe to run in parallel
      await Promise.all(newListings.map(listing => {
        pushSignal(listing.symbol, "BLOCKED", `🆕 New listing — sniper firing`);
        return sniperBuy(listing.symbol).catch(e => console.log(`⚠️  Sniper ${listing.symbol}: ${e.message}`));
      }));
    }
  } catch { /* non-critical */ }
}

// Check BitGet announcement API for upcoming listings — runs every 5 minutes.
// When an upcoming listing is found, stores it with its listing time so the
// sniper can fire at T=0 without waiting for the next 10-second symbols poll.
async function checkUpcomingListings() {
  if (CONFIG.paperTrading || acct().exchange !== "bitget") return;
  const ANNOUNCEMENT_URLS = [
    "https://api.bitget.com/api/v2/common/announcement?type=new_listing&language=en_US&pageSize=20",
    "https://api.bitget.com/api/v2/spot/market/symbol-info",
  ];
  for (const url of ANNOUNCEMENT_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const items = data.data?.list || data.data || [];
      if (!Array.isArray(items) || items.length === 0) continue;

      for (const item of items) {
        // Parse announcement text for coin name + listing time
        const text = ((item.title || "") + " " + (item.content || "") + " " + (item.annTitle || "")).toUpperCase();
        const coinMatch = text.match(/\b([A-Z]{2,10})\b.*?(?:WILL BE LISTED|SPOT LISTING|NEW LISTING)/);
        const timeMatch = text.match(/(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);

        if (coinMatch && timeMatch) {
          const symbol = coinMatch[1] + "USDT";
          if (_sniperKnownSymbols?.has(symbol)) continue; // already live
          const listingTime = new Date(`${timeMatch[1]}T${timeMatch[2]}:00Z`);
          if (listingTime <= new Date()) continue; // already passed

          if (!_scheduledSnipes[symbol]) {
            _scheduledSnipes[symbol] = listingTime.toISOString();
            const minsUntil = Math.round((listingTime - Date.now()) / 60000);
            console.log(`\n📅 UPCOMING LISTING: ${symbol} in ${minsUntil}min at ${listingTime.toUTCString()}`);
            pushSignal(symbol, "BLOCKED", `📅 Sniper armed — listing in ${minsUntil}min`);
            sendEmail(`📅 Upcoming listing: ${symbol.replace("USDT","")}`,
              `<h2>📅 Sniper armed</h2><p><b>${symbol}</b> lists in <b>${minsUntil} minutes</b><br>Scheduled for ${listingTime.toUTCString()}<br>Bot will buy the moment trading opens.</p>`);
          }
        }

        // Also track pre-market symbols from the symbol-info endpoint
        if (item.symbol?.endsWith("USDT") && item.status === "pre_market" && item.onboardDate) {
          const symbol = item.symbol;
          if (_sniperKnownSymbols?.has(symbol)) continue;
          const listingTime = new Date(parseInt(item.onboardDate));
          if (listingTime <= new Date() || _scheduledSnipes[symbol]) continue;
          _scheduledSnipes[symbol] = listingTime.toISOString();
          const minsUntil = Math.round((listingTime - Date.now()) / 60000);
          console.log(`\n📅 PRE-MARKET: ${symbol} — trading opens in ${minsUntil}min`);
          pushSignal(symbol, "BLOCKED", `📅 Pre-market — sniper fires in ${minsUntil}min`);
        }
      }
      break; // worked, don't try next URL
    } catch { continue; }
  }

  // Fire any scheduled snipes whose time has arrived
  const now = Date.now();
  for (const [symbol, timeStr] of Object.entries(_scheduledSnipes)) {
    const t = new Date(timeStr).getTime();
    if (now >= t && now - t < 10 * 60 * 1000) {
      console.log(`\n⏰ SCHEDULED SNIPE FIRING — ${symbol}`);
      delete _scheduledSnipes[symbol];
      _sniperKnownSymbols?.add(symbol);
      await sniperBuy(symbol).catch(e => console.log(`⚠️  Scheduled snipe ${symbol} failed: ${e.message}`));
    } else if (now - t > 10 * 60 * 1000) {
      delete _scheduledSnipes[symbol]; // expired
    }
  }
}

async function sniperBuy(symbol) {
  // Load a fresh log at the start — don't accept a shared one (race condition if
  // multiple snipers fire in parallel; each must own its read-modify-write cycle)
  const log = loadLog();
  const openSnipers = Object.entries(log.sniperPositions || {}).filter(([, p]) => p?.open).length;
  if (openSnipers >= SNIPER.maxPositions) {
    console.log(`🚫 Sniper full (${openSnipers}/${SNIPER.maxPositions}). Skipping ${symbol}.`);
    return;
  }
  if ((log.sniperPositions || {})[symbol]?.open) {
    console.log(`🚫 Sniper already open for ${symbol}. Skipping.`);
    return;
  }

  // Get live price
  const tickRes = await fetch(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${symbol}`, { signal: AbortSignal.timeout(5000) });
  const tickData = await tickRes.json();
  const ticker = (tickData.data || [])[0];
  if (!ticker) { console.log(`⚠️  No ticker for ${symbol}`); return; }

  const price = parseFloat(ticker.lastPr);
  const openPrice = parseFloat(ticker.open24h || ticker.openUtc0 || price);
  if (!price || price <= 0) { console.log(`⚠️  Invalid price for ${symbol}`); return; }

  // Skip if already a massive pump — we'd be exit liquidity
  const pumpedPct = openPrice > 0 ? (price - openPrice) / openPrice : 0;
  if (pumpedPct > SNIPER.maxPumpPct) {
    console.log(`🚫 Sniper skip — ${symbol} already pumped ${(pumpedPct * 100).toFixed(0)}% (limit: ${(SNIPER.maxPumpPct * 100).toFixed(0)}%)`);
    pushSignal(symbol, "BLOCKED", `New listing but already +${(pumpedPct * 100).toFixed(0)}% — exit liquidity risk`);
    return;
  }

  // Use cached USDT balance — skip live getBalance() to save ~1 second
  const estimatedUsdt = _livePortfolioValue ? _livePortfolioValue * 0.10 : 20;
  const portfolio = _livePortfolioValue || log.portfolioValue || acct().portfolioValue;
  const sizeUSD = Math.min(portfolio * SNIPER.portfolioPct, SNIPER.maxSizeUSD);
  if (sizeUSD < 5) { console.log(`⚠️  Sniper size too small ($${sizeUSD.toFixed(2)}). Skipping.`); return; }

  console.log(`\n🎯 SNIPER BUY — ${symbol} @ $${price.toFixed(8)}`);
  console.log(`   Size: $${sizeUSD.toFixed(2)} | Pump so far: +${(pumpedPct * 100).toFixed(1)}%`);
  console.log(`   Trail: activates at +${(SNIPER.trailActivatePct * 100).toFixed(0)}%, then ${(SNIPER.trailPct * 100).toFixed(0)}% below peak`);
  console.log(`   SL: $${(price * (1 - SNIPER.stopLossPct)).toFixed(8)} (-${(SNIPER.stopLossPct * 100).toFixed(0)}%)`);
  console.log(`   Timeout: ${SNIPER.maxHoldMin} minutes`);

  let qty = sizeUSD / price;
  let orderId = null;
  try {
    // Fast-path: direct market buy without the 12-second balance confirmation wait.
    // placeBitGetOrder waits 3+4+5s to verify coins landed — sniper can't afford that.
    const ts = await getBitGetServerTime();
    const path = "/api/v2/spot/trade/place-order";
    const body = JSON.stringify({ symbol, side: "buy", orderType: "market", size: sizeUSD.toFixed(2) });
    const sig = signBitGet(ts, "POST", path, body);
    const res = await fetch(`${acct().baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ACCESS-KEY": acct().apiKey, "ACCESS-SIGN": sig,
        "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": acct().passphrase, "locale": "en-US",
      },
      body,
    });
    const data = await res.json();
    if (data.code !== "00000") throw new Error(data.msg);
    orderId = data.data?.orderId;
    qty = sizeUSD / price; // estimate — no wait for settlement
    console.log(`✅ SNIPER ORDER PLACED — ${orderId} | est qty: ${qty.toFixed(8)}`);
  } catch (err) {
    console.log(`❌ SNIPER ORDER FAILED — ${err.message}`);
    return;
  }

  // Reload log immediately before writing — API calls above took 1-3 seconds,
  // so another interval may have modified the log while we were waiting.
  const freshLog = loadLog();
  if (!freshLog.sniperPositions) freshLog.sniperPositions = {};
  freshLog.sniperPositions[symbol] = {
    open: true,
    entryPrice: price,
    quantity: qty,           // number, not string — consistent with all other positions
    entryTime: new Date().toISOString(),
    orderId,
    highWatermark:   price,  // updated each monitor cycle; trail activates once up 20%
    stopLossPrice:   price * (1 - SNIPER.stopLossPct),
    maxHoldUntil:    new Date(Date.now() + SNIPER.maxHoldMin * 60 * 1000).toISOString(),
  };

  const entryLog = {
    timestamp: new Date().toISOString(), type: "entry", symbol,
    timeframe: "SNIPER", price, tradeSize: sizeUSD,
    indicators: { pumpedPct: parseFloat((pumpedPct * 100).toFixed(1)) },
    entryConfidence: Math.min(100, Math.round(pumpedPct * 250)),
    orderPlaced: true, orderId, paperTrading: false, tradeType: "sniper",
  };
  freshLog.trades.push(entryLog);
  saveLog(freshLog);
  writeTradeCsv(entryLog);
  pushSignal(symbol, "ENTRY", `🎯 Sniper @ $${price.toFixed(8)} | Trail: +${(SNIPER.trailActivatePct * 100).toFixed(0)}% activate, ${(SNIPER.trailPct * 100).toFixed(0)}% below peak | SL -${(SNIPER.stopLossPct * 100).toFixed(0)}% | ${SNIPER.maxHoldMin}min timeout`);

  sendEmail(
    `🎯 SNIPER — ${symbol.replace("USDT", "")} new listing @ $${price.toFixed(8)}`,
    `<h2 style="color:#4f8dff">🎯 New Listing Sniped</h2>
     <table style="font-size:16px;line-height:1.8">
       <tr><td><b>Symbol</b></td><td>${symbol}</td></tr>
       <tr><td><b>Entry</b></td><td>$${price.toFixed(8)}</td></tr>
       <tr><td><b>Size</b></td><td>$${sizeUSD.toFixed(2)}</td></tr>
       <tr><td><b>Already pumped</b></td><td>+${(pumpedPct * 100).toFixed(1)}%</td></tr>
       <tr><td><b>Trailing stop</b></td><td>Activates at +${(SNIPER.trailActivatePct * 100).toFixed(0)}%, then ${(SNIPER.trailPct * 100).toFixed(0)}% below peak</td></tr>
       <tr><td><b>Stop loss</b></td><td>$${(price * (1 - SNIPER.stopLossPct)).toFixed(8)} (-${(SNIPER.stopLossPct * 100).toFixed(0)}%)</td></tr>
       <tr><td><b>Timeout</b></td><td>${SNIPER.maxHoldMin} minutes</td></tr>
     </table>`
  );
}

async function monitorSniperPositions() {
  if (CONFIG.paperTrading || acct().exchange !== "bitget") return;
  const log = loadLog();
  const open = Object.entries(log.sniperPositions || {}).filter(([, p]) => p?.open);
  if (open.length === 0) return;

  let prices = {};
  try {
    const res = await fetch("https://api.bitget.com/api/v2/spot/market/tickers", { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    (data.data || []).forEach(t => { prices[t.symbol] = parseFloat(t.lastPr); });
  } catch { return; }

  for (const [symbol, pos] of open) {
    let price = prices[symbol];
    if (!price) {
      // Brand-new listings may not appear in the bulk ticker yet — try individual endpoint
      try {
        const r = await fetch(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${symbol}`, { signal: AbortSignal.timeout(3000) });
        const d = await r.json();
        const t = (d.data || [])[0];
        if (t) price = parseFloat(t.lastPr);
      } catch {}
    }
    if (!price) continue;

    const pnlPct  = (price - pos.entryPrice) / pos.entryPrice * 100;
    const ageMin  = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;

    // Update high watermark
    const hwm = Math.max(pos.highWatermark ?? pos.entryPrice, price);
    const hwmUpdated = hwm > (pos.highWatermark ?? pos.entryPrice);

    // Trailing stop — activates once up trailActivatePct, then trails trailPct below peak
    const trailActive = hwm >= pos.entryPrice * (1 + SNIPER.trailActivatePct);
    const trailStop   = trailActive ? hwm * (1 - SNIPER.trailPct) : null;
    const hitTrail    = trailActive && price <= trailStop;
    const hitSL       = price <= pos.stopLossPrice;
    const timedOut    = Date.now() >= new Date(pos.maxHoldUntil).getTime();

    // Save updated high watermark even when not exiting
    if (hwmUpdated || (!hitTrail && !hitSL && !timedOut)) {
      if (hwmUpdated) {
        const freshLog = loadLog();
        if (freshLog.sniperPositions?.[symbol]?.open) {
          freshLog.sniperPositions[symbol].highWatermark = hwm;
          saveLog(freshLog);
        }
      }
      const trailInfo = trailActive
        ? ` | Trail stop: $${trailStop.toFixed(8)} (peak $${hwm.toFixed(8)})`
        : ` | Trail activates at $${(pos.entryPrice * (1 + SNIPER.trailActivatePct)).toFixed(8)}`;
      console.log(`🎯 Sniper ${symbol.replace("USDT", "")} — $${price.toFixed(8)} | P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% | ${ageMin.toFixed(1)}min${trailInfo}`);
      if (!hitTrail && !hitSL && !timedOut) continue;
    }

    const reason = hitTrail  ? `Trail stop +${pnlPct.toFixed(2)}% (peak +${((hwm - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)}%)`
                 : hitSL     ? `SL ${pnlPct.toFixed(2)}% — stopped out`
                 :             `Timeout ${ageMin.toFixed(1)}min (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`;
    console.log(`\n${pnlPct >= 0 ? "💰" : "🔴"} SNIPER EXIT — ${symbol} | ${reason}`);

    try {
      await placeBitGetOrder(symbol, "sell", null, price, String(pos.quantity));
    } catch (err) {
      console.log(`❌ Sniper sell failed: ${err.message} — will retry next cycle`);
      continue;
    }

    const qty = Number(pos.quantity);
    const pnlUSD = (price - pos.entryPrice) * qty;
    // Reload before write — sell order above took ~1s; other intervals may have changed the log
    const freshLog = loadLog();
    if (!freshLog.sniperPositions) freshLog.sniperPositions = {};
    freshLog.sniperPositions[symbol] = { ...pos, open: false };

    const exitLog = {
      timestamp: new Date().toISOString(), type: "exit", symbol,
      timeframe: "SNIPER", price, entryPrice: pos.entryPrice,
      quantity: qty, pnlPct: parseFloat(pnlPct.toFixed(3)), pnlUSD,
      exitReasons: [reason], orderPlaced: true, tradeType: "sniper", paperTrading: false,
    };
    freshLog.trades.push(exitLog);
    // Cooldown prevents scalp from immediately re-entering after sniper exits
    if (!freshLog.coinCooldowns) freshLog.coinCooldowns = {};
    if (!freshLog.coinCooldowns[symbol]) freshLog.coinCooldowns[symbol] = {};
    const sniperCooldownMs = pnlPct < 0 ? 2 * 60 * 60 * 1000 : 30 * 60 * 1000;
    freshLog.coinCooldowns[symbol].scalp = { until: Date.now() + sniperCooldownMs, pnlPct: pnlPct.toFixed(2) };
    saveLog(freshLog);
    writeTradeCsv(exitLog);
    pushSignal(symbol, pnlUSD >= 0 ? "EXIT_WIN" : "EXIT_LOSS", `🎯 Sniper exit: ${reason}`);

    sendEmail(
      `${pnlUSD >= 0 ? "💰" : "🔴"} SNIPER EXIT — ${symbol.replace("USDT", "")} | ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)}`,
      `<h2>${pnlUSD >= 0 ? "💰 Profit" : "🔴 Loss"}</h2>
       <table style="font-size:16px;line-height:1.8">
         <tr><td><b>Symbol</b></td><td>${symbol}</td></tr>
         <tr><td><b>Exit price</b></td><td>$${price.toFixed(8)}</td></tr>
         <tr><td><b>P&L</b></td><td>${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)</td></tr>
         <tr><td><b>Reason</b></td><td>${reason}</td></tr>
         <tr><td><b>Time held</b></td><td>${ageMin.toFixed(1)} min</td></tr>
       </table>`
    );
  }
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

      // Start price stream immediately, then refresh top movers and restart with updated symbols
      startPriceStream(CONFIG.symbols);
      refreshTopMovers().then(() => startPriceStream(CONFIG.symbols)).catch(e => console.error("refreshTopMovers failed:", e.message));

      for (const account of ACCOUNTS) {
        await _accountStore.run(account, async () => {
          // Startup balance sync + position reconciliation
          // Reconciliation re-discovers open positions after Railway log wipe
          if (!CONFIG.paperTrading) {
            const startLog = loadLog();
            await syncPortfolioBalance(startLog).catch(e => console.error("syncPortfolioBalance failed:", e.message));
            await reconcilePositions(startLog).catch(e => console.error("reconcilePositions failed:", e.message));
            await sweepDust(startLog).catch(e => console.error("sweepDust failed:", e.message));
            saveLog(startLog);
            await initSniperSymbols().catch(e => console.error("initSniperSymbols failed:", e.message));
            await runLongTermPortfolio().catch(e => console.error("LT portfolio startup failed:", e.message));
            sendEmail(
              "🤖 Bot Online — Trading Started",
              `<h2>🤖 Bot is now live</h2>
               <p>Started at ${new Date().toUTCString()}</p>
               <p><b>Portfolio:</b> $${(startLog.portfolioValue || 0).toFixed(2)}</p>
               <p><b>Watching:</b> ${CONFIG.symbols.join(", ")}</p>
               <p><b>Mode:</b> LIVE TRADING</p>`
            );
          }
          console.log(`\n👛 Account ${account.id} — initial scan (sequential)`);
          const startSyms = [...CONFIG.symbols];
          for (const sym of startSyms) {
            await run(null, sym).catch((err) => { console.error(`Startup ${sym} [acct${account.id}] error:`, err.message); pushSignal(sym, "BLOCKED", `Scan error: ${err.message?.slice(0, 60)}`); });
          }
          if (SWING_ENABLED) {
            for (const sym of CONFIG.symbols) {
              await runSwing(sym).catch((err) => console.error(`Swing startup ${sym} [acct${account.id}] error:`, err));
            }
            for (const sym of CONFIG.symbols) {
              await runBreakout(sym).catch((err) => console.error(`Breakout startup ${sym} [acct${account.id}] error:`, err));
            }
          }
        });
      }
      _lastScanTime = Date.now();
      _lastScanCount = CONFIG.symbols.length;
    })();
  });

  // Reconcile positions every 30 minutes — catches untracked holdings after Railway restarts
  if (!CONFIG.paperTrading) {
    setInterval(async () => {
      try {
        const rLog = loadLog();
        await reconcilePositions(rLog);
        await syncPortfolioBalance(rLog);
        saveLog(rLog);
      } catch (e) {
        console.log(`⚠️ Periodic reconcile failed: ${e.message}`);
      }
    }, 30 * 60 * 1000);
  }

  // Run long-term portfolio check every 6 hours
  if (!CONFIG.paperTrading && LT_ENABLED) {
    setInterval(async () => {
      await runLongTermPortfolio().catch(e => console.log(`⚠️ LT portfolio run failed: ${e.message}`));
    }, 6 * 60 * 60 * 1000);
  }

  // Swap to fresh top movers every 4 hours (restarts price stream with new symbols)
  setInterval(async () => {
    await refreshTopMovers();
    startPriceStream(CONFIG.symbols);
  }, 4 * 60 * 60 * 1000);

  // Quick gainer scan every 15 minutes — adds any new 3%+ mover immediately, no 4h wait
  setInterval(async () => {
    try {
      const res  = await fetch("https://api.bitget.com/api/v2/spot/market/tickers");
      const json = await res.json();
      if (json.code !== "00000") return;
      const NEVER_TRADE = new Set(["BGBUSDT","BSVUSDT","WBTCUSDT","STETHUSDT","CBETHUSDT","BETHUSDT"]);
      const allCoins = (json.data || []).filter(t =>
        t.symbol.endsWith("USDT") && !NEVER_TRADE.has(t.symbol) &&
        parseFloat(t.usdtVolume) > 1_000_000
      );
      _topGainers = allCoins
        .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPr), change24h: parseFloat(t.change24h) * 100, vol: parseFloat(t.usdtVolume) }))
        .filter(t => t.change24h > 0)
        .sort((a, b) => b.change24h - a.change24h)
        .slice(0, 20);
      const newMovers = _topGainers.filter(t => {
        if (t.change24h < 3) return false;
        if (CONFIG.symbols.includes(t.symbol)) return false;
        // Unknown coins (not pre-validated by weekly backtest) need $5M+ daily volume
        // to rule out thin pump-and-dumps. Established coins keep the $1M floor.
        if (!BACKTEST[t.symbol] && t.vol < 5_000_000) return false;
        return true;
      });
      if (newMovers.length > 0) {
        console.log(`\n⚡ Quick scan — new movers: ${newMovers.map(t => `${t.symbol} +${t.change24h.toFixed(1)}% ($${(t.vol/1e6).toFixed(0)}M vol)`).join(", ")}`);
        newMovers.forEach(t => CONFIG.symbols.push(t.symbol));
        startPriceStream(CONFIG.symbols);
      }
    } catch { /* silent */ }
  }, 15 * 60 * 1000);

  // Daily summary email — fires at 8am UTC (good morning report)
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 8 && now.getUTCMinutes() < 5) {
      const log = loadLog();
      await emailDailySummary(log);
    }
  }, 5 * 60 * 1000);

  // WebSocket hard-stop checker — fires every 5 seconds using live streamed prices
  setInterval(async () => {
    for (const account of ACCOUNTS) {
      await _accountStore.run(account, () => checkLiveHardStops());
    }
  }, 5000);

  // Fast exit monitor — check open scalp positions every 60 seconds
  setInterval(async () => {
    for (const account of ACCOUNTS) {
      await _accountStore.run(account, async () => {
        const log = loadLog();
        const openSymbols = Object.entries(log.positions || {})
          .filter(([, p]) => p && p.open)
          .map(([sym]) => sym);
        for (const sym of openSymbols) {
          await run(null, sym).catch((err) => { console.error(`Exit monitor ${sym} [acct${account.id}] error:`, err.message); pushSignal(sym, "BLOCKED", `Scan error: ${err.message?.slice(0, 60)}`); });
        }
      });
    }
  }, 60 * 1000);

  // Swing exit monitor — check open swing positions every 30 minutes
  setInterval(async () => {
    if (!SWING_ENABLED) return;
    for (const account of ACCOUNTS) {
      await _accountStore.run(account, async () => {
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
      });
    }
  }, 30 * 60 * 1000);

  // Swing entry scan — every 4 hours (aligned with 4H candle closes)
  setInterval(async () => {
    if (!SWING_ENABLED) return;
    for (const account of ACCOUNTS) {
      await _accountStore.run(account, async () => {
        console.log(`\n📈 Swing entry scan [acct${account.id}]...`);
        for (const sym of CONFIG.symbols) {
          await runSwing(sym).catch((err) => console.error(`Swing scan ${sym} [acct${account.id}] error:`, err));
        }
      });
    }
  }, 4 * 60 * 60 * 1000);

  // Breakout exit monitor — every 15 minutes (1H candles, faster reaction than swing)
  setInterval(async () => {
    if (!SWING_ENABLED) return;
    for (const account of ACCOUNTS) {
      await _accountStore.run(account, async () => {
        const log = loadLog();
        const openBk = Object.entries(log.breakoutPositions || {})
          .filter(([, p]) => p?.open).map(([s]) => s);
        if (openBk.length > 0) {
          console.log(`\n🚀 Breakout exit check [acct${account.id}] — ${openBk.join(", ")}`);
          for (const sym of openBk) {
            await runBreakout(sym).catch((err) => console.error(`Breakout exit ${sym} [acct${account.id}] error:`, err));
          }
        }
      });
    }
  }, 15 * 60 * 1000);

  // Breakout entry scan — every 1 hour
  setInterval(async () => {
    if (!SWING_ENABLED) return;
    for (const account of ACCOUNTS) {
      await _accountStore.run(account, async () => {
        for (const sym of CONFIG.symbols) {
          await runBreakout(sym).catch((err) => console.error(`Breakout scan ${sym} [acct${account.id}] error:`, err));
        }
      });
    }
  }, 60 * 60 * 1000);

  // New listing sniper — poll every 10 seconds for instant detection (BitGet only)
  setInterval(async () => {
    await _accountStore.run(ACCOUNTS[0], () => checkNewListings()).catch(e => console.error("checkNewListings failed:", e.message));
  }, 10 * 1000);

  // Pre-announcement monitor — check BitGet announcement API every 5 minutes to get ahead of listings
  setInterval(async () => {
    await _accountStore.run(ACCOUNTS[0], () => checkUpcomingListings()).catch(e => console.error("checkUpcomingListings failed:", e.message));
  }, 5 * 60 * 1000);

  // Resting TP order monitor — check if limit sell orders filled every 15 seconds
  setInterval(async () => {
    await _accountStore.run(ACCOUNTS[0], () => checkTpOrders()).catch(e => console.error("checkTpOrders failed:", e.message));
  }, 15 * 1000);

  // Sniper exit monitor — check TP/SL/timeout every 15 seconds
  setInterval(async () => {
    await _accountStore.run(ACCOUNTS[0], () => monitorSniperPositions()).catch(e => console.error("monitorSniperPositions failed:", e.message));
  }, 15 * 1000);

  // Check all symbols every 5 minutes (scalp entry scan + exit check) — sequential to prevent log clobber
  setInterval(async () => {
    for (const account of ACCOUNTS) {
      await _accountStore.run(account, async () => {
        const pollSyms = [...CONFIG.symbols];
        for (const sym of pollSyms) {
          await run(null, sym).catch((err) => { console.error(`Poll ${sym} [acct${account.id}] error:`, err.message); pushSignal(sym, "BLOCKED", `Scan error: ${err.message?.slice(0, 60)}`); });
        }
      });
    }
    _lastScanTime = Date.now();
    _lastScanCount = CONFIG.symbols.length;
  }, 5 * 60 * 1000);
}
