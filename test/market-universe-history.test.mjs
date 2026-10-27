import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySpotUniverse,publicSpotMetadata,discoverBitgetSpotUniverse} from '../research/market-discovery.js';
import {normalizeSpotSymbols,planHistoryWindows,auditHourlyCandles,TEN_YEARS_DAYS} from '../research/market-universe-history.js';

const HOUR = 3600000;
const DAY = 86400000;
const NOW = Date.UTC(2026,9,27,12);
const sample = () => [
  {category:'SPOT',symbol:'BTCUSDT',baseCoin:'BTC',quoteCoin:'USDT',
    status:'online',launchTime:String(NOW-2*365*DAY),symbolType:'crypto'},
  {category:'SPOT',symbol:'NEWUSDT',baseCoin:'NEW',quoteCoin:'USDT',
    status:'online',launchTime:String(NOW-DAY),symbolType:'crypto'},
  {category:'SPOT',symbol:'THINUSDT',baseCoin:'THIN',quoteCoin:'USDT',
    status:'online',launchTime:String(NOW-70*DAY),symbolType:'crypto'},
  {category:'SPOT',symbol:'DELISTUSDT',baseCoin:'DELIST',quoteCoin:'USDT',
    status:'offline',launchTime:String(NOW-200*DAY)},
  {category:'SPOT',symbol:'STOCKUSDT',baseCoin:'STOCK',quoteCoin:'USDT',
    status:'online',symbolType:'stock',launchTime:String(NOW-200*DAY)},
  {category:'SPOT',symbol:'XUSD',baseCoin:'X',quoteCoin:'USD',
    status:'online',launchTime:String(NOW-200*DAY)}
];
const ticker = (symbol,turnover24h,bid1Price,ask1Price)=>({
  symbol,turnover24h:String(turnover24h),bid1Price:String(bid1Price),
  ask1Price:String(ask1Price)
});
test('spot inventory is not silently treated as a trade-eligible universe',()=>{
  const tickers=[ticker('BTCUSDT',100000000,100,100.1),ticker('NEWUSDT',10000000,1,1.001),
    ticker('THINUSDT',100,1,1.1)];
  const report=classifySpotUniverse(sample(),tickers,{nowMs:NOW});
  assert.equal(report.marketCount,3);
  assert.equal(report.researchEligibleCount,1);
  assert.equal(report.newlyListedCount,1);
  const btc=report.markets.find(m=>m.symbol==='BTCUSDT');
  assert.equal(btc.researchEligible,true);
  const coin=report.markets.find(m=>m.symbol==='NEWUSDT');
  assert.equal(coin.researchCohort,'NEW_LISTING');
  assert.ok(coin.researchExclusionReasons.includes('NEW_LISTING'));
  const thin=report.markets.find(m=>m.symbol==='THINUSDT');
  assert.ok(thin.researchExclusionReasons.includes('WIDE_OR_UNKNOWN_SPREAD'));
  assert.ok(thin.researchExclusionReasons.includes('LOW_OR_UNKNOWN_TURNOVER'));
  assert.equal(report.inventorySha256.length,64);
  assert.deepEqual(classifySpotUniverse(sample(),tickers,{nowMs:NOW}),report);
});
test('missing listing age or market depth cannot pass research filter',()=>{
  const instruments=[{category:'SPOT',symbol:'XYZUSDC',baseCoin:'XYZ',quoteCoin:'USDC',status:'online'}];
  const report=classifySpotUniverse(instruments,[{symbol:'XYZUSDC',turnover24h:'1000000'}],{nowMs:NOW});
  assert.equal(report.researchEligibleCount,0);
  assert.deepEqual(report.markets[0].researchExclusionReasons,
    ['WIDE_OR_UNKNOWN_SPREAD','UNKNOWN_LISTING_AGE']);
});
test('bad input and fabricated metadata fail closed',()=>{
  assert.throws(()=>classifySpotUniverse(null,[]),/INVALID/);
  assert.throws(()=>planHistoryWindows({symbol:'BTCUSDT',firstAvailableMs:0,nowMs:NOW,maxCandlesPerRequest:101}),/Invalid/);
  assert.deepEqual(normalizeSpotSymbols(sample()).map(x=>x.symbol),['BTCUSDT','NEWUSDT','STOCKUSDT','THINUSDT']);
});
test('public metadata makes only unauthenticated Bitget GET requests to allowlisted endpoints',async()=>{
  const logs=[];
  const instruments=sample();
  const tickers=[ticker('BTCUSDT',10000000,100,100.05)];
  const fetchFn=async(url,options)=>{
    const u=new URL(url);
    assert.equal(u.protocol,'https:');
    assert.equal(u.hostname,'api.bitget.com');
    assert.equal(u.searchParams.get('category'),'SPOT');
    assert.equal(options.method,'GET');
    assert.equal(options.credentials,'omit');
    assert.equal(options.headers.Authorization,undefined);
    assert.ok(['/api/v3/market/instruments','/api/v3/market/tickers'].includes(u.pathname));
    logs.push(u.pathname);
    return {ok:true,json:async()=>({code:'00000',data:u.pathname.endsWith('instruments')?instruments:tickers})};
  };
  await assert.rejects(publicSpotMetadata('/api/v3/trade/order',{fetchFn}),/ALLOWLIST/);
  const result=await discoverBitgetSpotUniverse({fetchFn,nowMs:NOW});
  assert.equal(result.researchEligibleCount,1);
  assert.deepEqual(logs,['/api/v3/market/instruments','/api/v3/market/tickers']);
});
test('ten year paging is bounded to closed hourly candles and 100 rows per request',()=>{
  const nowMs=NOW+15*60000; // partial current hour excluded
  const firstAvailableMs=nowMs-10*365*DAY;
  const plan=planHistoryWindows({symbol:'BTCUSDT',firstAvailableMs,nowMs});
  assert.ok(plan.length > 800);
  assert.ok(plan.every(x=>x.expectedHours<=100));
  assert.equal(plan.at(-1).endMs,NOW-HOUR);
  assert.equal(plan.reduce((n,x)=>n+x.expectedHours,0),
    (plan.at(-1).endMs-plan[0].startMs)/HOUR+1);
  assert.equal(TEN_YEARS_DAYS,3653);
  const recent=planHistoryWindows({symbol:'NEWUSDT',firstAvailableMs:NOW-10*DAY,nowMs:NOW});
  assert.equal(recent.length,3); // 240 hours: 90+90+60
  assert.equal(recent[0].startMs,NOW-10*DAY);
});
test('hourly audit exposes gaps, duplicates and invalid/out-of-window records',()=>{
  const base=NOW-4*HOUR;
  const audit=auditHourlyCandles([[base,1],[base+HOUR,1],[base+HOUR,1],
    [base+3*HOUR,1],[base+111,1],[base+20*HOUR,1]],
    {startMs:base,endMs:base+3*HOUR});
  assert.deepEqual(audit,{expected:4,unique:3,missing:1,duplicates:1,invalid:1,outside:1});
});
