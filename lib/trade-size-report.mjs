// Reporting only. Never use this module to determine order quantity or risk.
export function formatTradeSizeSummary(tradeSize, portfolioValue) {
  const size = Number.isFinite(tradeSize) && tradeSize >= 0 ? tradeSize : 0;
  const portfolio = Number.isFinite(portfolioValue) && portfolioValue > 0 ? portfolioValue : 0;
  const usedPct = portfolio > 0 ? (size / portfolio) * 100 : 0;
  return `$${size.toFixed(2)} (${usedPct.toFixed(1)}% of $${portfolio.toFixed(2)})`;
}
