/**
 * Tamper-EVIDENT (not tamper-proof) append-only synthetic paper event ledger.
 * READ ONLY market study; never order, trade, or access accounts.
 * File hash chain is not independent third-party reconciliation.
 */
import {existsSync,readFileSync,openSync,writeSync,fsyncSync,closeSync,mkdirSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
export const FORWARD_MODE='PUBLIC_QUOTES_SYNTHETIC_PAPER_NO_ORDERS';
const sha=s=>createHash('sha256').update(s).digest('hex');
const GENESIS='0'.repeat(64);
const types=new Set(['EXPERIMENT_START','CANDLE_EVALUATED','PAPER_ENTRY','PAPER_EXIT','MARKET_DATA_GAP','ERROR','HEARTBEAT']);
export function journalHash(sequence,previousHash,event){
  return sha(JSON.stringify({sequence,previousHash,event}));
}
export function inspectForwardLedger(path,{manifestSha256}={}){
  if(typeof path!=='string'||!path)throw new Error('FORWARD_JOURNAL_PATH_INVALID');
  if(!/^[a-f0-9]{64}$/.test(manifestSha256||''))throw new Error('FORWARD_MANIFEST_HASH_INVALID');
  if(!existsSync(path))return {records:[],tailHash:GENESIS,nextSequence:1};
  const raw=readFileSync(path,'utf8');
  if(raw.length>50_000_000 || (raw && !raw.endsWith('\n')))
    throw new Error('FORWARD_JOURNAL_TRUNCATED_OR_OVERSIZED');
  let previousHash=GENESIS,sequence=1;
  const records=[];
  for(const line of raw.split('\n').filter(Boolean)){
    let record;
    try{record=JSON.parse(line);}catch{throw new Error('FORWARD_JOURNAL_CORRUPT_JSON');}
    if(record?.sequence!==sequence || record?.previousHash!==previousHash ||
       typeof record?.hash!=='string' || !record.event ||
       record.event.mode!==FORWARD_MODE ||
       record.event.manifestSha256!==manifestSha256 ||
       !types.has(record.event.type) ||
       record.hash!==journalHash(sequence,previousHash,record.event))
      throw new Error('FORWARD_JOURNAL_INTEGRITY_FAILED_AT_'+sequence);
    records.push(record);previousHash=record.hash;sequence++;
  }
  return {records,tailHash:previousHash,nextSequence:sequence};
}
export function appendForwardRecord(path,event,tail){
  if(!tail || !Number.isSafeInteger(tail.nextSequence) ||
     typeof tail.tailHash!=='string' || !types.has(event?.type) || event.mode!==FORWARD_MODE)
    throw new Error('FORWARD_APPEND_INVALID');
  const record={sequence:tail.nextSequence,previousHash:tail.tailHash,event,
    hash:journalHash(tail.nextSequence,tail.tailHash,event)};
  mkdirSync(dirname(path),{recursive:true});
  // Single-writer lock is required at caller level; inspect tail before appending.
  const actual=inspectForwardLedger(path,{manifestSha256:event.manifestSha256});
  if(actual.tailHash!==tail.tailHash || actual.nextSequence!==tail.nextSequence)
    throw new Error('FORWARD_JOURNAL_CONCURRENT_WRITE');
  const fd=openSync(path,'a',0o600);
  try{writeSync(fd,JSON.stringify(record)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  return {record,tailHash:record.hash,nextSequence:record.sequence+1};
}
export function withExclusiveForwardLock(lockPath,fn){
  mkdirSync(dirname(lockPath),{recursive:true});
  let fd;
  try{fd=openSync(lockPath,'wx',0o600);writeSync(fd,String(process.pid)+'\n');fsyncSync(fd);}
  catch(err){if(fd!==undefined)closeSync(fd);throw new Error('FORWARD_LOCK_UNAVAILABLE: '+err.message);}
  closeSync(fd);
  return Promise.resolve().then(fn).finally(()=>unlinkSync(lockPath));
}
/** Rebuild position and processed-bar state exclusively from verified journal. */
export function replayPaperEvidence(records,{manifestSha256}={}){
  const state={positions:new Map(),lastEvaluatedCandleBySymbol:new Map(),
    realizedPnlUSD:0,exits:0,wins:0,losses:0,entries:0,gaps:0,
    errors:0,lastHeartbeatAt:null,startedAt:null,knownEntryIds:new Set(),knownEventIds:new Set()};
  for(const row of records){
    const e=row.event;
    if(e?.manifestSha256!==manifestSha256||!types.has(e?.type))
      throw new Error('FORWARD_REPLAY_MANIFEST_OR_TYPE_MISMATCH');
    if(typeof e.eventId!=='string'||state.knownEventIds.has(e.eventId))
      throw new Error('FORWARD_REPLAY_DUPLICATE_EVENT_ID');
    state.knownEventIds.add(e.eventId);
    if(e.type==='EXPERIMENT_START'){
      if(state.startedAt!==null)throw new Error('FORWARD_REPLAY_DUPLICATE_START');
      state.startedAt=e.at;continue;
    }
    if(state.startedAt===null)throw new Error('FORWARD_REPLAY_MISSING_START');
    if(e.type==='CANDLE_EVALUATED'){
      const prev=state.lastEvaluatedCandleBySymbol.get(e.symbol)||0;
      const ts=Date.parse(e.barCloseAt);
      if(!Number.isFinite(ts)||ts<=prev)throw new Error('FORWARD_REPLAY_DUPLICATE_OR_OLD_BAR');
      state.lastEvaluatedCandleBySymbol.set(e.symbol,ts);continue;
    }
    if(e.type==='PAPER_ENTRY'){
      if(state.positions.has(e.symbol)||state.knownEntryIds.has(e.positionId)||
        !Number.isFinite(e.qty)||e.qty<=0 || !Number.isFinite(e.entryTotalCostUSD)||
        e.entryTotalCostUSD<=0 || !Number.isFinite(e.entryReferenceUSD)||e.entryReferenceUSD<=0 ||
        !Number.isFinite(e.notionalUSD)||e.notionalUSD<=0)
        throw new Error('FORWARD_REPLAY_ENTRY_INVALID');
      state.positions.set(e.symbol,e);state.knownEntryIds.add(e.positionId);state.entries++;
      continue;
    }
    if(e.type==='PAPER_EXIT'){
      const entry=state.positions.get(e.symbol);
      if(!entry||entry.positionId!==e.positionId || !Number.isFinite(e.pnlUSD) ||
        !Number.isFinite(e.exitNetProceedsUSD) ||
        Math.abs(e.pnlUSD-(e.exitNetProceedsUSD-entry.entryTotalCostUSD))>0.00001)
        throw new Error('FORWARD_REPLAY_EXIT_MISMATCH');
      state.positions.delete(e.symbol);state.realizedPnlUSD+=e.pnlUSD;
      state.exits++;if(e.pnlUSD>0)state.wins++;else state.losses++;
      continue;
    }
    if(e.type==='MARKET_DATA_GAP')state.gaps++;
    else if(e.type==='ERROR')state.errors++;
    else if(e.type==='HEARTBEAT')state.lastHeartbeatAt=e.at;
  }
  return state;
}
