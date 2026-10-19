// Deterministic risk and simulation math; no network or order placement.
function numberAtLeast(v, floor = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= floor ? n : null;
}

export function safePositionNotional({
  portfolioUsd, stopFraction, absoluteLimitUsd = null,
  fractionLimit = 0.15, riskFraction = 0.01,
  feeFraction = 0.001, slippageFraction = 0.001,
  minSizeUsd = 1,
}) {
  const eq = numberAtLeast(portfolioUsd, 0);
  const stop = numberAtLeast(stopFraction, 0);
  const pct = numberAtLeast(fractionLimit, 0);
  const risk = numberAtLeast(riskFraction, 0);
  const fee = numberAtLeast(feeFraction, 0);
  const slip = numberAtLeast(slippageFraction, 0);
  if (!eq || !stop || pct === null || risk === null || fee === null || slip === null) return 0;
  if (pct === 0 || risk === 0) return 0;
  const configuredUsd = absoluteLimitUsd === null ? Infinity : numberAtLeast(absoluteLimitUsd);
  if (configuredUsd === null) return 0;
  // Include two-sided execution costs in maximum loss to avoid oversizing.
  const riskPerDollar = stop + 2 * fee + 2 * slip;
  const riskLimit = riskPerDollar > 0 ? (eq * risk) / riskPerDollar : 0;
  const amount = Math.min(eq * pct, configuredUsd, riskLimit);
  const rounded = Math.floor(amount * 100) / 100;
  return rounded >= minSizeUsd ? rounded : 0;
}

export function paperEntry({ marketPrice, notionalUsd, feeFraction = 0.001, slippageFraction = 0.001 }) {
  const price = numberAtLeast(marketPrice, 0), usd = numberAtLeast(notionalUsd, 0);
  const fee = numberAtLeast(feeFraction, 0), slip = numberAtLeast(slippageFraction, 0);
  if (!price || !usd || fee === null || slip === null) throw new Error("Invalid paper entry");
  const fillPrice = price * (1 + slip);
  const quantity = usd / fillPrice;
  const entryFeeUsd = usd * fee;
  return { marketPrice: price, fillPrice, quantity, entryFeeUsd, notionalUsd: usd };
}

export function paperExit({
  entryFillPrice, exitMarketPrice, quantity,
  entryFeeUsd = 0, feeFraction = 0.001, slippageFraction = 0.001,
}) {
  const entry = numberAtLeast(entryFillPrice, 0), exit = numberAtLeast(exitMarketPrice, 0);
  const qty = numberAtLeast(quantity, 0), buyFee = numberAtLeast(entryFeeUsd, 0);
  const fee = numberAtLeast(feeFraction, 0), slip = numberAtLeast(slippageFraction, 0);
  if (!entry || !exit || !qty || buyFee === null || fee === null || slip === null)
    throw new Error("Invalid paper exit");
  const exitFillPrice = exit * (1 - slip);
  const exitFeeUsd = exitFillPrice * qty * fee;
  const entryCostUsd = entry * qty + buyFee;
  const exitProceedsUsd = exitFillPrice * qty - exitFeeUsd;
  const pnlUsd = exitProceedsUsd - entryCostUsd;
  return {
    entryCostUsd, exitFillPrice, exitFeeUsd, exitProceedsUsd, pnlUsd,
    pnlPct: (pnlUsd / entryCostUsd) * 100,
    tradingCostsUsd: buyFee + exitFeeUsd + Math.max(0, (exit - exitFillPrice) * qty),
  };
}

// Intended for paper monitoring and signed P&L reports. Does NOT imply live trade approval.
export function paperStats(trades) {
  const completed = (Array.isArray(trades) ? trades : []).filter(t =>
    t?.type === "exit" && t?.paperTrading === true &&
    Number.isFinite(Number(t.pnlUSD)) && t.pnlUSD !== null);
  const wins = completed.filter(t => Number(t.pnlUSD) > 0);
  const losses = completed.filter(t => Number(t.pnlUSD) < 0);
  const sum = arr => arr.reduce((a,t) => a + Number(t.pnlUSD), 0);
  const grossWins = sum(wins), grossLossAbs = -sum(losses);
  return {
    sample: completed.length,
    wins: wins.length, losses: losses.length,
    winRatePct: completed.length ? 100 * wins.length / completed.length : null,
    realizedPnlUsd: sum(completed),
    profitFactor: grossLossAbs ? grossWins / grossLossAbs : null,
    basis: "paper-exits-only; fees included only for fills marked feeAdjusted",
    feeAdjustedExits: completed.filter(t => t.feeAdjusted === true).length,
  };
}
