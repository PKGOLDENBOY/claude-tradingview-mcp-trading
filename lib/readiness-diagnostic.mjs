/**
 * Fail-closed readiness assessment for independent evidence. READ-ONLY.
 * No keys, no exchange calls, no deployments, never authorises trading.
 * Shadow proxy positions, validation trades and real forward paper round-trips
 * are deliberately different categories and cannot substitute for each other.
 */
const finite = value => typeof value==='number' && Number.isFinite(value);
const nonnegativeInt = value => Number.isSafeInteger(value) && value>=0;
export function assessReadiness({research={},shadow={},paper={}}={}) {
  const blockers=[];
  const reject = (condition,code) => {if(condition)blockers.push(code);};
  const validationEligibleCount=nonnegativeInt(research.eligible)?research.eligible:0;
  reject(validationEligibleCount<1,'NO_VALIDATION_ELIGIBLE_CANDIDATE');
  reject(typeof research.selected!=='string'||!research.selected,'NO_RESEARCH_SELECTION');
  reject(research.independentOosVerified!==true,'NO_INDEPENDENT_UNTOUCHED_OOS');
  reject(!nonnegativeInt(shadow.errors)||shadow.errors>0,'SHADOW_ERRORS_UNRESOLVED');
  const stats=(shadow.stats && typeof shadow.stats==='object' && !Array.isArray(shadow.stats))?shadow.stats:{};
  const simulatedExits=Object.values(stats).reduce((n,s)=>n+(nonnegativeInt(s?.exits)?s.exits:0),0);
  for(const [family,s] of Object.entries(stats)) {
    if(!nonnegativeInt(s?.exits) || !finite(s?.realizedPnlUSD)){
      blockers.push('SHADOW_METRICS_INCOMPLETE_'+family.toUpperCase());
      continue;
    }
    if(s.exits>0 && (s.realizedPnlUSD<=0 || !finite(s.profitFactor) || s.profitFactor<=1))
      blockers.push('LOSING_SHADOW_STRATEGY_'+family.toUpperCase());
  }
  reject(!Object.keys(stats).length,'NO_SHADOW_EVIDENCE');
  const independentlyReconciled=paper.independentCompletedRoundTrips;
  reject(!nonnegativeInt(independentlyReconciled)||independentlyReconciled<100 ||
    paper.all100PaperTradesVerified!==true,'FEWER_THAN_100_RECONCILED_FORWARD_PAPER_ROUND_TRIPS');
  reject(!nonnegativeInt(paper.auditableFeeAdjustedExitEvents) ||
    paper.auditableFeeAdjustedExitEvents<100 ||
    (nonnegativeInt(independentlyReconciled)&&paper.auditableFeeAdjustedExitEvents<independentlyReconciled),
    'PAPER_FEE_ADJUSTED_LEDGER_INCOMPLETE');
  reject(paper.exchangeVerified!==true || !finite(paper.fullPortfolioMaxDrawdownPct) ||
    paper.fullPortfolioMaxDrawdownPct<0 || !nonnegativeInt(paper.riskLimitViolations),
    'INDEPENDENT_ACCOUNT_RISK_AUDIT_INCOMPLETE');
  reject(nonnegativeInt(paper.riskLimitViolations)&&paper.riskLimitViolations>0,
    'PAPER_RISK_LIMIT_VIOLATIONS');
  return {status:'NO_GO_REQUIRES_INDEPENDENT_REVIEW',
    liveMoneyReady:false,realOrdersAuthorized:false,
    blockers,validationEligibleCount,
    simulatedShadowExitsNotCountedAsPaper:simulatedExits,
    independentPaperRoundTrips:nonnegativeInt(independentlyReconciled)?independentlyReconciled:null,
    historicalShadowErrorCount:nonnegativeInt(shadow.errors)?shadow.errors:null,
    selectedResearchHypothesis:typeof research.selected==='string'?research.selected:null,
    note:'Even zero blockers would require separate human sign-off, independent verification, and explicit risk approval. This module has no order interface.'};
}
