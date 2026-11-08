/** Frozen ML-068 decision engine for PUBLIC read-only prospective PAPER research. */
import {createHash} from 'node:crypto';
import {prepareSeries} from './accelerator-core.mjs';
import {mlFeatures,predictLogistic,mlConfigurations} from './accelerator-ml.mjs';
export const NO_ORDER_MODE='PUBLIC_QUOTES_SYNTHETIC_PAPER_NO_ORDERS';
const sha=value=>createHash('sha256').update(value).digest('hex');
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const nonnegative=n=>finite(n)&&n>=0;
const positive=n=>finite(n)&&n>0;
export const PAPER_LIMITS=Object.freeze({initialEquityUSD:1000,
  maxOpenPositions:2,maxAssetNotionalPct:0.10,maxGrossNotionalPct:0.20,
  riskAtStopIncludingCostsPct:0.005,dailyRealizedHaltPct:0.02,
  accountRealizedDrawdownHaltPct:0.08,maxSpreadPct:0.003,
  maxQuoteAgeMs:15000,minNotionalUSD:10,
  maxObservedGapMinutes:10,allowMargin:false,allowShort:false,allowRealOrders:false});

export function verifyFrozenArtifact(artifact){
  if(!artifact||artifact.schemaVersion!==1 || artifact.mode!=='PUBLIC_MARKET_RESEARCH_NO_ORDERS' ||
    artifact.candidateId!=='ml-068' || artifact.candidate?.id!=='ml-068' ||
    !/^[0-9a-f]{64}$/.test(artifact.manifestSha256||'') ||
    !/^[0-9a-f]{64}$/.test(artifact.modelSha256||'') ||
    artifact.independentOosPassed!==false || artifact.liveMoneyReady!==false)
    throw new Error('FROZEN_ARTIFACT_INVALID');
  const {manifestSha256,...payload}=artifact;
  if(sha(JSON.stringify(payload))!==manifestSha256 ||
    sha(JSON.stringify(artifact.model))!==artifact.modelSha256)
    throw new Error('FROZEN_ARTIFACT_CHECKSUM_MISMATCH');
  const selected=mlConfigurations().find(c=>c.id==='ml-068');
  if(JSON.stringify(selected)!==JSON.stringify(artifact.candidate) ||
    !Array.isArray(artifact.universe)||artifact.universe.length!==5 ||
    JSON.stringify(artifact.universe)!==JSON.stringify(['BTCUSDT','ETHUSDT','SOLUSDT','LINKUSDT','ADAUSDT']) ||
    !Number.isFinite(Date.parse(artifact.activationNotBefore)) ||
    Date.parse(artifact.activationNotBefore)<=Date.parse(artifact.frozenAsOf) ||
    !Number.isFinite(Date.parse(artifact.frozenAsOf)) ||
    artifact.model?.featureNames?.length!==9 ||
    artifact.model?.weights?.length!==9)
    throw new Error('FROZEN_ARTIFACT_CONFIG_MISMATCH');
  return artifact;
}

/** Score a signal at an already CLOSED 1H candle; never touches future features. */
export function scoreFrozenML(artifact,bars,{symbol,observedAt}={}){
  verifyFrozenArtifact(artifact);
  const now=Date.parse(observedAt||'');
  if(!artifact.universe.includes(symbol)||!Number.isFinite(now)||!Array.isArray(bars)||bars.length<500)
    throw new Error('FORWARD_SIGNAL_INPUT_INVALID');
  for(let i=0;i<bars.length;i++){
    const b=bars[i],ts=b?.ts;
    if(!Number.isSafeInteger(ts)||ts<=0||ts%3600000!==0||
       ts+3600000>now||!positive(b.open)||!positive(b.close)||
       !positive(b.high)||!positive(b.low)||!nonnegative(b.quoteVolume)||
       b.high<Math.max(b.open,b.low,b.close)||b.low>Math.min(b.open,b.high,b.close)||
       (i>0 && ts!==bars[i-1].ts+3600000))
      throw new Error('FORWARD_CANDLE_DATA_INVALID');
  }
  const newest=bars.at(-1),barCloseAt=new Date(newest.ts+3600000).toISOString();
  if(Date.parse(barCloseAt)<=Date.parse(artifact.activationNotBefore))
    return {candidateId:artifact.candidateId,symbol,barCloseAt,
      probability:null,threshold:artifact.candidate.params.threshold,
      signal:false,reason:'BEFORE_FROZEN_ACTIVATION',liveOrderAuthorized:false};
  const series=prepareSeries(bars);
  const x=mlFeatures(series,bars.length-1);
  const confidence=x?predictLogistic(artifact.model,x):null;
  const signal=finite(confidence)&&confidence>=artifact.candidate.params.threshold;
  return {candidateId:artifact.candidateId,symbol,barCloseAt,
    probability:confidence,threshold:artifact.candidate.params.threshold,
    signal,reason:signal?'FROZEN_ML_SIGNAL':'NO_FROZEN_ML_SIGNAL',
    liveOrderAuthorized:false};
}

/** Conservative PAPER-only sizing, evaluated against current synthetic portfolio. */
export function sizeFrozenPaper({equityUSD,dayStartEquityUSD,peakEquityUSD,
  openNotionalUSD,openPositions,hasSymbolPosition,askUSD,bidUSD,
  quoteAgeMs}={},artifact){
  verifyFrozenArtifact(artifact);
  const no=reason=>({allowed:false,reason,notionalUSD:0,liveOrderAuthorized:false});
  if(!positive(equityUSD)||!positive(dayStartEquityUSD)||!positive(peakEquityUSD)||
    peakEquityUSD<equityUSD||!nonnegative(openNotionalUSD)||
    !Number.isSafeInteger(openPositions)||openPositions<0||
    typeof hasSymbolPosition!=='boolean'||!positive(askUSD)||!positive(bidUSD)||
    askUSD<bidUSD||!nonnegative(quoteAgeMs))return no('INVALID_PAPER_RISK_INPUT');
  if((dayStartEquityUSD-equityUSD)/dayStartEquityUSD>=PAPER_LIMITS.dailyRealizedHaltPct)
    return no('DAILY_HALT');
  if((peakEquityUSD-equityUSD)/peakEquityUSD>=PAPER_LIMITS.accountRealizedDrawdownHaltPct)
    return no('DRAWDOWN_HALT');
  if((askUSD-bidUSD)/((askUSD+bidUSD)/2)>PAPER_LIMITS.maxSpreadPct)
    return no('SPREAD_TOO_WIDE');
  if(quoteAgeMs>PAPER_LIMITS.maxQuoteAgeMs)return no('STALE_MARKET_QUOTE');
  if(openPositions>=PAPER_LIMITS.maxOpenPositions)return no('MAX_PAPER_POSITIONS');
  if(hasSymbolPosition)return no('PYRAMIDING_NOT_ALLOWED');
  const a=artifact.assumptions;
  const stopRiskFraction=artifact.candidate.stop+
    2*(a.feePerSide+a.adverseSlippagePerSide+a.assumedHalfSpreadPerSide);
  const maxNotional=Math.min(a.notionalUSD,
    equityUSD*PAPER_LIMITS.maxAssetNotionalPct,
    equityUSD*PAPER_LIMITS.maxGrossNotionalPct-openNotionalUSD,
    equityUSD*PAPER_LIMITS.riskAtStopIncludingCostsPct/stopRiskFraction);
  const notionalUSD=Math.floor(maxNotional*100)/100;
  return notionalUSD>=PAPER_LIMITS.minNotionalUSD?
    {allowed:true,reason:'SYNTHETIC_ONLY',notionalUSD,
      estimatedStopLossUSD:Math.ceil(notionalUSD*stopRiskFraction*10000)/10000,
      liveOrderAuthorized:false}:
    no('INSUFFICIENT_RISK_BUDGET');
}
