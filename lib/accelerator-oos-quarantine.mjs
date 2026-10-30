/** Immutable research safety decisions. No exchange/order dependencies. */
export const FAILED_OOS_CANDIDATES = Object.freeze({
  'reversion-0192': Object.freeze({
    status: 'REJECTED_INDEPENDENT_OOS',
    completedSimulatedTrades: 25,
    netPnlUSD: -38.2268,
    profitFactor: 0.3913,
    winRate: 0.36,
    evidence: 'https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/actions/runs/40917479432',
    note: 'The October 29, 2026 historical holdout has been consumed. Never reuse for model selection.',
  }),
});
export function enforceResearchHoldoutLock(requested) {
  if (requested) throw new Error('CONSUMED_HOLDOUT_LOCKED: independent preregistered future OOS protocol required; do not reuse historical holdout');
}
export function reviewResearchCandidate(candidate) {
  if (!candidate) return {status:'NO_CANDIDATE',profitabilityDemonstrated:false};
  const prior = FAILED_OOS_CANDIDATES[candidate.id];
  if (prior) return {status:'PRIOR_OOS_FAILED_DO_NOT_PROMOTE',profitabilityDemonstrated:false,prior};
  return {status:'VALIDATION_ONLY_NOT_OOS_VALIDATED',profitabilityDemonstrated:false};
}

/** Retain rejected candidates in diagnostics but exclude them from promotion. */
export function quarantineCandidateResults(results) {
  if (!Array.isArray(results)) throw new Error('CANDIDATE_RESULTS_INVALID');
  const quarantinedPreviouslyEligibleCandidates=[];
  const reviewed=results.map(candidate=>{
    if (!FAILED_OOS_CANDIDATES[candidate.id]) return candidate;
    if (candidate.eligible) quarantinedPreviouslyEligibleCandidates.push(candidate.id);
    return {...candidate,eligible:false,excludedFromPromotion:'PRIOR_INDEPENDENT_OOS_FAILED'};
  });
  return {results:reviewed,quarantinedPreviouslyEligibleCandidates};
}
