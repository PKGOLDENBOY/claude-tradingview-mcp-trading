import test from 'node:test';
import assert from 'node:assert/strict';
import {runResearch} from '../lib/accelerator-runner.mjs';
import {testUniverse} from './helpers.mjs';

test('worker and single-thread validation are deterministic and holdout sealed by default',async()=>{
  const data=testUniverse(1450);
  const a=await runResearch(data,{workers:1,candidateLimit:18});
  const b=await runResearch(data,{workers:2,candidateLimit:18});
  assert.equal(a.scope.candidateConfigurations,18);
  assert.equal(a.scope.candidateSegmentSimulations,18*3*2*3);
  assert.equal(a.holdout.status,'SEALED');
  assert.equal(b.holdout.status,'SEALED');
  assert.deepEqual(a.validation,b.validation);
  assert.deepEqual(a.scope,b.scope);
  assert.equal(a.safety.realOrders,false);
  assert.equal(b.timings.workers,2);
});
