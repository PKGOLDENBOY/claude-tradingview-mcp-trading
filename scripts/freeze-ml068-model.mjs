#!/usr/bin/env node
/**
 * One-time immutable model-freeze proposal. Bitget public 1H candle GET only.
 * This MUST NOT be re-run as a rolling model-selection process or presented as OOS.
 */
import {mkdirSync,writeFileSync,renameSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {prepareSeries,DEFAULT_ASSUMPTIONS,INTERVAL_MS} from '../lib/accelerator-core.mjs';
import {loadHistoryForSymbols,CORE_SYMBOLS} from '../lib/accelerator-data.mjs';
import {mlConfigurations,trainingSamples,fitLogistic} from '../lib/accelerator-ml.mjs';

export const FREEZE=Object.freeze({
  candidateId:'ml-068',
  asof:'2026-11-08T20:00:00.000Z',
  activationNotBefore:'2026-11-09T00:00:00.000Z',
  lookbackDays:180,
  trainingTailEmbargoBars:24,
  output:'research-data/reports/frozen-ml068-proposed.json',
  market:'BITGET_PUBLIC_SPOT_1H',
});
const sha=raw=>createHash('sha256').update(raw).digest('hex');
export function verifyFreezeConfiguration(){
  if(Date.parse(FREEZE.asof)%INTERVAL_MS!==0 ||
     Date.parse(FREEZE.activationNotBefore)<=Date.parse(FREEZE.asof))
    throw new Error('FROZEN_ACTIVATION_INVALID');
  const matched=mlConfigurations().filter(c=>c.id===FREEZE.candidateId);
  if(matched.length!==1 || matched[0].family!=='trained-logistic')
    throw new Error('FROZEN_CANDIDATE_NOT_UNIQUE');
  return matched[0];
}
export async function freezeMain(){
  const candidate=verifyFreezeConfiguration();
  if(Date.now()<Date.parse(FREEZE.asof))throw new Error('FROZEN_ASOF_IS_FUTURE');
  const histories=await loadHistoryForSymbols({symbols:CORE_SYMBOLS,
    lookbackDays:FREEZE.lookbackDays,asofMs:Date.parse(FREEZE.asof),
    cacheDir:'research-data/cache'});
  if(histories.successfulSymbols!==CORE_SYMBOLS.length || histories.excludedSymbols.length)
    throw new Error('FROZEN_UNIVERSE_NOT_COMPLETE');
  const series=Object.fromEntries(Object.entries(histories.data).map(([s,b])=>[s,prepareSeries(b)]));
  const n=series.BTCUSDT.length;
  const trainRange={start:110,end:n-FREEZE.trainingTailEmbargoBars};
  const samples=trainingSamples(series,trainRange,candidate.params.horizon,DEFAULT_ASSUMPTIONS);
  const model=fitLogistic(samples,candidate.params);
  const codeHashes={
    ml:sha(readFileSync(new URL('../lib/accelerator-ml.mjs',import.meta.url))),
    core:sha(readFileSync(new URL('../lib/accelerator-core.mjs',import.meta.url))),
    freeze:sha(readFileSync(new URL('./freeze-ml068-model.mjs',import.meta.url))),
  };
  const payload={schemaVersion:1,mode:'PUBLIC_MARKET_RESEARCH_NO_ORDERS',
    candidateId:FREEZE.candidateId,candidate,market:FREEZE.market,
    frozenAsOf:FREEZE.asof,activationNotBefore:FREEZE.activationNotBefore,
    lookbackDays:FREEZE.lookbackDays,universe:CORE_SYMBOLS.slice(),
    trainingLastLabelExcludedAtOrAfter:new Date(Date.parse(FREEZE.asof)-FREEZE.trainingTailEmbargoBars*INTERVAL_MS).toISOString(),
    trainingRange:trainRange,
    trainingDatasetSha256:histories.datasetSha256,
    trainingAssetChecksums:histories.assets.map(x=>({symbol:x.symbol,datasetSha256:x.datasetSha256})),
    codeHashes,assumptions:DEFAULT_ASSUMPTIONS,
    model,modelSha256:sha(JSON.stringify(model)),
    historicalSelectionCaveat:'Historical validation selected this ID; freeze once and assess ONLY observations captured after activation.',
    independentOosPassed:false,forwardPaperTradesVerified:0,liveMoneyReady:false};
  const output={...payload,manifestSha256:sha(JSON.stringify(payload))};
  mkdirSync(dirname(FREEZE.output),{recursive:true});
  writeFileSync(FREEZE.output+'.tmp',JSON.stringify(output,null,2)+'\n',{mode:0o600});
  renameSync(FREEZE.output+'.tmp',FREEZE.output);
  console.log('FROZEN_MODEL_ARTIFACT '+JSON.stringify(output));
  console.log(JSON.stringify({event:'FROZEN_MODEL_READY_FOR_PROSPECTIVE_RESEARCH_ONLY',
    candidateId:candidate.id,modelSha256:output.modelSha256,
    manifestSha256:output.manifestSha256,datasetSha256:histories.datasetSha256,
    trainingSamples:model.trainedExamples,noOrders:true,independentOosPassed:false,
    activationNotBefore:FREEZE.activationNotBefore}));
  return output;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===fileURLToPath(new URL('file://'+process.argv[1]))){
  if(process.argv.length!==2)throw new Error('MODEL_FREEZE_NEVER_ACCEPTS_PARAMETER_OVERRIDES');
  try{await freezeMain();}
  catch(err){console.error(JSON.stringify({event:'FROZEN_MODEL_FAILED',error:String(err?.message||err)}));
    process.exitCode=1;}
}
