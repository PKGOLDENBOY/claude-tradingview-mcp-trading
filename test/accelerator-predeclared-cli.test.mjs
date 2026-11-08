import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs} from '../scripts/predeclared-trend-eval.mjs';

test('single-frozen research CLI accepts only tightly bounded historical data arguments',()=>{
  const o=parseArgs(['--days=180','--asof=2026-11-08T18:00:00Z']);
  assert.equal(o.days,180);
  assert.equal(o.asofMs,Date.parse('2026-11-08T18:00:00Z'));
  assert.throws(()=>parseArgs(['--holdout']),/UNKNOWN_CLI_ARGUMENT/);
  assert.throws(()=>parseArgs(['--live=true']),/UNKNOWN_CLI_ARGUMENT/);
  assert.throws(()=>parseArgs(['--days=1']),/INVALID_RESEARCH_CLI_ARGUMENTS/);
  assert.throws(()=>parseArgs(['--days=999']),/INVALID_RESEARCH_CLI_ARGUMENTS/);
});
