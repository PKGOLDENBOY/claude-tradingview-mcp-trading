/** CPU-only research worker: isolated from market endpoints and production bot. */
import { parentPort,workerData,isMainThread } from 'node:worker_threads';
import { prepareSeries,evaluateCandidate } from '../lib/accelerator-core.mjs';
if(isMainThread)throw new Error('ACCELERATOR_WORKER_MUST_RUN_OFF_MAIN_THREAD');
try{
  const {data,candidates,splits,assumptions}=workerData;
  const prepared=Object.fromEntries(Object.entries(data).map(([symbol,bars])=>[symbol,prepareSeries(bars)]));
  parentPort.postMessage({results:candidates.map(c=>evaluateCandidate(c,prepared,splits,assumptions))});
}catch(err){parentPort.postMessage({error:String(err?.stack||err).slice(0,2000)});}
