/**
 * Minimal, privacy-conscious PAPER-only log summary of a persistent ledger.
 * This module never touches the filesystem, networks or exchange accounts.
 */
import { auditPaperLedger } from "./paper-ledger-evidence.mjs";
export function summarizePaperLedgerForLog(state, accountId) {
  const result = auditPaperLedger(state);
  return {
    mode: "PAPER",
    accountId: String(accountId),
    status: "APP_RECORDED_FEE_ADJUSTED_EXITS_ONLY",
    recordedExitEvents: result.paperExitEventsSeen,
    auditableFeeAdjustedExitEvents: result.auditableExitEvents,
    excludedExitEvents: result.excludedExitEvents,
    realizedPaperExitPnlUSD: result.realizedExitPnlUsd,
    exitEventWinRatePct: result.winRatePct,
    exitEventProfitFactor: result.profitFactor,
    independentCompletedRoundTrips: null,
    fullPortfolioMaxDrawdownPct: null,
    riskLimitViolations: null,
    all100PaperTradesVerified: false,
    exchangeVerified: false,
    liveMoneyReady: false
  };
}
