// AlphaBot statistical-model research: regularized logistic classifier.
// No live trading, exchange keys, orders or parameter deployment.
// Training: oldest 120d, validation: following 30d, untouched holdout: newest 30d.
// Labels have a 24h future horizon and are PURGED across chronological boundaries.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { indicators, stats, HOUR, DAY } from "./walkforward-train.mjs";
import { paperEntry, paperExit } from "../lib/risk-engine.mjs";

const HORIZON=24, STRIDE=6;
const TAKE_PROFIT=0.06, STOP_LOSS=0.035;
const COSTS={fee:0.001,slippage:0.001};
const THRESHOLDS=[0.45,0.50,0.55,0.60,0.65,0.70];
const clip=(x,a=-5,b=5)=>Math.max(a,Math.min(b,x));

export function features(c,x,i){
  if(i<220 || !c[i-24] || !c[i-4] || !c[i-1] || x.rsi14[i]==null || x.rsi3[i]==null)return null;
  const p=c[i].close;
  const v=c[i].volume,avg=x.avgVol20[i];
  if(!(p>0&&avg>0))return null;
  const vector=[
    Math.log(p/c[i-1].close)*100,
    Math.log(p/c[i-4].close)*100,
    Math.log(p/c[i-24].close)*100,
    100*(p/x.ema20[i]-1),
    100*(x.ema20[i]/x.ema50[i]-1),
    100*(x.ema50[i]/x.ema200[i]-1),
    (x.rsi14[i]-50)/20,
    (x.rsi3[i]-50)/30,
    Math.log(Math.max(1e-8,v/avg)),
    (c[i].high-c[i].low)/p*100,
    (c[i].close-c[i].open)/p*100,
    100*(p/x.vwap24[i]-1),
    Math.sin(2*Math.PI*(new Date(c[i].time).getUTCHours())/24),
    Math.cos(2*Math.PI*(new Date(c[i].time).getUTCHours())/24),
  ];
  return vector.every(Number.isFinite)?vector:null;
}

export function fixedHorizonFill(c,i,costs=COSTS){
  if(!c[i+1] || !c[i+HORIZON+1])return null;
  const entry=c[i+1],buy=paperEntry({
    marketPrice:entry.open,notionalUsd:100,feeFraction:costs.fee,
    slippageFraction:costs.slippage,
  });
  const stop=buy.fillPrice*(1-STOP_LOSS),target=buy.fillPrice*(1+TAKE_PROFIT);
  let last=null,price=null,reason="timeout";
  for(let j=i+1;j<=i+HORIZON+1;j++){
    const b=c[j];
    if(b.open<=stop){last=b;price=b.open;reason="gap-stop";break;}
    if(b.low<=stop){last=b;price=stop;reason="stop";break;}
    // Conservative: if target and stop touch on same bar, stop resolves first.
    if(b.high>=target){last=b;price=target;reason="target";break;}
    if(j===i+HORIZON+1){last=b;price=b.close;}
  }
  const exit=paperExit({entryFillPrice:buy.fillPrice,exitMarketPrice:price,quantity:buy.quantity,
    entryFeeUsd:buy.entryFeeUsd,feeFraction:costs.fee,slippageFraction:costs.slippage});
  return {entryTime:entry.time,exitTime:last.time,resultPct:exit.pnlPct,reason};
}

export function trainingExamples(datasets,opts={}){
  const out=[];
  for(const {symbol,candles:c} of datasets){
    const x=indicators(c);
    for(let i=220;i<c.length-HORIZON-1;i+=STRIDE){
      const vector=features(c,x,i);
      if(!vector)continue;
      const outcome=fixedHorizonFill(c,i,opts.costs??COSTS);
      if(!outcome)continue;
      out.push({symbol,features:vector,label:outcome.resultPct>0?1:0,...outcome});
    }
  }
  return out;
}
function sigmoid(x){return x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));}
export function fitLogistic(train,opts={}){
  if(train.length<100)throw new Error("Insufficient model training samples: "+train.length);
  const dim=train[0].features.length;
  if(!train.every(e=>e.features.length===dim&&e.features.every(Number.isFinite)&&[0,1].includes(e.label)))
    throw new Error("Invalid training examples");
  const means=Array(dim).fill(0),scales=Array(dim).fill(0);
  for(const e of train)for(let i=0;i<dim;i++)means[i]+=e.features[i]/train.length;
  for(const e of train)for(let i=0;i<dim;i++)scales[i]+=(e.features[i]-means[i])**2/train.length;
  for(let i=0;i<dim;i++)scales[i]=Math.max(Math.sqrt(scales[i]),1e-6);
  const standardized=train.map(e=>({z:e.features.map((v,i)=>clip((v-means[i])/scales[i])),label:e.label}));
  const weights=Array(dim+1).fill(0);
  const epochs=opts.epochs??180;
  for(let epoch=0;epoch<epochs;epoch++){
    const grad=Array(dim+1).fill(0);
    for(const e of standardized){
      let score=weights[dim];
      for(let k=0;k<dim;k++)score+=weights[k]*e.z[k];
      const diff=sigmoid(score)-e.label;
      for(let k=0;k<dim;k++)grad[k]+=diff*e.z[k]/standardized.length;
      grad[dim]+=diff/standardized.length;
    }
    const lr=0.5/(1+epoch*.03);
    for(let k=0;k<dim;k++)weights[k]-=lr*(grad[k]+0.03*weights[k]);
    weights[dim]-=lr*grad[dim];
  }
  return {weights,means,scales,trainedExamples:train.length,
    featureCount:dim,method:"L2-regularized binary logistic, no external model weights"};
}
export function predict(model,features){
  if(!Array.isArray(features)||features.length!==model.means.length||!features.every(Number.isFinite))
    throw new Error("Invalid prediction features");
  let total=model.weights.at(-1);
  for(let k=0;k<features.length;k++)
    total+=model.weights[k]*clip((features[k]-model.means[k])/model.scales[k]);
  return sigmoid(total);
}
export function selectTrades(model,samples,threshold,opts={}){
  const clock=opts.stress===true?0.30:0; // EXTRA 0.30 percentage points round trip, beyond original fees/slippage
  const result=[];
  const byCoin=new Map();
  for(const e of samples){
    if(!byCoin.has(e.symbol))byCoin.set(e.symbol,[]);
    byCoin.get(e.symbol).push(e);
  }
  for(const [symbol,events] of byCoin){
    let nextEligible=-Infinity;
    for(const e of events.sort((a,b)=>a.entryTime-b.entryTime)){
      if(e.entryTime<=nextEligible)continue;
      if(predict(model,e.features)<threshold)continue;
      const score=e.resultPct-clock;
      result.push({symbol,entryTime:e.entryTime,exitTime:e.exitTime,resultPct:score});
      nextEligible=e.exitTime;
    }
  }
  return result;
}
const meaningful=s=>s.n>=20 && s.tradedSymbols>=3 &&
  s.expectancyNetPct>0 && s.lower90MeanBoundPct>0 &&
  s.profitFactor!==null && s.profitFactor>=1.15;
export function evaluateModel(datasets,now){
  const end=Math.floor(now/HOUR)*HOUR;
  const trainingCut=end-60*DAY, validationCut=end-30*DAY;
  const samples=trainingExamples(datasets);
  const train=samples.filter(e=>e.entryTime>=end-180*DAY&&e.exitTime<trainingCut);
  const validation=samples.filter(e=>e.entryTime>=trainingCut&&e.exitTime<validationCut);
  const holdout=samples.filter(e=>e.entryTime>=validationCut&&e.exitTime<end);
  const model=fitLogistic(train);
  const trial=THRESHOLDS.map(threshold=>({
    threshold,metrics:stats(selectTrades(model,validation,threshold)),
  })).sort((a,b)=>(b.metrics.expectancyNetPct??-Infinity)-(a.metrics.expectancyNetPct??-Infinity));
  const eligible=trial.filter(x=>meaningful(x.metrics));
  const chosen=eligible[0]??null;
  // No final-period access at all unless the preceding validation passes.
  const oos=chosen?stats(selectTrades(model,holdout,chosen.threshold)):null;
  const stress=chosen?stats(selectTrades(model,holdout,chosen.threshold,{stress:true})):null;
  const approved=Boolean(chosen&&meaningful(oos)&&meaningful(stress));
  return {
    status:approved?"PAPER_RESEARCH_CANDIDATE":"NO_VALIDATED_ML_EDGE",
    trainingExamples:train.length,validationExamples:validation.length,
    untouchedHoldoutExamples:holdout.length,features:model.featureCount,
    trainingPositiveRate:train.reduce((s,e)=>s+e.label,0)/train.length,
    method:model.method,signalEveryHours:STRIDE,futureLabelHours:HORIZON+1,
    targetPct:TAKE_PROFIT*100,stopPct:STOP_LOSS*100,
    tradingCostPerSidePct:(COSTS.fee+COSTS.slippage)*100,
    chronologicalWindows:{trainEnd:new Date(trainingCut).toISOString(),
      validationEnd:new Date(validationCut).toISOString(),holdoutEnd:new Date(end).toISOString()},
    validation:trial,chosenThreshold:chosen?.threshold??null,
    holdout:oos,stress,approvalEvidence:approved,
    model: {weights:model.weights,means:model.means,scales:model.scales},
    action:"RESEARCH ONLY: NEVER AUTOMATICALLY CHANGE PAPER OR REAL ORDERS",
    warnings:[
      "This is a fitted binary classifier; it is not a live-trading AI model.",
      "24-hour labels overlap across samples; signals are spaced six hours and exit-aware.",
      "No future outcome from validation or holdout is used to fit the model weights.",
      "Thresholds were selected on validation only, NOT the final holdout.",
      "All results include simulated 0.10% fee and 0.10% slippage each side.",
      "Stress results deduct an extra 0.30% round-trip execution cost.",
      "Realized live results, order fills and broker position reconciliation not yet proven."
    ],
  };
}
export function main(){
  const dir=process.env.RESEARCH_OUTPUT_DIR||"research/out";
  const snaps=readdirSync(dir).filter(s=>/^market-candles-\d{4}-\d{2}-\d{2}\.json$/.test(s)).sort();
  if(snaps.length===0)throw new Error("No verified public research data snapshot found");
  const raw=JSON.parse(readFileSync(dir+"/"+snaps.at(-1),"utf8"));
  if(raw.datasets?.length!==5)throw new Error("Historical universe must have five coins");
  const datasets=raw.datasets.map(d=>({symbol:d.symbol,
    candles:d.bars.map(a=>({time:Number(a[0]),open:Number(a[1]),high:Number(a[2]),
      low:Number(a[3]),close:Number(a[4]),volume:Number(a[5])}))}));
  const now=Date.parse(raw.asOf);
  if(!Number.isFinite(now))throw new Error("Missing snapshot timestamp");
  const result=evaluateModel(datasets,now);
  const file=dir+"/ml-evaluation-"+new Date(now).toISOString().slice(0,10)+".json";
  writeFileSync(file,JSON.stringify({...result,asOf:raw.asOf,dataset:snaps.at(-1)},null,2)+"\n");
  console.log("ML_TRAINING_RESULT "+JSON.stringify({status:result.status,
    trainExamples:result.trainingExamples,validationExamples:result.validationExamples,
    holdoutExamples:result.untouchedHoldoutExamples,
    validatedThresholds:result.validation.filter(x=>meaningful(x.metrics)).map(x=>x.threshold),
    selected:result.chosenThreshold,holdout:result.holdout,stress:result.stress,
    modelWeightCount:result.model.weights.length,
    liveOrdersEnabled:false,output:file}));
  if(process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY,"\n## Independent supervised model experiment\n"+
      "Training samples: "+result.trainingExamples+"\n\n"+
      "Validation samples: "+result.validationExamples+"\n\n"+
      "Status: **"+result.status+"**\n\n"+
      "Selected threshold: "+(result.chosenThreshold??"none")+
      "\n\nReal-money trading is NEVER enabled by this research.\n",{flag:"a"});
  return result;
}
if(process.argv[1]&&/[/\\]train-ml\.mjs$/.test(process.argv[1])){
  try{main();}catch(err){console.error("ML_TRAINING_FAILED "+err.message);process.exitCode=1;}
}
