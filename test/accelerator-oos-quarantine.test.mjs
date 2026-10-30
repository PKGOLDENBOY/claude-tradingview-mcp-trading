import test from 'node:test';
import assert from 'node:assert/strict';
import {rankCandidateResults} from '../lib/accelerator-core.mjs';
import {runResearch} from '../lib/accelerator-runner.mjs';
import {parseArgs} from '../scripts/accelerated-research.mjs';
import {FAILED_OOS_CANDIDATES,enforceResearchHoldoutLock,
  reviewResearchCandidate,quarantineCandidateResults} from '../lib/accelerator-oos-quarantine.mjs';

test('October 29 failed independent OOS is a recorded rejection, not profitability evidence',()=>{
  const failure=FAILED_OOS_CANDIDATES['reversion-0192'];
  assert.equal(failure.status,'REJECTED_INDEPENDENT_OOS');
  assert.equal(failure.completedSimulatedTrades,25);
  assert.equal(failure.netPnlUSD,-38.2268);
  assert.ok(failure.profitFactor<1);
  assert.ok(failure.winRate<.5);
  assert.ok(Object.isFrozen(failure));
});
test('failed candidate stays visible in diagnostics but can never outrank alternatives',()=>{
  const source=[{id:'reversion-0192',family:'reversion',eligible:true,score:999},
    {id:'breakout-0312',family:'breakout',eligible:true,score:2}];
  const {results,quarantinedPreviouslyEligibleCandidates}=quarantineCandidateResults(source);
  assert.equal(source[0].eligible,true);
  assert.deepEqual(quarantinedPreviouslyEligibleCandidates,['reversion-0192']);
  assert.equal(results[0].eligible,false);
  assert.equal(results[0].excludedFromPromotion,'PRIOR_INDEPENDENT_OOS_FAILED');
  const ranked=rankCandidateResults(results);
  assert.equal(ranked.eligibleCount,1);
  assert.equal(ranked.selected.id,'breakout-0312');
  assert.equal(reviewResearchCandidate(ranked.selected).profitabilityDemonstrated,false);
  assert.equal(reviewResearchCandidate(source[0]).status,'PRIOR_OOS_FAILED_DO_NOT_PROMOTE');
  assert.equal(reviewResearchCandidate(null).status,'NO_CANDIDATE');
});
test('consumed historical holdout stays locked even with legacy acknowledgement variable',()=>{
  assert.doesNotThrow(()=>enforceResearchHoldoutLock(false));
  assert.throws(()=>enforceResearchHoldoutLock(true),/CONSUMED_HOLDOUT_LOCKED/);
  const prior=process.env.ALPHABOT_UNSEAL_HOLDOUT;
  try {
    process.env.ALPHABOT_UNSEAL_HOLDOUT='I_ACKNOWLEDGE_ONE_TIME_RESEARCH_REVIEW';
    assert.throws(()=>parseArgs(['--holdout']),/CONSUMED_HOLDOUT_LOCKED/);
    assert.equal(parseArgs(['--days=180','--workers=1']).holdout,false);
  } finally {
    if(prior===undefined) delete process.env.ALPHABOT_UNSEAL_HOLDOUT;
    else process.env.ALPHABOT_UNSEAL_HOLDOUT=prior;
  }
});
test('low-level runner fails closed on holdout access before any research starts',async()=>{
  await assert.rejects(
    runResearch(null,{unsealHoldout:true}),
    /CONSUMED_HOLDOUT_LOCKED/
  );
});
