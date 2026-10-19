import test from "node:test";
import assert from "node:assert/strict";
import { indicators,HOUR,DAY } from "../research/walkforward-train.mjs";
import { features, fixedHorizonFill, fitLogistic, predict, selectTrades, evaluateModel } from "../research/train-ml.mjs";

function candles(count=500,startingAt=0){
  return Array.from({length:count},(_,i)=>({
    time:startingAt+i*HOUR,open:100,high:101,low:99,close:100,volume:100,
  }));
}
test("classifier features see only this and prior candle data",()=>{
  const c=candles(),x=indicators(c);
  const before=features(c,x,250);
  c[350]={...c[350],close:99999,high:99999};
  const after=features(c,x,250);
  assert.deepEqual(before,after);
  assert.equal(before.length,14);
});
test("label is net of fees/slippage and pessimistic about intrabar ambiguity",()=>{
  const c=candles();
  c[251]={...c[251],open:100,high:110,low:90,close:100};
  const a=fixedHorizonFill(c,250);
  assert.equal(a.reason,"stop");
  assert.ok(a.resultPct<0);
});
test("flat market future produces negative label due to estimated execution costs",()=>{
  const c=candles(),a=fixedHorizonFill(c,250);
  assert.equal(a.reason,"timeout");
  assert.ok(a.resultPct<0);
});
test("regularized supervised model learns a synthetic positive correlation",()=>{
  const rows=Array.from({length:400},(_,i)=>({
    features:[(i%2===0?1:-1),Math.sin(i)*0.01],label:i%2===0?1:0,
  }));
  const model=fitLogistic(rows,{epochs:140});
  assert.ok(predict(model,[1,0])>0.7);
  assert.ok(predict(model,[-1,0])<0.3);
  assert.equal(model.featureCount,2);
});
test("model selection does not stack simultaneous positions on one symbol",()=>{
  const train=Array.from({length:400},(_,i)=>({features:[i%2===0?1:-1],label:i%2===0?1:0}));
  const model=fitLogistic(train);
  const samples=Array.from({length:20},(_,i)=>({
    symbol:"BTCUSDT",features:[1],entryTime:i*HOUR,exitTime:(i+10)*HOUR,resultPct:1,
  }));
  const picked=selectTrades(model,samples,0.5);
  assert.ok(picked.length<=2);
  assert.ok(picked.every((x,i)=>i===0||x.entryTime>picked[i-1].exitTime));
});
test("a no-edge artificial universe must never be promoted to live trading",()=>{
  const now=181*DAY;
  const universe=["BTCUSDT","ETHUSDT","SOLUSDT","LINKUSDT","ADAUSDT"].map(symbol=>({
    symbol,candles:candles(180*24,now-180*DAY),
  }));
  const result=evaluateModel(universe,now);
  assert.equal(result.status,"NO_VALIDATED_ML_EDGE");
  assert.equal(result.approvalEvidence,false);
  assert.equal(result.chosenThreshold,null);
  assert.equal(result.holdout,null);
});
