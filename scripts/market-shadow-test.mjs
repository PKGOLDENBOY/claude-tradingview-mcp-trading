/**
 * AlphaBot seven-hour REAL MARKET / ZERO-ORDER shadow evaluation.
 *
 * Public BitGet SPOT market-data GET endpoints ONLY. Never reads user API keys,
 * never imports bot.js, never sends any authenticated request, and has no buy,
 * sell, order, or POST logic.
 *
 * Six strategy *signal proxies*, not the complete production entry engine:
 * scalp, swing, breakout, momentum, long-term, new-listing sniper.
 * Paper positions use realistic bid/ask plus configurable taker fees/slippage.
 * Every report labels simulation P&L as simulated, not actual account profit.
 */
import { fileURLToPath } from "node:url";
import { loadShadowCheckpoint, saveShadowCheckpoint, appendShadowEvidence } from "../lib/shadow-checkpoint.mjs";

export const SAFETY = Object.freeze({
  exchangeWrites: false,
  authenticatedCalls: false,
  orderRequests: false,
  mode: "PUBLIC_MARKET_READ_ONLY_SHADOW",
});
export const STRATEGIES = Object.freeze(["scalp","swing","breakout","momentum","longterm","sniper"]);
export const CORE = Object.freeze(["BTCUSDT","ETHUSDT","SOLUSDT","LINKUSDT","ADAUSDT"]);
const ORIGIN = "https://api.bitget.com";
const MINUTES = 60_000;
const FEES = 0.001; // 0.1% per side
const SLIPPAGE = 0.001; // adverse 0.1% per side
const VIRTUAL_USD = 100; // simulated independent risk budget per position
const MAX_ENTRIES_PER_STRATEGY_PER_DAY = 3; // preserve cap as a daily limit across a two-month test
const SHADOW_CHECKPOINT_PATH = process.env.SHADOW_STATE_FILE || "/shadow-data/shadow-checkpoint.json";
const SHADOW_EVENTS_PATH = process.env.SHADOW_EVENTS_FILE || "/shadow-data/shadow-events.ndjson";
let STARTED = Date.now();
let DURATION_MS = Math.max(1, Number(process.env.SHADOW_DURATION_MINUTES || 420)) * MINUTES;
const explicitEnd = Date.parse(process.env.SHADOW_END_AT || "");
let ENDS = Number.isFinite(explicitEnd) ? explicitEnd : STARTED + DURATION_MS;
if (ENDS <= STARTED) throw new Error("SHADOW_INVALID_TEST_END: end must be in the future");
DURATION_MS = ENDS - STARTED;
const TICK_MS = Math.max(30_000, Number(process.env.SHADOW_CYCLE_SECONDS || 300) * 1000);
const candleTtlMs = Object.freeze({"15min":5*MINUTES,"1h":10*MINUTES,"4h":45*MINUTES,"1day":60*MINUTES,"1week":90*MINUTES});
const candleBarMs = Object.freeze({"15min":15*MINUTES,"1h":60*MINUTES,"4h":240*MINUTES,"1day":1440*MINUTES,"1week":10080*MINUTES});
const cache = new Map();
const positions = Object.fromEntries(STRATEGIES.map(s=>[s,new Map()]));
const summary = Object.fromEntries(STRATEGIES.map(s=>[s,{evaluations:0,qualifyingSignals:0,entries:0,exits:0,wins:0,losses:0,realizedUSD:0,markedUSD:0,open:0,blocked:{},dailyDate:"",dailyEntries:0,grossProfitUSD:0,grossLossUSD:0,peakRealizedUSD:0,maxRealizedDrawdownUSD:0}]));
let previousListings = null;
let knownListingsCount = 0;
let errors = 0, cycles = 0, quotes = 0, pendingEvents = [];
const time = () => new Date().toISOString();
const f = (n,d=4) => Number(n?.toFixed(d));
const emit = (tag,obj) => {
  const event = {tag,time:time(),safety:SAFETY.mode,...obj};
  if(tag==="SHADOW_ENTRY" || tag==="SHADOW_EXIT") appendShadowEvidence(SHADOW_EVENTS_PATH,event);
  console.log(JSON.stringify(event));
};
const n = v => Number(v);
const wait = ms => new Promise(ok=>setTimeout(ok,ms));

export function rsi(values,length=14) {
  if (!Array.isArray(values) || values.length < length+1) return null;
  let up=0,down=0;
  for(let i=1;i<=length;i++){const v=values[i]-values[i-1];if(v>0)up+=v;else down-=v}
  up/=length;down/=length;
  for(let i=length+1;i<values.length;i++){
    const d=values[i]-values[i-1];up=(up*(length-1)+Math.max(0,d))/length;down=(down*(length-1)+Math.max(0,-d))/length;
  }
  if(down===0) return up===0 ? 50 : 100;
  return 100-100/(1+up/down);
}
export function ema(values,length) {
  if (!Array.isArray(values) || values.length < length) return null;
  let avg=values.slice(0,length).reduce((a,b)=>a+b,0)/length;
  for(const v of values.slice(length))avg = v * (2/(length+1)) + avg * (1-2/(length+1));
  return avg;
}
export function rollingVwap(bars,length=20) {
  if(!Array.isArray(bars) || bars.length<length)return null;
  const b=bars.slice(-length),volume=b.reduce((s,x)=>s+x.volume,0);
  return volume>0 ? b.reduce((s,x)=>s+((x.high+x.low+x.close)/3)*x.volume,0)/volume : null;
}
export function parseClosedCandles(data,granularity,nowMs=Date.now()){
  const interval=candleBarMs[granularity];
  if(!interval || !Array.isArray(data))throw new Error("Unrecognized candle interval/shape");
  const rows=data.map(row=>({ts:n(row[0]),open:n(row[1]),high:n(row[2]),low:n(row[3]),close:n(row[4]),volume:n(row[5])}))
    .filter(c=>Number.isSafeInteger(c.ts) && c.ts>0 && c.ts+interval <= nowMs &&
      [c.open,c.high,c.low,c.close,c.volume].every(v=>Number.isFinite(v) && v>=0) &&
      c.open>0 && c.close>0 && c.high>=Math.max(c.open,c.close,c.low) && c.low<=Math.min(c.open,c.close))
    .sort((a,b)=>a.ts-b.ts);
  return [...new Map(rows.map(c=>[c.ts,c])).values()];
}
export function evaluateSignals({bars15,bars1h,bars4h,bars1d,bars1w,quote,isNewListing=false}){
  const result={};
  const close=b=>b?.map(x=>x.close) || [];
  const latest=b=>b?.at(-1);
  const r3=rsi(close(bars15),3), r3prior=rsi(close(bars15).slice(0,-1),3), vw=rollingVwap(bars15), e8=ema(close(bars15),8);
  const q=n(quote?.lastPr), volUsd=n(quote?.usdtVolume||quote?.quoteVolume);
  const change=n(quote?.change24h);
  const liquid=Number.isFinite(volUsd)&&volUsd>=1_000_000 && Number.isFinite(q) && q>0;
  result.scalp={signal:liquid&&r3!==null&&r3prior!==null&&vw!==null&&e8!==null &&
    r3<35&&r3>r3prior&&q>=vw*0.985&&q<=vw*1.012&&q>=e8*0.985,
    reason:!liquid?"thin-volume":"rsi3-vwap-ema8",diagnostics:{rsi3:f(r3??0,2),vwap:f(vw??0,4)}};
  const s3=rsi(close(bars4h),3),s14=rsi(close(bars4h),14),se21=ema(close(bars4h),21);
  result.swing={signal:liquid&&s3!==null&&s14!==null&&se21!==null&&
    (s3<40||s14<50) && q>0 && latest(bars4h)?.close>se21*0.95,
    reason:!liquid?"thin-volume":"4h-oversold-structure",diagnostics:{rsi3:f(s3??0,2),rsi14:f(s14??0,2)}};
  const hour=latest(bars1h),before=(bars1h||[]).slice(-21,-1),lastVol=before.reduce((x,c)=>x+c.volume,0)/(before.length||1);
  const highest=before.length===20?Math.max(...before.map(c=>c.high)):Infinity;
  result.breakout={signal:liquid&&!!hour && hour.close>highest && lastVol>0 && hour.volume>=1.4*lastVol &&
    (rsi(close(bars1h),14)??0)>55,
    reason:"1h-high-volume-resistance-break",diagnostics:{lastHigh:Number.isFinite(highest)?f(highest):null}};
  const rising=bars15?.length>=3 && latest(bars15).close > bars15.at(-3).close;
  result.momentum={signal:liquid&&change>=0.04 && rising && q>e8,
    reason:"24h-gainer-plus-rising-15m",diagnostics:{change24hPct:f(change*100,2)}};
  const de21=ema(close(bars1d),21),w14=rsi(close(bars1w),14),d14=rsi(close(bars1d),14);
  result.longterm={signal:liquid&&de21!==null&&w14!==null&&d14!==null &&
    latest(bars1d)?.close>de21 && w14>45 && w14<78 && d14<55,
    reason:"weekly-daily-multi-timeframe",diagnostics:{weeklyRsi14:f(w14??0,2),dailyRsi14:f(d14??0,2)}};
  result.sniper={signal:liquid&&isNewListing&&change<0.8,
    reason:isNewListing?"new-listing-screen":"no-new-listing-detected",diagnostics:{isNewListing}};
  return result;
}
async function publicGet(path,params={}) {
  if(!path.startsWith("/api/v2/spot/market/") && path!=="/api/v2/spot/public/symbols")
    throw new Error("STRICT_READ_ONLY: endpoint not allowlisted");
  const url=new URL(ORIGIN+path);
  for(const [k,v] of Object.entries(params)) url.searchParams.set(k,String(v));
  const res=await fetch(url, { method:"GET", signal:AbortSignal.timeout(9000),
    headers:{"Accept":"application/json","User-Agent":"AlphaBot-public-readonly-shadow/1.0"}});
  if(!res.ok)throw new Error("GET "+path+" HTTP "+res.status);
  const j=await res.json();
  if(j.code!=="00000" || !Array.isArray(j.data))throw new Error("BitGet GET response invalid "+path);
  return j.data;
}
async function candles(symbol,granularity) {
  const key=symbol+":"+granularity,old=cache.get(key),now=Date.now();
  if(old && now-old.at<candleTtlMs[granularity])return old.bars;
  const rows=await publicGet("/api/v2/spot/market/candles",{symbol,granularity,limit:120});
  const closed=parseClosedCandles(rows,granularity,now);
  if(closed.length<22)throw new Error("Not enough CLOSED "+granularity+" bars for "+symbol);
  cache.set(key,{at:now,bars:closed});
  return closed;
}
function virtualFill(quote,side) {
  const last=n(quote?.lastPr), raw=side==="buy"?n(quote?.askPr):n(quote?.bidPr);
  const quotePx=Number.isFinite(raw)&&raw>0?raw:last;
  if(!Number.isFinite(quotePx)||quotePx<=0)return null;
  return side==="buy"?quotePx*(1+SLIPPAGE):quotePx*(1-SLIPPAGE);
}
export function positionPnl(pos,quote) {
  const exit=virtualFill(quote,"sell");
  if(!exit)return null;
  const proceeds=pos.quantity*exit, exitFee=proceeds*FEES;
  return proceeds-exitFee-pos.totalCost;
}
const exits={
  scalp:{stop:0.025,tp:0.04,maxMin:180},
  swing:{stop:0.05,tp:0.10,maxMin:8*24*60},
  breakout:{stop:0.03,tp:0.06,maxMin:24*60},
  momentum:{stop:0.03,tp:0.06,maxMin:240},
  longterm:{stop:0.25,tp:0.30,maxMin:21*24*60},
  sniper:{stop:0.08,tp:0.20,maxMin:25},
};
function manageOpen(tickers) {
  const now=Date.now();
  for(const strat of STRATEGIES)for(const [symbol,pos] of positions[strat]){
    const quote=tickers.get(symbol);if(!quote)continue;
    const px=n(quote.lastPr);if(!Number.isFinite(px)||px<=0)continue;
    const moves=(px/pos.entryPrice)-1, held=(now-pos.opened)/MINUTES,rule=exits[strat];
    let reason=moves<=-rule.stop?"STOP":moves>=rule.tp?"TAKE_PROFIT":held>=rule.maxMin?"TIME_EXIT":null;
    if(!reason)continue;
    const pnl=positionPnl(pos,quote);if(pnl===null)continue;
    positions[strat].delete(symbol);
    const state=summary[strat];state.exits++;state.realizedUSD+=pnl;
    if(pnl>0){state.wins++;state.grossProfitUSD+=pnl;}
    else{state.losses++;state.grossLossUSD+=Math.abs(pnl);}
    state.peakRealizedUSD=Math.max(state.peakRealizedUSD,state.realizedUSD);
    state.maxRealizedDrawdownUSD=Math.max(state.maxRealizedDrawdownUSD,state.peakRealizedUSD-state.realizedUSD);
    emit("SHADOW_EXIT",{strategy:strat,symbol,reason,simulatedPnlUSD:f(pnl,4),heldMinutes:f(held,1)});
  }
}
function enter(strat,symbol,quote){
  const state=summary[strat];if(state.dailyDate!==new Date().toISOString().slice(0,10)) {
    state.dailyDate=new Date().toISOString().slice(0,10);
    state.dailyEntries=0;
  }
  if(state.dailyEntries>=MAX_ENTRIES_PER_STRATEGY_PER_DAY)return;
  if(positions[strat].has(symbol)||positions[strat].size>=2)return;
  const entryPrice=virtualFill(quote,"buy");
  if(!entryPrice)return;
  const quantity=VIRTUAL_USD/entryPrice, totalCost=VIRTUAL_USD*(1+FEES);
  positions[strat].set(symbol,{opened:Date.now(),quantity,entryPrice,totalCost});
  state.entries++;state.dailyEntries++;
  emit("SHADOW_ENTRY",{strategy:strat,symbol,simulatedNotionalUSD:VIRTUAL_USD,entryPrice:f(entryPrice,8)});
}
function snapshot(tickers){
  return Object.fromEntries(STRATEGIES.map(strat=>{
    const state=summary[strat];let marked=0,uncertain=0;
    for(const [sym,p]of positions[strat]){const q=tickers.get(sym);const pnl=q?positionPnl(p,q):null;if(pnl===null)uncertain++;else marked+=pnl}
    state.markedUSD=marked;state.open=positions[strat].size;
    return [strat,{evaluations:state.evaluations,qualifyingSignals:state.qualifyingSignals,entries:state.entries,
      exits:state.exits,wins:state.wins,losses:state.losses,open:state.open,unpricedOpen:uncertain,
      realizedPnlUSD:f(state.realizedUSD),openMarkedPnlUSD:f(marked),
      winRatePct:state.exits>0?f(state.wins/state.exits*100,2):null,
      profitFactor:state.grossLossUSD>0?f(state.grossProfitUSD/state.grossLossUSD,3):null,
      realizedPeakToTroughDrawdownUSD:f(state.maxRealizedDrawdownUSD),
      combinedSimulatedPnlUSD:uncertain===0?f(state.realizedUSD+marked):null}];
  }));
}
function collectNewListings(rows){
  const current=new Set(rows.filter(x=>x.symbol?.endsWith("USDT")&&x.status==="online").map(x=>x.symbol));
  const fresh=previousListings?[...current].filter(x=>!previousListings.has(x)):[];
  previousListings=current;knownListingsCount=current.size;
  return new Set(fresh);
}
async function cycle(){
  cycles++;const start=Date.now();
  const data=await publicGet("/api/v2/spot/market/tickers");
  const tickers=new Map(data.filter(q=>q.symbol&&Number.isFinite(n(q.lastPr))&&n(q.lastPr)>0).map(q=>[q.symbol,q]));
  quotes+=tickers.size;
  let listings=new Set();
  try { listings=collectNewListings(await publicGet("/api/v2/spot/public/symbols")); }
  catch(err){errors++;emit("SHADOW_MARKET_WARNING",{step:"listings",error:String(err.message).slice(0,150)});}
  manageOpen(tickers);
  const movers=data.filter(q=>q.symbol?.endsWith("USDT")&&!/UP|DOWN|BEAR|BULL|USDC|TUSD|BUSD|DAI/.test(q.symbol) &&
    n(q.change24h)>=0.04 && n(q.usdtVolume||q.quoteVolume)>=1_000_000)
    .sort((a,b)=>n(b.change24h)-n(a.change24h)).slice(0,5).map(x=>x.symbol);
  const symbols=[...new Set([...CORE,...movers,...listings])].slice(0,15);
  const needGran={"15min":new Set([...CORE,...movers]),"1h":new Set(CORE),
    "4h":new Set(CORE),"1day":new Set(CORE),"1week":new Set(CORE)};
  const cached={};
  for(const gran of Object.keys(needGran)){
    for(const symbol of needGran[gran]){
      try {cached[symbol]??={};cached[symbol][gran]=await candles(symbol,gran);}
      catch(err){errors++;emit("SHADOW_MARKET_WARNING",{step:"candles",symbol,gran,error:String(err.message).slice(0,120)});}
    }
  }
  for(const symbol of symbols){
    const quote=tickers.get(symbol);if(!quote)continue;
    const k=cached[symbol]||{};
    const res=evaluateSignals({bars15:k["15min"],bars1h:k["1h"],bars4h:k["4h"],
      bars1d:k["1day"],bars1w:k["1week"],quote,isNewListing:listings.has(symbol)});
    for(const strategy of STRATEGIES){
      if(strategy!=="momentum" && strategy!=="sniper" && !CORE.includes(symbol))continue;
      if(strategy==="momentum" && !movers.includes(symbol))continue;
      if(strategy==="sniper" && !listings.has(symbol))continue;
      summary[strategy].evaluations++;
      if(!res[strategy].signal)continue;
      summary[strategy].qualifyingSignals++;
      enter(strategy,symbol,quote);
    }
  }
  const progress=(Date.now()-STARTED)/DURATION_MS;
  emit("SHADOW_CYCLE",{cycle:cycles,progressPct:f(progress*100,1),durationSec:f((Date.now()-start)/1000,2),
    trackedSymbols:symbols,marketQuotes:tickers.size,knownListings:knownListingsCount,newListings:[...listings],errors,
    stats:snapshot(tickers)});
}
async function main(){
  emit("SHADOW_START",{startedAt:new Date(STARTED).toISOString(),targetEndAt:new Date(ENDS).toISOString(),
    durationHours:f(DURATION_MS/3600000,3),strategies:STRATEGIES,symbols:CORE,
    method:"PUBLIC READ-ONLY REAL MARKET DATA; independent rule-level signal proxies, not production bot fills",
    estimatedPerSideFeePct:FEES*100,estimatedPerSideSlippagePct:SLIPPAGE*100,
    exchangeKeyPresent:false,exchangeCalls:"GET ONLY; NO ORDERS",maxEntriesPerStrategyPerDay:MAX_ENTRIES_PER_STRATEGY_PER_DAY});
  let last=new Map();
  while(Date.now()<ENDS){
    try {await cycle();}catch(err){errors++;emit("SHADOW_CYCLE_ERROR",{error:String(err?.message||err).slice(0,250)});}
    const ms=Math.min(TICK_MS,Math.max(0,ENDS-Date.now()));
    if(ms>0)await wait(ms);
  }
  // Use final real quotes to mark all open synthetic positions.
  try {last=new Map((await publicGet("/api/v2/spot/market/tickers")).map(q=>[q.symbol,q]));}catch(err){errors++;emit("SHADOW_FINAL_PRICE_ERROR",{error:String(err.message)});}
  emit("SHADOW_FINAL",{startedAt:new Date(STARTED).toISOString(),finishedAt:time(),
    elapsedHours:f((Date.now()-STARTED)/3600000,3),cycles,errors,quoteRecords:quotes,
    strategies:snapshot(last),noOrders:true,noExchangeWrites:true,
    limitation:"7 hours is too short for representative multi-day swings, long-term holds or rare listings; rule-level shadow signals are not exact Claude/TradingView production decisions."});
  process.exitCode=0;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===fileURLToPath(new URL("file://"+process.argv[1])))
  await main();
