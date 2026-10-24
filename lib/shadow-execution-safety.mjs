/** Read-only shadow execution safeguards. Pure functions, no exchange access. */
export const MAX_SPREAD_BPS = 30;
export const STOP_REENTRY_COOLDOWN_MS = 60 * 60 * 1000;
export function spreadBps(quote) {
  const bid=Number(quote?.bidPr),ask=Number(quote?.askPr);
  if(!Number.isFinite(bid)||!Number.isFinite(ask)||bid<=0||ask<=0||ask<bid)return null;
  return 10000*(ask-bid)/((ask+bid)/2);
}
export function entrySafety(quote,lastStopAt,now=Date.now()) {
  const spread=spreadBps(quote);
  if(spread===null)return {allowed:false,reason:"invalid-or-missing-bid-ask"};
  if(spread>MAX_SPREAD_BPS)return {allowed:false,reason:"spread-too-wide"};
  if(Number.isFinite(lastStopAt)&&now-lastStopAt<STOP_REENTRY_COOLDOWN_MS)
    return {allowed:false,reason:"post-stop-cooldown"};
  return {allowed:true,reason:"ok"};
}

/** Stop/take-profit must use net executable bid-side P&L rather than last price. */
export function exitThresholdReason(netPnlUSD,totalCost,limits) {
  if(!Number.isFinite(netPnlUSD)||!Number.isFinite(totalCost)||totalCost<=0 ||
     !Number.isFinite(limits?.stop)||limits.stop<=0 || !Number.isFinite(limits?.tp)||limits.tp<=0)
    return null;
  const returnRatio=netPnlUSD/totalCost;
  if(returnRatio<=-limits.stop)return "STOP";
  if(returnRatio>=limits.tp)return "TAKE_PROFIT";
  return null;
}
