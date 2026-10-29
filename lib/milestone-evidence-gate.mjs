/**
 * AlphaBot research-only evidence manifest linter.
 *
 * This checks PRESENCE and SHAPE of evidence references, not the truth of the
 * linked reports or account statements. A passing result is NOT completion,
 * demonstrated profitability, permission to notify, or authorization to trade.
 * The reviewer must independently open and verify each source.
 *
 * Offline / read-only: no network, exchange credentials, orders, Railway calls,
 * production imports, deployment, or environment changes.
 */
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const link = v => nonempty(v) && /^https:\/\/[^\s]+$/i.test(v);
const num = v => typeof v === 'number' && Number.isFinite(v);
const nat = v => Number.isSafeInteger(v) && v >= 0;

export function inspectMilestoneEvidence(evidence) {
  const missing = [];
  const requireEvidence = (condition, message) => {
    if (!condition) missing.push(message);
  };
  if (!isObject(evidence) || evidence.schemaVersion !== 1) {
    return {
      structuralEvidencePresent: false, notificationAuthorized: false,
      humanSourceVerificationRequired: true,
      profitabilityDemonstrated: false, missing: ['Missing evidence schemaVersion 1.']
    };
  }

  for (const category of ['order', 'accounting', 'risk']) {
    const fix = Array.isArray(evidence.fixes)
      ? evidence.fixes.find(x => isObject(x) && x.category === category) : null;
    requireEvidence(fix?.isolatedBranch === true && nonempty(fix?.branch)
      && fix?.testsPassed === true && link(fix?.testUrl)
      && link(fix?.diffUrl) && nonempty(fix?.defectAndResolution),
      'Missing isolated branch, regression tests and documented ' + category + ' fixes.');
  }
  for (const strategy of ['momentum', 'scalp', 'swing']) {
    const finding = Array.isArray(evidence.strategyEvaluations)
      ? evidence.strategyEvaluations.find(x => isObject(x) && x.strategy === strategy) : null;
    requireEvidence(finding?.evaluated === true && link(finding?.reportUrl)
      && nonempty(finding?.finding)
      && finding?.afterCosts === true,
      'Missing fee/cost-aware ' + strategy + ' strategy evaluation.');
  }

  const r = evidence.research;
  requireEvidence(r?.chronologicalFolds === true && r?.trainingOnlyFeatures === true
    && r?.dataQualityAudited === true && r?.bothSideCosts === true
    && r?.selectionFrozenBeforeOos === true && r?.holdoutUsedOnceOnly === true
    && r?.noHoldoutRetuning === true && link(r?.foldsAndQualityReportUrl),
    'Missing leak-free folds, data-quality/cost audit, or one-time OOS protocol.');
  for (const family of ['fixedRule', 'ml']) {
    const f = r?.[family];
    requireEvidence(f?.trained === true && f?.validated === true
      && f?.untouchedOosCompleted === true && link(f?.trainReportUrl)
      && link(f?.validationReportUrl) && link(f?.oosReportUrl),
      'Missing independent untouched out-of-sample results for ' + family + '.');
  }

  const safety = evidence.safety;
  requireEvidence(safety?.paperTrading === true && safety?.liveTradingEnabled === false
    && safety?.exchangeWritesLocked === true && safety?.actualValuesVerified === true
    && link(safety?.independentReadOnlyVerificationUrl),
    'PAPER/live flag values and no-exchange-write condition not independently evidenced.');

  const decision = evidence.decision;
  let paperMetricsPositive = false;
  if (decision?.type === 'forward-paper') {
    const p = decision.paper;
    requireEvidence(p?.basis === 'forward-paper' && nat(p?.independentClosedRoundTrips)
      && p.independentClosedRoundTrips >= 100
      && p?.positionIdsReconciled === true && p?.rawFillsChecked === true
      && p?.feesAndSlippageIncluded === true && p?.portfolioEquityCurveAvailable === true
      && p?.independentAuditPassed === true && link(p?.reconciliationUrl)
      && link(p?.fillEvidenceUrl),
      'Need >=100 independently reconciled forward-paper CLOSED round trips, not simulated historic trades or exit events.');
    requireEvidence(num(p?.netRealizedPnlUsd)
      && num(p?.winRatePct) && p.winRatePct >= 0 && p.winRatePct <= 100
      && num(p?.profitFactor) && p.profitFactor >= 0
      && num(p?.maxPortfolioDrawdownPct) && p.maxPortfolioDrawdownPct >= 0
      && nat(p?.riskLimitViolations) && p?.safetyLimitsReviewed === true
      && link(p?.riskReviewUrl),
      'Missing reconciled fee-adjusted return/win rate/profit factor/full drawdown or risk-limit review.');
    paperMetricsPositive = num(p?.netRealizedPnlUsd) && p.netRealizedPnlUsd > 0
      && num(p?.profitFactor) && p.profitFactor > 1;
  } else if (decision?.type === 'no-validated-edge') {
    const n = decision.noEdge;
    requireEvidence(n?.adequateTestingDocumented === true
      && n?.candidateCoverageReviewed === true && n?.independentAuditPassed === true
      && n?.noValidatedEdge === true && link(n?.methodologyReportUrl)
      && link(n?.conclusionReportUrl) && nonempty(n?.limitations),
      'No-edge alternative requires adequate testing and an independently reviewed negative conclusion.');
  } else {
    missing.push('Neither completed forward-paper audit nor conclusive no-edge research decision.');
  }

  requireEvidence(evidence.finalReport?.published === true
    && evidence.finalReport?.limitationsPublished === true
    && link(evidence.finalReport?.url), 'Missing published final report and limitations.');

  const structuralEvidencePresent = missing.length === 0;
  return {
    structuralEvidencePresent,
    // Never silently grant completion based on a user-supplied JSON manifest.
    notificationAuthorized: false,
    humanSourceVerificationRequired: true,
    // Positive hypothetical paper results are only a claim in source material.
    // Separately verify the actual linked source before saying "demonstrated".
    profitabilityDemonstrated: false,
    claimedPaperMetricsPositive: structuralEvidencePresent && paperMetricsPositive,
    missing,
  };
}
