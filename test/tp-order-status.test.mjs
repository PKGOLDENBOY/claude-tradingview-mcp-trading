import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {confirmSpotSellFill} from "../lib/order-safety.mjs";
const src=readFileSync(new URL("../bot.js",import.meta.url),"utf8");
function section(start,end){
  const a=src.indexOf(start),b=src.indexOf(end,a+start.length);
  assert.ok(a>=0 && b>a);
  return src.slice(a,b);
}

function orderStatusMock(payload) {
  const calls=[], warnings=[];
  const deps={
    fetch:async (url,opts)=>{
      calls.push({url,opts});
      return {ok:true,json:async()=>payload};
    },
    acct:()=>({baseUrl:"https://mock.invalid",apiKey:"x",passphrase:"y"}),
    signBitGet:()=>"signature",AbortSignal,
    console:{warn:(...args)=>warnings.push(args.join(" "))},
  };
  const build=new Function("deps",
    "const {fetch,acct,signBitGet,AbortSignal,console}=deps;\n"+
    section("async function getOrderStatus(symbol, orderId) {","async function checkTpOrders() {")+
    "\nreturn getOrderStatus;");
  return {run:()=>build(deps)("ETHUSDT","tp123"),calls,warnings};
}

test("production getOrderStatus parses BitGet v2 array data and filled base quantity",async()=>{
  const a=orderStatusMock({code:"00000",data:[{
    orderId:"tp123",status:"filled",baseVolume:"2.000",priceAvg:"112.30",
  }]});
  const state=await a.run();
  assert.equal(state.confirmedQty,2);
  assert.equal(state.status,"filled");
  assert.equal(state.priceAvg,"112.30");
  assert.match(a.calls[0].url,/orderInfo\?orderId=tp123/);
});

test("bad orderInfo shape cannot masquerade as a full TP fill",async()=>{
  const a=orderStatusMock({code:"00000",data:{
    orderId:"tp123",status:"filled",baseVolume:"2",
  }});
  assert.equal(await a.run(),null);
  assert.ok(a.warnings.length>0);
});

function tpMonitor(status="filled",confirmedQty=2) {
  const state={
    portfolioValue:100,trades:[],
    positions:{ETHUSDT:{open:true,tpOrderId:"tp123",quantity:"2",entryPrice:100,tpPct:0.08}},
  };
  const halts=[],emails=[],signals=[];
  const deps={
    loadLog:()=>state,
    _processingStops:new Set(),
    _runningSymbols:new Set(),
    getOrderStatus:async()=>({status,confirmedQty,priceAvg:"112",orderId:"tp123"}),
    getQuantityPrecision:async()=>4,
    confirmSpotSellFill,
    haltOnUnconfirmedSell:o=>halts.push(o),
    acct:()=>({portfolioValue:100}),
    _recentlySold:new Map(),
    learnFromTrades:()=>false,
    saveLog:()=>{},
    writeTradeCsv:()=>{},
    syncPortfolioBalance:async()=>{},
    pushSignal:(...v)=>signals.push(v),
    emailExit:async x=>emails.push(x),
    console:{log:()=>{},error:()=>{}},
  };
  const build=new Function("deps",
    "const {loadLog,_processingStops,_runningSymbols,getOrderStatus,getQuantityPrecision,confirmSpotSellFill,haltOnUnconfirmedSell,acct,_recentlySold,learnFromTrades,saveLog,writeTradeCsv,syncPortfolioBalance,pushSignal,emailExit,console}=deps;\n"+
    section("async function checkTpOrders() {","// ─── Main ─")+
    "\nreturn checkTpOrders;");
  return {run:()=>build(deps)(),state,halts,emails,signals};
}

test("resting TP confirmed fully filled closes exactly the requested position",async()=>{
  const a=tpMonitor("filled",2); await a.run();
  assert.equal(a.state.positions.ETHUSDT,undefined);
  assert.equal(a.state.trades.length,1);
  assert.equal(a.state.trades[0].pnlUSD,24);
  assert.equal(a.state.portfolioValue,124);
  assert.equal(a.halts.length,0);
});

test("partial TP fill does not close position or book imaginary profit",async()=>{
  const a=tpMonitor("partially_filled",1); await a.run();
  assert.equal(a.state.positions.ETHUSDT.open,true);
  assert.equal(a.state.trades.length,0);
  assert.equal(a.state.portfolioValue,100);
  assert.equal(a.halts.length,1);
});

test("cancelled unfilled TP does not affect holdings",async()=>{
  const a=tpMonitor("cancelled",0); await a.run();
  assert.equal(a.state.positions.ETHUSDT.open,true);
  assert.equal(a.state.trades.length,0);
  assert.equal(a.halts.length,0);
});
