// Reconstruct REAL total-equity curve on BitGet over last ~7 days. Read-only (GET).
import crypto from "crypto";
import "dotenv/config";

const KEY = process.env.BITGET_API_KEY, SECRET = process.env.BITGET_SECRET_KEY;
const PASS = process.env.BITGET_PASSPHRASE, BASE = process.env.BITGET_BASE_URL || "https://api.bitget.com";

function sign(ts, m, p, q = "") { return crypto.createHmac("sha256", SECRET).update(`${ts}${m}${p}${q}`).digest("base64"); }
async function get(path, params = {}) {
  const ts = Date.now().toString();
  const qs = new URLSearchParams(params).toString(), query = qs ? `?${qs}` : "";
  const res = await fetch(`${BASE}${path}${query}`, { headers: {
    "ACCESS-KEY": KEY, "ACCESS-SIGN": sign(ts, "GET", path, query), "ACCESS-TIMESTAMP": ts,
    "ACCESS-PASSPHRASE": PASS, "locale": "en-US", "Content-Type": "application/json" } });
  const j = await res.json();
  if (j.code !== "00000") throw new Error(`${path} -> ${j.code} ${j.msg}`);
  return j.data;
}

// current balances
const assets = await get("/api/v2/spot/account/assets");
const balNow = {};
for (const a of assets) {
  const amt = parseFloat(a.available) + parseFloat(a.frozen) + parseFloat(a.locked || 0);
  if (amt > 0) balNow[a.coin] = amt;
}

// 7d of bills
const DAYS = 7;
const since = Date.now() - DAYS * 864e5;
let bills = [], idLessThan = "", g = 0;
while (g++ < 80) {
  const p = { limit: "100", startTime: String(since), endTime: String(Date.now()) };
  if (idLessThan) p.idLessThan = idLessThan;
  const d = await get("/api/v2/spot/account/bills", p);
  if (!d?.length) break;
  bills.push(...d);
  if (d.length < 100) break;
  idLessThan = d[d.length - 1].billId;
}
bills.sort((a, b) => +a.cTime - +b.cTime);

// transfers (should be zero per earlier check, but verify by coin)
let xfer = 0;
for (const b of bills) {
  const t = (b.businessType || "").toLowerCase();
  if (t.includes("deposit") || t.includes("withdraw") || t.includes("transfer")) xfer += 1;
}

// daily close timestamps (UTC) for last DAYS days incl now
const dayCloses = [];
const todayMid = new Date(); todayMid.setUTCHours(0, 0, 0, 0);
for (let i = DAYS - 1; i >= 0; i--) dayCloses.push(new Date(todayMid - (i - 1) * 864e5)); // end-of-day = next midnight
dayCloses[dayCloses.length - 1] = new Date(); // last point = now

// coins we need prices for
const coins = new Set(Object.keys(balNow));
for (const b of bills) coins.add(b.coin);
coins.delete("USDT");

// daily close price per coin via candles (1day). map dayKey->price
const priceHist = {}; // coin -> {YYYY-MM-DD: close}
for (const c of coins) {
  priceHist[c] = {};
  try {
    const r = await fetch(`${BASE}/api/v2/spot/market/candles?symbol=${c}USDT&granularity=1day&limit=10`);
    const j = await r.json();
    for (const row of (j.data || [])) {
      const d = new Date(+row[0]).toISOString().slice(0, 10);
      priceHist[c][d] = parseFloat(row[4]); // close
    }
  } catch {}
}
function priceAt(coin, date) {
  if (coin === "USDT") return 1;
  const h = priceHist[coin] || {};
  const k = date.toISOString().slice(0, 10);
  if (h[k] != null) return h[k];
  // fallback: nearest available
  const keys = Object.keys(h).sort();
  for (let i = keys.length - 1; i >= 0; i--) if (keys[i] <= k) return h[keys[i]];
  return keys.length ? h[keys[0]] : 0;
}

// balance of each coin at time T = balNow - sum(bill.size for bills after T)
function balAt(T) {
  const bal = { ...balNow };
  for (const b of bills) {
    if (+b.cTime > T) {
      const s = parseFloat(b.size);
      if (!isNaN(s)) bal[b.coin] = (bal[b.coin] || 0) - s;
    }
  }
  return bal;
}

console.log("=========== REAL TOTAL-EQUITY CURVE (BitGet) ===========");
console.log(`Transfer/deposit/withdraw events in window: ${xfer} (0 => equity change == trading P&L)`);
console.log(`Bills: ${bills.length}\n`);
console.log("Date (UTC close) |  Total Equity");
let prevEq = null, startEq = null;
for (const dc of dayCloses) {
  const bal = balAt(dc.getTime());
  let eq = 0;
  for (const [c, amt] of Object.entries(bal)) {
    if (amt <= 0) continue;
    eq += amt * priceAt(c, dc);
  }
  const lbl = dc.toISOString().slice(0, 10) + (dc.getTime() > Date.now() - 60000 ? " (now)" : "");
  const chg = prevEq == null ? "" : `  ${eq - prevEq >= 0 ? "+" : ""}$${(eq - prevEq).toFixed(2)}`;
  console.log(`${lbl.padEnd(17)}|  $${eq.toFixed(2)}${chg}`);
  if (startEq == null) startEq = eq;
  prevEq = eq;
}
console.log(`\n6-day net (trading P&L): ${prevEq - startEq >= 0 ? "+" : ""}$${(prevEq - startEq).toFixed(2)}  (${((prevEq / startEq - 1) * 100).toFixed(1)}%)`);
