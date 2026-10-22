/**
 * Read-only regime-aware long-term policy. Do NOT wire to live execution.
 * Requires completed BTC candles; unknown data means no new positions.
 */
export function adaptiveLongtermPolicy({regime,trend,volatilityRatio,fearGreed,drawdownPct=0}={}){
  const base={allowEntry:false,allocationMultiplier:0,requiredScore:8,allowDca:false,
    reason:"UNKNOWN_OR_INCOMPLETE_MARKET_DATA"};
  if(!Number.isFinite(fearGreed)||!Number.isFinite(volatilityRatio)||
     !Number.isFinite(drawdownPct)||!["TRENDING","VOLATILE","BEAR","RANGING"].includes(regime))
    return base;
  if(drawdownPct<=-6)return {...base,reason:"PORTFOLIO_DRAWDOWN_GUARD"};
  if(fearGreed<=25)return {...base,reason:"EXTREME_FEAR"};
  if(regime==="BEAR")return {...base,reason:"BEAR_MARKET"};
  if(regime==="RANGING")return {...base,reason:"NO_CLEAR_TREND"};
  if(regime==="VOLATILE"||volatilityRatio>=1.8)
    return {...base,reason:"HIGH_VOLATILITY"};
  if(regime==="TRENDING"&&trend==="bull"&&fearGreed>=45&&fearGreed<=80)
    return {allowEntry:true,allocationMultiplier:drawdownPct<=-3?0.5:1,
      requiredScore:8,allowDca:drawdownPct>-3,reason:"CONFIRMED_BULL"};
  return {...base,reason:"UNCONFIRMED_TREND_OR_SENTIMENT"};
}

/**
 * A less restrictive, risk-adjusting alternative to the pure defensive gate.
 * Baseline entry rules remain in place in ordinary bull markets. In less
 * certain environments, only virtual position size/score and DCA change.
 * Outputs instructions, never places any trade.
 */
export function balancedAdaptiveLongtermPolicy({
  regime,trend,volatilityRatio,fearGreed,drawdownPct=0
}={}){
  const blocked=(reason)=>({
    allowEntry:false,allowDca:false,allocationMultiplier:0,requiredScore:11,
    reason,
  });
  if(!Number.isFinite(fearGreed)||!Number.isFinite(volatilityRatio)||
     !Number.isFinite(drawdownPct)||!["TRENDING","VOLATILE","RANGING","BEAR"].includes(regime))
    return blocked("UNKNOWN_OR_INCOMPLETE_MARKET_DATA");
  if(drawdownPct<=-6)return blocked("PORTFOLIO_DRAWDOWN_GUARD");
  if(fearGreed<=25)return blocked("EXTREME_FEAR");
  if(regime==="BEAR"||trend==="bear")return blocked("BEAR_MARKET");
  if(regime==="RANGING")return blocked("NO_CLEAR_TREND");
  if(regime==="VOLATILE"||volatilityRatio>=1.8){
    if(trend!=="bull"||fearGreed<40)return blocked("UNSTABLE_HIGH_VOLATILITY");
    return {
      allowEntry:true,allowDca:false,allocationMultiplier:0.5,
      requiredScore:8,reason:"VOLATILE_BULL_SMALL_RISK",
    };
  }
  if(regime!=="TRENDING"||trend!=="bull")
    return blocked("UNCONFIRMED_TREND");
  const caution=fearGreed<40||fearGreed>75||drawdownPct<=-3;
  return {
    allowEntry:true,allowDca:!caution,allocationMultiplier:caution?0.5:1,
    requiredScore:caution?7:6,
    reason:caution?"TRENDING_BULL_REDUCED_RISK":"TRENDING_BULL_NORMAL_RISK",
  };
}
