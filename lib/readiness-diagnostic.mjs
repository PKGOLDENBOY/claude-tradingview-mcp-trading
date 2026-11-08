/**
 * Read-only readiness diagnostic. This never grants permission to trade.
 * Inputs are observational Railway telemetry, not exchange receipts.
 */
export function assessReadiness({research,shadow,paper}) {
  const reasons=[];
  const researchEligible=Number(research?.eligible);
  const selected=research?.selected;
  const oosVerified=research?.independentOosVerified===true;
  const simulatedExits=Object.values(shadow?.stats||{}).reduce((n,s)=>n+(s.exits||0),0);
  if(!Number.isSafeInteger(researchEligible)||researchEligible<1)
    reasons.push('NO_VALIDATION_ELIGIBLE_CANDIDATE');
  if(!selected)reasons.push('NO_RESEARCH_SELECTION');
  if(!oosVerified)reasons.push('NO_INDEPENDENT_UNTOUCHED_OOS');
  if(!Number.isSafeInteger(shadow?.errors)||shadow.errors!==0)
    reasons.push('SHADOW_ERRORS_UNRESOLVED');
  for(const [family,stats] of Object.entries(shadow?.stats||{})) {
    if(stats.exits>0 && (stats.realizedPnlUSD<=0 || stats.profitFactor===null || stats.profitFactor<=1))
      reasons.push('LOSING_SHADOW_STRATEGY_'+family.toUpperCase());
  }
  if(paper?.all100PaperTradesVerified!==true || paper?.independentCompletedRoundTrips<100)
    reasons.push('FEWER_THAN_100_RECONCILED_FORWARD_PAPER_ROUND_TRIPS');
  if(paper?.exchangeVerified!==true || paper?.fullPortfolioMaxDrawdownPct===null ||
     paper?.riskLimitViolations===null)reasons.push('PAPER_ACCOUNT_RISK_AUDIT_INCOMPLETE');
  // This module only diagnoses missing evidence; even zero reasons would require
  // separate human sign-off, independent audit and explicit risk approval.
  return {status:'NO_GO_REQUIRES_INDEPENDENT_REVIEW',liveMoneyReady:false,
    realOrdersAuthorized:false,simulatedExitsNotCountedAsPaper:simulatedExits,
    blockers:reasons,shadowErrorCount:shadow?.errors??null,
    candidate:selected??null,validationEligibleCount:researchEligible||0};
}
