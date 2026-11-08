import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {requireMatureCandleHistory,evaluateSignals,SAFETY} from '../scripts/market-shadow-test.mjs';

test('freshly listed markets with fewer than 22 closed candles are data-not-ready, not a market API fault',()=>{
  const bars=Array.from({length:21},(_,i)=>({ts:i,open:1,high:1,low:1,close:1,volume:1}));
  assert.throws(()=>requireMatureCandleHistory(bars,'15min','KORUSDT'),err=>
    err.code==='SHADOW_HISTORY_NOT_READY' && err.closedBars===21);
  assert.equal(requireMatureCandleHistory([...bars,bars[0]],'15min','KORUSDT').length,22);
});

test('malformed candle responses remain real errors and do not fall under warmup',()=>{
  assert.throws(()=>requireMatureCandleHistory(null,'15min','KORUSDT'),err=>
    err.message==='SHADOW_CANDLES_INVALID' && err.code!=='SHADOW_HISTORY_NOT_READY');
  const src=readFileSync(new URL('../scripts/market-shadow-test.mjs',import.meta.url),'utf8');
  assert.match(src,/if\(err\?\.code==="SHADOW_HISTORY_NOT_READY"\)/);
  assert.match(src,/errors\+\+;emit\("SHADOW_MARKET_WARNING"/);
});

test('missing warmup history does not generate scalp or momentum signals, trading stays read-only',()=>{
  const q={lastPr:'100',usdtVolume:'2500000',change24h:'0.11'};
  const outcome=evaluateSignals({quote:q,bars15:null,bars1h:[],bars4h:[],bars1d:[],bars1w:[]});
  assert.equal(outcome.scalp.signal,false);
  assert.equal(Boolean(outcome.momentum.signal),false);
  assert.equal(SAFETY.exchangeWrites,false);
  assert.equal(SAFETY.orderRequests,false);
});
