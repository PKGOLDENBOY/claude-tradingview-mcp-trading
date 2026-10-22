import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {planSpotSellQuantity,confirmSpotSellFill,confirmZeroFillCancellation} from "../lib/order-safety.mjs";
const src=readFileSync(new URL("../bot.js",import.meta.url),"utf8");

function slice(first,last) {
  const a=src.indexOf(first),b=src.indexOf(last,a+first.length);
  assert.ok(a>=0 && b>a,"missing live adapter marker");
  return src.slice(a,b);
}

function makeSpotSell({available=5,requested=2,precision=4,states=[{status:"filled",confirmedQty:2}],failPost=false}={}) {
  const calls=[],halts=[]; let stateIdx=0;
  const fetch=async (url,opts={})=>{
    calls.push({url,opts});
    if(failPost)throw new Error("connection interrupted");
    return {ok:true,json:async()=>({code:"00000",data:{orderId:"sell-id-123"}})};
  };
  const deps={
    requireExchangeWrites:()=>{},HARD_BLACKLIST:new Set(),
    CONFIG:{tradeMode:"spot"},
    getSpotBalance:async()=>available,getQuantityPrecision:async()=>precision,
    getBitGetServerTime:async()=>String(Date.now()),signBitGet:()=>"fake_signature",
    acct:()=>({baseUrl:"https://mock.invalid",apiKey:"x",passphrase:"y"}),
    AbortSignal, fetch,
    planSpotSellQuantity,confirmSpotSellFill,confirmZeroFillCancellation,
    setTimeout:f=>f(),
    readSpotOrderInfo:async()=>{
      const state=states[Math.min(stateIdx,states.length-1)];
      stateIdx++;
      if(state instanceof Error) throw state;
      return state;
    },
    haltOnUnconfirmedSell:obj=>halts.push(obj),
    haltOnUnconfirmedOrder:obj=>halts.push(obj),
  };
  const adapter=slice("async function placeBitGetOrder(symbol, side, sizeUSD, price, quantityOverride = null) {","// ─── Tax CSV Logging");
  const build=new Function("deps",
    "const {requireExchangeWrites,HARD_BLACKLIST,CONFIG,getSpotBalance,getQuantityPrecision,getBitGetServerTime,signBitGet,acct,AbortSignal,fetch,planSpotSellQuantity,confirmSpotSellFill,confirmZeroFillCancellation,setTimeout,readSpotOrderInfo,haltOnUnconfirmedSell,haltOnUnconfirmedOrder}=deps;\n"
    +adapter+"\nreturn placeBitGetOrder;");
  const place=build(deps);
  return {run:()=>place("ETHUSDT","sell",null,100,requested),calls,halts};
}

test("actual BitGet market sell POST honors requested partial size",async()=>{
  const a=makeSpotSell();const result=await a.run();
  assert.equal(result.confirmedQty,2);
  assert.equal(a.calls.length,1);
  const body=JSON.parse(a.calls[0].opts.body);
  assert.equal(body.side,"sell");assert.equal(body.size,"2.0000");
  assert.equal(a.halts.length,0);
});

test("actual BitGet market sell cannot oversell another strategy's balance",async()=>{
  const a=makeSpotSell({requested:6});
  await assert.rejects(a.run(),/exceeds available/);
  assert.equal(a.calls.length,0);assert.equal(a.halts.length,0);
});

test("actual BitGet market sell refuses missing and dust quantities",async()=>{
  const a=makeSpotSell({requested:null});
  await assert.rejects(a.run(),/Explicit spot sell quantity/);
  assert.equal(a.calls.length,0);
  const b=makeSpotSell({requested:0.00000001});
  await assert.rejects(b.run(),/below exchange quantity precision/);
  assert.equal(b.calls.length,0);
});

test("partial sell fill freezes entries and is NEVER reported as a full exit",async()=>{
  const a=makeSpotSell({states:[{status:"filled",confirmedQty:1}]});
  await assert.rejects(a.run(),/confirmed only/);
  assert.equal(a.calls.length,1);
  assert.equal(a.halts.length,1);
  assert.equal(a.halts[0].orderId,"sell-id-123");
  assert.equal(a.halts[0].requestedQty,2);
});

test("ambiguous sell network failure freezes and records uncertain order",async()=>{
  const a=makeSpotSell({failPost:true});
  await assert.rejects(a.run(),/connection interrupted/);
  assert.equal(a.calls.length,1);
  assert.equal(a.halts.length,1);
});

function makeCancel({responseCode="00000",states=[{status:"cancelled",confirmedQty:0}],failFetch=false}={}) {
  const halts=[],calls=[];let stateIdx=0;
  const deps={
    requireExchangeWrites:()=>{},AbortSignal,
    setTimeout:resolve=>resolve(),
    signBitGet:()=>"fake_sig",
    acct:()=>({baseUrl:"https://mock.invalid",apiKey:"x",passphrase:"y"}),
    readSpotOrderInfo:async()=>states[Math.min(stateIdx++,states.length-1)],
    confirmZeroFillCancellation,
    haltOnUnconfirmedSell:obj=>halts.push(obj),
    fetch:async (url,options)=>{
      calls.push({url,options});
      if(failFetch)throw new Error("timeout after cancel");
      return {ok:true,json:async()=>({code:responseCode})};
    },
  };
  const build=new Function("deps",
    "const {requireExchangeWrites,AbortSignal,setTimeout,signBitGet,acct,readSpotOrderInfo,confirmZeroFillCancellation,haltOnUnconfirmedSell,fetch}=deps;\n"+
    slice("async function cancelOrder(symbol, orderId) {","async function cancelAllSymbolOrders(symbol) {")+
    "\nreturn cancelOrder;");
  return {run:()=>build(deps)("ETHUSDT","tp123"),calls,halts};
}

test("cancelOrder requires exchange-confirmed zero-fill cancellation",async()=>{
  const a=makeCancel();
  assert.equal(await a.run(),true);assert.equal(a.halts.length,0);
});

test("partially filled take-profit cannot silently be cancelled and oversold",async()=>{
  const a=makeCancel({states:[{status:"cancelled",confirmedQty:0.7}]});
  await assert.rejects(a.run(),/filled quantity/);
  assert.equal(a.halts.length,1);
});

test("cancel POST network failure halts new entries rather than assuming cancellation",async()=>{
  const a=makeCancel({failFetch:true});
  await assert.rejects(a.run(),/timeout after cancel/);
  assert.equal(a.halts.length,1);
});
