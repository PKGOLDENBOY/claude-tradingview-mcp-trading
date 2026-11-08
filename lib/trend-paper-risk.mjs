/**
 * FROZEN candidate's proposed prospective PAPER risk sizing.
 * Pure function: cannot place, fill, cancel or authorise ANY exchange order.
 * This is not currently wired to a deployed forward paper runner.
 */
import {HYPOTHESIS} from './trend-pullback-hypothesis.mjs';
export const PAPER_RISK=Object.freeze({
  maxConcurrentPositions:2,
  maxSymbolNotionalPct:0.10,
  maxCombinedNotionalPct:0.20,
  maxNotionalPerPositionUSD:100,
  maxLossAtStopIncludingAssumedCostsPct:0.005,
  dailyHaltLossPct:0.02,
  portfolioHaltDrawdownPct:0.08,
  maxObservedBidAskSpreadPct:0.003,
  maxQuoteAgeMs:15000,
  minSimulatedNotionalUSD:10,
  noLeverage:true,
  allowRealOrders:false,
});
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const money=x=>finite(x)&&x>=0;
const roundDownCents=x=>Math.floor(x*100)/100;
/**
 * Fail-closed sizing only; never interprets stale/missing data as price 0.
 * Quote age/spread must be calculated at the observation time.
 */
export function sizeProspectivePaperEntry({equityUSD,dayStartEquityUSD,peakEquityUSD,
  currentOpenNotionalUSD,openPositionCount,symbolOpenNotionalUSD,
  quoteAgeMs,observedBidAskSpreadPct}={}) {
  const no=(reason)=>({allowed:false,reason,notionalUSD:0,estimatedStopLossUSD:0,
    liveOrderAuthorized:false});
  if(!finite(equityUSD)||equityUSD<=0||
    !finite(dayStartEquityUSD)||dayStartEquityUSD<=0||
    !finite(peakEquityUSD)||peakEquityUSD<equityUSD||
    !money(currentOpenNotionalUSD)||!Number.isSafeInteger(openPositionCount)||openPositionCount<0 ||
    !money(symbolOpenNotionalUSD)||!money(quoteAgeMs)||!money(observedBidAskSpreadPct))
    return no('RISK_INPUT_MISSING_OR_INVALID');
  if((dayStartEquityUSD-equityUSD)/dayStartEquityUSD>=PAPER_RISK.dailyHaltLossPct)
    return no('DAILY_LOSS_LIMIT');
  if((peakEquityUSD-equityUSD)/peakEquityUSD>=PAPER_RISK.portfolioHaltDrawdownPct)
    return no('PORTFOLIO_DRAWDOWN_LIMIT');
  if(quoteAgeMs>PAPER_RISK.maxQuoteAgeMs)return no('STALE_QUOTE');
  if(observedBidAskSpreadPct>PAPER_RISK.maxObservedBidAskSpreadPct)
    return no('WIDE_SPREAD');
  if(openPositionCount>=PAPER_RISK.maxConcurrentPositions)return no('POSITION_COUNT_LIMIT');
  if(symbolOpenNotionalUSD>0)return no('NO_POSITION_PYRAMIDING');
  const p=HYPOTHESIS.parameters,a=HYPOTHESIS.assumptions;
  const assumedRoundtripFriction=2*(a.feePerSide+a.adverseSlippagePerSide+a.assumedHalfSpreadPerSide);
  const expectedFullStopLossFraction=p.stopPct+assumedRoundtripFriction;
  const maxNewNotional=Math.min(PAPER_RISK.maxNotionalPerPositionUSD,
    equityUSD*PAPER_RISK.maxSymbolNotionalPct,
    equityUSD*PAPER_RISK.maxCombinedNotionalPct-currentOpenNotionalUSD,
    equityUSD*PAPER_RISK.maxLossAtStopIncludingAssumedCostsPct/expectedFullStopLossFraction);
  const notionalUSD=roundDownCents(maxNewNotional);
  if(notionalUSD<PAPER_RISK.minSimulatedNotionalUSD)return no('INSUFFICIENT_PAPER_RISK_BUDGET');
  return {allowed:true,reason:'SIMULATION_ONLY',notionalUSD,
    estimatedStopLossUSD:Math.round(notionalUSD*expectedFullStopLossFraction*10000)/10000,
    equityRiskBudgetUSD:Math.round(equityUSD*PAPER_RISK.maxLossAtStopIncludingAssumedCostsPct*10000)/10000,
    liveOrderAuthorized:false,
    warning:'Backtest stop losses can be exceeded in gaps; calculated budget is an estimate, not a guarantee.'};
}
