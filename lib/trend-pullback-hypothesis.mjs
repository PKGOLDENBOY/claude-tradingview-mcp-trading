/**
 * Predeclared, unoptimised SPOT LONG-ONLY trend/pullback hypothesis.
 * Offline research only; NO live orders, keys, or historical holdout access.
 * Signal at CLOSED 1H bar i; simulator enters at i+1 open.
 */
import {DEFAULT_ASSUMPTIONS,simulateCandidate,aggregateSimulations} from './accelerator-core.mjs';
export const HYPOTHESIS=Object.freeze({
  id:'trend-pullback-v1',version:1,
  universe:Object.freeze(['BTCUSDT','ETHUSDT','SOLUSDT','LINKUSDT','ADAUSDT']),
  timeframe:'1H',side:'SPOT_LONG_ONLY',
  minBars:110,
  parameters:Object.freeze({fastEma:24,slowEma:80,rsiLength:14,
    rsiMin:46,rsiMax:62,previousRsiMax:46,minimumTrendSlopeBars:6,
    minimumVolumeRatio:0.8,maximumBarRangePct:0.035,
    stopPct:0.025,takePct:0.05,maxHoldBars:48,cooldownBars:12}),
  assumptions:Object.freeze({...DEFAULT_ASSUMPTIONS,maxHoldBars:48,stopCooldownBars:12,
    minQuoteTurnoverPerBarUSD:50000}),
  promotion:'RESEARCH_ONLY_UNVALIDATED',
});

export function trendPullbackSignal(series,i){
  if(!series || !Number.isSafeInteger(i)||i<HYPOTHESIS.minBars || i>=series.length)return false;
  const p=HYPOTHESIS.parameters;
  const close=series.close?.[i],fast=series.ema?.[24]?.[i],slow=series.ema?.[80]?.[i];
  const oldSlow=series.ema?.[80]?.[i-p.minimumTrendSlopeBars];
  const rsi=series.rsi?.[14]?.[i],priorRsi=series.rsi?.[14]?.[i-1];
  const priorVolume=series.priorQuoteVolume20?.[i];
  const vol=series.quoteVolume?.[i];
  const high=series.high?.[i],low=series.low?.[i];
  const inputs=[close,fast,slow,oldSlow,rsi,priorRsi,priorVolume,vol,high,low];
  if(inputs.some(x=>!Number.isFinite(x))||close<=0||priorVolume<=0)return false;
  // Trend + prior oversold/pullback recovery, avoid chasing vertical bars.
  return fast>slow && slow>oldSlow && close>fast &&
    priorRsi<=p.previousRsiMax && rsi>=p.rsiMin && rsi<=p.rsiMax &&
    vol>=p.minimumVolumeRatio*priorVolume &&
    (high-low)/close<=p.maximumBarRangePct;
}

/** Never touch the previously consumed 29 Oct frozen holdout. */
export function evaluatePredeclaredTrend(prepared,splits) {
  if(!splits || !Array.isArray(splits.folds) || splits.folds.length!==3)
    throw new Error('REQUIRES_THREE_WALK_FORWARD_FOLDS');
  const candidate={id:HYPOTHESIS.id,family:'predeclared-trend-pullback',
    stop:HYPOTHESIS.parameters.stopPct,take:HYPOTHESIS.parameters.takePct};
  const config={...HYPOTHESIS.assumptions,signalFn:(_,s,i)=>trendPullbackSignal(s,i)};
  const symbols=Object.keys(prepared||{}).sort();
  if(symbols.length!==HYPOTHESIS.universe.length ||
     symbols.some(s=>!HYPOTHESIS.universe.includes(s)))
    throw new Error('RESEARCH_UNIVERSE_INVALID');
  const folds=splits.folds.map(f=>({fold:f.id,
    validation:aggregateSimulations(symbols.map(sym=>simulateCandidate(candidate,prepared[sym],f.validation,config)),
      {initialCapitalUSD:config.initialCapitalUSD})}));
  const trades=folds.reduce((n,f)=>n+f.validation.trades,0);
  const pnl=folds.reduce((n,f)=>n+f.validation.pnlUSD,0);
  const positiveFolds=folds.filter(f=>f.validation.pnlUSD>0).length;
  return {id:HYPOTHESIS.id,version:1,status:'RETROSPECTIVE_VALIDATION_ONLY',
    frozenParameters:HYPOTHESIS.parameters,assumptions:HYPOTHESIS.assumptions,
    validation:{trades,pnlUSD:Math.round(pnl*10000)/10000,positiveFolds,folds},
    independentOosVerified:false,forwardPaperRoundTripsVerified:0,
    liveMoneyReady:false,realOrdersAuthorized:false,
    warning:'No prior frozen holdout may be reopened. Positive validation is not a proven edge.'};
}
