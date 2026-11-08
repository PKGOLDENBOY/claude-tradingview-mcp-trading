import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessReadiness} from '../lib/readiness-diagnostic.mjs';

const observed={research:{selected:'ml-068',eligible:5,independentOosVerified:false},
  shadow:{errors:14,stats:{momentum:{exits:51,realizedPnlUSD:-179.8473,profitFactor:0.222},
    scalp:{exits:51,realizedPnlUSD:-20.2235,profitFactor:0.162},
    swing:{exits:4,realizedPnlUSD:-19.2367,profitFactor:0},
    breakout:{exits:11,realizedPnlUSD:-15.6493,profitFactor:0.211},
    sniper:{exits:8,realizedPnlUSD:-110.7254,profitFactor:0},
    longterm:{exits:0,realizedPnlUSD:0,profitFactor:null}}},
  paper:{auditableFeeAdjustedExitEvents:0,independentCompletedRoundTrips:null,
    all100PaperTradesVerified:false,exchangeVerified:false,
    fullPortfolioMaxDrawdownPct:null,riskLimitViolations:null}};

test('observed Nov 8 telemetry unequivocally fails real-money readiness',()=>{
  const result=assessReadiness(observed);
  assert.equal(result.status,'NO_GO_REQUIRES_INDEPENDENT_REVIEW');
  assert.equal(result.liveMoneyReady,false);
  assert.equal(result.realOrdersAuthorized,false);
  assert.equal(result.selectedResearchHypothesis,'ml-068');
  assert.ok(result.blockers.includes('NO_INDEPENDENT_UNTOUCHED_OOS'));
  assert.ok(result.blockers.includes('SHADOW_ERRORS_UNRESOLVED'));
  assert.ok(result.blockers.includes('LOSING_SHADOW_STRATEGY_MOMENTUM'));
  assert.ok(result.blockers.includes('FEWER_THAN_100_RECONCILED_FORWARD_PAPER_ROUND_TRIPS'));
  assert.ok(result.blockers.includes('PAPER_FEE_ADJUSTED_LEDGER_INCOMPLETE'));
  assert.equal(result.independentPaperRoundTrips,null);
  assert.equal(result.simulatedShadowExitsNotCountedAsPaper,125);
});

test('empty, partial and malformed evidence fail closed',()=>{
  for(const input of [undefined,{}, {paper:{independentCompletedRoundTrips:100}},
    {paper:{independentCompletedRoundTrips:-4,exchangeVerified:true,
      fullPortfolioMaxDrawdownPct:NaN,riskLimitViolations:0}}]){
    const result=assessReadiness(input);
    assert.equal(result.liveMoneyReady,false);
    assert.ok(result.blockers.includes('FEWER_THAN_100_RECONCILED_FORWARD_PAPER_ROUND_TRIPS'));
    assert.ok(result.blockers.includes('NO_INDEPENDENT_UNTOUCHED_OOS'));
  }
});

test('historical simulated exits never count as genuine independently reconciled paper trades',()=>{
  const telemetry=structuredClone(observed);
  telemetry.shadow.stats.momentum.exits=100000;
  const result=assessReadiness(telemetry);
  assert.equal(result.independentPaperRoundTrips,null);
  assert.ok(result.blockers.includes('FEWER_THAN_100_RECONCILED_FORWARD_PAPER_ROUND_TRIPS'));
});

test('missing fee-adjusted ledger evidence cannot be bypassed by claimed 100 paper trades',()=>{
  const telemetry=structuredClone(observed);
  telemetry.paper={independentCompletedRoundTrips:100,all100PaperTradesVerified:true,
    auditableFeeAdjustedExitEvents:0,exchangeVerified:true,
    fullPortfolioMaxDrawdownPct:2,riskLimitViolations:0};
  const result=assessReadiness(telemetry);
  assert.ok(result.blockers.includes('PAPER_FEE_ADJUSTED_LEDGER_INCOMPLETE'));
});

test('even apparently complete metrics never authorize live orders without independent signoff',()=>{
  const telemetry={research:{eligible:1,selected:'frozen-model',independentOosVerified:true},
    shadow:{errors:0,stats:{forward:{exits:120,realizedPnlUSD:12,profitFactor:1.5}}},
    paper:{independentCompletedRoundTrips:100,all100PaperTradesVerified:true,
      auditableFeeAdjustedExitEvents:100,exchangeVerified:true,
      fullPortfolioMaxDrawdownPct:2,riskLimitViolations:0}};
  const result=assessReadiness(telemetry);
  assert.deepEqual(result.blockers,[]);
  assert.equal(result.liveMoneyReady,false);
  assert.equal(result.realOrdersAuthorized,false);
  const code=readFileSync(new URL('../lib/readiness-diagnostic.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(code,/fetch\(|axios|\bbot\.js\b|privateKey|placeOrder|submitOrder/);
});
