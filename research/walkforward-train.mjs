// AlphaBot independent evidence lab — read-only BitGet SPOT candles.
// Absolutely no exchange credentials, private account APIs, order submission,
// automatic configuration changes, or automatic live trading are used here.
// Research results are never permission to deploy an optimized strategy.
import { mkdirSync, writeFileSync } from "node:fs";
import { normaliseCandles } from "../lib/market-data.mjs";
import { paperEntry, paperExit } from "../lib/risk-engine.mjs";

export const HOUR = 3600000;
export const DAY = 24 * HOUR;
export const UNIVERSE = Object.freeze(["BTCUSDT","ETHUSDT","SOLUSDT","LINKUSDT","ADAUSDT"]);
export const PARAMETERS = Object.freeze([
  { id:"trend-a", strategy:"trend", rsiMax:54, tp:.05, sl:.025, hold:72 },
  { id:"trend-b", strategy:"trend", rsiMax:60, tp:.075, sl:.035, hold:96 },
  { id:"breakout-a", strategy:"breakout", lookback:20, volumeMultiple:1.25, tp:.05, sl:.03, hold:72 },
  { id:"breakout-b", strategy:"breakout", lookback:40, volumeMultiple:1.50, tp:.08, sl:.04, hold:120 },
  { id:"reversion-a", strategy:"reversion", rsiMax:30, tp:.04, sl:.025, hold:72 },
  { id:"reversion-b", strategy:"reversion", rsiMax:36, tp:.06, sl:.035, hold:96 },
  { id:"vwap-a", strategy:"vwap", rsiMax:45, tp:.03, sl:.02, hold:48 },
  { id:"vwap-b", strategy:"vwap", rsiMax:55, tp:.05, sl:.03, hold:72 },
]);
const FEE = 0.001, SLIPPAGE = 0.001;
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function getJSON(url, get = fetch, wait = sleep) {
  for (let attempt=0; attempt<=3; attempt++) {
    try {
      const response = await get(url, {method:"GET",signal:AbortSignal.timeout(18000)});
      if (response.status===429 || response.status>=500) {
        if (attempt===3) throw new Error("HTTP "+response.status);
        let retryMs = 800 * 2**attempt;
        const header = response.headers?.get?.("retry-after");
        if (header && Number.isFinite(Number(header))) retryMs = Math.min(15000,Math.max(retryMs,Number(header)*1000));
        await wait(retryMs);
        continue;
      }
      if (!response.ok) throw new Error("HTTP "+response.status);
      const data=await response.json();
      if (data.code!=="00000" || !Array.isArray(data.data))
        throw new Error("BitGet rejected data ("+String(data.code)+") "+String(data.msg||"").slice(0,90));
      return data.data;
    } catch(err) {
      if(attempt===3 || !/fetch failed|timeout|aborted/i.test(String(err.message))) throw err;
      await wait(800 * 2**attempt);
    }
  }
  throw new Error("Historical feed exhausted all retries");
}

export async function historicalCandles(symbol, config={}) {
  if(!/^[A-Z]{2,14}USDT$/.test(symbol)) throw new Error("Invalid SPOT symbol");
  const now = config.now ?? Date.now(), days=config.days ?? 180;
  const maxPages=config.maxPages ?? Math.ceil(days*24/90)+6;
  const oldestAllowed = Math.floor((now-days*DAY)/HOUR)*HOUR;
  const fetcher=config.fetcher ?? fetch, wait=config.wait ?? sleep;
  const rows = new Map();
  let endTime = Math.floor(now/HOUR)*HOUR-1;
  for(let page=0;page<maxPages;page++) {
    const query = "https://api.bitget.com/api/v3/market/history-candles?category=SPOT&symbol=" + symbol +
      "&interval=1H&limit=100&endTime=" + endTime;
    const raw=await getJSON(query,fetcher,wait);
    const candles=normaliseCandles(raw,{now,intervalMs:HOUR,closedOnly:true});
    if(candles.length===0) break;
    for(const c of candles)if(c.time>=oldestAllowed)rows.set(c.time,c);
    const earliest=candles[0].time;
    if(earliest>=endTime)throw new Error("Historical pagination made no progress: "+symbol);
    if(earliest<=oldestAllowed)break;
    endTime=earliest-1;
    // Keep GitHub Actions below BitGet's documented 20 req/s limit.
    if(config.spacingMs!==0)await wait(config.spacingMs ?? 220);
  }
  const result=[...rows.values()].sort((a,b)=>a.time-b.time);
  const minBars=config.minBars ?? Math.floor(days*24*0.83);
  if(result.length<minBars)throw new Error(symbol+" insufficient 1H history "+result.length+"/"+minBars);
  // Fail rather than fit indicators to a feed with major holes or duplicates.
  const expectedHours=(result.at(-1).time-result[0].time)/HOUR+1;
  const coverage=result.length/expectedHours;
  if(coverage<0.93)throw new Error(symbol+" gap-heavy data: "+(coverage*100).toFixed(1)+"% coverage");
  return {symbol,periodDays:days,candles:result,coverage,first:result[0].time,last:result.at(-1).time};
}

function ema(values,period){
  const k=2/(period+1);let level=values[0];
  return values.map((x,i)=>(level=i===0?x:level+(x-level)*k));
}
function rsi(values,period){
  const result=Array(values.length).fill(null);
  if(values.length<=period)return result;
  let up=0,down=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];up+=Math.max(0,d);down+=Math.max(0,-d);}
  up/=period;down/=period;
  for(let i=period;i<values.length;i++){
    if(i>period){const d=values[i]-values[i-1];up=(up*(period-1)+Math.max(0,d))/period;down=(down*(period-1)+Math.max(0,-d))/period;}
    result[i]=down===0?100:100-100/(1+up/down);
  }
  return result;
}
export function indicators(candles){
  const p=candles.map(x=>x.close);
  const result={ema8:ema(p,8),ema20:ema(p,20),ema50:ema(p,50),ema100:ema(p,100),ema200:ema(p,200),
    rsi3:rsi(p,3),rsi14:rsi(p,14),vwap24:[],avgVol20:[],high20:[],high40:[],lowerBB20:[]};
  for(let i=0;i<candles.length;i++){
    const block=candles.slice(Math.max(0,i-19),i+1);
    const avg=block.reduce((s,c)=>s+c.close,0)/block.length;
    const sd=Math.sqrt(block.reduce((s,c)=>s+(c.close-avg)**2,0)/block.length);
    result.lowerBB20.push(avg-2*sd);
    let numerator=0,denom=0;
    for(const c of candles.slice(Math.max(0,i-23),i+1)){
      const tp=(c.high+c.low+c.close)/3;
      numerator+=tp*c.volume;denom+=c.volume;
    }
    result.vwap24.push(denom>0?numerator/denom:p[i]);
    const prior=candles.slice(Math.max(0,i-20),i);
    result.avgVol20.push(prior.length?prior.reduce((s,c)=>s+c.volume,0)/prior.length:0);
    for(const n of [20,40]){
      const priorHigh=candles.slice(Math.max(0,i-n),i);
      result["high"+n].push(priorHigh.length===n?Math.max(...priorHigh.map(c=>c.high)):Infinity);
    }
  }
  return result;
}
export function signal(c,i,x,p){
  if(i<220)return false; // 200h EMA warm-up; decisions use only completed bars <= i
  const candle=c[i],prev=c[i-1],rv=x.rsi14[i], fast=x.rsi3[i];
  if(!(rv>=0) || !(fast>=0) || !(x.avgVol20[i]>0))return false;
  if(p.strategy==="trend")return (
    candle.close>x.ema100[i] && x.ema20[i]>x.ema50[i] &&
    rv>40 && rv<p.rsiMax && rv>x.rsi14[i-1] &&
    candle.close<=x.ema20[i]*1.007 && candle.close>candle.open
  );
  if(p.strategy==="breakout")return (
    candle.close>x["high"+p.lookback][i] &&
    candle.volume>x.avgVol20[i]*p.volumeMultiple &&
    x.ema20[i]>x.ema50[i] && candle.close>x.ema100[i]
  );
  if(p.strategy==="reversion")return (
    x.ema100[i]>x.ema200[i] && candle.close<x.lowerBB20[i] &&
    rv<p.rsiMax && candle.close>candle.low
  );
  if(p.strategy==="vwap")return (
    candle.close>x.vwap24[i] && candle.close>x.ema8[i] &&
    fast<p.rsiMax && candle.volume>x.avgVol20[i]*0.8 &&
    Math.abs(candle.close/x.vwap24[i]-1)<0.03
  );
  return false;
}

// The signal at bar i is filled at the OPEN of bar i+1, never its own close.
// If both target and stop are touched during one bar, stop wins.
// All positions must be CLOSED inside the relevant chronological window.
// Trade sizes are normalized notional for comparing signal quality, NOT account return.
export function simulate(candles,x,params,windowStart,windowEnd,options={}){
  const trades=[];
  const fee=options.fee??FEE,slippage=options.slippage??SLIPPAGE;
  for(let i=220;i<candles.length-1;){
    const next=candles[i+1];
    if(next.time<windowStart){i++;continue;}
    if(next.time>=windowEnd)break;
    if(!signal(candles,i,x,params)){i++;continue;}
    const buy=paperEntry({marketPrice:next.open,notionalUsd:100,feeFraction:fee,slippageFraction:slippage});
    const stop=buy.fillPrice*(1-params.sl),target=buy.fillPrice*(1+params.tp);
    const furthest=Math.min(candles.length-1,i+1+params.hold);
    let exited=false;
    for(let j=i+1;j<=furthest;j++){
      const bar=candles[j];if(bar.time>=windowEnd)break;
      let closePrice=null,reason=null;
      if(bar.open<=stop){closePrice=bar.open;reason="gap-stop";}
      else if(bar.low<=stop){closePrice=stop;reason="stop";}
      else if(bar.high>=target){closePrice=target;reason="target";}
      else if(j===furthest){closePrice=bar.close;reason="timeout";}
      // A window boundary forces a close at the prior bar, without using data beyond it.
      else if(j===candles.length-1 || candles[j+1].time>=windowEnd){closePrice=bar.close;reason="window-close";}
      if(closePrice===null)continue;
      const sold=paperExit({entryFillPrice:buy.fillPrice,exitMarketPrice:closePrice,quantity:buy.quantity,
        entryFeeUsd:buy.entryFeeUsd,feeFraction:fee,slippageFraction:slippage});
      trades.push({symbol:options.symbol||"",entryTime:next.time,exitTime:bar.time,
        resultPct:sold.pnlPct,exitReason:reason,holdHours:j-(i+1)+1});
      exited=true;i=j+1;break;
    }
    if(!exited)break;
  }
  return trades;
}

export function stats(trades){
  const a=[...(trades||[])].sort((a,b)=>a.exitTime-b.exitTime);
  const n=a.length,w=a.filter(t=>t.resultPct>0),l=a.filter(t=>t.resultPct<0);
  const pos=w.reduce((s,t)=>s+t.resultPct,0),neg=-l.reduce((s,t)=>s+t.resultPct,0);
  const sum=a.reduce((s,t)=>s+t.resultPct,0),mean=n?sum/n:null;
  let peak=1,equity=1,drawdown=0;let lossStreak=0,longestLosingStreak=0;
  for(const t of a){
    // Diagnostic only: constant 10%-notional trade sequence ignoring overlapping positions.
    // NOT a true portfolio-level cash/equity simulation.
    equity*=1+t.resultPct/100*0.10;
    peak=Math.max(peak,equity);
    drawdown=Math.max(drawdown,1-equity/peak);
    lossStreak=t.resultPct<0?lossStreak+1:0;
    longestLosingStreak=Math.max(longestLosingStreak,lossStreak);
  }
  const meanSorted=a.map(t=>t.resultPct).sort((a,b)=>a-b);
  const avg=mean??0;
  const variance=n>1?a.reduce((s,t)=>s+(t.resultPct-avg)**2,0)/(n-1):0;
  return {n,wins:w.length,losses:l.length,winRatePct:n?100*w.length/n:null,
    expectancyNetPct:mean,profitFactor:neg>0?pos/neg:null,
    worstPct:n?meanSorted[0]:null,medianPct:n?meanSorted[Math.floor(n/2)]:null,
    approximateDrawdownPct:100*drawdown,losingStreak:longestLosingStreak,
    lower90MeanBoundPct:n>=2?avg-1.645*Math.sqrt(variance/n):null,
    tradedSymbols:new Set(a.map(t=>t.symbol)).size,
    note:"Trade-sequence approximate drawdown only; not account P&L or a realistic portfolio ledger"};
}
function strong(s,{minTrades=20,minPF=1.15}={}){
  return s.n>=minTrades && s.tradedSymbols>=3 &&
    s.expectancyNetPct>0 && s.profitFactor!==null && s.profitFactor>=minPF;
}
export function trainOnDatasets(datasets,asOf=Date.now(),options={}){
  const endHour=Math.floor(asOf/HOUR)*HOUR;
  const trainEnd=endHour-60*DAY,validateEnd=endHour-30*DAY, holdoutEnd=endHour;
  const phases=[
    {name:"training",start:endHour-180*DAY,end:trainEnd},
    {name:"validation",start:trainEnd,end:validateEnd},
    {name:"holdout",start:validateEnd,end:holdoutEnd},
  ];
  const prepared=datasets.map(({symbol,candles})=>({symbol,candles,ind:indicators(candles)}));
  const assess=(p,period,settings={})=>{
    const trades=prepared.flatMap(d=>simulate(d.candles,d.ind,p,period.start,period.end,{symbol:d.symbol,...settings}));
    return stats(trades);
  };
  const training=PARAMETERS.map(p=>({parameter:p,metrics:assess(p,phases[0])}))
    .sort((a,b)=>(b.metrics.expectancyNetPct??-999)-(a.metrics.expectancyNetPct??-999));
  // Never use validation or holdout to refit signals or risk settings.
  const trainPassed=training.filter(x=>strong(x.metrics,{minTrades:30,minPF:1.10}));
  const validation=trainPassed.map(x=>({...x,validation:assess(x.parameter,phases[1])}))
    .sort((a,b)=>(b.validation.expectancyNetPct??-999)-(a.validation.expectancyNetPct??-999));
  const valPassed=validation.filter(x=>strong(x.validation,{minTrades:10,minPF:1.10}));
  const chosen=valPassed[0]??null;
  const holdout=chosen?assess(chosen.parameter,phases[2]):null;
  const stress=chosen?assess(chosen.parameter,phases[2],{fee:0.0015,slippage:0.0020}):null;
  const approved=Boolean(chosen && strong(holdout,{minTrades:12,minPF:1.15}) &&
    stress.n>=12 && stress.expectancyNetPct>0 && stress.profitFactor!==null && stress.profitFactor>1);
  return {
    asOf:new Date(asOf).toISOString(),status:approved?"RESEARCH_CANDIDATE_ONLY":"NO_VALIDATED_EDGE",
    selected:chosen?{id:chosen.parameter.id,parameters:chosen.parameter}:null,
    assessedStrategies:PARAMETERS.length,trainingCandidates:trainPassed.length,
    validationCandidates:valPassed.length,windows:phases.map(p=>({...p,start:new Date(p.start).toISOString(),end:new Date(p.end).toISOString()})),
    training:training.map(x=>({id:x.parameter.id,metrics:x.metrics})),
    validation:validation.map(x=>({id:x.parameter.id,metrics:x.validation})),
    holdout,stress,approvalEvidence:approved,
    action:"KEEP_LIVE_TRADING_DISABLED; DO NOT AUTOMATICALLY CHANGE PAPER BOT PARAMETERS",
    warnings:[
      "Historical fills are synthetic and ignore live order-book depth, taxes, and outages.",
      "Multiple hypotheses tested: strong historical results may still be luck.",
      "No machine-learning claim: this tunes predefined strategies only.",
      "Never train on holdout results; reserve future unseen data for an independent check.",
      "A passing holdout is evidence for extended paper testing, not permission for live orders."
    ],
    data:datasets.map(d=>({symbol:d.symbol,candles:d.candles.length,
      first:new Date(d.candles[0].time).toISOString(),last:new Date(d.candles.at(-1).time).toISOString()})),
  };
}

export async function main() {
  const now=Date.now();
  const datasets=[];
  for(const symbol of UNIVERSE) {
    const d=await historicalCandles(symbol,{now,days:180});
    console.log("HISTORY_OK "+JSON.stringify({symbol,bars:d.candles.length,
      first:new Date(d.first).toISOString(),last:new Date(d.last).toISOString(),coverage:d.coverage}));
    datasets.push(d);
  }
  if(datasets.length!==UNIVERSE.length)throw new Error("Partial universe: assessment must abort");
  const result=trainOnDatasets(datasets,now);
  const folder=process.env.RESEARCH_OUTPUT_DIR || "research/out";
  mkdirSync(folder,{recursive:true});
  const file=folder+"/evaluation-"+new Date(now).toISOString().slice(0,10)+".json";
  writeFileSync(file,JSON.stringify(result,null,2)+"\n");
  console.log("WALK_FORWARD_RESULT "+JSON.stringify({
    status:result.status,trainPassed:result.trainingCandidates,
    valPassed:result.validationCandidates,selected:result.selected,
    holdout:result.holdout,stress:result.stress,output:file,
  }));
  if(process.env.GITHUB_STEP_SUMMARY) {
    const body=[
      "## AlphaBot independent walk-forward research",
      "**Status:** "+result.status,
      "**Study:** 180 days, five liquid SPOT coins, 1H candles, chronological 120/30/30-day windows.",
      "**Costs:** 0.10% fee and 0.10% slippage per side; pessimistic stop-first on ambiguous bars.",
      "**Training candidates:** "+result.trainingCandidates,
      "**Validation candidates:** "+result.validationCandidates,
      "**Selected for holdout:** "+(result.selected?.id || "NONE"),
      "**Holdout trades:** "+(result.holdout?.n ?? 0),
      "**Holdout average net return per trade:** "+(result.holdout?.expectancyNetPct?.toFixed(3) || "n/a")+"%",
      "**Stress-test average net return:** "+(result.stress?.expectancyNetPct?.toFixed(3)||"n/a")+"%",
      "**Live trading:** always disabled by this research.",
      "All detailed metrics are in the saved JSON artifact."
    ].join("\n\n");
    writeFileSync(process.env.GITHUB_STEP_SUMMARY,body+"\n",{flag:"a"});
  }
  return result;
}
if(process.argv[1] && /[/\\]walkforward-train\.mjs$/.test(process.argv[1]))
  main().catch(err=>{console.error("TRAINING_DATA_OR_EXECUTION_ERROR "+err.message);process.exitCode=1;});
