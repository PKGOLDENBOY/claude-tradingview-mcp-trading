#!/usr/bin/env node
/**
 * AlphaBot Accelerator: a SECOND, wholly independent research-only engine.
 * - Public Bitget v3 SPOT historical candle GET ONLY.
 * - Historical data cached with SHA-256 and strict missing-bar detection.
 * - Parallel worker-thread evaluation of 420 candidate rule configurations.
 * - Train-only time-series logistic regression learns 96 ML configurations.
 * - Three expanding train/validation folds and a default sealed 20% holdout.
 * - No imports from bot.js; no exchange accounts, credentials or orders.
 * - NEVER silently substitutes synthetic data when public candles are unavailable.
 */
import { mkdirSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERVAL_MS,prepareSeries,chronologicalSplits } from '../lib/accelerator-core.mjs';
import { enforceResearchHoldoutLock, reviewResearchCandidate, FAILED_OOS_CANDIDATES } from '../lib/accelerator-oos-quarantine.mjs';
import { trainMLCandidates } from '../lib/accelerator-ml.mjs';
import { loadHistoryForSymbols, CORE_SYMBOLS } from '../lib/accelerator-data.mjs';
import { runResearch, suggestedWorkers } from '../lib/accelerator-runner.mjs';

export function parseArgs(argv) {
  const opts={days:180,workers:suggestedWorkers(),cacheDir:'research-data/cache',
    output:'research-data/reports/latest.json',holdout:false,asofMs:Math.floor(Date.now()/INTERVAL_MS)*INTERVAL_MS};
  for(const arg of argv) {
    if(arg==='--holdout'){opts.holdout=true;continue;}
    const match=/^--([a-z-]+)=(.+)$/.exec(arg);
    if(!match)throw new Error('UNRECOGNIZED_ARGUMENT: '+arg);
    const [,key,value]=match;
    if(key==='days')opts.days=Number(value);
    else if(key==='workers')opts.workers=Number(value);
    else if(key==='cache-dir')opts.cacheDir=value;
    else if(key==='output')opts.output=value;
    else if(key==='asof')opts.asofMs=Date.parse(value);
    else throw new Error('UNRECOGNIZED_ARGUMENT: '+key);
  }
  if(!Number.isSafeInteger(opts.days)||opts.days<60||opts.days>365||
    !Number.isSafeInteger(opts.workers)||opts.workers<1||opts.workers>8 ||
    !Number.isSafeInteger(opts.asofMs)||opts.asofMs%INTERVAL_MS!==0)
    throw new Error('INVALID_CLI_ARGUMENTS');
  // A manually set environment variable must never reopen the consumed historical holdout.
  enforceResearchHoldoutLock(opts.holdout);
  return opts;
}

export async function researchMain(argv=process.argv.slice(2)){
  const args=parseArgs(argv);
  console.log(JSON.stringify({event:'ACCELERATOR_RESEARCH_START',safety:'PUBLIC_GET_RESEARCH_ONLY',
    asof:new Date(args.asofMs).toISOString(),days:args.days,workers:args.workers,
    symbols:CORE_SYMBOLS,holdoutSealed:!args.holdout}));
  const downloads=[];
  const downloaded=await loadHistoryForSymbols({
    symbols:CORE_SYMBOLS,cacheDir:args.cacheDir,lookbackDays:args.days,asofMs:args.asofMs,
    log:item=>{downloads.push(item);console.log(JSON.stringify({event:'ACCELERATOR_CANDLE_CACHE',...item}));},
  });
  // Neither ML training nor rule search ever sees sealed holdout observations.
  const analysis=await runResearch(downloaded.data,{workers:args.workers,unsealHoldout:false});
  const prepared=Object.fromEntries(Object.entries(downloaded.data).map(([symbol,bars])=>
    [symbol,prepareSeries(bars)]));
  const splits=chronologicalSplits(downloaded.data.BTCUSDT.length);
  const machineLearning=trainMLCandidates(prepared,splits);
  const best=[analysis.validation.selected,machineLearning.selected]
    .filter(c=>c && !FAILED_OOS_CANDIDATES[c.id])
    .sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id))[0]??null;
  // No historical holdout calculation is permitted in this research branch.
  const finalHoldout=null;
  const report={...analysis,
    machineLearning,
    overall:{selectedHypothesis:best,
      evaluatedConfigurations:analysis.scope.candidateConfigurations+machineLearning.training.configurations,
      holdoutStatus:'SEALED_PREVIOUS_HISTORICAL_HOLDOUT_CONSUMED',
      candidateReview:reviewResearchCandidate(best),
      priorIndependentOosFailures:FAILED_OOS_CANDIDATES,
      finalHoldout,
      conclusion:best?'PROMISING_RESEARCH_HYPOTHESIS_NOT_PROVEN_PROFITABLE':'NO_VALIDATED_EDGE',
      selectionNeverUsedHoldout:true},
    generatedAt:new Date().toISOString(),
    source:{exchange:'Bitget',market:'SPOT',endpointScope:'PUBLIC /api/v3/market/candles and history-candles',
      interval:'1H',asof:new Date(args.asofMs).toISOString(),lookbackDays:args.days,
      datasetSha256:downloaded.datasetSha256,assets:downloaded.assets,
      excludedSymbols:downloaded.excludedSymbols,downloadStats:downloads,
      sha256Algorithm:'SHA-256 over canonical JSON candles, verified per asset cache'},
    reproducibility:{fixedCandidateGrid:true,seed:'NOT_USED_DETERMINISTIC',
      split:'three expanding walk-forward train/validation folds, 24-bar purge embargo, final 20% sealed',
      strategyClass:'Four fixed-rule hypotheses plus train-only logistic regression classifiers. Not production bot.'},
  };
  const full=JSON.stringify(report,null,2)+'\n';
  mkdirSync(dirname(args.output),{recursive:true});
  const tmp=args.output+'.tmp';
  writeFileSync(tmp,full,{encoding:'utf8',mode:0o600});
  renameSync(tmp,args.output);
  // Durable time-series evidence of successive research runs; no original logs reset.
  appendFileSync(dirname(args.output)+'/history.ndjson',JSON.stringify({
    generatedAt:report.generatedAt,asof:report.source.asof,
    datasetSha256:report.source.datasetSha256,selected:best?.id??null,
    qualifiedRules:report.validation.qualifiedCandidateCount,
    quarantinedPreviouslyEligibleCandidates:report.validation.quarantinedPreviouslyEligibleCandidates,
    qualifiedML:report.machineLearning.qualifiedCount,
    holdout:report.overall.holdoutStatus,safety:'NO_ORDERS',
  })+'\n',{encoding:'utf8',mode:0o600});
  console.log(JSON.stringify({event:'ACCELERATOR_RESEARCH_RESULT',
    generatedAt:report.generatedAt,conclusion:report.conclusion,
    candidates:report.overall.evaluatedConfigurations,
    trainedModels:report.machineLearning.training.modelFits,
    candidateSegmentSimulations:report.scope.candidateSegmentSimulations,
    workers:report.timings.workers,evaluationWallMs:report.timings.evaluationWallMs,
    candidatesPerSecond:report.timings.candidatesPerSecond,
    eligible:report.validation.qualifiedCandidateCount,
    quarantinedPreviouslyEligibleCandidates:report.validation.quarantinedPreviouslyEligibleCandidates,
    selected:report.overall.selectedHypothesis?.id??null,
    selectedPromotionStatus:report.overall.candidateReview.status,
    selectedValidation:best ? {
      simulatedPnlUSD:best.validation.pnlUSD,
      completedSimulatedTrades:best.validation.trades,
      profitFactor:best.validation.profitFactor,
      positiveFolds:best.validation.positiveFolds,
      maxFoldDrawdownUSD:best.validation.maxFoldDrawdownUSD,
      note:'RETROSPECTIVE VALIDATION ONLY; PREVIOUS HISTORICAL OOS CONSUMED AND FAILED FOR REVERSION-0192; FORWARD PAPER NOT AVAILABLE',
    } : null,
    qualifiedML:report.machineLearning.qualifiedCount,
    holdoutStatus:report.overall.holdoutStatus,excludedSymbols:downloaded.excludedSymbols,
    datasetSha256:downloaded.datasetSha256,output:args.output,
    safety:'NO_ORDERS;NO_AUTH;NO_PRODUCTION_DEPLOYMENT'}));
  return report;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===fileURLToPath(new URL('file://'+process.argv[1]))){
  try{await researchMain();}
  catch(err){console.error(JSON.stringify({event:'ACCELERATOR_RESEARCH_FAILED',
    reason:String(err?.message||err).slice(0,400),safety:'NO_ORDERS'}));process.exitCode=1;}
}
