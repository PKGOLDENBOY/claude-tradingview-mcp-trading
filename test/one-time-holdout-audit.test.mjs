import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeSelection,reviewHoldout} from '../scripts/one-time-holdout-audit.mjs';

// Entirely SYNTHETIC fixture. These numbers are NOT Bitget market evidence.
// The actual one-time real-market workflow is separately gated and never
// triggered by this offline unit test.
const digest='a'.repeat(64);
const clone=x=>structuredClone(x);
const selected={
  id:'reversion-0192',family:'reversion',eligible:true,
  params:{length:9,oversold:20,trendFilter:true},
  stop:.04,take:.035,score:18,
  validation:{trades:24,positiveFolds:2,pnlUSD:22.34}
};
function syntheticValidation(){
  return {
    source:{
      exchange:'Bitget',market:'SPOT',endpointScope:'PUBLIC GET',
      interval:'1H',asof:'2026-10-29T16:00:00.000Z',lookbackDays:180,
      datasetSha256:digest,excludedSymbols:[],
      assets:[{symbol:'BTCUSDT',datasetSha256:'b'.repeat(64),apiRequests:50,cacheHitBars:0,newBars:4320}],
      downloadStats:[{fromCache:false}]
    },
    scope:{candidateConfigurations:420,walkForwardFolds:3,
      symbols:['ADAUSDT','BTCUSDT','ETHUSDT','LINKUSDT','SOLUSDT']},
    overall:{holdoutStatus:'SEALED',selectedHypothesis:clone(selected),
      evaluatedConfigurations:516,selectionNeverUsedHoldout:true,finalHoldout:null},
    machineLearning:{training:{configurations:96},qualifiedCount:0},
    safety:{realOrders:false,authenticatedRequests:false},
    reproducibility:{fixedCandidateGrid:true},
    validation:{foldBoundaries:[{fold:1},{fold:2},{fold:3}]},
    assumptions:{feePerSide:.001,slippagePerSide:.001},
    holdout:{status:'SEALED'}
  };
}
function syntheticOpened(){
  const r=syntheticValidation();
  r.overall.holdoutStatus='ONE_VALIDATION_SELECTED_MODEL_REVIEWED';
  r.overall.finalHoldout={
    result:{trades:6,pnlUSD:12.45,profitFactor:1.1,
      maxDrawdownUSD:7.12,winRatePct:50},
    holdoutSelectionUsed:false
  };
  r.source.assets[0].apiRequests=0;
  r.source.assets[0].cacheHitBars=4320;
  r.source.assets[0].newBars=0;
  r.source.downloadStats=[{fromCache:true}];
  return r;
}
test('preflight preregisters candidate and no holdout data is consumed',()=>{
  const frozen=freezeSelection(syntheticValidation());
  assert.equal(frozen.selected.id,'reversion-0192');
  assert.equal(frozen.finalHoldoutStillSealed,true);
  assert.equal(frozen.noOrderRequests,true);
  assert.equal(frozen.profitabilityProven,false);
  assert.match(frozen.datasetSha256,/^[a-f0-9]{64}$/);
});
test('final historical OOS report is not treated as forward PAPER or proven edge',()=>{
  const a=syntheticValidation(), frozen=freezeSelection(a);
  const reviewed=reviewHoldout(a,frozen,syntheticOpened());
  assert.equal(reviewed.holdoutTrades,6);
  assert.equal(reviewed.historicalOosSimulatedPnlUSD,12.45);
  assert.equal(reviewed.completeForwardPaperRoundTripsVerified,0);
  assert.equal(reviewed.profitableStrategyProven,false);
  assert.equal(reviewed.liveTradingReady,false);
  assert.equal(reviewed.reusableForCandidateRetuning,false);
});
test('holdout cannot open if preliminary selection changed',()=>{
  const a=syntheticValidation();
  a.overall.selectedHypothesis.id='momentum-0001';
  assert.throws(()=>freezeSelection(a),/VALIDATION_SCOPE_OR_SELECTION_MISMATCH/);
});
test('holdout refuses different data digest, config and selected score',()=>{
  const a=syntheticValidation(), frozen=freezeSelection(a);
  const modifiedData=syntheticOpened();
  modifiedData.source.datasetSha256='c'.repeat(64);
  assert.throws(()=>reviewHoldout(a,frozen,modifiedData),/CHANGED_DATA_OR_SELECTED_MODEL/);
  const modifiedConfig=syntheticOpened();
  modifiedConfig.overall.selectedHypothesis.params.length=14;
  assert.throws(()=>reviewHoldout(a,frozen,modifiedConfig),/CHANGED_DATA_OR_SELECTED_MODEL/);
  const modifiedScore=syntheticOpened();
  modifiedScore.overall.selectedHypothesis.score=200;
  assert.throws(()=>reviewHoldout(a,frozen,modifiedScore),/CHANGED_DATA_OR_SELECTED_MODEL/);
});
test('no holdout preflight when final 20% previously opened',()=>{
  const opened=syntheticOpened();
  assert.throws(()=>freezeSelection(opened),/PRE_SELECTION_HOLDOUT_NOT_SEALED/);
});
test('opening without a numerical holdout result fails closed',()=>{
  const a=syntheticValidation(), frozen=freezeSelection(a);
  const b=syntheticOpened(); b.overall.finalHoldout.result.pnlUSD='profit';
  assert.throws(()=>reviewHoldout(a,frozen,b),/HOLDOUT_RESULT_MISSING_OR_INVALID/);
});
test('two runs can differ in downloaded-versus-cached statistics, never in raw candle hashes',()=>{
  const a=syntheticValidation(), frozen=freezeSelection(a);
  const cached=syntheticOpened();
  cached.source.downloadStats=[{cacheHits:4320}];
  cached.source.assets[0].apiRequests=3;
  const ok=reviewHoldout(a,frozen,cached);
  assert.equal(ok.datasetSha256,digest);
  cached.source.assets[0].datasetSha256='c'.repeat(64);
  assert.throws(()=>reviewHoldout(a,frozen,cached),/CHANGED_DATA_OR_SELECTED_MODEL/);
});
