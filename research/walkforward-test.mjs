// Research-only out-of-sample test of the VWAP + RSI(3) + EMA(8) entry strategy.
// Never imports the live trading bot or credentials; performs GET-only market data requests.
// This tests the *core scalp entry idea*, not the full bot's swing/breakout logic.
const coins = ['BTCUSDT','ETHUSDT','SOLUSDT','LINKUSDT','ADAUSDT'];
const fee = 0.00064;
const slippage = 0.0005;
const stopLoss = 0.04;
const maxHoldBars = 24;

async function getCandles(symbol) {
  const url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol + '&interval=1h&limit=1000';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(14000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const a = await r.json();
    if (!Array.isArray(a) || a.length < 550) throw new Error('Insufficient Binance candles');
    return a.map(k => ({ ts: Number(k[0]), open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }))
      .sort((a,b) => a.ts - b.ts);
  } catch (e) {
    console.log('Binance fallback for ' + symbol + ': ' + e.message);
    // v3 accepts SPOT, interval=1H and up to 1000 bars; v2 uses granularity=1h.
    const candidates = [
      'https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=' + symbol + '&interval=1H&limit=1000',
      'https://api.bitget.com/api/v2/spot/market/candles?symbol=' + symbol + '&granularity=1h&limit=1000'
    ];
    let lastError = '';
    for (const candidate of candidates) {
      try {
        const r2 = await fetch(candidate, {signal:AbortSignal.timeout(14000)});
        if (!r2.ok) throw new Error('HTTP ' + r2.status);
        const d = await r2.json();
        if (d.code !== '00000' || !Array.isArray(d.data) || d.data.length < 550)
          throw new Error('bad response ' + String(d.code||'none') + ' bars:' + (d.data?.length||0));
        return d.data.map(k=>({ts:+k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]})).sort((a,b)=>a.ts-b.ts);
      } catch (f) { lastError = f.message; }
    }
    throw new Error('BitGet candle endpoints unavailable: ' + lastError);
  }
}
function prep(c) {
  const p=c.map(x=>x.close), ema=[],rsi=[],vwap=[],avgVolume=[];
  const alpha=2/9;
  let em=p[0];for(let i=0;i<p.length;i++){if(i)em=p[i]*alpha+em*(1-alpha);ema.push(em);}
  let g=0,l=0;for(let i=1;i<=3;i++){const ch=p[i]-p[i-1];g+=Math.max(ch,0);l+=Math.max(-ch,0);}
  g/=3;l/=3;for(let i=0;i<p.length;i++){if(i<3){rsi.push(null);continue;}if(i>3){const ch=p[i]-p[i-1];g=(2*g+Math.max(ch,0))/3;l=(2*l+Math.max(-ch,0))/3;}rsi.push(l===0?100:100-100/(1+g/l));}
  for(let i=0;i<c.length;i++){
    const recent=c.slice(Math.max(0,i-23),i+1);
    let weighted=0,vol=0;for(const x of recent){weighted+=(x.high+x.low+x.close)/3*x.volume;vol+=x.volume;}
    vwap.push(vol?weighted/vol:p[i]);
    const previous=c.slice(Math.max(0,i-20),i);
    avgVolume.push(previous.length?previous.reduce((t,x)=>t+x.volume,0)/previous.length:0);
  }
  return {ema,rsi,vwap,avgVolume};
}
function run(c,ind,begin,end,threshold,tp) {
  const trades=[];
  for(let i=Math.max(30,begin);i<end-2;){
    const x=c[i],v=ind.vwap[i],r=ind.rsi[i],av=ind.avgVolume[i];
    const ok=Number.isFinite(r) && v>0 && av>0 &&
      x.close>v && x.close>ind.ema[i] && r<threshold &&
      Math.abs(x.close/v-1)<0.03 && x.volume>av*0.8;
    if(!ok){i++;continue;}
    const start=i+1;
    const entry=c[start].open*(1+slippage), stop=entry*(1-stopLoss), target=entry*(1+tp);
    let exitIdx=Math.min(end-1,start+maxHoldBars), exitPrice=c[exitIdx].close*(1-slippage),why='TIME';
    for(let j=start;j<=Math.min(end-1,start+maxHoldBars);j++){
      const b=c[j];
      if(b.open<stop){exitIdx=j;exitPrice=b.open*(1-slippage);why='GAP_STOP';break;}
      // When both stop and target are touched intrabar, resolve against the strategy.
      if(b.low<=stop){exitIdx=j;exitPrice=stop*(1-slippage);why='STOP';break;}
      if(b.high>=target){exitIdx=j;exitPrice=target*(1-slippage);why='TARGET';break;}
    }
    const cost=entry*(1+fee),net=(exitPrice*(1-fee)-cost)/cost;
    trades.push({returnPct:100*net,win:net>0,reason:why,holdBars:exitIdx-start+1});
    i=exitIdx+1;
  }
  return trades;
}
function stats(trades) {
  const w=trades.filter(t=>t.win), losses=trades.filter(t=>!t.win);
  const gain=w.reduce((s,t)=>s+t.returnPct,0),loss=-losses.reduce((s,t)=>s+t.returnPct,0);
  return {n:trades.length,wins:w.length,winRate:trades.length?100*w.length/trades.length:null,
    netNotionalPct:trades.reduce((s,t)=>s+t.returnPct,0),
    avgNetPct:trades.length?trades.reduce((s,t)=>s+t.returnPct,0)/trades.length:null,
    profitFactor:loss?gain/loss:(gain>0?null:0)};
}
function choose(c,ind,cut) {
  let best=null;
  for(const rsi of [20,25,30,35,40,45,50])for(const tp of [0.03,0.04,0.05,0.06,0.08]){
    const t=run(c,ind,30,cut,rsi,tp),s=stats(t);
    if(s.n<5 || s.winRate<60 || s.avgNetPct<=0)continue;
    const score=s.avgNetPct*Math.sqrt(s.n);
    if(!best||score>best.score)best={rsi,tp,score,train:s};
  }
  return best;
}
let all=[];
let baselineTrades=[];
const results=[];
for(const symbol of coins){
  try {
    const c=await getCandles(symbol);
    c.pop(); // do not use currently forming candle as a finalized result
    const cutoff=Math.floor(c.length*0.7),ind=prep(c);
    // Independent fixed-parameter baseline: no optimization, evaluated unseen.
    const baseline=run(c,ind,cutoff,c.length,50,0.04);
    baselineTrades.push(...baseline);
    const best=choose(c,ind,cutoff);
    if(!best){
      const o={symbol,candles:c.length,result:'SKIP',fixedRuleOOS:stats(baseline),reason:'no training setup met >=5 trades, >=60% WR and positive net expectancy'};
      results.push(o);console.log(JSON.stringify(o));continue;
    }
    const trades=run(c,ind,cutoff,c.length,best.rsi,best.tp);
    all.push(...trades);
    const o={symbol,candles:c.length,trainSize:cutoff,testSize:c.length-cutoff,
      train:best.train,rsiGate:best.rsi,takeProfit:best.tp,
      test:stats(trades),fixedRuleOOS:stats(baseline),result:'TESTED',first:c[cutoff].ts,last:c.at(-1).ts};
    results.push(o);console.log(JSON.stringify(o));
  }catch(e){const o={symbol,result:'DATA_ERROR',reason:e.message};results.push(o);console.error(JSON.stringify(o));}
}
const tested=results.filter(x=>x.result==='TESTED');
const aggregate={test:stats(all),fixedRuleOOS:stats(baselineTrades),
  fixedRuleParameters:{rsi3Below:50,takeProfitPct:4,stopLossPct:4},
  totalSymbols:coins.length,testedSymbols:tested.length,
  skippedSymbols:results.filter(x=>x.result==='SKIP').length,
  failedSources:results.filter(x=>x.result==='DATA_ERROR').length,
  assumptions:{timeframe:'1h',bars:1000,trainShare:0.7,testShare:0.3,
    feeEachSidePct:fee*100,slippageEachSidePct:slippage*100,
    stopLossPct:4,maxHoldHours:24,
    intrabarPolicy:'assume stop hit before take profit',
    strategy:'Simplified VWAP+RSI3+EMA8 scalp only; NOT full deployed bot'},
  conclusion: tested.length===0 ? 'NO_TRAINING_EDGE' : (all.length>=10?'OOS_SAMPLE_PRESENT':'INSUFFICIENT_OOS_TRADES')};
console.log('OUT_OF_SAMPLE_RESULT_JSON '+JSON.stringify(aggregate));
if(aggregate.failedSources>0)process.exitCode=2;
