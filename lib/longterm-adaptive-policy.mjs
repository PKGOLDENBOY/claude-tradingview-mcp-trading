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
