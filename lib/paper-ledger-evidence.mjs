/**
 * Conservative audit of recorded simulated exits. Zero exchange/network access.
 *
 * IMPORTANT: Even 100 verified exit EVENTS cannot establish 100 independent,
 * fully closed ROUND TRIPS when legacy logs lack immutable position identifiers.
 * Never infer a full account equity drawdown from exit-only realized P&L.
 */
const money = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const round = (n,places=6) => Number(n.toFixed(places));
export function auditPaperLedger(log, { initialEquityUsd = null } = {}) {
  if (!log || !Array.isArray(log.trades)) throw new Error("MISSING_PERSISTED_TRADE_EVENTS");
  const allPaperExits = log.trades.filter(t => t?.type === "exit" && t?.paperTrading === true);
  const verified = [], excluded = [], keys = new Set();
  for (const t of allPaperExits) {
    const usd = money(t.pnlUSD);
    const qty = Number(t.quantity);
    const ts = Date.parse(t.timestamp);
    const required = t.orderPlaced === true && t.feeAdjusted === true &&
      usd !== null && Number.isFinite(qty) && qty > 0 &&
      Number.isFinite(ts) && typeof t.symbol === "string" && t.symbol.length > 2;
    if (!required) { excluded.push({reason:"MISSING_FILL_OR_FEE_EVIDENCE",symbol:t.symbol??null});continue; }
    const key = [t.timestamp,t.symbol,t.orderId??"",String(qty),String(usd)].join("|");
    if (keys.has(key)) { excluded.push({reason:"DUPLICATE_EXIT_EVENT",symbol:t.symbol});continue; }
    keys.add(key);
    verified.push({time:ts,symbol:t.symbol,quantity:qty,pnlUSD:usd});
  }
  verified.sort((a,b)=>a.time-b.time);
  const gains=verified.filter(t=>t.pnlUSD>0),losses=verified.filter(t=>t.pnlUSD<0);
  const sum=a=>a.reduce((s,t)=>s+t.pnlUSD,0);
  const grossGains=sum(gains),grossLosses=-sum(losses), realized=sum(verified);
  const initial=money(initialEquityUsd);
  let exitOnlyRealizedDrawdownPct=null;
  if (initial !== null && initial>0) {
    let equity=initial,peak=initial,maxDd=0;
    for (const event of verified) {
      equity+=event.pnlUSD;peak=Math.max(peak,equity);
      maxDd=Math.max(maxDd,(peak-equity)/peak*100);
    }
    exitOnlyRealizedDrawdownPct=round(maxDd,3);
  }
  return {
    basis:"fee-adjusted PAPER exit events from persisted app state; not exchange verified",
    paperExitEventsSeen:allPaperExits.length,
    auditableExitEvents:verified.length,
    excludedExitEvents:excluded.length,
    excludedReasons:Object.fromEntries(["MISSING_FILL_OR_FEE_EVIDENCE","DUPLICATE_EXIT_EVENT"]
      .map(reason=>[reason,excluded.filter(x=>x.reason===reason).length])),
    realizedExitPnlUsd:round(realized,4),
    wins:gains.length,losses:losses.length,
    breakeven:verified.length-gains.length-losses.length,
    winRatePct:verified.length?round(gains.length/verified.length*100,2):null,
    profitFactor:grossLosses>0?round(grossGains/grossLosses,4):null,
    exitOnlyRealizedDrawdownPct,
    fullPortfolioMaxDrawdownPct:null,
    riskLimitViolations:null,
    completedIndependentRoundTripsVerified:null,
    hasVerified100CompletedTrades:false,
    readyForLiveMoney:false,
    readOnly:true,
    limitations:[
      "Paper P&L relies on app-recorded fee/slippage calculations, not independent exchange fills.",
      "Exit events can be partial fills, so event count is NOT fully closed position count.",
      "Trade events lack immutable position IDs and full position-by-position reconciliation.",
      "Exit-only drawdown misses unrealized intra-position losses and is not portfolio maximum drawdown.",
      "Risk-limit compliance needs a time-stamped portfolio/equity and order-risk ledger.",
    ],
  };
}
