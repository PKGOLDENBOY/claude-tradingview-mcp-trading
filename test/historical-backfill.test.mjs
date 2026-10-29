import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHistoricalPlan,verifyHistoricalPlan,historyRequestUrl,
  normalizeHistoryResponse,fetchHistoricalPage,historyPagePath,
  backfillHistoricalPages,saveHistoricalPlan,loadHistoricalPlan
} from '../research/historical-backfill.js';
import { planHistoryWindows } from '../research/market-universe-history.js';
import { historyPilotMain,parsePilotArgs } from '../scripts/research-history-pilot.mjs';

const H=3_600_000, NOW=Date.UTC(2026,9,29,12);
const row=(ts,price=100)=>[String(ts),String(price),String(price+1),
  String(price-1),String(price), '2.0','200.0'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const universe=()=>{
  const markets=[
    {symbol:'BTCUSDT',firstListedMs:NOW-5*H,researchEligible:true},
    {symbol:'THINUSDT',firstListedMs:null,researchEligible:false}
  ];
  return {exchange:'Bitget',market:'SPOT',asof:new Date(NOW).toISOString(),
    inventorySha256:hash(markets),marketCount:markets.length,markets};
};
const plan=()=>createHistoricalPlan(universe(),{nowMs:NOW,lookbackDays:1,maxMarkets:1,candlesPerPage:2});
const windows=()=>planHistoryWindows({
  symbol:'BTCUSDT',firstAvailableMs:NOW-5*H,nowMs:NOW,maxCandlesPerRequest:2,yearsDays:1
});
const withDir=async fn=>{
  const d=mkdtempSync(join(tmpdir(),'alpha-history-'));
  try{return await fn(d);}finally{rmSync(d,{recursive:true,force:true});}
};
const goodMock=(calls=[])=>async(url,opts)=>{
  const u=new URL(url);
  calls.push({url,opts});
  assert.equal(u.protocol,'https:');
  assert.equal(u.hostname,'api.bitget.com');
  assert.equal(u.pathname,'/api/v3/market/history-candles');
  assert.equal(u.searchParams.get('category'),'SPOT');
  assert.equal(u.searchParams.get('interval'),'1H');
  assert.equal(u.searchParams.get('limit'),'100');
  assert.equal(opts.method,'GET');
  assert.equal(opts.credentials,'omit');
  assert.equal(opts.headers.Authorization,undefined);
  assert.equal(opts.headers['ACCESS-KEY'],undefined);
  const start=Number(u.searchParams.get('startTime'))+H;
  const end=Number(u.searchParams.get('endTime'))-H;
  const data=[];
  for(let ts=start;ts<=end;ts+=H)data.push(row(ts));
  return {ok:true,status:200,json:async()=>({code:'00000',data:data.reverse()})};
};

test('frozen plan includes even unqualified current altcoins; no historic completeness claim',()=>{
  const p=createHistoricalPlan(universe(),{nowMs:NOW,lookbackDays:1,maxMarkets:2});
  assert.equal(p.markets.length,2);
  assert.equal(p.markets[1].researchEligible,false);
  assert.equal(p.markets[1].firstAvailableMs,NOW-86_400_000);
  assert.match(p.selection,/NOT_POINT_IN_TIME/);
  assert.equal(verifyHistoricalPlan(p),p);
  assert.throws(()=>verifyHistoricalPlan({...p,anchorNowMs:NOW+H}),/CHECKSUM/);
  assert.throws(()=>createHistoricalPlan(universe(),{nowMs:NOW,maxMarkets:101}),/INVALID/);
});

test('URL is hardcoded public GET with bounded aligned inclusive windows',()=>{
  const w=windows()[0],u=new URL(historyRequestUrl(w));
  assert.equal(u.searchParams.get('symbol'),'BTCUSDT');
  assert.equal(Number(u.searchParams.get('startTime')),w.startMs-H);
  assert.equal(Number(u.searchParams.get('endTime')),w.endMs+H);
  assert.equal(w.expectedHours,2);
  assert.throws(()=>historyRequestUrl({...w,symbol:'BTCUSDT/../../orders'}),/INVALID/);
  assert.throws(()=>historyRequestUrl({...w,expectedHours:101}),/INVALID/);
});

test('outside, duplicate, missing candles are measured without fabrication',()=>{
  const w=windows()[0];
  const data=[row(w.startMs-H),row(w.startMs),row(w.startMs),row(w.endMs)];
  const normalized=normalizeHistoryResponse(data,w);
  assert.deepEqual(normalized.rows.map(x=>x[0]),[w.startMs,w.endMs]);
  assert.equal(normalized.audit.rawRows,4);
  assert.equal(normalized.audit.outside,1);
  assert.equal(normalized.audit.duplicates,1);
  assert.equal(normalized.audit.missing,0);
  const sparse=normalizeHistoryResponse([row(w.startMs)],w);
  assert.equal(sparse.audit.missing,1);
  assert.equal(sparse.rows.length,1);
});

test('conflicting duplicates, malformed volumes, future timestamps, oversize API data fail closed',()=>{
  const w=windows()[0];
  assert.throws(()=>normalizeHistoryResponse([row(w.startMs),row(w.startMs,90)],w),/CONFLICT/);
  const negative=row(w.startMs);negative[5]='-3';
  assert.throws(()=>normalizeHistoryResponse([negative],w),/OHLCV/);
  assert.throws(()=>normalizeHistoryResponse([[String(w.startMs),'1']],w),/ROW/);
  assert.throws(()=>normalizeHistoryResponse(Array.from({length:101},()=>row(w.startMs)),w),/SIZE/);
});

test('HTTP retry uses only GET with no credentials and 429 backoff',async()=>{
  let n=0;const requests=[],delays=[];
  const fetchFn=async(url,opts)=>{
    n++;
    if(n===1)return {ok:false,status:429};
    return goodMock(requests)(url,opts);
  };
  const result=await fetchHistoricalPage(windows()[0],{
    fetchFn,sleepFn:async ms=>delays.push(ms)
  });
  assert.equal(n,2);
  assert.equal(result.rows.length,2);
  assert.deepEqual(delays,[500]);
  assert.equal(requests.length,1);
  await assert.rejects(fetchHistoricalPage(windows()[0],{
    fetchFn:async()=>({ok:false,status:401})
  }),/HISTORY_HTTP_401/);
});

test('bounded pages resume from immutable verified files without duplicate downloads',()=>withDir(async dir=>{
  const p=plan();
  const calls=[];
  const run=()=>backfillHistoricalPages({
    plan:p,outputDir:dir,maxNewPages:1,maxStorageBytes:1_000_000,
    minDelayMs:0,sleepFn:async()=>{},fetchFn:goodMock(calls)
  });
  const one=await run();
  assert.equal(one.downloadedPages,1);assert.equal(one.resumedPages,0);
  assert.equal(one.complete,false);
  const first=historyPagePath(dir,windows()[0]);
  assert.equal(existsSync(first),true);
  assert.equal(JSON.parse(readFileSync(first,'utf8')).rows.length,2);
  const two=await run();
  assert.equal(two.downloadedPages,1);assert.equal(two.resumedPages,1);
  assert.equal(calls.length,2);
  const three=await run();
  assert.equal(three.downloadedPages,1);assert.equal(three.resumedPages,2);
  assert.equal(three.complete,true);
  const four=await run();
  assert.equal(four.downloadedPages,0);assert.equal(four.resumedPages,3);
  assert.equal(four.complete,true);
  assert.equal(calls.length,3);
}));

test('corrupt or edited resume page fails closed without re-download',()=>withDir(async dir=>{
  const p=plan(),calls=[];
  const opts={plan:p,outputDir:dir,maxNewPages:1,maxStorageBytes:1_000_000,
    minDelayMs:0,sleepFn:async()=>{},fetchFn:goodMock(calls)};
  await backfillHistoricalPages(opts);
  const first=historyPagePath(dir,windows()[0]);
  const rec=JSON.parse(readFileSync(first,'utf8'));
  rec.rows[0][4]=9999; // replay forgery: checksum and OHLC invalid
  writeFileSync(first,JSON.stringify(rec));
  await assert.rejects(backfillHistoricalPages(opts),/CHECKSUM|INVALID|OHLCV/);
  assert.equal(calls.length,1);
}));

test('storage cap prevents a new page from being written',()=>withDir(async dir=>{
  writeFileSync(join(dir,'preexisting.bin'),'z'.repeat(49_500));
  const p=plan(),w=windows()[0];
  await assert.rejects(backfillHistoricalPages({
    plan:p,outputDir:dir,maxNewPages:1,maxStorageBytes:50_000,
    minDelayMs:0,sleepFn:async()=>{},fetchFn:goodMock()
  }),/BACKFILL_STORAGE_BUDGET_REACHED/);
  assert.equal(existsSync(historyPagePath(dir,w)),false);
}));

test('frozen plans must be saved once and verified on restart',()=>withDir(async dir=>{
  const p=plan(),name=join(dir,'frozen.json');
  saveHistoricalPlan(name,p);
  assert.deepEqual(loadHistoricalPlan(name),p);
  assert.throws(()=>saveHistoricalPlan(name,p),/EXISTS/);
  writeFileSync(name,JSON.stringify({...p,lookbackDays:10}));
  assert.throws(()=>loadHistoricalPlan(name),/CHECKSUM/);
}));

test('bounded CLI discovers once, writes inventory, then resumes without metadata calls',()=>withDir(async dir=>{
  const calls=[];
  const fetchFn=async(url,opts)=>{
    const u=new URL(url);
    calls.push(u.pathname);
    assert.equal(opts.method,'GET');
    if(u.pathname==='/api/v3/market/instruments')return {ok:true,status:200,json:async()=>({
      code:'00000',data:[{category:'SPOT',symbol:'BTCUSDT',
        baseCoin:'BTC',quoteCoin:'USDT',status:'online',
        launchTime:String(NOW-200*H),symbolType:'crypto'}]})};
    if(u.pathname==='/api/v3/market/tickers')return {ok:true,status:200,json:async()=>({
      code:'00000',data:[{symbol:'BTCUSDT',turnover24h:'10000000',bid1Price:'100',ask1Price:'100.01'}]})};
    return goodMock()(url,opts);
  };
  const args=['--output-dir='+dir,'--max-markets=1','--lookback-days=10',
    '--max-new-pages=1','--min-delay-ms=250'];
  const reports=[];
  const one=await historyPilotMain(args,{fetchFn,nowMs:NOW,sleepFn:async()=>{},log:r=>reports.push(r)});
  assert.equal(one.discoveredNewInventory,true);
  assert.equal(one.downloadedPages,1);
  const two=await historyPilotMain(args,{fetchFn,nowMs:NOW+H,sleepFn:async()=>{},log:r=>reports.push(r)});
  assert.equal(two.discoveredNewInventory,false);
  assert.equal(two.downloadedPages,1);
  assert.equal(calls.filter(x=>x==='/api/v3/market/instruments').length,1);
  assert.equal(calls.filter(x=>x==='/api/v3/market/history-candles').length,2);
  assert.equal(existsSync(join(dir,'market-inventory.json')),true);
  assert.equal(reports.length,2);
  await assert.rejects(historyPilotMain([...args,'--max-markets=2'],
    {fetchFn,sleepFn:async()=>{}}),/FROZEN_PLAN|UNKNOWN/);
}));

test('CLI rejects unbounded, secret, and unknown options',()=>{
  assert.throws(()=>parsePilotArgs(['--max-markets=1001']),/INVALID/);
  assert.throws(()=>parsePilotArgs(['--max-new-pages=1000']),/INVALID/);
  assert.throws(()=>parsePilotArgs(['--min-delay-ms=0']),/INVALID/);
  assert.throws(()=>parsePilotArgs(['--api-key=test']),/UNKNOWN/);
  assert.throws(()=>parsePilotArgs(['--market-offset=-1']),/INVALID/);
  assert.throws(()=>parsePilotArgs(['--inventory-file=plain.txt']),/INVALID/);
});

test('all 529 currently listed markets can be partitioned into non-overlapping frozen batches',()=>{
  const markets=Array.from({length:529},(_,i)=>({symbol:'COIN'+String(i).padStart(4,'0')+'USDT',
    firstListedMs:NOW-5*H,researchEligible:i%3===0}));
  const snapshot={exchange:'Bitget',market:'SPOT',asof:new Date(NOW).toISOString(),
    inventorySha256:hash(markets),marketCount:markets.length,markets};
  const batches=[];
  for(let marketOffset=0;marketOffset<markets.length;marketOffset+=100){
    batches.push(createHistoricalPlan(snapshot,{nowMs:NOW,lookbackDays:3653,
      maxMarkets:100,marketOffset}));
  }
  const symbols=batches.flatMap(p=>p.markets.map(m=>m.symbol));
  assert.equal(symbols.length,529);
  assert.equal(new Set(symbols).size,529);
  assert.deepEqual(symbols,markets.map(m=>m.symbol));
  assert.equal(batches.at(-1).marketOffset,500);
  assert.equal(batches.at(-1).selectedMarketCount,29);
  assert.throws(()=>createHistoricalPlan(snapshot,{nowMs:NOW,marketOffset:529}),/OFFSET_OUT_OF_RANGE/);
  assert.throws(()=>createHistoricalPlan({...snapshot,inventorySha256:'f'.repeat(64)},
    {nowMs:NOW,maxMarkets:1}),/CHECKSUM_MISMATCH/);
});

test('shared immutable inventory enables offset batches without repeated metadata GETs',()=>withDir(async dir=>{
  const inventory=join(dir,'shared-market-inventory.json');
  writeFileSync(inventory,JSON.stringify({
    event:'CURRENT_MARKET_UNIVERSE_SNAPSHOT',
    safety:'UNAUTHENTICATED_GET_ONLY',universe:universe()
  }));
  const reports=[],calls=[];
  const fetchFn=goodMock(calls);
  const args=['--inventory-file='+inventory,'--output-dir='+join(dir,'batch-1'),
    '--market-offset=1','--max-markets=1','--lookback-days=1',
    '--max-new-pages=1','--min-delay-ms=250'];
  const result=await historyPilotMain(args,{fetchFn,nowMs:NOW+H,
    sleepFn:async()=>{},log:x=>reports.push(x)});
  assert.equal(result.discoveredNewInventory,false);
  assert.equal(result.marketOffset,1);
  assert.equal(result.chosenMarketCount,1);
  assert.equal(calls.length,1);
  assert.equal(new URL(calls[0].url).searchParams.get('symbol'),'THINUSDT');
  const frozen=loadHistoricalPlan(join(dir,'batch-1','frozen-plan.json'));
  assert.equal(frozen.anchorNowMs,NOW);
  assert.equal(frozen.markets[0].symbol,'THINUSDT');
  await assert.rejects(historyPilotMain([...args,'--market-offset=2'],{
    fetchFn,sleepFn:async()=>{}
  }),/FROZEN_PLAN|UNKNOWN/);
}));
