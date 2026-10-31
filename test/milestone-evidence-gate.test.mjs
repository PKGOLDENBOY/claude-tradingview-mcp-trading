import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMilestoneEvidence } from '../lib/milestone-evidence-gate.mjs';

// These are synthetic MANIFEST fixtures. They are NEVER real trading evidence.
const url = path => 'https://example.invalid/independent-audit/' + path;
function fullPaperFixture() {
  return {
    schemaVersion: 1,
    fixes: ['order','accounting','risk'].map(category=>({
      category,isolatedBranch:true,branch:'fix/isolated-' + category,
      testsPassed:true,testUrl:url(category+'-ci'),
      diffUrl:url(category+'-diff'),defectAndResolution:'Documented defect and regression.'
    })),
    strategyEvaluations: ['momentum','scalp','swing'].map(strategy=>({
      strategy,evaluated:true,reportUrl:url(strategy),finding:'No gain after costs.',
      afterCosts:true
    })),
    research: {
      chronologicalFolds:true, trainingOnlyFeatures:true,
      dataQualityAudited:true,bothSideCosts:true,
      selectionFrozenBeforeOos:true,holdoutUsedOnceOnly:true,
      noHoldoutRetuning:true,foldsAndQualityReportUrl:url('folds'),
      fixedRule:{trained:true,validated:true,untouchedOosCompleted:true,
        trainReportUrl:url('rules-train'),validationReportUrl:url('rules-val'),
        oosReportUrl:url('rules-oos')},
      ml:{trained:true,validated:true,untouchedOosCompleted:true,
        trainReportUrl:url('ml-train'),validationReportUrl:url('ml-val'),
        oosReportUrl:url('ml-oos')}
    },
    safety: {paperTrading:true,liveTradingEnabled:false,exchangeWritesLocked:true,
      actualValuesVerified:true,independentReadOnlyVerificationUrl:url('safety')},
    decision: {type:'forward-paper', paper:{
      basis:'forward-paper',independentClosedRoundTrips:100,
      positionIdsReconciled:true,rawFillsChecked:true,feesAndSlippageIncluded:true,
      portfolioEquityCurveAvailable:true,independentAuditPassed:true,
      reconciliationUrl:url('reconciliation'),fillEvidenceUrl:url('fills'),
      netRealizedPnlUsd:21,winRatePct:53,profitFactor:1.2,
      maxPortfolioDrawdownPct:5,riskLimitViolations:0,
      safetyLimitsReviewed:true,riskReviewUrl:url('risk-review')
    }},
    finalReport:{published:true,limitationsPublished:true,url:url('final')},
  };
}
const inspect = record => inspectMilestoneEvidence(record);
test('missing manifest is fail-closed and never authorizes a notification',()=>{
  const actual=inspect(null);
  assert.equal(actual.structuralEvidencePresent,false);
  assert.equal(actual.notificationAuthorized,false);
  assert.equal(actual.profitabilityDemonstrated,false);
  assert.ok(actual.missing.length);
});
test('a fully populated synthetic dossier passes SHAPE checks, never verifies profit',()=>{
  const actual=inspect(fullPaperFixture());
  assert.equal(actual.structuralEvidencePresent,true);
  assert.equal(actual.missing.length,0);
  assert.equal(actual.notificationAuthorized,false);
  assert.equal(actual.profitabilityDemonstrated,false);
  assert.equal(actual.humanSourceVerificationRequired,true);
  assert.equal(actual.claimedPaperMetricsPositive,true);
});
test('legacy 100 exit events and 102 backtest trades cannot pass forward-paper count',()=>{
  const record=fullPaperFixture();
  record.decision.paper.independentClosedRoundTrips=0;
  record.decision.paper.historicalSimulatedTrades=102;
  record.decision.paper.paperExitEvents=100;
  assert.equal(inspect(record).structuralEvidencePresent,false);
  record.decision.paper.independentClosedRoundTrips=102;
  record.decision.paper.basis='backtest';
  assert.equal(inspect(record).structuralEvidencePresent,false);
});
test('missing original fill reconciliation, fees or portfolio DD fails closed',()=>{
  const record=fullPaperFixture();
  record.decision.paper.rawFillsChecked=false;
  record.decision.paper.maxPortfolioDrawdownPct=null;
  record.decision.paper.feesAndSlippageIncluded=false;
  assert.equal(inspect(record).structuralEvidencePresent,false);
});
test('no holdout reopening, missing ML OOS, or incomplete strategies fails',()=>{
  const record=fullPaperFixture();
  record.research.holdoutUsedOnceOnly=false;
  record.research.ml.untouchedOosCompleted=false;
  record.strategyEvaluations[2].evaluated=false;
  assert.equal(inspect(record).structuralEvidencePresent,false);
  assert.ok(inspect(record).missing.some(x=>x.includes('swing')));
});
test('redacted environmental variables are not verified safety values',()=>{
  const record=fullPaperFixture();
  record.safety.actualValuesVerified=false;
  assert.equal(inspect(record).structuralEvidencePresent,false);
});
test('conclusive no-edge requires independently audited adequate testing',()=>{
  const record=fullPaperFixture();
  record.decision={type:'no-validated-edge',noEdge:{
    adequateTestingDocumented:true,candidateCoverageReviewed:true,
    independentAuditPassed:true,noValidatedEdge:true,
    methodologyReportUrl:url('methods'),conclusionReportUrl:url('no-edge'),
    limitations:'Sampling and market impact cannot be fully modeled.'
  }};
  const actual=inspect(record);
  assert.equal(actual.structuralEvidencePresent,true);
  assert.equal(actual.claimedPaperMetricsPositive,false);
  assert.equal(actual.notificationAuthorized,false);
  record.decision.noEdge.adequateTestingDocumented=false;
  assert.equal(inspect(record).structuralEvidencePresent,false);
});
test('risk violations must be enumerated and reviewed',()=>{
  const record=fullPaperFixture();
  record.decision.paper.riskLimitViolations=null;
  assert.equal(inspect(record).structuralEvidencePresent,false);
});
