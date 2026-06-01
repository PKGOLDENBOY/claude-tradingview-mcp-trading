import "dotenv/config";
import crypto from "crypto";

const BASE = "https://api.bitget.com";
const KEY  = process.env.BITGET_API_KEY;
const SEC  = process.env.BITGET_SECRET_KEY;
const PASS = process.env.BITGET_PASSPHRASE;

function sign(ts, method, path, body = "") {
  return crypto.createHmac("sha256", SEC).update(ts + method + path + body).digest("base64");
}

async function api(method, path, body = null) {
  const ts  = Date.now().toString();
  const raw = body ? JSON.stringify(body) : "";
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "ACCESS-KEY": KEY, "ACCESS-SIGN": sign(ts, method, path, raw),
      "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": PASS,
      "Content-Type": "application/json", "locale": "en-US",
    },
    body: body ? raw : undefined,
  });
  const j = await res.json();
  if (j.code !== "00000") throw new Error(`API ${path}: ${j.msg} (${j.code})`);
  return j.data;
}

// Get all balances
const assets = await api("GET", "/api/v2/spot/account/assets");
const tickers = await fetch(BASE + "/api/v2/spot/market/tickers").then(r => r.json()).then(d => d.data);
const prices = Object.fromEntries(tickers.map(t => [t.symbol, parseFloat(t.lastPr)]));

// Get symbol info for stepSize
const symbolInfo = await fetch(BASE + "/api/v2/spot/public/symbols").then(r => r.json()).then(d => d.data);
const stepSizes = Object.fromEntries((symbolInfo || []).map(s => [s.symbol, s.quantityPrecision ?? 6]));

// Coins bot is actively managing via log.positions — don't touch these
// Update this list before running if the bot has open positions
const TRACKED = ["TRX", "WLFI", "GOMIN", "INJ"];
// Never sell these (long-term holds, locked tokens, exchange coins)
const SKIP = ["USDT", "BGB", "USDC", "ARKM", "preSPCX"];

const candidates = assets.filter(a => {
  const qty = parseFloat(a.available);
  if (qty <= 0) return false;
  if (SKIP.includes(a.coin)) return false;
  if (TRACKED.includes(a.coin)) return false;
  const price = prices[a.coin + "USDT"] ?? 0;
  return qty * price >= 2; // only sell if worth at least $2
});

if (candidates.length === 0) {
  console.log("Nothing to sell.");
  process.exit(0);
}

console.log(`\nSelling ${candidates.length} untracked position(s):\n`);

for (const asset of candidates) {
  const sym   = asset.coin + "USDT";
  const qty   = parseFloat(asset.available);
  const price = prices[sym] ?? 0;
  const usd   = qty * price;
  const prec  = stepSizes[sym] ?? 6;
  const factor = Math.pow(10, prec);
  const size  = (Math.floor(qty * factor) / factor).toFixed(prec);
  console.log(`  ${asset.coin.padEnd(8)} ${size} @ $${price.toFixed(6)} = $${usd.toFixed(2)} (prec=${prec})`);

  try {
    const order = await api("POST", "/api/v2/spot/trade/place-order", {
      symbol: sym,
      side: "sell",
      orderType: "market",
      force: "GTC",
      size,
    });
    console.log(`  ✅ Sold — order ${order.orderId}`);
  } catch (err) {
    console.log(`  ❌ Failed: ${err.message}`);
  }
}

// Show resulting USDT balance
await new Promise(r => setTimeout(r, 1500));
const after = await api("GET", "/api/v2/spot/account/assets");
const usdt  = after.find(a => a.coin === "USDT");
console.log(`\nDone. USDT balance now: $${parseFloat(usdt?.available ?? 0).toFixed(2)}\n`);
