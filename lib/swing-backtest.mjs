import { paperEntry, paperExit } from "./risk-engine.mjs";

// Deterministic long-only swing research simulation. No network calls, no order placement.
// Entry signals use ONLY closed candle i and execute at next candle OPEN.
// Stops resolve before targets when the ordering inside a candle is unknowable.
export function simulateSwingTrades(candles, rsiThreshold, takeProfit, stopLoss, indicators,
  { feeFraction = 0.001, slippageFraction = 0.001, maxHoldBars = 48 } = {}) {
  if (!Array.isArray(candles) || candles.length < 35) return [];
  if (![rsiThreshold,takeProfit,stopLoss,maxHoldBars].every(Number.isFinite) ||
      rsiThreshold <= 0 || takeProfit <= 0 || stopLoss <= 0 || maxHoldBars < 1)
    throw new Error("Invalid swing-backtest parameters");
  const trades=[];
  let position=null;
  for(let i=30;i<candles.length;i++){
    const candle=candles[i];
    if(!candle || !Number.isFinite(candle.open) || !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) || !Number.isFinite(candle.close) ||
      candle.open<=0 || candle.low<=0) continue;
    if(position){
      if(i<position.entryBar)continue;
      const stop=position.buy.fillPrice*(1-stopLoss);
      const target=position.buy.fillPrice*(1+takeProfit);
      let px=null,why=null;
      if(candle.open<=stop){px=candle.open;why="GAP_STOP";}
      else if(candle.low<=stop){px=stop;why="STOP";}
      else if(candle.high>=target){px=target;why="TAKE_PROFIT";}
      else if(i-position.entryBar>=maxHoldBars){px=candle.close;why="TIME";}
      if(px!==null){
        const exit=paperExit({
          entryFillPrice:position.buy.fillPrice,exitMarketPrice:px,
          quantity:position.buy.quantity,entryFeeUsd:position.buy.entryFeeUsd,
          feeFraction,slippageFraction,
        });
        trades.push({ pct:exit.pnlPct,win:exit.pnlUsd>0,
          netPnlUsd:exit.pnlUsd,exitReason:why,holdingBars:i-position.entryBar+1 });
        position=null;
      }
      continue;
    }
    if(i+1>=candles.length)break;
    const rsi=indicators.rsi3[i],e8=indicators.ema8[i],e21=indicators.ema21[i],vwap=indicators.vwap[i];
    if(![rsi,e8,e21,vwap].every(Number.isFinite))continue;
    // Dip buy on a closed 4H candle, fill on the NEXT bar to avoid lookahead.
    if(candle.close<=vwap*1.01 && e8>e21 && rsi<rsiThreshold){
      const fillOpen=candles[i+1]?.open;
      if(!Number.isFinite(fillOpen)||fillOpen<=0)continue;
      const buy=paperEntry({marketPrice:fillOpen,notionalUsd:100,feeFraction,slippageFraction});
      position={buy,entryBar:i+1};
    }
  }
  // Leave incomplete open trades OUT of realized-win statistics.
  return trades;
}

export function swingTradeMetrics(trades) {
  const wins=trades.filter(t=>t.netPnlUsd>0);
  const losses=trades.filter(t=>t.netPnlUsd<0);
  const lossAbs=-losses.reduce((s,t)=>s+t.netPnlUsd,0);
  const winSum=wins.reduce((s,t)=>s+t.netPnlUsd,0);
  return {sample:trades.length,
    winRate:trades.length?wins.length/trades.length:0,
    expectancyPct:trades.length?trades.reduce((s,t)=>s+t.pct,0)/trades.length:0,
    profitFactor:lossAbs?winSum/lossAbs:(winSum>0?Infinity:0)};
}
