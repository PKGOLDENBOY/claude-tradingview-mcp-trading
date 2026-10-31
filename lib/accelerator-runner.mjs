/** Parallel, strictly offline candidate evaluation; no network, auth or orders. */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { enforceResearchHoldoutLock, FAILED_OOS_CANDIDATES,
  quarantineCandidateResults } from './accelerator-oos-quarantine.mjs';
import { generateCandidates, prepareSeries, chronologicalSplits,
  evaluateCandidate, rankCandidateResults,
  DEFAULT_ASSUMPTIONS, MODE } from './accelerator-core.mjs';

const round = n => Math.round(n*100)/100;
export function suggestedWorkers() {return Math.max(1,Math.min(4,availableParallelism()));}

async function workerBatch(data,chunk,splits,assumptions) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('../scripts/accelerator-worker.mjs',import.meta.url),
      {workerData:{data,candidates:chunk,splits,assumptions}});
    let done=false;
    worker.once('message',message=>{
      if(message?.error){done=true;reject(new Error(message.error));return;}
      done=true;resolve(message.results);
    });
    worker.once('error',error=>{if(!done){done=true;reject(error);}});
    worker.once('exit',code=>{if(code!==0&&!done){done=true;reject(new Error('RESEARCH_WORKER_EXIT_'+code));}});
  });
}

export async function runResearch(data,{
  workers=suggestedWorkers(),unsealHoldout=false,assumptions=DEFAULT_ASSUMPTIONS,
  candidateLimit=null,
}={}) {
  // The 29 October 2026 historical holdout was consumed; fail closed before simulation.
  enforceResearchHoldoutLock(unsealHoldout);
  if(!data || Object.keys(data).length<3 || !data.BTCUSDT)
    throw new Error('RESEARCH_REQUIRES_AT_LEAST_THREE_ASSETS_INCLUDING_BTC');
  const symbols=Object.keys(data).sort();
  const n=data[symbols[0]].length;
  const firstTs=data[symbols[0]][0]?.ts;
  const lastTs=data[symbols[0]][n-1]?.ts;
  if(symbols.some(s=>data[s].length!==n || data[s][0]?.ts!==firstTs ||
    data[s][n-1]?.ts!==lastTs))throw new Error('RESEARCH_HISTORY_ALIGNMENT_REQUIRED');
  const splits=chronologicalSplits(n);
  const allCandidates=generateCandidates();
  const candidates=candidateLimit===null?allCandidates:allCandidates.slice(0,candidateLimit);
  if(!candidates.length)throw new Error('RESEARCH_NO_CANDIDATES');
  const start=performance.now();
  let results=[];
  const concurrency=Math.min(Math.max(1,Math.floor(workers)),candidates.length,8);
  if(concurrency===1){
    const prepared=Object.fromEntries(symbols.map(s=>[s,prepareSeries(data[s])]));
    results=candidates.map(c=>evaluateCandidate(c,prepared,splits,assumptions));
  }else{
    const chunks=Array.from({length:concurrency},()=>[]);
    candidates.forEach((candidate,i)=>chunks[i%concurrency].push(candidate));
    const groups=await Promise.all(chunks.map(chunk=>workerBatch(data,chunk,splits,assumptions)));
    results=groups.flat();
  }
  const elapsedMs=performance.now()-start;
  // A formerly validation-eligible candidate that failed independent OOS cannot reappear
  // as the suggested winner when the rolling historical window moves.
  const {results:reviewedResults,quarantinedPreviouslyEligibleCandidates}=quarantineCandidateResults(results);
  const ranked=rankCandidateResults(reviewedResults);
  const families=[...new Set(candidates.map(c=>c.family))].map(family=>({
    family,configurations:candidates.filter(c=>c.family===family).length,
    qualified:reviewedResults.filter(r=>r.family===family&&r.eligible).length,
    topValidationPnlUSD:round(Math.max(...results.filter(r=>r.family===family).map(r=>r.validation.pnlUSD))),
  }));
  return {
    safety:{mode:MODE,realOrders:false,authenticatedRequests:false,noProductionImports:true},
    scope:{symbols,interval:'1H',barsPerSymbol:n,firstBar:new Date(firstTs).toISOString(),
      lastClosedBar:new Date(lastTs).toISOString(),
      candidateConfigurations:candidates.length,walkForwardFolds:splits.folds.length,
      candidateSegmentSimulations:candidates.length*splits.folds.length*2*symbols.length,
      holdoutSealed:true},
    timings:{evaluationWallMs:round(elapsedMs),workers:concurrency,
      candidatesPerSecond:round(candidates.length/(elapsedMs/1000)),
      segmentEvaluationsPerSecond:round(candidates.length*splits.folds.length*2*symbols.length/(elapsedMs/1000))},
    assumptions:{...assumptions,
      warning:'Historical bid/ask, actual depth, gaps between bars, market impact, partial fills, funding and taxes are not observed. All fills and costs are modelled, not real.'},
    validation:{qualifiedCandidateCount:ranked.eligibleCount,
      priorIndependentOosFailures:FAILED_OOS_CANDIDATES,
      quarantinedPreviouslyEligibleCandidates,
      selected:ranked.selected,
      topTen:ranked.top.filter(candidate=>!FAILED_OOS_CANDIDATES[candidate.id]),
      excludedPriorOosFailures:reviewedResults.filter(candidate=>Boolean(FAILED_OOS_CANDIDATES[candidate.id])),
      foldBoundaries:splits.folds.map(({id,train,validation})=>({id,trainEnd:new Date(data[symbols[0]][train.end-1].ts).toISOString(),
        validationStart:new Date(data[symbols[0]][validation.start].ts).toISOString(),
        validationEnd:new Date(data[symbols[0]][validation.end-1].ts).toISOString()})),
      families},
    holdout:{status:'SEALED_PREVIOUS_HISTORICAL_HOLDOUT_CONSUMED',
      selectionUsedHoldout:false,
      result:null,
      disclaimer:'A prior one-time historical holdout failed on 29 October 2026. Reopening is prohibited, even via legacy flags.'},
    conclusion:ranked.selected?
      'POTENTIAL_RULE_CANDIDATE_REQUIRES_INDEPENDENT_OOS_AND_FORWARD_PAPER_TEST':
      'NO_VALIDATED_EDGE_ON_EXPANDING_WALK_FORWARD',
    guarantee:'No profitable performance, 100x speed, or live-money readiness is claimed. Faster searches can overfit.',
  };
}
