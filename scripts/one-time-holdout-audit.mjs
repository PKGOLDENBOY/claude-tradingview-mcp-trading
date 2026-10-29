/**
 * AlphaBot SINGLE frozen research holdout review, not a strategy optimizer.
 *
 * PRE-REGISTRATION: 2026-10-29 16:00 UTC (fixed), hypothesis reversion-0192.
 * This utility itself makes no network calls, imports no bot/exchange logic,
 * places no orders, never changes the accelerator, and NEVER makes a live
 * trading / profitability decision. The holdout can only be opened by the
 * separately gated workflow after a frozen validation selection is confirmed.
 */
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';

const ASOF='2026-10-29T16:00:00.000Z';
const CANDIDATE='reversion-0192';
const SYMBOLS=['ADAUSDT','BTCUSDT','ETHUSDT','LINKUSDT','SOLUSDT'];
const HASH=/^[a-f0-9]{64}$/;
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const read=path=>{
  if(statSync(path).size>30_000_000)throw new Error('UNEXPECTED_LARGE_RESEARCH_REPORT');
  return JSON.parse(readFileSync(path,'utf8'));
};
const config=selected=>({
  id:selected.id,family:selected.family,params:selected.params,
  stop:selected.stop,take:selected.take,score:selected.score,
});
const fail=reason=>{throw new Error('FROZEN_OOS_REVIEW_REFUSED_'+reason);};
function validateReport(report,{sealed}){
  if(!isObject(report)||!isObject(report.overall)||!isObject(report.source)||
    report.source.asof!==ASOF || report.source.lookbackDays!==180 ||
    !HASH.test(report.source.datasetSha256??'') ||
    report.scope?.candidateConfigurations!==420 ||
    report.overall.evaluatedConfigurations!==516 ||
    report.scope?.walkForwardFolds!==3 ||
    JSON.stringify([...(report.scope?.symbols??[])].sort())!==JSON.stringify(SYMBOLS) ||
    report.machineLearning?.training?.configurations!==96 ||
    report.overall.selectedHypothesis?.id!==CANDIDATE ||
    report.overall.selectedHypothesis?.family!=='reversion' ||
    report.overall.selectedHypothesis?.eligible!==true ||
    report.overall.selectedHypothesis?.validation?.trades<15 ||
    report.overall.selectedHypothesis?.validation?.positiveFolds<2 ||
    report.source.excludedSymbols?.length!==0 ||
    report.safety?.realOrders!==false ||
    report.safety?.authenticatedRequests!==false ||
    !Array.isArray(report.validation?.foldBoundaries)||
    report.validation.foldBoundaries.length!==3 ||
    report.overall.selectionNeverUsedHoldout!==true ||
    report.reproducibility?.fixedCandidateGrid!==true)
    fail('VALIDATION_SCOPE_OR_SELECTION_MISMATCH');
  if(sealed){
    if(report.overall.holdoutStatus!=='SEALED'||report.holdout?.status!=='SEALED'||
      report.overall.finalHoldout!==null)fail('PRE_SELECTION_HOLDOUT_NOT_SEALED');
  }else{
    if(report.overall.holdoutStatus!=='ONE_VALIDATION_SELECTED_MODEL_REVIEWED'||
      !isObject(report.overall.finalHoldout?.result)||
      report.overall.finalHoldout.holdoutSelectionUsed!==false||
      report.overall.finalHoldout.result.trades<0||
      !finite(report.overall.finalHoldout.result.pnlUSD)||
      !finite(report.overall.finalHoldout.result.maxDrawdownUSD))
      fail('HOLDOUT_RESULT_MISSING_OR_INVALID');
  }
}
export function freezeSelection(validation){
  validateReport(validation,{sealed:true});
  const selected=config(validation.overall.selectedHypothesis);
  return {
    schemaVersion:1,asof:ASOF,modelSelection:'FROZEN_VALIDATION_ONLY',
    selected,selectedConfigSha256:sha(selected),
    datasetSha256:validation.source.datasetSha256,
    foldBoundaries:validation.validation.foldBoundaries,
    assumptionsSha256:sha(validation.assumptions),
    sourceSnapshotSha256:sha(validation.source),
    selectionReproducibilitySha256:sha(validation.overall.selectedHypothesis),
    finalHoldoutStillSealed:true,
    mode:'PUBLIC_MARKET_OFFLINE_PAPER_RESEARCH_ONLY',
    noOrderRequests:true,
    profitabilityProven:false,
  };
}
export function reviewHoldout(validation,selection,holdout){
  validateReport(validation,{sealed:true});
  validateReport(holdout,{sealed:false});
  const expected=freezeSelection(validation);
  if(JSON.stringify(selection)!==JSON.stringify(expected) ||
    holdout.source.datasetSha256!==selection.datasetSha256 ||
    sha(holdout.source)!==selection.sourceSnapshotSha256 ||
    sha(config(holdout.overall.selectedHypothesis))!==selection.selectedConfigSha256 ||
    sha(holdout.overall.selectedHypothesis)!==selection.selectionReproducibilitySha256 ||
    sha(holdout.assumptions)!==selection.assumptionsSha256 ||
    JSON.stringify(holdout.validation.foldBoundaries)!==
      JSON.stringify(selection.foldBoundaries))
    fail('HOLDOUT_REPORT_CHANGED_DATA_OR_SELECTED_MODEL');
  const oos=holdout.overall.finalHoldout.result;
  return {
    schemaVersion:1,asof:ASOF,
    kind:'FROZEN_SINGLE_HOLDOUT_REVIEW_NOT_FORWARD_PAPER',
    selectedCandidate:selection.selected.id,
    datasetSha256:selection.datasetSha256,
    selectedConfigSha256:selection.selectedConfigSha256,
    holdoutTrades:oos.trades,
    historicalOosSimulatedPnlUSD:oos.pnlUSD,
    historicalOosSimulatedProfitFactor:oos.profitFactor,
    historicalOosMaxSimulatedDrawdownUSD:oos.maxDrawdownUSD,
    historicalOosWinRatePct:oos.winRatePct,
    chronologicalSelectionUsedHoldout:false,
    reusableForCandidateRetuning:false,
    sourceAuthenticityHumanAuditRequired:true,
    completeForwardPaperRoundTripsVerified:0,
    profitableStrategyProven:false,
    liveTradingReady:false,
    conclusion:'ONE_TIME_HISTORICAL_OOS_RESULT_ONLY_NOT_PROOF_OF_A_TRADING_EDGE',
    caveats:[
      'Only one validation-selected hypothesis was evaluated on the one-time historical 20% holdout.',
      'Zero trained ML configurations qualified for validation selection in the prior verified runs; do not inspect every rejected ML candidate on this same holdout.',
      'Costs are conservative models, not executable fee/spread/depth/order-book evidence.',
      'A passing OOS test does not substitute for 100 reconciled forward PAPER round trips.',
      'Do not re-run or tune this candidate against the consumed historical holdout.',
    ]
  };
}
if(process.argv[1]?.endsWith('one-time-holdout-audit.mjs')){
  const [mode,...args]=process.argv.slice(2);
  if(process.env.GITHUB_RUN_NUMBER!=='1'||process.env.GITHUB_RUN_ATTEMPT!=='1'){
    fail('ONE_TIME_RUN_NUMBER_OR_ATTEMPT_NOT_ONE');
  }
  if(mode==='preflight'&&args.length===2){
    const evidence=freezeSelection(read(args[0]));
    writeFileSync(args[1],JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({event:'OOS_PREREGISTERED_HOLDOUT_STILL_SEALED',
      asof:evidence.asof,selected:evidence.selected.id,datasetSha256:evidence.datasetSha256}));
  }else if(mode==='finalize'&&args.length===4){
    const evidence=reviewHoldout(read(args[0]),read(args[1]),read(args[2]));
    writeFileSync(args[3],JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({event:'OOS_ONE_TIME_REVIEW_ONLY_NOT_PROVEN_PROFIT',
      asof:evidence.asof,candidate:evidence.selectedCandidate,
      simulatedTrades:evidence.holdoutTrades,simulatedPnl:evidence.historicalOosSimulatedPnlUSD,
      noRealOrders:true}));
  }else fail('INVALID_CLI_ARGUMENTS');
}
