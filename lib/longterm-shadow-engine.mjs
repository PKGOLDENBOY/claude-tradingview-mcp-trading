/**
 * Pure long-term strategy scorer and paper ledger. NO network or exchange writes.
 * Mirrors bot.js:checkLtEntry's 11 conditions, T1/T2 sizing, +30/+60/+100
 * exits, -25% inventory stop, 21-day dead-money exit, +15% spike trail.
 * Production bot's market-regime and F&G guards must be passed separately.
 */
export const LT_COINS = Object.freeze([
  "ETHUSDT","ADAUSDT","AXSUSDT","AVAXUSDT","DOGEUSDT","ETCUSDT","FETUSDT",
  "FILUSDT","GALAUSDT","HBARUSDT","ICPUSDT","LINKUSDT","LTCUSDT","LUNCUSDT",
  "MANAUSDT","PEPEUSDT","SEIUSDT","SLPUSDT","SUIUSDT","THETAUSDT","VIRTUALUSDT",
  "VRAUSDT","XRPUSDT","ARKMUSDT","STRKUSDT","CHRUSDT","PHBUSDT","ZILUSDT",
  "EGLDUSDT","IOTAUSDT","INJUSDT","DOTUSDT","JASMYUSDT","RUNEUSDT","ALICEUSDT",
  "ORAIUSDT","ORDIUSDT","NEOUSDT","COTIUSDT","1INCHUSDT","COMPUSDT",
  "FLOWUSDT","KAVAUSDT","PAALUSDT","MERLUSDT",
]);
export const CONFIG_LT = Object.freeze({
  t1USD:2.50,t2USD:2.50,cashReserveUSD:20,
  feeRate:0.001,slippageRate:0.001,
  hardStopPct:-25,deadMoneyDays:21,deadMoneyProfitPct:10,
  trailArmPct:15,trailGivebackPct:10,
  t2DipPct:8,initialUSD:150, // $150 is a virtual test bankroll, NOT exchange funds
});
const isNumber = v => typeof v==="number" && Number.isFinite(v);
const number = v=>Number(v);
const money = v=>Math.round(v*1000000)/1000000;
export function ema(closes, period){
  if(!Array.isArray(closes)||closes.length<period)return null;
  const k=2/(period+1);
  let e=closes.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(const close of closes.slice(period))e=close*k+e*(1-k);
  return e;
}
export function rsi(closes,period=14){
  if(!closes||closes.length<period+1)return null;
  let wins=0,losses=0;
  for(let i=closes.length-period;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    if(d>0)wins+=d;else losses-=d;
  }
  if(losses===0)return 100;
  return 100-100/(1+wins/losses);
}
export function macd(closes){
  if(!closes||closes.length<35)return null;
  const e12=ema(closes,12), e26=ema(closes,26);
  const line=e12-e26,series=[];
  for(let i=26;i<closes.length;i++){
    const v=ema(closes.slice(0,i+1),12)-ema(closes.slice(0,i+1),26);
    if(v!==0)series.push(v);
  }
  if(series.length<9)return null;
  const signal=ema(series,9);
  return {macdLine:line,signal,histogram:line-signal};
}
export function bollinger(closes,period=20,mult=2){
  if(!closes||closes.length<period)return null;
  const a=closes.slice(-period),mean=a.reduce((s,v)=>s+v,0)/period;
  const stdev=Math.sqrt(a.reduce((s,v)=>s+(v-mean)**2,0)/period);
  const upper=mean+mult*stdev,lower=mean-mult*stdev;
  return {pct:upper!==lower?(a.at(-1)-lower)/(upper-lower):null};
}
export function ichimoku(bars){
  if(!bars||bars.length<78)return null;
  const mid=n=>{
    const last=bars.slice(-n);
    return (Math.max(...last.map(x=>x.high))+Math.min(...last.map(x=>x.low)))/2;
  };
  const tenkan=mid(9),kijun=mid(26),a=(tenkan+kijun)/2,b=mid(52);
  return {aboveCloud:bars.at(-1).close>Math.max(a,b),bullishCross:tenkan>kijun};
}
export function scoreLtEntry(weekly,daily){
  // Expect fully closed bars from the caller; NEVER include an active candle.
  if(!weekly||weekly.length<35||!daily||daily.length<78)
    return {pass:false,passed:0,total:11,reason:"insufficient closed indicator warmup"};
  const w=weekly.map(x=>x.close),d=daily.map(x=>x.close);
  if(![...w,...d].every(x=>isNumber(x)&&x>0))return {pass:false,passed:0,total:11,reason:"invalid candle"};
  const w52High=Math.max(...w.slice(-52)),wp=w.at(-1),dp=d.at(-1);
  if(wp<w52High*0.30)return {pass:false,passed:0,total:11,reason:"dead-coin 52W filter"};
  const w10=ema(w,10),w20=ema(w,20),wr=rsi(w,14),wm=macd(w);
  const d21=ema(d,21),d50=ema(d,50),dr=rsi(d,14),dm=macd(d);
  const dVolume=daily.slice(-20),avgVolume=dVolume.reduce((s,x)=>s+x.volume,0)/dVolume.length;
  const vol3=daily.slice(-3).reduce((s,x)=>s+x.volume,0)/3;
  const dVolRatio=vol3/(avgVolume>0?avgVolume:1);
  const bb=bollinger(d),ichi=ichimoku(daily);
  if(![w10,w20,wr,d21,d50,dr,dVolRatio].every(isNumber) || !wm||!dm||!bb||!ichi)
    return {pass:false,passed:0,total:11,reason:"invalid indicator"};
  const sma50=d.slice(-50).reduce((s,v)=>s+v,0)/50;
  const checks={
    wPriceAboveEma10:wp>w10,
    wEmaStackBull:w10>w20,
    wRsiHealthy:wr>=40&&wr<=75,
    wMacdBull:wm.histogram>0||wm.macdLine>wm.signal*0.97,
    dRsiPullback:dr>=30&&dr<=65,
    dAboveSupport:dp>d50||dp>d21,
    dMacdPositive:dm.histogram>0,
    dVolumeAlive:dVolRatio>=0.65,
    dGoldenCross:d21>sma50,
    dBBNotExtended:isNumber(bb.pct)&&bb.pct<=0.65,
    dIchimokuBull:ichi.aboveCloud||ichi.bullishCross,
  };
  const passed=Object.values(checks).filter(Boolean).length;
  // Production code says 7/11 in a comment but actually >= 6; reproduce code, not comment.
  return {pass:passed>=6&&wr<80&&dr<72,passed,total:11,
    diagnostics:{weeklyRsi:money(wr),dailyRsi:money(dr),weeklyPrice:money(wp),dailyPrice:money(dp)},
    checks};
}
export function parseClosedBars(raw,granularity,now=Date.now()){
  const ms={"1day":86400000,"1week":604800000,"4h":14400000}[granularity];
  if(!ms||!Array.isArray(raw))throw new Error("invalid exchange candle response");
  return [...new Map(raw.map(a=>({timestamp:number(a[0]),open:number(a[1]),high:number(a[2]),low:number(a[3]),close:number(a[4]),volume:number(a[5])}))
    .filter(x=>Number.isSafeInteger(x.timestamp)&&x.timestamp>0&&x.timestamp+ms<=now&&
      [x.open,x.high,x.low,x.close,x.volume].every(isNumber)&&
      x.open>0&&x.close>0&&x.low>0&&x.volume>=0&&x.high>=Math.max(x.open,x.close,x.low)&&x.low<=Math.min(x.open,x.close))
    .sort((a,b)=>a.timestamp-b.timestamp).map(x=>[x.timestamp,x])).values()];
}
export function makeState(startAt,days=35){
  if(!Number.isSafeInteger(startAt))throw new Error("invalid start time");
  return {schema:1,mode:"PUBLIC_MARKET_READ_ONLY_LONGTERM",
    startAt:new Date(startAt).toISOString(),endAt:new Date(startAt+days*86400000).toISOString(),
    initialUsd:CONFIG_LT.initialUSD,cashUsd:CONFIG_LT.initialUSD,positions:{},
    events:[],cycles:0,dataErrors:0,complete:false,
    scans:0,qualifiedSignals:0,marketBlockedCycles:0,
    lastCycleAt:null,closedByReason:{},indicatorsMissing:0};
}
function buyPrice(mark){return mark*(1+CONFIG_LT.slippageRate);}
function sellPrice(mark){return mark*(1-CONFIG_LT.slippageRate);}
function event(state,e){state.events.push({date:e.date??new Date().toISOString(),...e});}
export function buyVirtual(state,symbol,marketPrice,sizeUSD,now,kind="T1",score=null){
  if(!isNumber(marketPrice)||marketPrice<=0)throw new Error("no fresh positive price");
  const cost=sizeUSD*(1+CONFIG_LT.feeRate);
  if(state.cashUsd-cost<CONFIG_LT.cashReserveUSD) return false;
  const price=buyPrice(marketPrice),qty=sizeUSD/price;
  const existing=state.positions[symbol];
  if(kind==="T1"&&existing?.open)return false;
  if(kind==="T2"&&(!existing?.open||existing.t2Bought))return false;
  const pos=existing || {symbol,open:true,entryTime:new Date(now).toISOString(),t1Price:price,
    qty:0,totalCostUsd:0,avgEntry:0,remainingQty:0,peakPrice:price,
    trailArmed:false,t2Bought:false,t1Qty:0,ladderDone:[false,false,false]};
  const oldQty=pos.qty;pos.qty+=qty;pos.remainingQty+=qty;pos.totalCostUsd+=cost;
  pos.avgEntry=(oldQty*pos.avgEntry+qty*price)/pos.qty;
  if(kind==="T1"){pos.t1Qty=qty;pos.t1Price=price;pos.entryScore=score;}
  else pos.t2Bought=true;
  state.cashUsd-=cost;state.positions[symbol]=pos;
  event(state,{kind:"SIMULATED_BUY",tranche:kind,symbol,quantity:money(qty),price:money(price),costUSD:money(cost),score});
  return true;
}
export function sellVirtual(state,symbol,marketPrice,quantity,reason,now){
  const p=state.positions[symbol];
  if(!p?.open || !isNumber(marketPrice)||marketPrice<=0 || !isNumber(quantity)||quantity<=0 ||
    quantity>p.remainingQty*(1+1e-9))throw new Error("invalid virtual sell");
  const qty=Math.min(quantity,p.remainingQty), price=sellPrice(marketPrice);
  const proceeds=qty*price*(1-CONFIG_LT.feeRate);
  // Cost basis includes entry fees and is allocated pro-rata across quantity sold.
  const basis=p.totalCostUsd*(qty/p.qty);
  const realized=proceeds-basis;
  state.cashUsd+=proceeds;
  p.remainingQty-=qty;
  p.realizedPnlUsd=(p.realizedPnlUsd||0)+realized;
  if(p.remainingQty<=1e-12){p.remainingQty=0;p.open=false;p.closedAt=new Date(now).toISOString();}
  state.closedByReason[reason]=(state.closedByReason[reason]||0)+1;
  event(state,{kind:"SIMULATED_SELL",symbol,reason,quantity:money(qty),price:money(price),proceedsUSD:money(proceeds),realizedPnlUSD:money(realized)});
  return realized;
}
export function manageLongterm(state,prices,now,marketBlocked=false){
  for(const p of Object.values(state.positions)){
    if(!p.open)continue;
    const price=prices[p.symbol];if(!isNumber(price)||price<=0)continue;
    const pct=(price/p.avgEntry-1)*100,heldDays=(now-Date.parse(p.entryTime))/86400000;
    p.peakPrice=Math.max(p.peakPrice||0,price);
    if(pct>=CONFIG_LT.trailArmPct)p.trailArmed=true;
    const giveback=100*(p.peakPrice-price)/p.peakPrice;
    let exitReason=null;
    if(pct<=CONFIG_LT.hardStopPct)exitReason="CATASTROPHIC_STOP";
    else if(heldDays>CONFIG_LT.deadMoneyDays&&pct<CONFIG_LT.deadMoneyProfitPct)exitReason="DEAD_MONEY";
    else if(p.trailArmed&&giveback>=CONFIG_LT.trailGivebackPct)exitReason="SPIKE_TRAIL";
    if(exitReason){sellVirtual(state,p.symbol,price,p.remainingQty,exitReason,now);continue;}
    if(!p.t2Bought && !marketBlocked && 100*(p.t1Price-price)/p.t1Price>=CONFIG_LT.t2DipPct)
      buyVirtual(state,p.symbol,price,CONFIG_LT.t2USD,now,"T2",p.entryScore);
    // For consistency with production, target ladder 25% of total acquired units.
    for(const [index,target] of [30,60,100].entries()){
      if(!p.ladderDone[index] && pct>=target && p.remainingQty>0){
        sellVirtual(state,p.symbol,price,Math.min(p.qty*0.25,p.remainingQty),`LADDER_+${target}`,now);
        p.ladderDone[index]=true;
      }
    }
  }
}
export function snapshot(state,prices){
  let openMarketValue=0,unpriced=0,realized=0,openPositions=0,completeExits=0;
  for(const p of Object.values(state.positions)){
    realized+=p.realizedPnlUsd||0;
    if(!p.open){completeExits++;continue;}
    openPositions++;
    const price=prices[p.symbol];
    if(!isNumber(price)||price<=0){unpriced++;continue;}
    openMarketValue+=p.remainingQty*sellPrice(price)*(1-CONFIG_LT.feeRate);
  }
  const portfolioUSD=unpriced?null:state.cashUsd+openMarketValue;
  return {initialUSD:state.initialUsd,cashUSD:money(state.cashUsd),
    openPositions,completeExits,unpriced,realizedPnlUSD:money(realized),
    markToMarketUSD:portfolioUSD===null?null:money(portfolioUSD),
    combinedSimulatedPnlUSD:portfolioUSD===null?null:money(portfolioUSD-state.initialUsd),
    combinedReturnPct:portfolioUSD===null?null:money((portfolioUSD/state.initialUsd-1)*100),
    simulatedBuys:state.events.filter(e=>e.kind==="SIMULATED_BUY").length,
    simulatedSells:state.events.filter(e=>e.kind==="SIMULATED_SELL").length};
}
