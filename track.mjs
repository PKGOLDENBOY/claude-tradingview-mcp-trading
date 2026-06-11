// Strategy forward-tracker. Run any time:  node track.mjs
// Reads BitGet directly (exchange ground truth — independent of the bot's internal log).
// On first run it records a baseline so "since tracking started" is meaningful afterward.
import crypto from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

const START_CAPITAL = 250;
const BASE_FILE = "track-baseline.json";
const ENV = {};
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) ENV[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const B = "https://api.bitget.com";
const sign = (ts, m, p, b = "") => crypto.createHmac("sha256", ENV.BITGET_SECRET_KEY).update(ts + m + p + b).digest("base64");
async function priv(path) {
  const ts = Date.now().toString();
  const r = await fetch(B + path, { headers: { "ACCESS-KEY": ENV.BITGET_API_KEY, "ACCESS-SIGN": sign(ts, "GET", path), "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": ENV.BITGET_PASSPHRASE, "locale": "en-US" } });
  return r.json();
}

(async () => {
  const pr = await (await fetch(B + "/api/v2/spot/market/tickers")).json();
  const px = Object.fromEntries((pr.data || []).map(t => [t.symbol, parseFloat(t.lastPr)]));
  const btcPx = px["BTCUSDT"];

  const assets = (await priv("/api/v2/spot/account/assets")).data || [];
  let total = 0, holdings = [];
  for (const a of assets) {
    const q = parseFloat(a.available) + parseFloat(a.frozen || 0);
    const p = a.coin === "USDT" ? 1 : (px[a.coin + "USDT"] || 0);
    const v = q * p; if (v < 0.01) continue; total += v;
    if (a.coin !== "USDT" && v >= 2) holdings.push(`${a.coin} $${v.toFixed(2)}`);
  }

  // Prefer BitGet's OFFICIAL total valuation (the number shown in the app) over our manual
  // sum — the manual sum undercounts coins without a clean USDT ticker (was ~$7 low).
  try {
    const ov = (await priv("/api/v2/account/all-account-balance")).data || [];
    const official = ov.reduce((s, a) => s + parseFloat(a.usdtBalance || 0), 0);
    if (official > 0) total = official;
  } catch { /* fall back to manual sum */ }

  let base;
  if (existsSync(BASE_FILE)) base = JSON.parse(readFileSync(BASE_FILE, "utf8"));
  else { base = { date: new Date().toISOString(), value: total, btc: btcPx }; writeFileSync(BASE_FILE, JSON.stringify(base, null, 2)); }
  const sinceDays = ((Date.now() - new Date(base.date).getTime()) / 86400000).toFixed(1);
  const btcRetSince = base.btc ? (btcPx - base.btc) / base.btc * 100 : 0;
  const acctRetSince = base.value > 0 ? (total - base.value) / base.value * 100 : 0;

  // Realized round-trips from actual fills, last 7 days, FIFO-matched
  let rt = { n: 0, wins: 0, pnl: 0 };
  try {
    const since = Date.now() - 7 * 86400000;
    const fills = (await priv(`/api/v2/spot/trade/fills?limit=500&startTime=${since}`)).data || [];
    fills.sort((a, b) => +a.cTime - +b.cTime);
    const q = {};
    for (const f of fills) {
      const s = f.symbol, side = f.side, price = parseFloat(f.priceAvg || f.price), qty = parseFloat(f.size);
      const fee = Math.abs(parseFloat(f.feeDetail?.[0]?.totalFee ?? f.fee ?? 0));
      if (!q[s]) q[s] = [];
      if (side === "buy") q[s].push({ qty, price, fee });
      else {
        let remain = qty, cost = 0; const proceeds = qty * price;
        while (remain > 1e-9 && q[s].length) { const b = q[s][0]; const take = Math.min(remain, b.qty); cost += take * b.price + (b.fee * take / b.qty); b.qty -= take; remain -= take; if (b.qty <= 1e-9) q[s].shift(); }
        if (cost > 0) { const pnl = proceeds - cost - fee; rt.n++; if (pnl > 0) rt.wins++; rt.pnl += pnl; }
      }
    }
  } catch (e) { rt.err = e.message; }

  let fg = {}; try { fg = (await (await fetch("https://api.alternative.me/fng/")).json()).data[0]; } catch {}

  const beating = acctRetSince - btcRetSince;
  console.log("\n╔═══════════ STRATEGY FORWARD TRACKER ═══════════╗");
  console.log("  " + new Date().toLocaleString());
  console.log("\n── Account (BitGet ground truth) ──────────────────");
  console.log(`  Value now:        $${total.toFixed(2)}`);
  console.log(`  vs $250 start:    ${total - START_CAPITAL >= 0 ? "+" : ""}$${(total - START_CAPITAL).toFixed(2)}  (${((total - START_CAPITAL) / START_CAPITAL * 100).toFixed(1)}%)`);
  console.log(`  Open positions:   ${holdings.length ? holdings.join(", ") : "none — all cash"}`);
  console.log(`\n── Since tracking started (${sinceDays} days ago) ──`);
  console.log(`  Account:          ${acctRetSince >= 0 ? "+" : ""}${acctRetSince.toFixed(2)}%`);
  console.log(`  Buy-and-hold BTC: ${btcRetSince >= 0 ? "+" : ""}${btcRetSince.toFixed(2)}%`);
  console.log(`  → Strategy is ${beating >= 0 ? "✅ BEATING" : "🔴 LAGGING"} buy-hold by ${Math.abs(beating).toFixed(2)}%`);
  console.log(`\n── Realized round-trips (last 7d, from fills) ──────`);
  if (rt.err) console.log(`  (fills unavailable: ${rt.err})`);
  else console.log(`  Trades: ${rt.n}  |  win rate: ${rt.n ? (100 * rt.wins / rt.n).toFixed(0) : "—"}%  |  net: ${rt.pnl >= 0 ? "+" : ""}$${rt.pnl.toFixed(2)}`);
  console.log(`\n── Context ────────────────────────────────────────`);
  console.log(`  BTC: $${btcPx.toLocaleString()}  |  F&G: ${fg.value ?? "?"} (${fg.value_classification ?? "?"})`);
  console.log(`\n  ⚖️  Judge by account-vs-BTC over WEEKS. Edge is thin —`);
  console.log(`     ~hundreds more trades needed to confirm. Don't react to one run.`);
  console.log("╚════════════════════════════════════════════════╝\n");
})().catch(e => console.log("Tracker error:", e.message));
