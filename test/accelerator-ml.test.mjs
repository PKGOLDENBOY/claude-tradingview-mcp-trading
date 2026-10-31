import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareSeries,chronologicalSplits} from '../lib/accelerator-core.mjs';
import {mlFeatures,trainingSamples,fitLogistic,predictLogistic,
  mlConfigurations,trainMLCandidates,evaluateMLHoldout} from '../lib/accelerator-ml.mjs';
import {testUniverse} from './helpers.mjs';

test('96 genuine logistic classifier threshold and risk configurations',()=>{
  const grid=mlConfigurations();
  assert.equal(grid.length,96);
  assert.equal(new Set(grid.map(x=>x.id)).size,96);
  assert.ok(grid.every(c=>c.family==='trained-logistic'));
});
test('logistic model fits deterministic training labels and estimates distinct probabilities',()=>{
  const X=[],Y=[];
  for(let i=0;i<600;i++){
    const a=((i*37)%301-150)/30;
    X.push([a,a*.2,0,0,0,0,0,0,0]);Y.push(a>0?1:0);
  }
  const model=fitLogistic({X,Y,trainingEndExclusive:700,horizon:6},
    {learningRate:.012,l2:.0001,epochs:8});
  assert.ok(predictLogistic(model,[3,.6,0,0,0,0,0,0,0])>.7);
  assert.ok(predictLogistic(model,[-3,-.6,0,0,0,0,0,0,0])<.3);
  assert.equal(model.trainingEndExclusive,700);
});
test('ML feature inference and training-set fitted model cannot see sealed future values',()=>{
  const data=testUniverse(1460);
  const splits=chronologicalSplits(1460);
  const prepared=Object.fromEntries(Object.entries(data).map(([s,b])=>[s,prepareSeries(b)]));
  const x=mlFeatures(prepared.BTCUSDT,splits.folds.at(-1).validation.start);
  const train=trainingSamples(prepared,splits.folds.at(-1).train,12);
  assert.ok(train.X.length>300);
  assert.equal(train.trainingEndExclusive,splits.folds.at(-1).train.end);
  const a=fitLogistic(train,{learningRate:.003,l2:.0001,epochs:8});
  for(const bars of Object.values(data))for(let i=splits.holdout.start;i<bars.length;i++){
    bars[i].close*=.5;bars[i].open*=.5;bars[i].high*=1.5;bars[i].low*=.4;
  }
  const after=Object.fromEntries(Object.entries(data).map(([s,b])=>[s,prepareSeries(b)]));
  const x2=mlFeatures(after.BTCUSDT,splits.folds.at(-1).validation.start);
  const b=fitLogistic(trainingSamples(after,splits.folds.at(-1).train,12),
    {learningRate:.003,l2:.0001,epochs:8});
  assert.deepEqual(x,x2);
  assert.deepEqual(a,b);
});
test('ML cross-validation retains sealed holdout; independent model candidate requires positive evidence',()=>{
  const data=testUniverse(1450);
  const splits=chronologicalSplits(1450);
  const prepared=Object.fromEntries(Object.entries(data).map(([s,b])=>[s,prepareSeries(b)]));
  const r=trainMLCandidates(prepared,splits,{maxConfigs:9});
  assert.equal(r.training.configurations,9);
  assert.equal(r.training.modelFits,6);
  assert.ok(r.qualifiedCount>=0);
  assert.equal(r.training.trainOnlyFeatureScaling,true);
  assert.equal(r.topTen.length,9);
  assert.ok(r.selected===null||r.selected.eligible);
  // Holdout evaluation is available only on a specifically chosen candidate.
  const holdout=evaluateMLHoldout(mlConfigurations()[0],prepared,splits);
  assert.equal(holdout.holdoutSelectionUsed,false);
  assert.ok(holdout.model.trainingEndExclusive<splits.holdout.start);
});
