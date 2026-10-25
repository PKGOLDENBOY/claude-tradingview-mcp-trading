import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {INTERVAL_MS} from '../lib/accelerator-core.mjs';
import {fetchSymbolHistory,publicBitgetCandles} from '../lib/accelerator-data.mjs';
import {syntheticBars} from './helpers.mjs';
const DAY=24*INTERVAL_MS;
async function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'alpha-accelerator-'));
  try{await fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
function marketResponse(rows,logs){return async(url,init)=>{
  const u=new URL(url);
  assert.equal(u.hostname,'api.bitget.com');assert.equal(init.method,'GET');
  assert.ok(u.pathname==='/api/v3/market/candles'||u.pathname==='/api/v3/market/history-candles');
  assert.equal(u.searchParams.get('category'),'SPOT');
  assert.equal(init.headers.Authorization,undefined);
  logs.push(u.toString());
  const start=Number(u.searchParams.get('startTime'));
  const end=Number(u.searchParams.get('endTime'));
  const limit=Number(u.searchParams.get('limit'));
  const selected=rows.filter(b=>b.ts>start && b.ts<end).slice(-limit)
    .map(b=>[b.ts,b.open,b.high,b.low,b.close,b.volume,b.quoteVolume].map(String));
  return {ok:true,json:async()=>({code:'00000',data:selected})};
};}
test('only explicit public GET historical SPOT endpoints allowed',async()=>{
  const noop=async()=>({ok:true,json:async()=>({code:'00000',data:[]})});
  await assert.rejects(publicBitgetCandles('/api/v2/spot/trade/place-order',{},
    {fetchFn:noop,rateLimit:async()=>{}}),/ALLOWLIST/);
});
test('fetch complete public data once, then read checksum-verified cache without network',()=>fixture(async dir=>{
  const asofMs=Math.floor(Date.now()/INTERVAL_MS)*INTERVAL_MS;
  const rows=syntheticBars(60*24,{startMs:asofMs-60*DAY});
  const calls=[];
  const opts={cacheDir:dir,asofMs,lookbackDays:60,
    fetchFn:marketResponse(rows,calls),rateLimit:async()=>{}};
  const a=await fetchSymbolHistory('BTCUSDT',opts);
  assert.equal(a.bars.length,1440);assert.ok(a.apiRequests>=2);assert.equal(a.newBars,1440);
  const c=calls.length;
  const b=await fetchSymbolHistory('BTCUSDT',opts);
  assert.equal(calls.length,c);
  assert.equal(b.apiRequests,0);assert.equal(b.cacheHitBars,1440);
  assert.equal(a.datasetSha256,b.datasetSha256);
  const file=join(dir,'BTCUSDT-1H.json');
  const record=JSON.parse(readFileSync(file,'utf8'));record.bars[11].close*=2;
  writeFileSync(file,JSON.stringify(record));
  await assert.rejects(fetchSymbolHistory('BTCUSDT',opts),/INTEGRITY/);
}));
test('data holes fail closed after corrective download retry',()=>fixture(async dir=>{
  const asofMs=Math.floor(Date.now()/INTERVAL_MS)*INTERVAL_MS;
  const rows=syntheticBars(1440,{startMs:asofMs-60*DAY}).filter((_,i)=>i!==310);
  const calls=[];
  await assert.rejects(fetchSymbolHistory('BTCUSDT',{
    cacheDir:dir,asofMs,lookbackDays:60,fetchFn:marketResponse(rows,calls),
    rateLimit:async()=>{},
  }),/INCOMPLETE_HISTORY/);
  assert.ok(calls.length>2);
}));
