/**
 * AlphaBot Accelerator: isolated public-market, offline rule research.
 * SPOT LONG ONLY, zero orders, zero user credentials, no bot.js imports.
 *
 * Methodological boundaries:
 * - Indicators computed from historical/closed bars only.
 * - At the close of bar i, a signal can fill no earlier than bar i+1 open.
 * - Stops are simulated against subsequent bar OHLC with stop-first if ambiguous.
 * - Historical bid/ask is unknown: spread, fee and slippage are assumptions.
 * - Candidate selection sees expanding-window train and validation only.
 * - Final holdout must never influence candidate selection.
 */
export const MODE = 'RESEARCH_ONLY_NO_ORDERS';
export const INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_ASSUMPTIONS = Object.freeze({
  feePerSide: 0.001,
  adverseSlippagePerSide: 0.001,
  assumedHalfSpreadPerSide: 0.0005,
  notionalUSD: 100,
  initialCapitalUSD: 1000,
  minQuoteTurnoverPerBarUSD: 30000,
  maxHoldBars: 72,
  stopCooldownBars: 6,
});
const WARMUP_BARS = 110;
const minFinite = (a, b) => Number.isFinite(a) ? a : b;
const r4 = value => Math.round(value * 10000) / 10000;

export function parseAndValidateBars(raw, {intervalMs = INTERVAL_MS, nowMs = Date.now()} = {}) {
  if (!Array.isArray(raw)) throw new Error('CANDLES_NOT_ARRAY');
  const converted = raw.map((row) => {
    if (Array.isArray(row)) {
      if (row.length < 7) throw new Error('CANDLE_TOO_SHORT');
      return {ts: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
        low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
        quoteVolume: Number(row[6])};
    }
    return {ts: Number(row?.ts), open: Number(row?.open), high: Number(row?.high),
      low: Number(row?.low), close: Number(row?.close), volume: Number(row?.volume),
      quoteVolume: Number(row?.quoteVolume)};
  });
  for (const bar of converted) {
    const nums = [bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume];
    if (!Number.isSafeInteger(bar.ts) || bar.ts <= 0 || bar.ts % intervalMs !== 0 ||
        bar.ts + intervalMs > nowMs || nums.some(v => !Number.isFinite(v)) ||
        bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0 ||
        bar.volume < 0 || bar.quoteVolume < 0 ||
        bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close, bar.high)) {
      throw new Error('CANDLE_INVALID_OHLC_OR_TIME');
    }
  }
  converted.sort((a, b) => a.ts - b.ts);
  for (let i=1; i<converted.length; i++) {
    if (converted[i].ts === converted[i-1].ts) throw new Error('CANDLE_DUPLICATE_TIMESTAMP');
    if (converted[i].ts !== converted[i-1].ts + intervalMs)
      throw new Error('CANDLE_GAP_AT_' + new Date(converted[i-1].ts).toISOString());
  }
  return converted;
}

/** Stable UTC-chronological expanding train/validation windows; last 20% sealed. */
export function chronologicalSplits(n, {embargoBars = 24} = {}) {
  if (!Number.isSafeInteger(n) || n < 1200) throw new Error('INSUFFICIENT_HISTORY_1200_BARS');
  if (!Number.isSafeInteger(embargoBars) || embargoBars < 1) throw new Error('EMBARGO_REQUIRED');
  const pct = f => Math.floor(n*f);
  const foldPoints = [[0.37, 0.47], [0.52, 0.62], [0.68, 0.80]];
  const folds = foldPoints.map(([trainStop, validStop], id) => ({
    id: id + 1,
    train: {start:WARMUP_BARS, end:pct(trainStop) - embargoBars},
    validation: {start:pct(trainStop) + embargoBars, end:pct(validStop) - embargoBars},
  }));
  const holdout = {start:pct(0.80) + embargoBars, end:n};
  if (folds.some(f => f.train.end-f.train.start < 100 ||
    f.validation.end-f.validation.start < 48 ||
    f.train.end + 2*embargoBars > f.validation.start) ||
    holdout.end - holdout.start < 100) throw new Error('CHRONOLOGICAL_SPLIT_TOO_SHORT');
  return {folds, holdout, embargoBars, warmupBars:WARMUP_BARS};
}

export function generateCandidates() {
  const result=[];
  const push=(family,params,stop,take)=>{
    const id = family + '-' + String(result.length+1).padStart(4,'0');
    result.push({id,family,params,stop,take});
  };
  for (const fast of [6,10,15,24]) for (const slow of [30,50,80])
    for (const minRsi of [46,54,60]) for (const stop of [.015,.025])
      for (const take of [.03,.06]) push('trend',{fast,slow,minRsi},stop,take);
  for (const length of [5,9,14]) for (const oversold of [20,30,40])
    for (const trendFilter of [false,true]) for (const stop of [.015,.025,.04])
      for (const take of [.02,.035]) push('reversion',{length,oversold,trendFilter},stop,take);
  for (const lookback of [12,24,48,72]) for (const volumeMultiple of [1,1.3,1.6])
    for (const stop of [.015,.025,.04]) for (const take of [.03,.06])
      push('breakout',{lookback,volumeMultiple},stop,take);
  for (const lookback of [3,6,12,24]) for (const threshold of [.006,.012,.02])
    for (const volumeMultiple of [.8,1.1]) for (const stop of [.015,.03])
      for (const take of [.03,.06]) push('momentum',{lookback,threshold,volumeMultiple},stop,take);
  return result;
}

function ema(values, length) {
  const out = new Float64Array(values.length).fill(Number.NaN);
  if (values.length < length) return out;
  let total=0;
  for (let i=0; i<length; i++) total+=values[i];
  let prev=total/length, alpha=2/(length+1);
  out[length-1]=prev;
  for (let i=length; i<values.length; i++) {
    prev=values[i]*alpha+prev*(1-alpha);
    out[i]=prev;
  }
  return out;
}
function rsi(values, length) {
  const out = new Float64Array(values.length).fill(Number.NaN);
  if (values.length <= length) return out;
  let gain=0, loss=0;
  for(let i=1;i<=length;i++){
    const d=values[i]-values[i-1];
    gain+=Math.max(0,d);loss+=Math.max(0,-d);
  }
  gain/=length; loss/=length;
  const val=()=>loss===0?(gain===0?50:100):100-100/(1+gain/loss);
  out[length]=val();
  for(let i=length+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    gain=(gain*(length-1)+Math.max(0,d))/length;
    loss=(loss*(length-1)+Math.max(0,-d))/length;
    out[i]=val();
  }
  return out;
}
function priorWindowMax(values,length) {
  const out=new Float64Array(values.length).fill(Number.NaN);
  const deque=[];
  for(let i=0;i<values.length;i++){
    const prev=i-1;
    if(prev>=0) {
      while(deque.length && values[deque.at(-1)]<=values[prev]) deque.pop();
      deque.push(prev);
    }
    while(deque.length && deque[0]<i-length) deque.shift();
    if(i>=length)out[i]=values[deque[0]];
  }
  return out;
}
function priorWindowAverage(values,length) {
  const out=new Float64Array(values.length).fill(Number.NaN);
  let total=0;
  for(let i=0;i<values.length;i++){
    if(i>0)total+=values[i-1];
    if(i>length)total-=values[i-length-1];
    if(i>=length)out[i]=total/length;
  }
  return out;
}

/** One-time technical indicator computation for all candidate configurations. */
export function prepareSeries(bars) {
  const n=bars.length;
  const close=Float64Array.from(bars,b=>b.close);
  const high=Float64Array.from(bars,b=>b.high);
  const volume=Float64Array.from(bars,b=>b.quoteVolume);
  return {
    length:n,
    ts:Float64Array.from(bars,b=>b.ts),
    open:Float64Array.from(bars,b=>b.open),
    high,low:Float64Array.from(bars,b=>b.low),close,quoteVolume:volume,
    ema:Object.fromEntries([6,10,15,24,30,50,80].map(len=>[len,ema(close,len)])),
    rsi:Object.fromEntries([5,9,14].map(len=>[len,rsi(close,len)])),
    priorHigh:Object.fromEntries([12,24,48,72].map(len=>[len,priorWindowMax(high,len)])),
    priorQuoteVolume20:priorWindowAverage(volume,20),
  };
}

export function isSignal(candidate,series,i) {
  const {close,rsi,ema,quoteVolume,priorQuoteVolume20,priorHigh}=series;
  if (i<WARMUP_BARS || !Number.isFinite(close[i]) || !Number.isFinite(rsi[14][i])) return false;
  const {family,params:p}=candidate;
  if(family==='trend')
    return ema[p.fast][i]>ema[p.slow][i] && close[i]>ema[p.fast][i] && rsi[14][i]>=p.minRsi;
  if(family==='reversion')
    return rsi[p.length][i]<=p.oversold && (!p.trendFilter || close[i]>=ema[80][i]*.94);
  if(family==='breakout')
    return close[i]>priorHigh[p.lookback][i] && rsi[14][i]>52 &&
      quoteVolume[i]>=p.volumeMultiple*priorQuoteVolume20[i];
  if(family==='momentum')
    return close[i]/close[i-p.lookback]-1>=p.threshold && close[i]>ema[50][i] &&
      quoteVolume[i]>=p.volumeMultiple*priorQuoteVolume20[i];
  throw new Error('CANDIDATE_FAMILY_INVALID');
}

/** Pure, reproducible spot-long per-symbol simulation of ONE candidate and ONE partition. */
export function simulateCandidate(candidate,series,range,options={}) {
  const signalFn=options.signalFn || isSignal;
  const a={...DEFAULT_ASSUMPTIONS,...options};
  if(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||
    range.start<WARMUP_BARS||range.end>series.length||range.end<=range.start)
    throw new Error('SIMULATION_RANGE_INVALID');
  if(a.feePerSide<0 || a.adverseSlippagePerSide<0 || a.assumedHalfSpreadPerSide<0 ||
    a.notionalUSD<=0 || !Number.isFinite(a.notionalUSD) ||
    !Number.isSafeInteger(a.maxHoldBars) || a.maxHoldBars<1 ||
    !Number.isSafeInteger(a.stopCooldownBars) || a.stopCooldownBars<0)
    throw new Error('SIMULATION_ASSUMPTIONS_INVALID');
  let position=null,pending=false,cooldownUntil=0,signals=0,skippedLiquidity=0;
  const events=[];
  const friction = a.adverseSlippagePerSide + a.assumedHalfSpreadPerSide;
  const closePosition=(i,rawPrice,reason)=>{
    const sell=rawPrice*(1-friction);
    const proceeds=position.qty*sell*(1-a.feePerSide);
    const pnl=proceeds-position.totalCost;
    if(!Number.isFinite(pnl))throw new Error('SIMULATED_PNL_NONFINITE');
    events.push({exitTs:series.ts[i],entryTs:series.ts[position.entryIndex],pnl,reason,
      entryIndex:position.entryIndex,exitIndex:i,holdBars:i-position.entryIndex,
      entryMid:position.entryMid,exitMid:rawPrice});
    if(reason.startsWith('STOP')) cooldownUntil=i+a.stopCooldownBars+1;
    position=null;
  };
  for(let i=range.start; i<range.end; i++){
    const open=series.open[i],low=series.low[i],high=series.high[i],close=series.close[i];
    if(pending && !position && i>=cooldownUntil){
      const entry= open*(1+friction);
      position={qty:a.notionalUSD/entry,entryMid:open,entryIndex:i,
        totalCost:a.notionalUSD*(1+a.feePerSide)};
    }
    pending=false;
    if(position){
      const stop=position.entryMid*(1-candidate.stop);
      const take=position.entryMid*(1+candidate.take);
      // Stop has priority if stop and take both appear within one OHLC bar.
      if(open<=stop)closePosition(i,open,'STOP_GAP');
      else if(low<=stop)closePosition(i,stop,'STOP');
      else if(high>=take)closePosition(i,take,'TAKE_PROFIT');
      else if(i-position.entryIndex>=a.maxHoldBars)closePosition(i,close,'TIME');
    }
    if(i===range.end-1){
      if(position)closePosition(i,close,'PARTITION_END');
      continue;
    }
    if(!position && i>=cooldownUntil && signalFn(candidate,series,i)){
      signals++;
      if(series.quoteVolume[i]>=a.minQuoteTurnoverPerBarUSD &&
        series.priorQuoteVolume20[i]>=a.minQuoteTurnoverPerBarUSD) pending=true;
      else skippedLiquidity++;
    }
  }
  return {events,signals,skippedLiquidity};
}

export function aggregateSimulations(parts,{initialCapitalUSD=1000}={}){
  const all=parts.flatMap(p=>p.events).sort((a,b)=>a.exitTs-b.exitTs||a.entryTs-b.entryTs);
  let realized=0,peak=0,drawdown=0,wins=0,grossProfit=0,grossLoss=0,maxLoss=0,lossStreak=0,maxLossStreak=0;
  for(const trade of all){
    realized+=trade.pnl;
    peak=Math.max(peak,realized);
    drawdown=Math.max(drawdown,peak-realized);
    if(trade.pnl>0){wins++;grossProfit+=trade.pnl;lossStreak=0;}
    else{grossLoss+=Math.abs(trade.pnl);lossStreak++;maxLossStreak=Math.max(maxLossStreak,lossStreak);}
    maxLoss=Math.min(maxLoss,trade.pnl);
  }
  const count=all.length;
  return {
    trades:count,wins,losses:count-wins,
    pnlUSD:r4(realized),returnPct:r4(realized/initialCapitalUSD*100),
    grossProfitUSD:r4(grossProfit),grossLossUSD:r4(grossLoss),
    winRatePct:count?r4(wins/count*100):null,
    profitFactor:grossLoss? r4(grossProfit/grossLoss) : null,
    expectancyUSD:count?r4(realized/count):null,
    maxDrawdownUSD:r4(drawdown),maxDrawdownPct:r4(drawdown/initialCapitalUSD*100),
    maxTradeLossUSD:r4(maxLoss),maxConsecutiveLosses:maxLossStreak,
    signals:parts.reduce((sum,p)=>sum+p.signals,0),
    skippedLiquidity:parts.reduce((sum,p)=>sum+p.skippedLiquidity,0),
    tradesByExitReason:Object.fromEntries([...new Set(all.map(t=>t.reason))].map(reason=>[reason,all.filter(t=>t.reason===reason).length])),
  };
}

function combineParts(parts,capital) {return aggregateSimulations(parts,{initialCapitalUSD:capital});}

/** Cross-asset 3-fold expanding walk-forward evaluation. Never reads sealed holdout. */
export function evaluateCandidate(candidate,preparedBySymbol,splits,options={}) {
  const symbols=Object.keys(preparedBySymbol).sort();
  const capital=options.initialCapitalUSD ?? DEFAULT_ASSUMPTIONS.initialCapitalUSD;
  const foldReports=splits.folds.map(f=>{
    const train=combineParts(symbols.map(sym=>simulateCandidate(candidate,preparedBySymbol[sym],f.train,options)),capital);
    const validation=combineParts(symbols.map(sym=>simulateCandidate(candidate,preparedBySymbol[sym],f.validation,options)),capital);
    return {fold:f.id,train,validation};
  });
  const lastTrain=foldReports.at(-1).train;
  const valid=foldReports.map(f=>f.validation);
  const validTrades=valid.reduce((a,v)=>a+v.trades,0);
  const validPnl=valid.reduce((a,v)=>a+v.pnlUSD,0);
  const worstFold=Math.min(...valid.map(v=>v.pnlUSD));
  const positiveFolds=valid.filter(v=>v.pnlUSD>0).length;
  const maxFoldDrawdown=Math.max(...valid.map(v=>v.maxDrawdownUSD));
  const totalGrossProfit=valid.reduce((sum,v)=>sum+v.grossProfitUSD,0);
  const totalGrossLoss=valid.reduce((sum,v)=>sum+v.grossLossUSD,0);
  const validationProfitFactor=totalGrossLoss>0?r4(totalGrossProfit/totalGrossLoss):null;
  // Conservative ranking; no claim of statistical significance.
  const score=r4(validPnl - maxFoldDrawdown*.45 + worstFold*.35);
  const eligible=lastTrain.trades>=12 && lastTrain.pnlUSD>0 &&
    lastTrain.profitFactor!==null && lastTrain.profitFactor>=1.1 &&
    validTrades>=15 && validPnl>0 && validationProfitFactor!==null &&
    validationProfitFactor>=1.2 && positiveFolds>=2 &&
    maxFoldDrawdown<=45 && valid.every(v=>v.trades>=2) &&
    valid.every(v=>v.pnlUSD>=-20);
  return {id:candidate.id,family:candidate.family,params:candidate.params,
    stop:candidate.stop,take:candidate.take,score,eligible,
    train:lastTrain,validation:{trades:validTrades,pnlUSD:r4(validPnl),
      returnPct:r4(validPnl/capital*100),positiveFolds,worstFoldPnlUSD:r4(worstFold),
      maxFoldDrawdownUSD:r4(maxFoldDrawdown),profitFactor:validationProfitFactor},
    foldReports};
}

export function sealedHoldout(candidate,preparedBySymbol,splits,options={}) {
  const cap=options.initialCapitalUSD??DEFAULT_ASSUMPTIONS.initialCapitalUSD;
  return aggregateSimulations(Object.keys(preparedBySymbol).sort().map(sym=>
    simulateCandidate(candidate,preparedBySymbol[sym],splits.holdout,options)),{initialCapitalUSD:cap});
}

export function rankCandidateResults(results){
  const sort=(a,b)=>b.score-a.score||a.id.localeCompare(b.id);
  const eligible=results.filter(r=>r.eligible).sort(sort);
  const top=[...results].sort(sort).slice(0,10);
  return {eligibleCount:eligible.length,selected:eligible[0]||null,top};
}
