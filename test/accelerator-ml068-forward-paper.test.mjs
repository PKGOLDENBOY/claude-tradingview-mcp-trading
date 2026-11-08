import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyFrozenArtifact,scoreFrozenML,sizeFrozenPaper,PAPER_LIMITS} from '../lib/frozen-ml-forward-strategy.mjs';
import {FORWARD_MODE,inspectForwardLedger,appendForwardRecord,replayPaperEvidence,withExclusiveForwardLock} from '../lib/frozen-ml-forward-ledger.mjs';
import {runPaperCycle,parseQuotes} from '../scripts/ml068-paper-cron.mjs';
const stored=JSON.parse(readFileSync(new URL('../models/frozen-ml068-20261108.json',import.meta.url),'utf8'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const strong=()=>{const m=structuredClone(stored);m.model.intercept=100;
  m.modelSha256=sha(JSON.stringify(m.model));const {manifestSha256,...payload}=m;
  m.manifestSha256=sha(JSON.stringify(payload));return m;};
const symbols=['BTCUSDT','ETHUSDT','SOLUSDT','LINKUSDT','ADAUSDT'];
const barTs=Date.parse('2026-11-09T02:00:00Z')-1440*3600000;
function bars(){return Array.from({length:1440},(_,i)=>{const close=100+i*0.001;
  return {ts:barTs+i*3600000,open:close,high:close*1.002,low:close*.998,
    close,volume:1000,quoteVolume:200000};});}
const mockHistory=async()=>({successfulSymbols:5,excludedSymbols:[],
  data:Object.fromEntries(symbols.map(sym=>[sym,bars()])),datasetSha256:'a'.repeat(64)});
const quotesAt=(at,bid=100)=>async()=>({at,quotes:new Map(symbols.map(sym=>[sym,
  {bidUSD:bid,askUSD:bid*1.0001,lastUSD:bid,observedAt:new Date(at).toISOString()}]))});

test('immutable artifact SHA, 9-feature model and sources are valid',()=>{
  assert.equal(verifyFrozenArtifact(stored).candidate.id,'ml-068');
  const corrupt=structuredClone(stored);corrupt.model.weights[0]+=1;
  assert.throws(()=>verifyFrozenArtifact(corrupt),/CHECKSUM_MISMATCH/);
  const badTime=structuredClone(stored);badTime.activationNotBefore='invalid';
  const {manifestSha256,...payload}=badTime;
  badTime.manifestSha256=sha(JSON.stringify(payload));
  assert.throws(()=>verifyFrozenArtifact(badTime),/CONFIG_MISMATCH/);
});

test('scorer will not emit any signal until strictly after activation',()=>{
  const m=strong(),s=bars();
  const valid=scoreFrozenML(m,s,{symbol:'BTCUSDT',observedAt:'2026-11-09T02:05:00Z'});
  assert.equal(valid.signal,true);assert.equal(valid.liveOrderAuthorized,false);
  assert.equal(valid.barCloseAt,'2026-11-09T02:00:00.000Z');
  assert.throws(()=>scoreFrozenML(m,s,{symbol:'INVALID',observedAt:'2026-11-09T02:05:00Z'}),/SIGNAL_INPUT_INVALID/);
  s[10].ts+=3600000;
  assert.throws(()=>scoreFrozenML(m,s,{symbol:'BTCUSDT',observedAt:'2026-11-09T02:05:00Z'}),/CANDLE_DATA_INVALID/);
});

test('synthetic position sizing blocks wide quotes and enforces 0.5% equity loss estimate',()=>{
  const m=strong(),r={equityUSD:1000,dayStartEquityUSD:1000,peakEquityUSD:1000,
    openNotionalUSD:0,openPositions:0,hasSymbolPosition:false,
    askUSD:100.01,bidUSD:100,quoteAgeMs:1000};
  const x=sizeFrozenPaper(r,m);assert.equal(x.allowed,true);
  assert.equal(x.liveOrderAuthorized,false);
  assert.ok(x.estimatedStopLossUSD<=5);
  assert.equal(sizeFrozenPaper({...r,askUSD:110},m).allowed,false);
  assert.equal(sizeFrozenPaper({...r,openPositions:2},m).allowed,false);
  assert.equal(sizeFrozenPaper({...r,equityUSD:970},m).reason,'DAILY_HALT');
  assert.equal(PAPER_LIMITS.allowRealOrders,false);
});

test('journal detects corruption and prevents overwriting or duplicate trades',()=>{
  const dir=mkdtempSync(join(tmpdir(),'alphabot-ml-'));
  const path=join(dir,'events.ndjson'),hash=stored.manifestSha256;
  const start={type:'EXPERIMENT_START',mode:FORWARD_MODE,
    manifestSha256:hash,eventId:'first_unique',at:'2026-11-09T02:00:00Z'};
  const original=inspectForwardLedger(path,{manifestSha256:hash});
  appendForwardRecord(path,start,original);
  assert.equal(replayPaperEvidence(inspectForwardLedger(path,{manifestSha256:hash}).records,
    {manifestSha256:hash}).startedAt,start.at);
  assert.throws(()=>appendForwardRecord(path,start,original),/CONCURRENT_WRITE/);
  writeFileSync(path,readFileSync(path,'utf8').replace('first_unique','evil_unique'));
  assert.throws(()=>inspectForwardLedger(path,{manifestSha256:hash}),/INTEGRITY_FAILED/);
});

test('prospective run records synthetic entries/exits but never exchange-verified trades',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'alphabot-ml-cycle-'));
  const path=join(dir,'ledger.ndjson'),m=strong();
  const at=Date.parse('2026-11-09T02:05:00Z');
  const r=await runPaperCycle({nowMs:at,artifact:m,store:path,
    historyLoader:mockHistory,tickerLoader:quotesAt(at,100)});
  assert.equal(r.processed,5);assert.equal(r.newEntries,2);
  assert.equal(r.independentlyReconciledRoundTrips,null);
  let rows=inspectForwardLedger(path,{manifestSha256:m.manifestSha256});
  let state=replayPaperEvidence(rows.records,{manifestSha256:m.manifestSha256});
  assert.equal(state.entries,2);assert.equal(state.positions.size,2);
  const later=Date.parse('2026-11-09T02:10:00Z');
  const r2=await runPaperCycle({nowMs:later,artifact:m,store:path,
    historyLoader:mockHistory,tickerLoader:quotesAt(later,85)});
  assert.equal(r2.processed,0);
  assert.equal(r2.cumulativeSyntheticExits,2);
  rows=inspectForwardLedger(path,{manifestSha256:m.manifestSha256});
  state=replayPaperEvidence(rows.records,{manifestSha256:m.manifestSha256});
  assert.equal(state.positions.size,0);assert.ok(state.realizedPnlUSD<0);
  assert.ok(rows.records.every(x=>x.event.mode===FORWARD_MODE));
});

test('quote parser refuses fake last-price-only fills and duplicate markets',()=>{
  assert.throws(()=>parseQuotes(symbols.map(symbol=>({symbol,lastPr:'100'})),'2026-11-09T02:00:00Z'),/ORDERBOOK_QUOTE_INVALID/);
  const rows=symbols.map(symbol=>({symbol,askPr:'100.2',bidPr:'100',lastPr:'100.1'}));
  assert.equal(parseQuotes(rows,'2026-11-09T02:00:00Z').size,5);
  assert.throws(()=>parseQuotes([...rows,rows[0]],'2026-11-09T02:00:00Z'),/DUPLICATE_TICKER/);
});
