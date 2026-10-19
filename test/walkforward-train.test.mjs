import test from "node:test";
import assert from "node:assert/strict";
import { HOUR, DAY, historicalCandles, indicators, signal, simulate, stats, trainOnDatasets, PARAMETERS } from "../research/walkforward-train.mjs";

function makeCandles(count=420,start=0) {
  return Array.from({length:count},(_,i)=>({
    time:start+i*HOUR,open:100,high:101,low:99,close:100,volume:100,
  }));
}
test("history pagination retrieves older than 100 hours, sorted without duplicates",async()=>{
  const now=200*HOUR,seen=[];
  const fetcher=async(url,options)=>{
    assert.equal(options.method,"GET");
    assert.match(url,/history-candles/);
    const end=Math.floor(Number(new URL(url).searchParams.get("endTime"))/HOUR)*HOUR;
    seen.push(end);
    return {ok:true,status:200,json:async()=>({code:"00000",
      data:Array.from({length:100},(_,i)=>[String(end-i*HOUR),"100","101","99","100","5","500"])})};
  };
  const result=await historicalCandles("BTCUSDT",{days:7,now,maxPages:4,minBars:135,fetcher,spacingMs:0,wait:async()=>{}});
  assert.ok(result.candles.length>=165);
  assert.ok(seen.length>=2);
  assert.ok(result.candles.every((c,i)=>i===0||c.time>result.candles[i-1].time));
  assert.equal(result.candles.at(-1).time + HOUR<=now,true,"last partial candle must be excluded");
});
test("missing historical data fails research closed, rather than inventing signals",async()=>{
  const fetcher=async()=>({ok:true,status:200,json:async()=>({code:"00000",data:[]})});
  await assert.rejects(historicalCandles("BTCUSDT",{now:200*HOUR,days:7,minBars:130,fetcher,spacingMs:0,wait:async()=>{}}),
    /insufficient 1H history/);
});
test("signals use only completed bars (future data changes cannot change prior signal)",()=>{
  const candles=makeCandles();
  const ind=indicators(candles);
  const params={strategy:"breakout",lookback:20,volumeMultiple:1.25,tp:0.05,sl:0.02,hold:10};
  candles[250]={...candles[250],high:112,close:111,volume:200};
  ind.high20[250]=107;
  ind.avgVol20[250]=100;
  ind.ema20[250]=105;ind.ema50[250]=100;ind.ema100[250]=99;
  assert.equal(signal(candles,250,ind,params),true);
  candles[300]={...candles[300],close:100000,volume:10000,high:100000};
  assert.equal(signal(candles,250,ind,params),true);
});
test("next-bar execution, intrabar stop-first, no same-bar clairvoyance",()=>{
  const candles=makeCandles();
  const x=indicators(candles), i=250;
  const params={strategy:"breakout",lookback:20,volumeMultiple:1.25,tp:0.05,sl:0.02,hold:10};
  candles[i]={...candles[i],high:112,close:111,volume:200};
  x.high20[i]=107;x.avgVol20[i]=100;x.ema20[i]=105;x.ema50[i]=100;x.ema100[i]=99;
  candles[i+1]={...candles[i+1],open:110,high:130,low:100,close:120,volume:300};
  const out=simulate(candles,x,params,candles[i+1].time,candles[i+10].time,{symbol:"BTCUSDT"});
  assert.equal(out.length,1);
  assert.equal(out[0].entryTime,candles[i+1].time);
  assert.equal(out[0].exitReason,"stop","Stop should win when TP and SL overlap");
  assert.ok(out[0].resultPct<0);
});
test("even a flat price loses money after taker fee and slippage",()=>{
  const candles=makeCandles();
  const x=indicators(candles),i=250;
  const params={strategy:"breakout",lookback:20,volumeMultiple:1.25,tp:0.20,sl:0.10,hold:2};
  candles[i]={...candles[i],close:105,volume:200,high:106};
  x.high20[i]=102;x.avgVol20[i]=100;x.ema20[i]=103;x.ema50[i]=101;x.ema100[i]=99;
  const out=simulate(candles,x,params,candles[i+1].time,candles[i+10].time,{symbol:"BTCUSDT"});
  assert.equal(out.length,1);
  assert.ok(out[0].resultPct<0.0);
  assert.equal(out[0].exitReason,"timeout");
});
test("small, seemingly lucky samples are NOT treated as validated",()=>{
  const data=["BTCUSDT","ETHUSDT","SOLUSDT","LINKUSDT","ADAUSDT"].map(symbol=>({
    symbol,candles:makeCandles(180*24,Date.now()-180*DAY),
  }));
  const result=trainOnDatasets(data,Date.now());
  assert.equal(result.status,"NO_VALIDATED_EDGE");
  assert.equal(result.selected,null);
  assert.equal(result.approvalEvidence,false);
});
test("report distinguishes trade-level returns from account profits",()=>{
  const s=stats([{symbol:"BTCUSDT",resultPct:2,exitTime:1},
    {symbol:"ETHUSDT",resultPct:-3,exitTime:2}]);
  assert.equal(s.n,2);
  assert.equal(s.tradedSymbols,2);
  assert.equal(s.expectancyNetPct,-0.5);
  assert.match(s.note,/NOT account P&L/);
});
test("parameter search is deliberately small and fixed; no automatic live promotion",()=>{
  assert.equal(PARAMETERS.length,8);
  const x=PARAMETERS.every(p=>p.tp>0&&p.sl>0&&p.hold>0);
  assert.equal(x,true);
});
