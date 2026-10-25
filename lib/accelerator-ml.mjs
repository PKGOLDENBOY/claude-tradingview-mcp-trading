/**
 * Strictly offline training: deterministic logistic-regression probability models.
 * Trains ONLY on chronologically prior data and training-set fitted scaling.
 * Holdout remains sealed until a SINGLE validation-selected candidate is chosen.
 * No orders, private feeds, pretrained secret models, exchange authentication or ML API.
 */
import { simulateCandidate, aggregateSimulations, prepareSeries,
  chronologicalSplits, DEFAULT_ASSUMPTIONS } from './accelerator-core.mjs';
const FEATURES = Object.freeze(['logReturn1','logReturn6','logReturn24','emaSpread10_50',
  'rsi14Centered','barRangePct','logVolumeRatio20','realizedVol12','ema80Distance']);
const round=n=>Math.round(n*10000)/10000;
const sigmoid=x=>x<-35?0:x>35?1:1/(1+Math.exp(-x));
const clip=x=>Math.max(-8,Math.min(8,x));

/** Explicitly lag-only technical features; NO future input at inference time. */
export function mlFeatures(series,i){
  const c=series.close;
  if(i<110 || i>=series.length)return null;
  const v=series.priorQuoteVolume20[i];
  if(!Number.isFinite(v)||v<=0)return null;
  let sq=0;
  for(let j=i-11;j<=i;j++){
    const ret=Math.log(c[j]/c[j-1]);sq+=ret*ret;
  }
  const x=[Math.log(c[i]/c[i-1]),Math.log(c[i]/c[i-6]),Math.log(c[i]/c[i-24]),
    Math.log(series.ema[10][i]/series.ema[50][i]),
    (series.rsi[14][i]-50)/50,
    (series.high[i]-series.low[i])/c[i],
    Math.log(Math.max(1,series.quoteVolume[i])/v),
    Math.sqrt(sq/12),
    c[i]/series.ema[80][i]-1];
  return x.every(Number.isFinite)?x:null;
}

/** A label at time i is usable ONLY if its horizon ends before train.end. */
export function trainingSamples(prepared,range,horizon,{
  feePerSide=DEFAULT_ASSUMPTIONS.feePerSide,
  adverseSlippagePerSide=DEFAULT_ASSUMPTIONS.adverseSlippagePerSide,
  assumedHalfSpreadPerSide=DEFAULT_ASSUMPTIONS.assumedHalfSpreadPerSide,
}={}){
  if(!Number.isSafeInteger(horizon)||horizon<1||horizon>24)
    throw new Error('ML_TRAINING_HORIZON_INVALID');
  const X=[],Y=[];
  const roundtripCost=2*(feePerSide+adverseSlippagePerSide+assumedHalfSpreadPerSide);
  for(const sym of Object.keys(prepared).sort()){
    const s=prepared[sym];
    for(let i=Math.max(110,range.start);i+horizon<range.end;i++){
      const features=mlFeatures(s,i);
      if(!features || !Number.isFinite(s.open[i+1]) || !Number.isFinite(s.close[i+horizon]))continue;
      const logReturn=Math.log(s.close[i+horizon]/s.open[i+1]);
      X.push(features);
      // Label uses future close ONLY for supervised train targets, never as an entry signal.
      Y.push(logReturn-roundtripCost>0.003?1:0);
    }
  }
  if(X.length<300)throw new Error('ML_INSUFFICIENT_TRAINING_SAMPLES');
  return {X,Y,horizon,trainingEndExclusive:range.end};
}
function scaleTraining(X){
  const mean=new Float64Array(FEATURES.length),std=new Float64Array(FEATURES.length);
  for(const x of X)for(let j=0;j<mean.length;j++)mean[j]+=x[j];
  for(let j=0;j<mean.length;j++)mean[j]/=X.length;
  for(const x of X)for(let j=0;j<std.length;j++)std[j]+=(x[j]-mean[j])**2;
  for(let j=0;j<std.length;j++)std[j]=Math.max(1e-8,Math.sqrt(std[j]/X.length));
  return {mean:[...mean],std:[...std]};
}
const normalized=(x,scaler)=>x.map((v,j)=>clip((v-scaler.mean[j])/scaler.std[j]));
export function fitLogistic(samples,{learningRate=0.01,l2=0.0001,epochs=12}={}){
  if(!Number.isFinite(learningRate)||learningRate<=0||learningRate>.2 ||
    !Number.isFinite(l2)||l2<0||l2>.02 || !Number.isSafeInteger(epochs)||epochs<1||epochs>80)
    throw new Error('ML_UNSAFE_HYPERPARAMETERS');
  const scaler=scaleTraining(samples.X);
  const X=samples.X.map(x=>normalized(x,scaler)),Y=samples.Y;
  const weights=new Float64Array(FEATURES.length),n=X.length;
  let intercept=0;
  for(let epoch=0;epoch<epochs;epoch++){
    const reverse=(epoch%2)===1;
    for(let k=0;k<n;k++){
      const i=reverse?n-k-1:k,x=X[i];
      let z=intercept;
      for(let j=0;j<weights.length;j++)z+=weights[j]*x[j];
      const error=sigmoid(z)-Y[i];
      intercept-=learningRate*error;
      for(let j=0;j<weights.length;j++)
        weights[j]-=learningRate*(error*x[j]+l2*weights[j]);
    }
  }
  return {weights:[...weights],intercept,scaler,
    trainedExamples:n,positiveRate:Y.reduce((a,b)=>a+b,0)/n,
    featureNames:FEATURES.slice(),trainingEndExclusive:samples.trainingEndExclusive,
    horizon:samples.horizon,learningRate,l2,epochs};
}
export function predictLogistic(model,features){
  if(features===null)return null;
  const x=normalized(features,model.scaler);
  let z=model.intercept;
  for(let j=0;j<model.weights.length;j++)z+=model.weights[j]*x[j];
  return sigmoid(z);
}
export function predictSeries(model,series){
  const out=new Float64Array(series.length).fill(Number.NaN);
  for(let i=110;i<series.length;i++){
    const features=mlFeatures(series,i);
    if(features)out[i]=predictLogistic(model,features);
  }
  return out;
}
export function mlConfigurations(){
  const variants=[];
  for(const horizon of [6,12]) for(const learningRate of [.003,.012])
    for(const l2 of [.0001,.001]) for(const epochs of [8,24]){
      const modelParams={horizon,learningRate,l2,epochs};
      for(const threshold of [.51,.55,.60])
        for(const [stop,take] of [[.025,.05],[.04,.08]]){
          const id='ml-'+String(variants.length+1).padStart(3,'0');
          variants.push({id,family:'trained-logistic',params:{...modelParams,threshold},stop,take});
        }
    }
  return variants;
}
function modelKey(params){return [params.horizon,params.learningRate,params.l2,params.epochs].join(':');}
function signalParts(candidate,prepared,predictions,range,assumptions){
  return Object.keys(prepared).sort().map(sym=>simulateCandidate(candidate,prepared[sym],range,{
    ...assumptions,signalFn:(_,s,i)=>Number.isFinite(predictions[sym][i]) &&
      predictions[sym][i]>=candidate.params.threshold,
  }));
}
export function trainMLCandidates(prepared,splits,{
  assumptions=DEFAULT_ASSUMPTIONS,
  maxConfigs=null,
}={}){
  const capital=assumptions.initialCapitalUSD??DEFAULT_ASSUMPTIONS.initialCapitalUSD;
  const all=mlConfigurations();
  const configs=maxConfigs===null?all:all.slice(0,maxConfigs);
  const byId=new Map(configs.map(c=>[c.id,[]]));
  const started=performance.now();
  let fits=0;
  for(const fold of splits.folds){
    const modelCache=new Map();
    for(const candidate of configs){
      const key=modelKey(candidate.params);
      let preparedModel=modelCache.get(key);
      if(!preparedModel){
        const samples=trainingSamples(prepared,fold.train,candidate.params.horizon,assumptions);
        const model=fitLogistic(samples,candidate.params);fits++;
        const predictions=Object.fromEntries(Object.entries(prepared).map(([s,series])=>
          [s,predictSeries(model,series)]));
        preparedModel={model,predictions};
        modelCache.set(key,preparedModel);
      }
      const train=aggregateSimulations(signalParts(candidate,prepared,preparedModel.predictions,fold.train,assumptions),
        {initialCapitalUSD:capital});
      const validation=aggregateSimulations(signalParts(candidate,prepared,preparedModel.predictions,fold.validation,assumptions),
        {initialCapitalUSD:capital});
      byId.get(candidate.id).push({fold:fold.id,train,validation,
        trainSamples:preparedModel.model.trainedExamples,
        trainingPositiveRate:round(preparedModel.model.positiveRate)});
    }
  }
  const results=configs.map(candidate=>{
    const folds=byId.get(candidate.id),train=folds.at(-1).train;
    const val=folds.map(f=>f.validation);
    const valTrades=val.reduce((sum,x)=>sum+x.trades,0);
    const valPnl=val.reduce((sum,x)=>sum+x.pnlUSD,0);
    const positiveFolds=val.filter(x=>x.pnlUSD>0).length;
    const worstFold=Math.min(...val.map(x=>x.pnlUSD));
    const maxDrawdown=Math.max(...val.map(x=>x.maxDrawdownUSD));
    const grossProfit=val.reduce((sum,x)=>sum+x.grossProfitUSD,0);
    const grossLoss=val.reduce((sum,x)=>sum+x.grossLossUSD,0);
    const profitFactor=grossLoss>0?round(grossProfit/grossLoss):null;
    const score=round(valPnl-maxDrawdown*.45+worstFold*.35);
    const eligible=train.trades>=12 && train.pnlUSD>0 && train.profitFactor!==null &&
      train.profitFactor>=1.1 && valTrades>=15 && valPnl>0 && profitFactor!==null &&
      profitFactor>=1.2 && positiveFolds>=2 && maxDrawdown<=45 &&
      val.every(x=>x.trades>=2 && x.pnlUSD>=-20);
    return {id:candidate.id,family:candidate.family,params:candidate.params,
      stop:candidate.stop,take:candidate.take,score,eligible,train,
      validation:{trades:valTrades,pnlUSD:round(valPnl),positiveFolds,
        worstFoldPnlUSD:round(worstFold),maxFoldDrawdownUSD:round(maxDrawdown),profitFactor},foldReports:folds};
  });
  const order=(a,b)=>b.score-a.score||a.id.localeCompare(b.id);
  const qualified=results.filter(r=>r.eligible).sort(order);
  const result={
    algorithm:'TRAINED_LOGISTIC_REGRESSION_ONLY',
    training:{configurations:configs.length,modelFits:fits,trainOnlyFeatureScaling:true,
      target:'Forward 6h or 12h spot price gain over assumed roundtrip cost plus 0.3%; future labels only in training',
      featureNames:FEATURES.slice(),
      elapsedMs:round(performance.now()-started),
      noFutureLabelsAcrossFoldBoundary:true},
    selected:qualified[0]??null,qualifiedCount:qualified.length,
    topTen:results.sort(order).slice(0,10),
    conclusion:qualified.length?'ML_RESEARCH_CANDIDATE_ONLY':'ML_NO_VALIDATED_EDGE',
  };
  return result;
}

/** One-time frozen holdout evaluation; retrain once on development only. */
export function evaluateMLHoldout(candidate,prepared,splits,assumptions=DEFAULT_ASSUMPTIONS){
  const train={start:110,end:splits.holdout.start-splits.embargoBars};
  const samples=trainingSamples(prepared,train,candidate.params.horizon,assumptions);
  const model=fitLogistic(samples,candidate.params);
  const predictions=Object.fromEntries(Object.entries(prepared).map(([sym,series])=>
    [sym,predictSeries(model,series)]));
  const result=aggregateSimulations(signalParts(candidate,prepared,predictions,splits.holdout,assumptions),
    {initialCapitalUSD:assumptions.initialCapitalUSD??DEFAULT_ASSUMPTIONS.initialCapitalUSD});
  return {result,model:{...model,weights:model.weights.map(round),
    intercept:round(model.intercept),
    instruction:'Frozen research model. Not production-ready or authorised for live trading.'},
    holdoutSelectionUsed:false};
}
