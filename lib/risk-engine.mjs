// Deterministic risk and simulation math; no network or order placement.
function numberAtLeast(v, floor = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= floor ? n : null;
}

export function safePositionNotional({
  portfolioUsd, stopFraction, absoluteLimitUsd = null,
  fractionLimit = 0.15, riskFraction = 0.01,
  feeFraction = 0.001, slippageFraction = 0.001,
  minSizeUsd = 1,
}) {
  const eq = numberAtLeast(portfolioUsd, 0);
  const stop = numberAtLeast(stopFraction, 0);
  const pct = numberAtLeast(fractionLimit, 0);
  const risk = numberAtLeast(riskFraction, 0);
  const fee = numberAtLeast(feeFraction, 0);
  const slip = numberAtLeast(slippageFraction, 0);
  if (!eq || !stop || pct === null || risk === null || fee === null || slip === null) return 0;
  if (pct === 0 || risk === 0) return 0;
  const configuredUsd = absoluteLimitUsd === null ? Infinity : numberAtLeast(absoluteLimitUsd);
  if (configuredUsd === null) return 0;
  // Include two-sided execution costs in maximum loss to avoid oversizing.
  const riskPerDollar = stop + 2 * fee + 2 * slip;
  const riskLimit = riskPerDollar > 0 ? (eq * risk) / riskPerDollar : 0;
  const amount = Math.min(eq * pct, configuredUsd, riskLimit);
  const rounded = Math.floor(amount * 100) / 100;
  return rounded >= minSizeUsd ? rounded : 0;
}

export function paperEntry({ marketPrice, notionalUsd, feeFraction = 0.001, slippageFraction = 0.001 }) {
  const price = numberAtLeast(marketPrice, 0), usd = numberAtLeast(notionalUsd, 0);
  const fee = numberAtLeast(feeFraction, 0), slip = numberAtLeast(slippageFraction, 0);
  if (!price || !usd || fee === null || slip === null) throw new Error("Invalid paper entry");
  const fillPrice = price * (1 + slip);
  const quantity = usd / fillPrice;
  const entryFeeUsd = usd * fee;
  return { marketPrice: price, fillPrice, quantity, entryFeeUsd, notionalUsd: usd };
}

export function paperExit({
  entryFillPrice, exitMarketPrice, quantity,
  entryFeeUsd = 0, feeFraction = 0.001, slippageFraction = 0.001,
}) {
  const entry = numberAtLeast(entryFillPrice, 0), exit = numberAtLeast(exitMarketPrice, 0);
  const qty = numberAtLeast(quantity, 0), buyFee = numberAtLeast(entryFeeUsd, 0);
  const fee = numberAtLeast(feeFraction, 0), slip = numberAtLeast(slippageFraction, 0);
  if (!entry || !exit || !qty || buyFee === null || fee === null || slip === null)
    throw new Error("Invalid paper exit");
  const exitFillPrice = exit * (1 - slip);
  const exitFeeUsd = exitFillPrice * qty * fee;
  const entryCostUsd = entry * qty + buyFee;
  const exitProceedsUsd = exitFillPrice * qty - exitFeeUsd;
  const pnlUsd = exitProceedsUsd - entryCostUsd;
  return {
    entryCostUsd, exitFillPrice, exitFeeUsd, exitProceedsUsd, pnlUsd,
    pnlPct: (pnlUsd / entryCostUsd) * 100,
    tradingCostsUsd: buyFee + exitFeeUsd + Math.max(0, (exit - exitFillPrice) * qty),
  };
}

// Intended for paper monitoring and signed P&L reports. Does NOT imply live trade approval.
export function paperStats(trades) {
  const completed = (Array.isArray(trades) ? trades : []).filter(t =>
    t?.type === "exit" && t?.paperTrading === true &&
    Number.isFinite(Number(t.pnlUSD)) && t.pnlUSD !== null);
  const wins = completed.filter(t => Number(t.pnlUSD) > 0);
  const losses = completed.filter(t => Number(t.pnlUSD) < 0);
  const sum = arr => arr.reduce((a,t) => a + Number(t.pnlUSD), 0);
  const grossWins = sum(wins), grossLossAbs = -sum(losses);
  return {
    sample: completed.length,
    wins: wins.length, losses: losses.length,
    winRatePct: completed.length ? 100 * wins.length / completed.length : null,
    realizedPnlUsd: sum(completed),
    profitFactor: grossLossAbs ? grossWins / grossLossAbs : null,
    basis: "paper-exits-only; fees included only for fills marked feeAdjusted",
    feeAdjustedExits: completed.filter(t => t.feeAdjusted === true).length,
  };
}


// Paper-only mark-to-market balance: cost basis is removed from virtual cash, and
// remaining holdings are valued at estimated liquidation proceeds (after fees/slippage).
// This avoids the previous dashboard bug of adding positions to full starting equity.
export function paperPortfolioValuation(log, snapshots = {}, options = {}) {
  const realizedEquityUsd=numberAtLeast(log?.portfolioValue,0);
  if(realizedEquityUsd===null)throw new Error("Cannot price invalid paper ledger equity");
  const feeFraction=options.feeFraction ?? 0.001;
  const slippageFraction=options.slippageFraction ?? 0.001;
  const collections=[["scalp","positions"],["swing","swingPositions"],["breakout","breakoutPositions"],
    ["sniper","sniperPositions"],["lt","ltPositions"]];
  let costBasis=0,estimatedProceeds=0,openProfit=0,staleQuotes=0;
  const positions=[];
  for(const [strategy,key] of collections){
    for(const [symbol,pos] of Object.entries(log?.[key] || {})){
      if(!pos?.open)continue;
      const quantity=Number(pos.quantity||0);
      const entryPrice=Number(pos.entryPrice || pos.avgEntry || 0);
      if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(entryPrice)||entryPrice<=0)
        throw new Error("Invalid open paper position: "+symbol+" "+strategy);
      const snap=snapshots[symbol];
      const quote=Number(snap?.price);
      const hasPrice=Number.isFinite(quote)&&quote>0;
      const age=Number.isFinite(Date.parse(snap?.updatedAt || "")) ? Date.now()-Date.parse(snap.updatedAt) : Infinity;
      const stale=!hasPrice||age>15*60000;
      if(stale)staleQuotes++;
      const price=hasPrice?quote:entryPrice;
      const entryFeeUsd=Number(pos.entryFeeUsd||0);
      const estimate=paperExit({
        entryFillPrice:entryPrice,exitMarketPrice:price,quantity,entryFeeUsd,
        feeFraction,slippageFraction
      });
      const spent=entryPrice*quantity+entryFeeUsd;
      costBasis+=spent;
      estimatedProceeds+=estimate.exitProceedsUsd;
      openProfit+=estimate.pnlUsd;
      positions.push({symbol,coin:symbol.replace(/USDT$/,""),sym:symbol,
        entryType:strategy,qty:quantity,entryPrice,price,
        usdVal:price*quantity,pnlUSD:estimate.pnlUsd,pnlPct:estimate.pnlPct,
        markIsStale:stale,feeAdjusted:true,entryFeeUsd,
        tpPct:pos.tpPct??null,slPct:pos.slPct??null});
    }
  }
  const cashUsd=realizedEquityUsd-costBasis;
  return {
    mode:"PAPER",realizedEquityUsd,cashUsd,openLiquidationValueUsd:estimatedProceeds,
    equityUsd:cashUsd+estimatedProceeds,unrealizedPnlUSD:openProfit,
    realizedAndUnrealizedPnlUSD:(cashUsd+estimatedProceeds)-(Number(options.startingEquityUsd??realizedEquityUsd)),
    staleQuotes,overAllocated:cashUsd<0,positions,
    valuationIsEstimated:true,exchangeVerified:false,
    estimateMethod:"Bid/ask slippage 0.10% and fee 0.10% per side; excludes funding and taxes",
  };
}
