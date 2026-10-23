// Real exchange integration smoke test: GET-only public historical candles.
// Never reads user credentials, balance, or submits an order.
import assert from "node:assert/strict";
import { fetchMarketCandles } from "../lib/market-data.mjs";
import { fetchWalkForwardHistory } from "../lib/walkforward-history.mjs";
for (const [symbol,interval,count,min] of [
  ["BTCUSDT","1H",100,80],["ETHUSDT","15m",100,80],
  ["SOLUSDT","4H",100,80],["BTCUSDT","1W",30,20],
]) {
  const c=await fetchMarketCandles(symbol,interval,count,{closedOnly:true});
  assert(c.length>=min,"Too few valid "+interval+" "+symbol+" candles: "+c.length);
  assert(c.every((x,i)=>i===0||x.time>c[i-1].time),"Unsorted candles: "+symbol+" "+interval);
  assert(c.every(x=>x.high>=Math.max(x.open,x.close)&&x.low<=Math.min(x.open,x.close)),
    "Bad OHLC candle "+symbol+" "+interval);
  console.log("MARKET_SMOKE_PASS",JSON.stringify({symbol,interval,closed:c.length,
    first:new Date(c[0].time).toISOString(),last:new Date(c.at(-1).time).toISOString()}));
}

const history = await fetchWalkForwardHistory(fetchMarketCandles, "BTCUSDT", "15m");
assert.equal(history.length, 2910, "Walk-forward must have 23d IS + 7d OOS + warmup");
assert(history.every((x, i) => i === 0 || x.time - history[i-1].time === 900000),
  "Walk-forward market candles must be contiguous 15-minute bars");
console.log("WALK_FORWARD_MARKET_SMOKE_PASS", JSON.stringify({
  symbol:"BTCUSDT", interval:"15m", closed:history.length,
  first:new Date(history[0].time).toISOString(), last:new Date(history.at(-1).time).toISOString(),
  trainingDays:23, oosDays:7,
}));
