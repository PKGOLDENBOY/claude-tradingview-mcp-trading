/** Read-only shadow execution safeguards. Pure functions, no exchange access. */
export const MAX_SPREAD_BPS = 50;
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
