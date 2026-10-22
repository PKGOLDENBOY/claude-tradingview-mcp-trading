import test from "node:test";
import assert from "node:assert/strict";
import {
  safePositionNotional,paperEntry,paperExit,paperPortfolioValuation
} from "../lib/risk-engine.mjs";
import {
  planSpotSellQuantity,confirmSpotSellFill,confirmZeroFillCancellation
} from "../lib/order-safety.mjs";
import {
  buyVirtual,sellVirtual,manageLongterm,makeState,snapshot,CONFIG_LT
} from "../lib/longterm-shadow-engine.mjs";
import {balancedAdaptiveLongtermPolicy} from "../lib/longterm-adaptive-policy.mjs";
let seed=0x62A11;
const random=()=>{
  seed|=0;seed=seed+0x6D2B79F5|0;
  let t=Math.imul(seed^seed>>>15,1|seed);
  t=t+Math.imul(t^t>>>7,61|t)^t;
  return ((t^t>>>14)>>>0)/4294967296;
};
const between=(lo,hi)=>lo+(hi-lo)*random();
const approx=(a,b,tol=1e-6)=>Math.abs(a-b)<=tol;

test("10000 randomized risk-sized entries never exceed absolute, fraction or 1% stopped-loss caps",()=>{
  for(let k=0;k<10000;k++){
    const equity=between(0.1,100000),stop=between(.001,.25),frac=between(.02,.75);
    const fee=between(0,.005),slip=between(0,.02),risk=between(.002,.05);
    const absolute=between(5,5000),min=between(0,10);
    const size=safePositionNotional({
      portfolioUsd:equity,stopFraction:stop,
      absoluteLimitUsd:absolute,fractionLimit:frac,riskFraction:risk,
      feeFraction:fee,slippageFraction:slip,minSizeUsd:min,
    });
    assert.ok(Number.isFinite(size)&&size>=0,"finite nonnegative notional");
    assert.ok(size<=absolute+1e-9,"absolute USDT cap");
    assert.ok(size<=equity*frac+1e-9,"fraction cap");
    assert.ok(size*(stop+2*fee+2*slip)<=equity*risk+1e-8,"stopped-loss risk cap");
    if(size>0)assert.ok(size+1e-9>=min,"minimum tradable size");
  }
});
test("10000 flat-price synthetic round-trips always lose fees/slippage, never report imaginary profit",()=>{
  for(let k=0;k<10000;k++){
    const market=10**between(-6,6),notional=10**between(-1,4);
    const fee=between(.0001,.01),slip=between(.0001,.03);
    const buy=paperEntry({marketPrice:market,notionalUsd:notional,feeFraction:fee,slippageFraction:slip});
    const sell=paperExit({
      entryFillPrice:buy.fillPrice,exitMarketPrice:market,quantity:buy.quantity,
      entryFeeUsd:buy.entryFeeUsd,feeFraction:fee,slippageFraction:slip,
    });
    assert.ok(sell.pnlUsd<0,JSON.stringify({market,notional,fee,slip,sell}));
    assert.ok(sell.exitProceedsUsd<notional);
    assert.ok(approx(sell.pnlUsd,sell.exitProceedsUsd-(notional+notional*fee),notional*1e-8+1e-9));
  }
});
test("10000 randomized sell requests never oversell and precision plans match fills",()=>{
  for(let k=0;k<10000;k++){
    const precision=Math.floor(between(0,13));
    const available=between(.5,500);
    const requested=available*between(.02,.999);
    const unit=10**precision;
    if(Math.floor(requested*unit+1e-7)<=0) {
      assert.throws(()=>planSpotSellQuantity({available,requested,precision}),
        /below exchange quantity precision/);
      continue;
    }
    const a=planSpotSellQuantity({available,requested,precision});
    assert.ok(a.quantity>=0,"non-negative");
    assert.ok(a.quantity<=available+1/unit*0.501,"must not oversell balance");
    assert.ok(a.quantity<=requested+1/unit*0.501,"must not exceed partial order");
    assert.ok(confirmSpotSellFill({
      status:"filled",confirmedQty:a.quantity,requestedQty:a.quantity,precision
    }));
    assert.equal(confirmZeroFillCancellation({status:"cancelled",confirmedQty:a.quantity}),false);
    if(precision<6)assert.equal(Number(a.size).toFixed(precision),a.size);
  }
});
test("ten thousand price ticks preserve LT virtual ledger: cash + marks = final closed PnL",()=>{
  const started=Date.UTC(2026,0,1),state=makeState(started,365);
  const symbols=Array.from({length:12},(_,i)=>"COIN"+i+"USDT");
  const marks=Object.fromEntries(symbols.map((sym,i)=>[sym,(i+1)*10]));
  let t=started;
  for(let k=0;k<10000;k++){
    t+=5*60*1000;
    for(const sym of symbols){
      marks[sym]*=between(.98,1.02);
      const existing=state.positions[sym];
      if(!existing?.open&&random()>.96)
        buyVirtual(state,sym,marks[sym],CONFIG_LT.t1USD,t);
    }
    manageLongterm(state,marks,t,random()>.5);
    const snap=snapshot(state,marks);
    assert.ok(Number.isFinite(snap.markToMarketUSD)&&snap.markToMarketUSD>0);
    assert.ok(Number.isFinite(snap.realizedPnlUSD));
    assert.ok(Number.isFinite(state.cashUsd)&&state.cashUsd>=CONFIG_LT.cashReserveUSD-1e-7);
    assert.ok(snap.unpriced===0);
    for(const p of Object.values(state.positions)){
      assert.ok(Number.isFinite(p.remainingQty)&&p.remainingQty>=0);
      if(p.open)assert.ok(p.remainingQty>0);
      else assert.ok(p.remainingQty===0);
    }
  }
  for(const [sym,p] of Object.entries(state.positions))
    if(p.open)sellVirtual(state,sym,marks[sym],p.remainingQty,"END_OF_STRESS",t);
  const final=snapshot(state,{});
  assert.equal(final.openPositions,0);
  assert.equal(final.unpriced,0);
  assert.ok(approx(final.combinedSimulatedPnlUSD,final.realizedPnlUSD,0.000003),
    JSON.stringify(final));
  assert.ok(approx(final.cashUSD,final.initialUSD+final.realizedPnlUSD,0.000003));
  console.log("LT_STRESS_10000_TICKS",JSON.stringify({
    virtualBuys:final.simulatedBuys,virtualSells:final.simulatedSells,
    fullyClosed:final.completeExits,pnlUSD:final.combinedSimulatedPnlUSD,
    endingUSD:final.markToMarketUSD,
  }));
});
test("random market regime vectors never trade in unknown, bear, fear or 6% drawdown",()=>{
  const regimes=["TRENDING","RANGING","BEAR","VOLATILE","UNKNOWN"];
  for(let k=0;k<10000;k++){
    const regime=regimes[Math.floor(random()*regimes.length)];
    const trend=random()>.5?"bull":"bear",fearGreed=between(0,100);
    const drawdownPct=between(-15,0),volatilityRatio=between(.2,3.5);
    const p=balancedAdaptiveLongtermPolicy({regime,trend,fearGreed,drawdownPct,volatilityRatio});
    assert.ok(p.allocationMultiplier>=0&&p.allocationMultiplier<=1);
    if(!["TRENDING","VOLATILE"].includes(regime)||trend==="bear"||fearGreed<=25||drawdownPct<=-6)
      assert.equal(p.allowEntry,false,JSON.stringify({regime,trend,fearGreed,drawdownPct,volatilityRatio,p}));
    if(!p.allowEntry){assert.equal(p.allowDca,false);assert.equal(p.allocationMultiplier,0)}
  }
});
