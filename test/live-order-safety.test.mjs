import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

// Compile only the exchange-order adapter with controlled dependencies.
// No real exchange credentials and no network requests are used.
const source = readFileSync(new URL("../bot.js", import.meta.url), "utf8");
const begin = source.indexOf("async function readSpotOrderInfo(orderId)");
const end = source.indexOf("// ─── Resting TP helpers", begin);
assert.ok(begin > 0 && end > begin);
const adapterCode = source.slice(begin, end);
function mockExchange(states, overrides = {}) {
  const calls = [];
  const state = { trades: [] };
  let readIndex = 0;
  const fetcher = async (url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ url, method });
    if (overrides.failAtPlace && url.includes("/place-order"))
      throw new Error("connection dropped immediately after submission");
    if (url.includes("/public/symbols")) return {
      ok: true, json: async() => ({code:"00000",data:[{pricePrecision:"2",quantityPrecision:"4"}]})
    };
    if (url.includes("/place-order")) return {
      ok: true, json: async()=>({code:"00000",data:{orderId:"oid123"}})
    };
    if (url.includes("/orderInfo")) {
      if (overrides.failInfo) throw new Error("order-info network down");
      const entry = states[Math.min(readIndex++, states.length-1)];
      return { ok: true, json:async()=>({code:"00000",data:[{status:entry.status,baseVolume:String(entry.qty)}]}) };
    }
    if (url.includes("/cancel-order")) return {
      ok: !overrides.cancelFails,
      json:async()=>({code:overrides.cancelFails?"bad":"00000"})
    };
    throw new Error("Unexpected URL " + url);
  };
  const deps = {
    crypto, AbortSignal, fetch: fetcher, setTimeout: resolve=>resolve(),
    HARD_BLACKLIST: new Set(), entryCapReached: () => false,
    failsLiquidityFloor: async()=>false, requireExchangeWrites:()=>{},
    acct:()=>({baseUrl:"https://fake-bitget.invalid",apiKey:"x",passphrase:"x"}),
    signBitGet:()=> "signature-not-real", floorToDecimals:(a,n)=>Math.floor(a*10**n)/10**n,
    loadLog:()=>state, saveLog:(log)=>Object.assign(state,log),
  };
  const preamble = 'const {crypto,AbortSignal,fetch,setTimeout,HARD_BLACKLIST,entryCapReached,failsLiquidityFloor,requireExchangeWrites,acct,signBitGet,floorToDecimals,loadLog,saveLog}=deps;let _tradingPaused=false;\n';
  const build = new Function("deps", preamble + adapterCode +
    '\nreturn {placeLimitBuyWithFallback, readSpotOrderInfo, getPaused:()=>_tradingPaused};');
  return { ...build(deps), calls, state };
}

test("BitGet full limit fill is parsed from array and never creates a second market buy",async()=>{
  const a=mockExchange([{status:"filled",qty:0.1}]);
  const result=await a.placeLimitBuyWithFallback("BTCUSDT",10,100);
  assert.equal(result.orderId,"oid123");
  assert.equal(result.confirmedQty,0.1);
  assert.equal(a.calls.filter(x=>x.method==="POST").length,1);
  assert.equal(a.getPaused(),false);
});

test("verified cancelled AND zero fill is the sole safe market fallback",async()=>{
  const a=mockExchange([{status:"cancelled",qty:0}]);
  const result=await a.placeLimitBuyWithFallback("BTCUSDT",10,100);
  assert.equal(result,null);
  assert.equal(a.calls.filter(x=>x.method==="POST").length,1);
});

test("partially filled then cancelled returns actual filled qty, NOT a full-size fallback",async()=>{
  const a=mockExchange([
    ...Array(10).fill({status:"partially_filled",qty:0.03}),
    {status:"cancelled",qty:0.03},
  ]);
  const result=await a.placeLimitBuyWithFallback("BTCUSDT",10,100);
  assert.equal(result.orderId,"oid123");
  assert.equal(result.confirmedQty,0.03);
  assert.equal(a.calls.filter(x=>x.method==="POST").length,2);
  assert.equal(a.getPaused(),false);
});

test("missing order info halts trading and persists uncertain order",async()=>{
  const a=mockExchange([],{failInfo:true});
  await assert.rejects(a.placeLimitBuyWithFallback("BTCUSDT",10,100),/order-info network down/);
  assert.equal(a.getPaused(),true);
  assert.equal(a.state._tradingHaltReason,"UNCONFIRMED_BITGET_LIMIT_ORDER");
  assert.equal(a.state.unconfirmedOrders.length,1);
  assert.equal(a.calls.filter(x=>x.method==="POST").length,1);
});

test("network loss after submission halts trading and remembers clientOid",async()=>{
  const a=mockExchange([],{failAtPlace:true});
  await assert.rejects(a.placeLimitBuyWithFallback("BTCUSDT",10,100),/connection dropped/);
  assert.equal(a.getPaused(),true);
  assert.match(a.state.unconfirmedOrders[0].clientOid,/^ab[a-z0-9]+$/);
});

test("unconfirmed cancel cannot trigger a second buy",async()=>{
  const a=mockExchange(Array(11).fill({status:"live",qty:0}),{cancelFails:true});
  await assert.rejects(a.placeLimitBuyWithFallback("BTCUSDT",10,100),/cancellation not confirmed/);
  assert.equal(a.getPaused(),true);
  assert.equal(a.calls.filter(x=>x.url.includes("/place-order")).length,1);
});
