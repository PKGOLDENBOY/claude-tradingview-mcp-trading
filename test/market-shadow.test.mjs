import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {STRATEGIES,SAFETY,rsi,ema,rollingVwap,parseClosedCandles,evaluateSignals,positionPnl} from "../scripts/market-shadow-test.mjs";
test("shadow covers six named strategy families and hard-denies exchange orders",()=>{
  assert.deepEqual([...STRATEGIES],["scalp","swing","breakout","momentum","longterm","sniper"]);
  assert.equal(SAFETY.exchangeWrites,false);
  assert.equal(SAFETY.orderRequests,false);
  const source=readFileSync(new URL("../scripts/market-shadow-test.mjs",import.meta.url),"utf8");
  assert.ok(source.includes('method:"GET"'));
  assert.ok(source.includes('STRICT_READ_ONLY'));
  assert.equal(/method:\s*["']POST["']/.test(source),false);
  assert.equal(source.includes('requireExchangeWrites('),false);
});
test("RSI/EMA/VWAP math is bounded and sane",()=>{
  const up=Array.from({length:50},(_,i)=>i+1);
  assert.equal(rsi(up,14),100);
  assert.equal(rsi(up.map(()=>1),14),50);
  assert.equal(ema(up,8)>0,true);
  const bars=Array.from({length:25},(_,i)=>({high:20,low:10,close:15,volume:100}));
  assert.equal(rollingVwap(bars),15);
});
test("incomplete and invalid candles cannot leak into signals",()=>{
  const now=Date.now(),k=15*60_000;
  const sample=[
    [now-k,1,2,1,1.5,100], // active bar must never be used
    [now-2*k,1,2,1,1.5,100],
    [now-3*k,1,2,1,NaN,100],
  ];
  const found=parseClosedCandles(sample,"15min",now);
  assert.equal(found.length,1);
  assert.ok(found[0].ts===now-2*k);
});
test("signals fail closed on missing market data",()=>{
  const s=evaluateSignals({quote:{lastPr:"100",usdtVolume:"1000000",change24h:"0.1"}});
  for(const name of STRATEGIES)assert.equal(s[name].signal,false,name);
});
test("synthetic profit includes fees, bid/ask and adverse slippage",()=>{
  const pnl=positionPnl({entryPrice:100,quantity:1,totalCost:100.1},{lastPr:"100",bidPr:"100",askPr:"100"});
  assert.ok(pnl<-0.19 && pnl> -0.22);
  assert.equal(positionPnl({entryPrice:100,quantity:1,totalCost:100},{}),null);
});
