import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {adaptiveLongtermPolicy, balancedAdaptiveLongtermPolicy} from "../lib/longterm-adaptive-policy.mjs";
import {makeState,buyVirtual,manageLongterm,CONFIG_LT,snapshot} from "../lib/longterm-shadow-engine.mjs";
const bull={regime:"TRENDING",trend:"bull",volatilityRatio:1.1,fearGreed:55,drawdownPct:0};
test("requires complete market regime and fear/greed data",()=>{
  for(const changes of [{fearGreed:null},{fearGreed:NaN},{volatilityRatio:undefined},{regime:"UNKNOWN"},{drawdownPct:NaN}]){
    const p=adaptiveLongtermPolicy({...bull,...changes});
    assert.equal(p.allowEntry,false);
    assert.equal(p.allowDca,false);
    assert.equal(p.allocationMultiplier,0);
  }
});
test("blocks bear, range, volatile regimes, extreme fear, overgreed and portfolio shock",()=>{
  const cases=[
    [{regime:"BEAR",trend:"bear"},"BEAR_MARKET"],
    [{regime:"RANGING",trend:"neutral"},"NO_CLEAR_TREND"],
    [{regime:"VOLATILE",volatilityRatio:2.0},"HIGH_VOLATILITY"],
    [{regime:"TRENDING",volatilityRatio:2.0},"HIGH_VOLATILITY"],
    [{fearGreed:25},"EXTREME_FEAR"],
    [{fearGreed:90},"UNCONFIRMED_TREND_OR_SENTIMENT"],
    [{drawdownPct:-6.1},"PORTFOLIO_DRAWDOWN_GUARD"],
  ];
  for(const [change,reason] of cases){
    const p=adaptiveLongtermPolicy({...bull,...change});
    assert.equal(p.allowEntry,false,JSON.stringify(change));
    assert.equal(p.allowDca,false,JSON.stringify(change));
    assert.equal(p.reason,reason,JSON.stringify(change));
  }
});
test("confirmed bullish market needs a stronger 8/11 entry score",()=>{
  const p=adaptiveLongtermPolicy(bull);
  assert.equal(p.allowEntry,true);
  assert.equal(p.allocationMultiplier,1);
  assert.equal(p.requiredScore,8);
  assert.equal(p.allowDca,true);
  assert.equal(p.reason,"CONFIRMED_BULL");
});
test("modest account drawdown halves virtual new position and blocks DCA",()=>{
  const p=adaptiveLongtermPolicy({...bull,drawdownPct:-4});
  assert.equal(p.allowEntry,true);
  assert.equal(p.allocationMultiplier,0.5);
  assert.equal(p.allowDca,false);
  const start=Date.UTC(2026,7,1),state=makeState(start,153);
  assert.equal(buyVirtual(state,"LINKUSDT",100,CONFIG_LT.t1USD*p.allocationMultiplier,start),true);
  const remaining=state.cashUsd;
  // Market price drops enough to trigger DCA, but it must stay off.
  manageLongterm(state,{LINKUSDT:90},start+6*3600000,!p.allowDca,CONFIG_LT.t2USD*p.allocationMultiplier);
  assert.equal(state.positions.LINKUSDT.t2Bought,false);
  assert.equal(state.cashUsd,remaining);
  assert.equal(snapshot(state,{LINKUSDT:90}).simulatedBuys,1);
});
test("read-only five-month market replay cannot make an authenticated exchange request",()=>{
  const source=readFileSync(new URL("../scripts/longterm-5m-backtest.mjs",import.meta.url),"utf8");
  assert.ok(source.includes('method:"GET"'));
  assert.ok(source.includes("NONPUBLIC_API_PATH_BLOCKED"));
  assert.ok(!/method:\s*["']POST["']/.test(source));
  assert.ok(!source.includes("/trade/place-order"));
  assert.ok(!source.includes('import "./bot.js"'));
  assert.ok(source.includes("LT_ADAPTIVE_POLICY"));
});

test("balanced: ordinary bull uses baseline entry threshold and full virtual allocation",()=>{
  const p=balancedAdaptiveLongtermPolicy(bull);
  assert.deepEqual(p,{
    allowEntry:true,allowDca:true,allocationMultiplier:1,requiredScore:6,
    reason:"TRENDING_BULL_NORMAL_RISK",
  });
});
test("balanced: weak sentiment or mild drawdown halves risk and blocks average-down",()=>{
  for(const item of [{fearGreed:33},{fearGreed:82},{drawdownPct:-3.1}]){
    const p=balancedAdaptiveLongtermPolicy({...bull,...item});
    assert.equal(p.allowEntry,true);
    assert.equal(p.allowDca,false);
    assert.equal(p.allocationMultiplier,0.5);
    assert.equal(p.requiredScore,7);
  }
});
test("balanced: volatile bull only takes stronger signals with reduced size",()=>{
  const p=balancedAdaptiveLongtermPolicy({...bull,regime:"VOLATILE",volatilityRatio:2.1});
  assert.deepEqual(p,{
    allowEntry:true,allowDca:false,allocationMultiplier:0.5,requiredScore:8,
    reason:"VOLATILE_BULL_SMALL_RISK",
  });
  assert.equal(balancedAdaptiveLongtermPolicy({...bull,regime:"VOLATILE",trend:"bear",volatilityRatio:2.1}).allowEntry,false);
});
test("balanced: bear, range, extreme fear, incomplete feed or big drawdown block ALL new positions",()=>{
  for(const p of [
    {regime:"BEAR",trend:"bear"},{regime:"RANGING",trend:"neutral"},
    {fearGreed:20},{drawdownPct:-6.01},{volatilityRatio:NaN},{fearGreed:null},
  ]){
    const decision=balancedAdaptiveLongtermPolicy({...bull,...p});
    assert.equal(decision.allowEntry,false,JSON.stringify(p));
    assert.equal(decision.allowDca,false,JSON.stringify(p));
    assert.equal(decision.allocationMultiplier,0,JSON.stringify(p));
  }
});
