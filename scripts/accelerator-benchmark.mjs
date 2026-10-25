#!/usr/bin/env node
/** SYNTHETIC CPU ENGINE BENCHMARK ONLY. NOT trading/backtest evidence. */
import { availableParallelism } from 'node:os';
import { syntheticBars } from '../test/helpers.mjs';
import { runResearch } from '../lib/accelerator-runner.mjs';
const days=180;
const symbols=['BTCUSDT','ETHUSDT','SOLUSDT','LINKUSDT','ADAUSDT'];
const bars=days*24;
const data=Object.fromEntries(symbols.map((symbol,i)=>
  [symbol,syntheticBars(bars,{seed:93+i*104,trend:.0003+.0001*i,fluctuation:.007})]));
const reports=[];
for(const workers of [1,Math.min(4,Math.max(1,availableParallelism()))]){
  const result=await runResearch(data,{workers});
  reports.push({workers:result.timings.workers,candidates:result.scope.candidateConfigurations,
    segments:result.scope.candidateSegmentSimulations,
    wallMs:result.timings.evaluationWallMs,
    candidatePerSecond:result.timings.candidatesPerSecond,
    segmentPerSecond:result.timings.segmentEvaluationsPerSecond,
    candidateValidationMatched:result.validation.topTen.map(x=>x.id)});
}
if(JSON.stringify(reports[0].candidateValidationMatched)!==JSON.stringify(reports.at(-1).candidateValidationMatched))
  throw new Error('PARALLEL_SEQUENTIAL_RESEARCH_INCONSISTENT');
console.log(JSON.stringify({event:'ACCELERATOR_SYNTHETIC_CPU_BENCHMARK',
  disclaimer:'Synthetic prices only; this DOES NOT establish learning speed versus the original bot or any profitable trading edge.',
  availableParallelism:availableParallelism(),assets:symbols.length,barsPerAsset:bars,
  runs:reports,parallelThroughputVsSingle:Math.round(reports.at(-1).segmentPerSecond/reports[0].segmentPerSecond*100)/100}));
