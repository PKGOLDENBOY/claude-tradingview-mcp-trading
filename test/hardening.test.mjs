import test from "node:test";
import assert from "node:assert/strict";
import { createCandleClient, normaliseCandles } from "../lib/market-data.mjs";
import { safePositionNotional, paperEntry, paperExit, paperStats, paperPortfolioValuation } from "../lib/risk-engine.mjs";

function row(ts, price = 100) {
  return [String(ts),String(price),String(price+1),String(price-1),String(price), "10"];
}
test("candle data is chronological, valid and deduplicated", () => {
  const cleaned = normaliseCandles([
    row(3,103),row(1,101),row(2,102),row(2,102),row(4,-1),["bad"],row(5,105)
  ],{now:6,closedOnly:false});
  assert.deepEqual(cleaned.map(c=>c.time),[1,2,3,5]);
});
test("closed-only signals reject still-forming candles",()=>{
  const now=299999; const data=normaliseCandles([row(0),row(240000)],{now,intervalMs:60000,closedOnly:true});
  assert.equal(data.length,1);
});
test("market client can retry HTTP 429s and normalise the result", async()=>{
  let calls=0;
  const fetched=[];
  const fetcher=async (url,opt)=>{
    calls++;fetched.push([url,opt.method]);
    if(calls===1)return {status:429,ok:false,headers:{get:()=>null}};
    return {status:200,ok:true,json:async()=>({code:"00000",data:[row(2000),row(1000),row(3000)]})};
  };
  const client=createCandleClient({fetcher,pause:async()=>{},spacingMs:0,cache:new Map(),maxRetries:2});
  const a=await client("BTCUSDT","1H",100);
  const b=await client("BTCUSDT","1H",100);
  assert.equal(calls,2,"cache should avoid an identical second request");
  assert.deepEqual(a.map(x=>x.time),[1000,2000,3000]);
  assert.deepEqual(a,b);
  assert.equal(fetched[0][1],"GET");
});
test("bad v3 API payload falls back to correct v2 granularity",async()=>{
  const urls=[];
  const client=createCandleClient({fetcher:async url=>{
    urls.push(url);
    if(url.includes("/v3/"))return {status:400,ok:false};
    return {status:200,ok:true,json:async()=>({code:"00000",data:[row(1000),row(2000)]})};
  },pause:async()=>{},spacingMs:0,cache:new Map(),maxRetries:0});
  const data=await client("BTCUSDT","1H",100);
  assert.equal(data.length,2);
  assert.match(urls[1],/granularity=1h/);
});
test("invalid or exhausted feeds fail closed",async()=>{
  const client=createCandleClient({fetcher:async()=>({status:429,ok:false,headers:{get:()=>null}}),pause:async()=>{},spacingMs:0,cache:new Map(),maxRetries:1});
  await assert.rejects(client("BTCUSDT","1H"),/Both BitGet candle feeds failed/);
  await assert.rejects(client("BAD/COIN","1H"),/Invalid trading symbol/);
});
test("both absolute dollar cap and one-percent equity risk are enforced",()=>{
  const size=safePositionNotional({portfolioUsd:100,stopFraction:0.05,absoluteLimitUsd:10});
  assert.equal(size,10);
  assert.ok(safePositionNotional({portfolioUsd:100,stopFraction:0.1,absoluteLimitUsd:20}) <= 9.62);
  assert.equal(safePositionNotional({portfolioUsd:100,stopFraction:0.1,absoluteLimitUsd:0}),0);
  assert.equal(safePositionNotional({portfolioUsd:0,stopFraction:0.05,absoluteLimitUsd:10}),0);
  assert.equal(safePositionNotional({portfolioUsd:NaN,stopFraction:0.05,absoluteLimitUsd:10}),0);
});
test("paper round trip incurs fee and slippage even when market does not move",()=>{
  const buy=paperEntry({marketPrice:100,notionalUsd:10});
  assert.ok(buy.fillPrice>100);
  const sold=paperExit({entryFillPrice:buy.fillPrice,exitMarketPrice:100,quantity:buy.quantity,entryFeeUsd:buy.entryFeeUsd});
  assert.ok(sold.pnlUsd<0);
  assert.ok(sold.pnlPct<0);
});
test("paper profits and partial-fee allocation don't double-count entry fees",()=>{
  const buy=paperEntry({marketPrice:100,notionalUsd:10});
  const full=paperExit({entryFillPrice:buy.fillPrice,exitMarketPrice:110,quantity:buy.quantity,entryFeeUsd:buy.entryFeeUsd});
  const h=buy.quantity/2;
  const a=paperExit({entryFillPrice:buy.fillPrice,exitMarketPrice:110,quantity:h,entryFeeUsd:buy.entryFeeUsd/2});
  const b=paperExit({entryFillPrice:buy.fillPrice,exitMarketPrice:110,quantity:h,entryFeeUsd:buy.entryFeeUsd/2});
  assert.ok(Math.abs(full.pnlUsd-a.pnlUsd-b.pnlUsd)<1e-8);
});
test("paper dashboard metrics never present an open position as closed profit",()=>{
  const a=paperStats([{type:"entry",paperTrading:true,pnlUSD:0},{type:"exit",paperTrading:true,pnlUSD:1.25,feeAdjusted:true},{type:"exit",paperTrading:true,pnlUSD:-0.8,feeAdjusted:true}]);
  assert.equal(a.sample,2);
  assert.equal(a.feeAdjustedExits,2);
  assert.equal(a.wins,1);
  assert.ok(Math.abs(a.realizedPnlUsd-0.45)<1e-8);
});

test("paper equity does NOT double-count holdings on top of starting capital",()=>{
  const portfolio=paperPortfolioValuation({
    portfolioValue:100,
    positions:{BTCUSDT:{open:true,entryPrice:100.1,quantity:0.1,entryFeeUsd:0.01}}
  },{BTCUSDT:{price:100,updatedAt:new Date().toISOString()}},
  {startingEquityUsd:100});
  assert.ok(portfolio.equityUsd>99.9 && portfolio.equityUsd<100);
  assert.ok(portfolio.cashUsd>89.9 && portfolio.cashUsd<90.1);
  assert.ok(portfolio.openLiquidationValueUsd>9.9);
  assert.ok(portfolio.unrealizedPnlUSD<0);
  assert.equal(portfolio.staleQuotes,0);
});
test("paper equity accounts for swing + breakout and flags old marks",()=>{
  const log={portfolioValue:100,swingPositions:{BTCUSDT:{open:true,entryPrice:100,quantity:0.1}},
    breakoutPositions:{ETHUSDT:{open:true,entryPrice:100,quantity:0.1}}};
  const x=paperPortfolioValuation(log,{BTCUSDT:{price:110,updatedAt:new Date().toISOString()}});
  assert.equal(x.positions.length,2);
  assert.equal(x.staleQuotes,1);
  assert.ok(x.cashUsd<81 && x.cashUsd>79);
  assert.ok(x.equityUsd<110 && x.equityUsd>100);
});
test("paper allocation report flags positions that exceed virtual cash",()=>{
  const log={portfolioValue:100,positions:{BTCUSDT:{open:true,entryPrice:100,quantity:1.5}}};
  const x=paperPortfolioValuation(log,{BTCUSDT:{price:100,updatedAt:new Date().toISOString()}});
  assert.equal(x.overAllocated,true);
  assert.ok(x.cashUsd<0);
});
test("market data refuses repeated 429s rather than hammering fallback endpoints",async()=>{
  let requests=0;
  const client=createCandleClient({fetcher:async()=>{requests++;return{status:429,ok:false,headers:{get:()=>null}};},
    pause:async()=>{},spacingMs:0,cache:new Map(),maxRetries:1});
  await assert.rejects(client("BTCUSDT","1H",10),/429/);
  assert.equal(requests,2);
});
test("parallel identical candle requests share one in-flight HTTP request",async()=>{
  let requests=0;
  const client=createCandleClient({fetcher:async()=>{requests++;await Promise.resolve();
    return{status:200,ok:true,json:async()=>({code:"00000",data:[row(1000),row(2000)]})};},
    pause:async()=>{},spacingMs:0,cache:new Map(),maxRetries:0});
  const [a,b,c]=await Promise.all(["BTCUSDT","BTCUSDT","BTCUSDT"].map(sym=>client(sym,"1H")));
  assert.equal(requests,1);
  assert.deepEqual(a,b);
  assert.deepEqual(b,c);
});
