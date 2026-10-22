/**
 * Five-calendar-month *historical* long-term backtest on BitGet REAL SPOT market candles.
 *
 * STRICT READ-ONLY. Never loads bot.js, authenticated APIs, private tokens,
 * exchange accounts, order APIs, WebSocket trade APIs, nor any POST method.
 * Uses closed historical daily/weekly/4h indicators, 6h decision ticks, a
 * conservative virtual balance, adverse fill slippage + two-sided fees.
 *
 * Reproduces major production rule decisions and ladder/stop mechanics.
 * Not an exact intra-6h execution simulation; cannot establish true edge.
 */
import { fileURLToPath } from "node:url";
import { adaptiveLongtermPolicy, balancedAdaptiveLongtermPolicy } from "../lib/longterm-adaptive-policy.mjs";
import { LT_COINS,CONFIG_LT,ema,parseClosedBars,scoreLtEntry,
  makeState,manageLongterm,buyVirtual,snapshot } from "../lib/longterm-shadow-engine.mjs";
const HOST="https://api.bitget.com",DAY=86400000,HOUR=3600000;
const DURATIONS={"6Hutc":6*HOUR,"4h":4*HOUR,"1Dutc":DAY,"1Wutc":7*DAY};
const requestedEnd=process.env.LT_BACKTEST_END_UTC;
const cutoff=requestedEnd?Date.parse(requestedEnd):Math.floor(Date.now()/DAY)*DAY;
// Five calendar months ending 2026-10-22 (inclusive of May 22, exclusive of Oct 22).
const DAYS=Number(process.env.LT_BACKTEST_DAYS || 153);
if(!Number.isInteger(DAYS)||DAYS<7||DAYS>210||!Number.isFinite(cutoff)||cutoff>Date.now())
  throw new Error("Invalid backtest duration/cutoff");
const START=cutoff-DAYS*DAY, FEES=CONFIG_LT.feeRate, SLIPPAGE=CONFIG_LT.slippageRate;
const ADAPTIVE = process.env.LT_ADAPTIVE_POLICY === "true";
const ADAPTIVE_VARIANT=process.env.LT_ADAPTIVE_VARIANT || "defensive";
if(!["balanced","defensive"].includes(ADAPTIVE_VARIANT))throw new Error("Unknown adaptive strategy variant");
const nowISO=n=>new Date(n).toISOString();
const events=new Map(),data=new Map(),issue=[];
const meta={apiRequests:0,retries:0,fetchErrors:0,unavailable:[],fngEntries:0,
  errorDetails:[],historical:true,exchangeOrders:0,indicatorsPreclosed:true};
const say=(tag,fields)=>console.log(JSON.stringify({tag,at:new Date().toISOString(),mode:"LONGTERM_FIVE_MONTH_HISTORICAL_READ_ONLY",...fields}));
const safeErr=e=>String(e?.message||e).slice(0,180);
const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
function requirePublicGet(url) {
  if (!["api.bitget.com","api.alternative.me"].includes(url.hostname))throw new Error("NONPUBLIC_HOST_BLOCKED");
  if(url.hostname==="api.bitget.com" && url.pathname!=="/api/v2/spot/market/history-candles")
    throw new Error("NONPUBLIC_API_PATH_BLOCKED");
  if(url.hostname==="api.alternative.me" && url.pathname!=="/fng/")
    throw new Error("NONPUBLIC_SENTIMENT_PATH_BLOCKED");
}
async function fetchJson(url){
  requirePublicGet(url);
  let last;
  for(let i=0;i<4;i++){
    try{
      meta.apiRequests++;
      const response=await fetch(url,{method:"GET",headers:{Accept:"application/json"},
        signal:AbortSignal.timeout(12500)});
      if(response.status===429||response.status>=500)throw new Error("HTTP "+response.status);
      if(!response.ok)throw new Error("HTTP "+response.status);
      return await response.json();
    }catch(e){last=e;meta.retries++;await delay(300*(i+1));}
  }
  meta.fetchErrors++;
  throw last;
}
async function bitgetHistory(symbol,granularity,minimumTs,limit=200){
  let until=cutoff+12*HOUR, all=new Map(),pages=0, seen=new Set(),reason=null;
  while(pages<8){
    const url=new URL("/api/v2/spot/market/history-candles",HOST);
    for(const [k,v] of Object.entries({symbol,granularity,endTime:until,limit}))
      url.searchParams.set(k,String(v));
    let raw;
    try{
      const result=await fetchJson(url);
      if(result.code!=="00000"||!Array.isArray(result.data))
        throw new Error("BitGet response "+result.code+" "+String(result.msg).slice(0,90));
      raw=result.data;
    }catch(e){reason=safeErr(e);break}
    const parsed=parseClosedBars(raw,granularity,cutoff);
    if(parsed.length===0)break;
    for(const c of parsed)all.set(c.timestamp,c);
    pages++;
    const minT=Math.min(...parsed.map(c=>c.timestamp));
    if(minT<=minimumTs || seen.has(minT) || raw.length<limit)break;
    seen.add(minT);
    until=minT-1;
    await delay(90);
  }
  const candles=[...all.values()].sort((a,b)=>a.timestamp-b.timestamp);
  if(reason)issue.push({symbol,granularity,error:reason});
  return {candles,pages,reason};
}
async function fetchFG(){
  const url=new URL("https://api.alternative.me/fng/");
  url.searchParams.set("limit",String(Math.max(45,DAYS+15)));
  url.searchParams.set("format","json");
  try{
    const j=await fetchJson(url);
    if(!Array.isArray(j.data))throw new Error("Invalid historical fear/greed series");
    const out=j.data.map(v=>({ts:Number(v.timestamp)*1000,value:Number(v.value)}))
      .filter(v=>Number.isFinite(v.ts)&&v.ts>0&&Number.isFinite(v.value)&&v.value>=0&&v.value<=100)
      .sort((a,b)=>a.ts-b.ts);
    meta.fngEntries=out.length;
    return out;
  }catch(e){issue.push({source:"fear_and_greed",error:safeErr(e)});return [];}
}
function fgAsOf(rows,t){
  // No future sentiment data may be used.
  let v=null;for(const row of rows)if(row.ts<=t)v=row;else break;
  // Treat sentiment older than 48h as unknown; policy fail-closed.
  return v&&t-v.ts<=2*DAY?v.value:null;
}
function atr(bars){
  if(!bars||bars.length<3)return null;
  let sum=0;
  for(let i=1;i<bars.length;i++){
    const c=bars[i],prev=bars[i-1];
    sum+=Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close));
  }
  return sum/(bars.length-1);
}
function btcRegime(bars,t){
  const closed=bars.filter(x=>x.timestamp+4*HOUR<=t);
  if(closed.length<50)return {regime:"UNKNOWN",reason:"BTC 4h warmup unavailable"};
  const candles=closed.slice(-60),closes=candles.map(x=>x.close);
  const e8=ema(closes,8),e21=ema(closes,21),curATR=atr(candles.slice(-14));
  if(!curATR||!e8||!e21)return {regime:"UNKNOWN",reason:"BTC indicators unavailable"};
  let sum=0,count=0;
  for(let i=14;i<candles.length-14;i+=3){
    const a=atr(candles.slice(i,i+14));if(a){sum+=a;count++;}
  }
  if(count===0)return {regime:"UNKNOWN",reason:"BTC prior ATR unavailable"};
  const ratio=curATR/(sum/count);
  let trend=e8>e21*1.005?"bull":e8<e21*0.995?"bear":"neutral";
  const volatility=ratio>1.8?"high":ratio<0.6?"low":"normal";
  const recentMove=(closes.at(-1)-closes.at(-2))/closes.at(-2);
  if(trend==="bear"&&recentMove>=0.02)trend="neutral";
  const regime=volatility==="high"?"VOLATILE":
    trend==="bull"?"TRENDING":trend==="bear"?"BEAR":"RANGING";
  return {regime,trend,ratio};
}
function resultByWeek(){return [];}
async function run(){
  say("LT_5M_START",{requestedSymbols:LT_COINS.length,from:nowISO(START),
    untilExclusive:nowISO(cutoff),durationDays:DAYS,virtualCapitalUSD:CONFIG_LT.initialUSD,
    adaptiveMarketPolicy:ADAPTIVE,adaptivePolicyVariant:ADAPTIVE?ADAPTIVE_VARIANT:"baseline",
    virtualEntryTrancheUSD:CONFIG_LT.t1USD,virtualSecondTrancheUSD:CONFIG_LT.t2USD,
    feeEachSidePct:FEES*100,slippageEachSidePct:SLIPPAGE*100,
    verifiedNoOrders:true,market:"real public BitGet spot history",
    caution:"simulation approximates execution at 6h opens; NO live orders"});
  const state=makeState(START,DAYS),fng=await fetchFG();
  const taskList=[];
  for(const symbol of [...LT_COINS,"BTCUSDT"]){
    taskList.push({symbol,granularity:"6Hutc",minimumTs:START-2*DAY});
    if(symbol==="BTCUSDT")taskList.push({symbol,granularity:"4h",minimumTs:START-12*DAY});
    else {
      taskList.push({symbol,granularity:"1Dutc",minimumTs:START-100*DAY});
      taskList.push({symbol,granularity:"1Wutc",minimumTs:START-60*7*DAY});
    }
  }
  // Deliberately sequential: <=20 requests/s per BitGet public-IP rate limit.
  let loaded=0;
  for(const item of taskList){
    const result=await bitgetHistory(item.symbol,item.granularity,item.minimumTs);
    const record=data.get(item.symbol)||{};
    record[item.granularity]=result.candles;data.set(item.symbol,record);
    loaded++;
    if(loaded%25===0)say("LT_5M_FETCH_PROGRESS",{loaded,total:taskList.length,
      apiRequests:meta.apiRequests,fetchErrors:meta.fetchErrors,issues:issue.length});
    await delay(90);
  }
  const eligible=LT_COINS.filter(sym=>{
    const b=data.get(sym);
    // A five-month result must have the whole evaluation window AND enough
    // PRE-START history to warm up daily Ichimoku/MACD and weekly MACD. No
    // look-ahead and no partial-season performance masquerading as five months.
    const six=b?.["6Hutc"]||[],daily=b?.["1Dutc"]||[],weekly=b?.["1Wutc"]||[];
    const warmDaily=daily.filter(c=>c.timestamp+DAY<=START).length;
    const warmWeekly=weekly.filter(c=>c.timestamp+7*DAY<=START).length;
    const firstTick=six.find(c=>c.timestamp===START);
    const finalTick=six.find(c=>c.timestamp===cutoff-6*HOUR);
    return six.length>=DAYS*4-4 && firstTick && finalTick &&
      warmDaily>=78 && warmWeekly>=35;
  });
  const excluded=LT_COINS.filter(sym=>!eligible.includes(sym)).map(sym=>{
    const r=data.get(sym)||{};
    return {symbol:sym,sixHour:r["6Hutc"]?.length||0,daily:r["1Dutc"]?.length||0,
      weekly:r["1Wutc"]?.length||0,earlyDailyBars:(r["1Dutc"]||[]).filter(b=>b.timestamp+DAY<=START).length,
      earlyWeeklyBars:(r["1Wutc"]||[]).filter(b=>b.timestamp+7*DAY<=START).length};
  });
  meta.unavailable=excluded;
  const btc4=data.get("BTCUSDT")?.["4h"]||[];
  const btc6=data.get("BTCUSDT")?.["6Hutc"]||[];
  if(btc4.filter(b=>b.timestamp+4*HOUR<=START).length<50)
    issue.push({source:"BTC4H_WARMUP",error:"Insufficient closed BTC 4-hour candles before test start; no new buys should pass unknown regime"});
  say("LT_5M_DATA_COVERAGE",{requested:LT_COINS.length,eligible:eligible.length,excluded,
    bitcoinFourHourBars:btc4.length,bitcoinSixHourBars:btc6.length,
    sentimentRecords:meta.fngEntries,issues:issue.slice(0,12)});
  const barMaps=Object.fromEntries(eligible.map(sym=>[sym,new Map((data.get(sym)?.["6Hutc"]||[]).map(b=>[b.timestamp,b]))]));
  const counters={scanCycles:0,blockedRegime:0,blockedFear:0,blockedUnknownRegime:0,
    blockedUnknownSentiment:0,skippedMissingSixHour:0,qualifyingSignals:0,entryAttempts:0,
    blockedBudget:0,indicatorReadyPairs:0,activeSymbols:eligible.length,weekly:[],
    adaptiveReasonCounts:{},adaptiveSizeReduced:0,adaptiveEntryBlockedByScore:0};
  const lastPrices={},equityTrace=[],equityReturns=[],weekly=[];
  let peakEquity=CONFIG_LT.initialUSD;
  // Decision at every 6h opening, with historical indicators ending *before* t.
  for(let t=START;t<cutoff;t+=6*HOUR){
    counters.scanCycles++;
    const prices={};
    for(const sym of eligible){
      const b=barMaps[sym].get(t);
      if(b){prices[sym]=b.open;lastPrices[sym]=b.open;}
      else counters.skippedMissingSixHour++;
    }
    // Existing holdings may be liquidated even if entries are gated.
    const regime=btcRegime(btc4,t),fear=fgAsOf(fng,t);
    const uncertain=regime.regime==="UNKNOWN"||fear===null;
    // PRE-TRADE NAV and drawdown use prices available at the current 6h OPEN.
    // No future price/indicator data influences the adaptive allocation.
    const preTradeEquity=snapshot(state,lastPrices).markToMarketUSD;
    if(Number.isFinite(preTradeEquity))peakEquity=Math.max(peakEquity,preTradeEquity);
    const drawdownPct=Number.isFinite(preTradeEquity)&&peakEquity>0
      ?(preTradeEquity/peakEquity-1)*100:NaN;
    const policy=ADAPTIVE
      ?(ADAPTIVE_VARIANT==="balanced"?balancedAdaptiveLongtermPolicy:adaptiveLongtermPolicy)({
        regime:regime.regime,trend:regime.trend,volatilityRatio:regime.ratio,
        fearGreed:fear,drawdownPct
      }):null;
    if(policy){
      counters.adaptiveReasonCounts[policy.reason]=(counters.adaptiveReasonCounts[policy.reason]||0)+1;
      if(policy.allowEntry&&policy.allocationMultiplier<1)counters.adaptiveSizeReduced++;
    }
    const blocked=ADAPTIVE?!policy.allowEntry
      :uncertain||["RANGING","BEAR"].includes(regime.regime)||fear<=25;
    if(regime.regime==="UNKNOWN")counters.blockedUnknownRegime++;
    if(fear===null)counters.blockedUnknownSentiment++;
    if(["RANGING","BEAR"].includes(regime.regime))counters.blockedRegime++;
    if(fear!==null&&fear<=25)counters.blockedFear++;
    manageLongterm(state,prices,t,ADAPTIVE?!policy.allowDca:blocked,
      ADAPTIVE?CONFIG_LT.t2USD*policy.allocationMultiplier:CONFIG_LT.t2USD);
    const virtualEntrySize=CONFIG_LT.t1USD*(ADAPTIVE?policy.allocationMultiplier:1);
    const haveEnoughCash=virtualEntrySize>0&&state.cashUsd>=
      CONFIG_LT.cashReserveUSD+virtualEntrySize*(1+FEES);
    if(!blocked&&haveEnoughCash){
      const candidates=[];
      for(const sym of eligible){
        if(state.positions[sym]?.open||!prices[sym])continue;
        const d=(data.get(sym)?.["1Dutc"]||[]).filter(b=>b.timestamp+DAY<=t).slice(-200);
        const w=(data.get(sym)?.["1Wutc"]||[]).filter(b=>b.timestamp+7*DAY<=t).slice(-52);
        const scored=scoreLtEntry(w,d);
        state.scans++;
        if(scored.reason==="insufficient closed indicator warmup")state.indicatorsMissing++;
        if(scored.pass){
          if(ADAPTIVE&&scored.passed<policy.requiredScore){
            counters.adaptiveEntryBlockedByScore++;
            continue;
          }
          state.qualifiedSignals++;counters.qualifyingSignals++;
          candidates.push({sym,score:scored.passed,checks:scored.checks});
        }
      }
      candidates.sort((a,b)=>b.score-a.score||LT_COINS.indexOf(a.sym)-LT_COINS.indexOf(b.sym));
      if(candidates.length){
        const best=candidates[0];counters.entryAttempts++;
        if(!buyVirtual(state,best.sym,prices[best.sym],virtualEntrySize,t,"T1",best.score))
          counters.blockedBudget++;
      }
    }else if(!blocked){counters.blockedBudget++;}
    const cur=snapshot(state,lastPrices);
    if(cur.markToMarketUSD!==null)equityTrace.push({t,equity:cur.markToMarketUSD});
    if((t-START)%(7*DAY)===0&&t>START)weekly.push({at:nowISO(t),portfolioUSD:cur.markToMarketUSD,
      profitUSD:cur.combinedSimulatedPnlUSD,open:cur.openPositions,virtualBuys:cur.simulatedBuys,
      blockedRegime:counters.blockedRegime,blockedFear:counters.blockedFear});
    if(counters.scanCycles%28===0){
      say("LT_5M_WEEK",{weeksComplete:counters.scanCycles/28,at:nowISO(t),
        stats:cur,entrySignals:counters.qualifyingSignals,excludedSymbols:excluded.length});
    }
  }
  const endPrices={};
  for(const sym of eligible){
    const last=(data.get(sym)?.["6Hutc"]||[]).filter(x=>x.timestamp+6*HOUR<=cutoff).at(-1);
    if(last)endPrices[sym]=last.close;
  }
  const final=snapshot(state,endPrices);
  if(final.markToMarketUSD!==null)equityTrace.push({t:cutoff,equity:final.markToMarketUSD});
  let peak=-Infinity,maxDrawdownPct=0;
  for(const v of equityTrace){
    peak=Math.max(peak,v.equity);
    maxDrawdownPct=Math.min(maxDrawdownPct,100*(v.equity/peak-1));
  }
  const signedTrades=state.events.filter(x=>x.kind==="SIMULATED_SELL");
  const wins=signedTrades.filter(x=>x.realizedPnlUSD>0),losses=signedTrades.filter(x=>x.realizedPnlUSD<=0);
  const soldPnlUSD=signedTrades.reduce((s,x)=>s+x.realizedPnlUSD,0);
  const btcStart=btc6.find(b=>b.timestamp===START);
  const btcEnd=btc6.filter(b=>b.timestamp+6*HOUR<=cutoff).at(-1);
  const benchmarkBTC=btcStart&&btcEnd?{
    startPrice:btcStart.open,endPrice:btcEnd.close,
    afterEstimatedCostsPct:(btcEnd.close*(1-SLIPPAGE)*(1-FEES)/
      (btcStart.open*(1+SLIPPAGE)*(1+FEES))-1)*100}:null;
  if(final.openPositions===0 && Math.abs(final.realizedPnlUSD-final.combinedSimulatedPnlUSD)>0.0001)
    throw new Error("LEDGER_INCONSISTENCY: all virtual positions are closed, but cash and realized PnL disagree");
  const realizedByCoin=new Map();
  for(const ev of state.events){
    if(ev.kind==="SIMULATED_SELL")
      realizedByCoin.set(ev.symbol,(realizedByCoin.get(ev.symbol)||0)+ev.realizedPnlUSD);
  }
  const sortedPositions=Object.values(state.positions).map(pos=>({
    symbol:pos.symbol,open:pos.open,initialScore:pos.entryScore,
    realizedPnlUSD:realizedByCoin.get(pos.symbol)||0,
    openPnlUSD:pos.open&&endPrices[pos.symbol]?
      pos.remainingQty*endPrices[pos.symbol]*(1-SLIPPAGE)*(1-FEES)-
      pos.totalCostUsd*(pos.remainingQty/pos.qty):0,
    remainingQty:pos.remainingQty,t2Bought:pos.t2Bought,
  })).sort((a,b)=>(b.realizedPnlUSD+b.openPnlUSD)-(a.realizedPnlUSD+a.openPnlUSD));
  state.complete=true;
  const result={from:nowISO(START),to:nowISO(cutoff),days:DAYS,
    adaptiveMarketPolicyEnabled:ADAPTIVE,adaptivePolicyVariant:ADAPTIVE?ADAPTIVE_VARIANT:"baseline",
    dataCoverage:{requested:LT_COINS.length,eligible:eligible.length,excluded:excluded.length,
      exclusions:excluded,eligibleSymbols:eligible,
      historyBtc4h:btc4.length,historyBtc6h:btc6.length,fngDays:meta.fngEntries},
    simulation:final,wins:wins.length,losses:losses.length,winRatePct:signedTrades.length?
      Number((wins.length/signedTrades.length*100).toFixed(2)):null,
    maxDrawdownPct:Number(maxDrawdownPct.toFixed(2)),
    soldPnlUSD:Number(soldPnlUSD.toFixed(3)),
    totalFullyClosedPositions:state.closedPositionsCount,
    weekly,maxTradesSimulated:signedTrades.length,benchmarkBTC,counters,
    closedByReason:state.closedByReason,topAssets:sortedPositions.slice(0,12),
    worstAssets:sortedPositions.slice(-10),lastEvents:state.events.slice(-20),
    totalEvents:state.events.length,api:meta,ledgerReconciled:final.openPositions>0?null:true,
    limitations:["Five months remains insufficient to establish durable risk-adjusted profitability.",
      "Six-hour OPEN tick fills do not model intrabar stops, gaps, spread or order book depth exactly.",
      "Historical F&G and a closed-BTC regime are modelled; missing data blocks buys.",
      "Only currently configured symbols with enough historical data are included (survivorship bias).",
      "All profit/loss figures are hypothetical after assumed 0.1% fee and 0.1% adverse slippage per side.",
      "No account access and no real orders.",
      "Historical results are in-sample for the strategy as configured after this interval; do not treat as forward-tested."],
  };
  say("LT_5M_FINAL",result);
}
if(process.argv[1] && fileURLToPath(import.meta.url)===fileURLToPath(new URL("file://"+process.argv[1])))
  await run().catch(err=>{say("LT_5M_FATAL",{error:safeErr(err)});process.exitCode=1;});
