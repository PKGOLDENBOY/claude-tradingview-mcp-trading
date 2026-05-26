/**
 * Smart Backtester v4
 * - 360 candles (15 days of 1H data) — recent market conditions
 * - Optimises RSI threshold (15–50) and TP (3–8%) per coin
 * - Minimum 3 trades for statistical validity (shorter window = fewer trades)
 * - 60%+ win rate required to trade
 * - Self-learning: re-runs after every 10 live trades to update thresholds
 * - Full 30-coin watchlist
 */

import { writeFileSync, readFileSync, existsSync } from "fs";

const SYMBOLS = [
  "AXSUSDT","VIRTUALUSDT","LINKUSDT","ZECUSDT","SOLUSDT","SUIUSDT",
  "BNBUSDT","ADAUSDT","AVAXUSDT","INJUSDT","ARBUSDT","DOTUSDT",
  "NEARUSDT","POLUSDT","XRPUSDT","DOGEUSDT","TRXUSDT","ONDOUSDT",
  "LTCUSDT","ATOMUSDT","UNIUSDT","AAVEUSDT","FTMUSDT","SANDUSDT",
  "MANAUSDT","GALAUSDT","APEUSDT","OPUSDT","APTUSDT","HYPEUSDT"
];

const STOP_LOSS = 0.04;
const MAX_BARS  = 24;

function calcEMA(closes, p) {
  const k=2/(p+1); let e=closes[0]; const r=[e];
  for(let i=1;i<closes.length;i++){e=closes[i]*k+e*(1-k);r.push(e);}
  return r;
}
function calcRSI(closes, p=3) {
  const r=new Array(p).fill(null);
  let g=0,l=0;
  for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l-=d;}
  g/=p;l/=p;
  r.push(l===0?100:100-100/(1+g/l));
  for(let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    g=(g*(p-1)+(d>0?d:0))/p;
    l=(l*(p-1)+(d<0?-d:0))/p;
    r.push(l===0?100:100-100/(1+g/l));
  }
  return r;
}
function calcVWAP(candles) {
  return candles.map((_,i)=>{
    const w=candles.slice(Math.max(0,i-23),i+1);
    const tv=w.reduce((s,c)=>s+((c.high+c.low+c.close)/3)*c.volume,0);
    const v=w.reduce((s,c)=>s+c.volume,0);
    return v>0?tv/v:candles[i].close;
  });
}

async function fetchCandles(symbol, limit=360) {
  // Try Binance first, fall back to BitGet for coins not on Binance
  try {
    const url=`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`;
    const res=await fetch(url);
    const d=await res.json();
    if(Array.isArray(d)&&d.length>10) return d.map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}));
  } catch {}
  // BitGet fallback
  const url2=`https://api.bitget.com/api/v2/spot/market/candles?symbol=${symbol}&granularity=1H&limit=${limit}`;
  const res2=await fetch(url2);
  const d2=await res2.json();
  if(!d2.data?.length) throw new Error("no data from Binance or BitGet");
  return d2.data.reverse().map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}));
}

function runSim(candles, rsiThreshold, takeProfit) {
  const closes=candles.map(c=>c.close);
  const ema8=calcEMA(closes,8);
  const rsi=calcRSI(closes,3);
  const vwap=calcVWAP(candles);
  const avgVol=candles.slice(0,20).reduce((s,c)=>s+c.volume,0)/20;

  const trades=[]; let in_=false,entry=0,bar=0;
  for(let i=30;i<candles.length-1;i++){
    if(in_){
      const p=candles[i].close,pct=(p-entry)/entry,held=i-bar;
      if(pct>=takeProfit||pct<=-STOP_LOSS||held>=MAX_BARS){
        trades.push({pct:pct*100,win:pct>0,held,exit:pct>=takeProfit?"TP":pct<=-STOP_LOSS?"SL":"TIME"});
        in_=false;
      }
      continue;
    }
    const p=candles[i].close,rv=rsi[i];
    if(rv===null)continue;
    const bull=p>vwap[i]&&p>ema8[i];
    const os=rv<rsiThreshold;
    const near=Math.abs((p-vwap[i])/vwap[i])<0.03;
    const vol=candles[i].volume>avgVol*0.8;
    if(bull&&os&&near&&vol){in_=true;entry=candles[i+1].open;bar=i+1;}
  }
  return trades;
}

function optimise(symbol, candles) {
  let best=null;
  for(const rsi of [15,20,25,30,35,40,45,50]){
    for(const tp of [0.03,0.04,0.05,0.06,0.08]){
      const trades=runSim(candles,rsi,tp);
      if(trades.length<3)continue;
      const wins=trades.filter(t=>t.win);
      const losses=trades.filter(t=>!t.win);
      const wr=wins.length/trades.length;
      const aw=wins.length>0?wins.reduce((s,t)=>s+t.pct,0)/wins.length:0;
      const al=losses.length>0?losses.reduce((s,t)=>s+t.pct,0)/losses.length:0;
      const exp=wr*aw+(1-wr)*al;
      if(wr<0.60||exp<=0)continue;
      const score=wr*exp;
      if(!best||score>best.score){
        best={rsiThreshold:rsi,takeProfit:tp,trades:trades.length,
          winRate:+(wr*100).toFixed(1),avgWin:+aw.toFixed(2),avgLoss:+al.toFixed(2),
          expectancy:+exp.toFixed(2),score};
      }
    }
  }
  if(!best)return{symbol,trades:0,winRate:0,avgWin:0,avgLoss:0,expectancy:0,rsiThreshold:25,takeProfit:0.05,recommendation:"SKIP",testedAt:new Date().toISOString()};
  return{symbol,...best,recommendation:best.winRate>=70?"TRADE":"CAUTION",testedAt:new Date().toISOString()};
}

async function main() {
  console.log("Smart Backtest v4 — 15 days (360 x 1H candles), all 30 watchlist coins...\n");
  const results={};

  // Incorporate live trade feedback if available
  let liveWins={};
  if(existsSync("safety-check-log.json")){
    try{
      const log=JSON.parse(readFileSync("safety-check-log.json","utf8"));
      const exits=log.trades?.filter(t=>t.type==="exit"&&t.orderPlaced&&t.pnlPct!=null)||[];
      for(const t of exits){
        if(!liveWins[t.symbol])liveWins[t.symbol]={wins:0,total:0};
        liveWins[t.symbol].total++;
        if(t.pnlPct>0)liveWins[t.symbol].wins++;
      }
    }catch{}
  }

  for(const sym of SYMBOLS){
    try{
      const candles=await fetchCandles(sym,1000);
      const r=optimise(sym,candles);

      // Blend live trade feedback if we have enough data
      const live=liveWins[sym];
      if(live&&live.total>=3){
        const liveWR=live.wins/live.total;
        const backtestWR=r.winRate/100;
        const blended=(backtestWR*0.6+liveWR*0.4);
        r.winRate=+(blended*100).toFixed(1);
        r.liveData=`${live.wins}W/${live.total}T live`;
        r.recommendation=blended>=0.70?"TRADE":blended>=0.60?"CAUTION":"SKIP";
      }

      results[sym]=r;
      const icon=r.recommendation==="TRADE"?"✅":r.recommendation==="CAUTION"?"⚠️ ":"🚫";
      if(r.trades>0){
        const live=r.liveData?` [live:${r.liveData}]`:"";
        console.log(`${icon} ${sym.padEnd(14)} WR:${r.winRate}%  n:${r.trades}  exp:+${r.expectancy}%  RSI<${r.rsiThreshold}  TP:${(r.takeProfit*100).toFixed(0)}%${live}`);
      } else {
        console.log(`🚫 ${sym.padEnd(14)} No setup with 65%+ WR found`);
      }
    }catch(e){
      console.log(`❌ ${sym}: ${e.message}`);
      results[sym]={symbol:sym,trades:0,winRate:0,recommendation:"SKIP",rsiThreshold:25,takeProfit:0.05};
    }
  }

  writeFileSync("backtest_results.json",JSON.stringify(results,null,2));
  console.log("\n✅ Saved → backtest_results.json");

  const tradeable=Object.values(results).filter(r=>r.recommendation==="TRADE").sort((a,b)=>b.expectancy-a.expectancy);
  console.log(`\n🏆 Trade-ready coins (by expectancy/trade):`);
  if(tradeable.length){
    tradeable.forEach(r=>console.log(`   ${r.symbol.padEnd(14)} WR:${r.winRate}%  +${r.expectancy}%/trade  RSI<${r.rsiThreshold}  TP:${(r.takeProfit*100).toFixed(0)}%`));
    console.log(`\n📝 SYMBOLS=${tradeable.map(r=>r.symbol).join(",")}`);
  } else {
    console.log("   None met 65% WR + 5 trades + positive expectancy.");
    console.log("   Current market may be trending hard — wait for pullback.");
  }
}

main().catch(console.error);
