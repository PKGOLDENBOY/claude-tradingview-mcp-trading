import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import crypto from "crypto";

const BASE_URL = "https://api.bitget.com";

function sign(ts, method, path, body = "") {
  return crypto.createHmac("sha256", process.env.BITGET_SECRET_KEY)
    .update(ts + method.toUpperCase() + path + body).digest("base64");
}

async function api(path) {
  const ts = Date.now().toString();
  const res = await fetch(BASE_URL + path, {
    headers: {
      "ACCESS-KEY": process.env.BITGET_API_KEY,
      "ACCESS-SIGN": sign(ts, "GET", path),
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": process.env.BITGET_PASSPHRASE,
      "locale": "en-US",
    },
  });
  return (await res.json()).data;
}

function bar(value, width = 20) {
  const filled = Math.round(Math.min(Math.max(value, 0), 1) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${(value * 100).toFixed(0)}%`;
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║         BOT STATUS (LIVE) — " + new Date().toLocaleTimeString() + "              ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // ── Live BitGet balances + prices ────────────────────────────────────────────
  const [assets, tickerData] = await Promise.all([
    api("/api/v2/spot/account/assets").catch(() => []),
    fetch(BASE_URL + "/api/v2/spot/market/tickers").then(r => r.json()).then(d => d.data).catch(() => []),
  ]);

  const prices = Object.fromEntries((tickerData || []).map(t => [t.symbol, parseFloat(t.lastPr)]));

  let totalUSD = 0;
  const holdings = [];
  for (const a of assets || []) {
    const qty = parseFloat(a.available) + parseFloat(a.frozen || 0);
    if (qty < 0.0001) continue;
    const price = a.coin === "USDT" ? 1 : (prices[a.coin + "USDT"] ?? 0);
    const usdVal = qty * price;
    if (usdVal < 0.50) continue;
    totalUSD += usdVal;
    holdings.push({ coin: a.coin, qty, usdVal, price });
  }

  const usdt = holdings.find(h => h.coin === "USDT")?.usdVal ?? 0;
  const openPositions = holdings.filter(h => h.coin !== "USDT" && h.coin !== "BGB" && h.usdVal >= 5);

  console.log("── Live Portfolio ────────────────────────────────────────");
  console.log(`  Total value:      $${totalUSD.toFixed(2)}`);
  console.log(`  USDT (cash):      $${usdt.toFixed(2)}`);
  if (openPositions.length > 0) {
    console.log(`  Open positions:   ${openPositions.length}`);
    openPositions.sort((a, b) => b.usdVal - a.usdVal).forEach(h => {
      console.log(`    ${h.coin.padEnd(8)} $${h.usdVal.toFixed(2).padStart(7)}  (${h.qty.toFixed(4)} @ $${h.price.toFixed(4)})`);
    });
  }

  // ── Today's trades from local CSV (best available without Railway log) ───────
  const CSV = "trades.csv";
  if (existsSync(CSV)) {
    const today = new Date().toISOString().slice(0, 10);
    const lines = readFileSync(CSV, "utf8").split("\n").filter(l =>
      l.includes(today) && l.includes("LIVE") && !l.includes("BLOCKED")
    );

    const exits = lines.filter(l => l.includes(",SELL,") || l.includes("Exit"));
    let wins = 0, losses = 0, grossPnl = 0;
    exits.forEach(l => {
      const m = l.match(/P&L: ([+-]?\d+\.?\d+)%/);
      if (m) {
        const pct = parseFloat(m[1]);
        grossPnl += pct;
        pct > 0 ? wins++ : losses++;
      }
    });

    const entries = lines.filter(l => l.includes(",BUY,"));
    const feePct = 0.16; // 0.08% × 2 round-trip with BGB
    const avgSize = usdt > 0 ? Math.min(totalUSD * 0.20, totalUSD) : 40;
    const estFees = (wins + losses) * (avgSize * feePct / 100);

    console.log("\n── Today (from local CSV) ────────────────────────────────");
    console.log(`  Entries:          ${entries.length}`);
    console.log(`  Exits:            ${exits.length}  (${wins}W / ${losses}L)`);
    if (exits.length > 0) {
      console.log(`  Gross P&L:        ${grossPnl >= 0 ? "+" : ""}${grossPnl.toFixed(2)}% across positions`);
      console.log(`  Est fees:         ~$${estFees.toFixed(2)}`);
    }

    // Last 5 executed trades
    const allTrades = readFileSync(CSV, "utf8").split("\n")
      .filter(l => l.includes("LIVE") && !l.includes("BLOCKED") && !l.includes("NOTE"))
      .slice(-5);
    if (allTrades.length > 0) {
      console.log("\n── Last 5 Trades ─────────────────────────────────────────");
      allTrades.forEach(l => {
        const parts = l.split(",");
        if (parts.length < 6) return;
        const time = parts[1]?.slice(0, 5) ?? "?";
        const coin = parts[3] ?? "?";
        const side = parts[4] === "BUY" ? "ENTRY" : "EXIT ";
        const pnlM = l.match(/P&L: ([+-]?\d+\.?\d+)%/);
        const pnl  = pnlM ? `  P&L: ${parseFloat(pnlM[1]) >= 0 ? "+" : ""}${parseFloat(pnlM[1]).toFixed(2)}%` : "";
        console.log(`  ${time}  ${side}  ${coin.padEnd(12)}${pnl}`);
      });
    }
  } else {
    console.log("\n  (trades.csv not found locally — check Railway logs for trade history)");
  }

  console.log("\n──────────────────────────────────────────────────────────\n");
}

main().catch(console.error);
