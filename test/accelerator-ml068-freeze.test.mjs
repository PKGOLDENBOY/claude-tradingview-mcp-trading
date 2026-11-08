import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FREEZE,verifyFreezeConfiguration} from '../scripts/freeze-ml068-model.mjs';

test('freezes exactly ml-068, a deterministic earlier-selected hypothesis',()=>{
  const c=verifyFreezeConfiguration();
  assert.equal(c.id,'ml-068');
  assert.equal(c.family,'trained-logistic');
  assert.equal(c.params.horizon,12);
  assert.equal(c.params.threshold,.51);
  assert.equal(c.stop,.04);
  assert.equal(c.take,.08);
  assert.equal(FREEZE.asof,'2026-11-08T20:00:00.000Z');
  assert.equal(FREEZE.activationNotBefore,'2026-11-09T00:00:00.000Z');
  assert.equal(FREEZE.trainingTailEmbargoBars,24);
});

test('frozen model job has no user-provided optimizer inputs, live orders or private exchange API',()=>{
  const code=readFileSync(new URL('../scripts/freeze-ml068-model.mjs',import.meta.url),'utf8');
  assert.match(code,/MODEL_FREEZE_NEVER_ACCEPTS_PARAMETER_OVERRIDES/);
  assert.doesNotMatch(code,/submitOrder|placeOrder|privateKey|process\.env|\bbot\.js\b/);
  assert.match(code,/PUBLIC_MARKET_RESEARCH_NO_ORDERS/);
});
