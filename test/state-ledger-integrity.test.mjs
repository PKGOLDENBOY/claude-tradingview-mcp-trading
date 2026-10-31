import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseExistingTradingState,assertPaperEventHistoryPreserved} from '../lib/state-ledger-integrity.mjs';

const botSource=readFileSync(new URL('../bot.js',import.meta.url),'utf8');
const begin=botSource.indexOf('function loadLog() {');
const end=botSource.indexOf('function countTodaysTrades(log) {',begin);
assert.ok(begin>=0&&end>begin,'Production state I/O functions must be found');
const stateSource=botSource.slice(begin,end);

// Execute the real application state functions in a controlled sandbox without
// importing the server, exchange clients, API credentials, or network capabilities.
function stateFunctions(path,live=false,configuredEnv={}) {
  const env={
    readFileSync,writeFileSync,renameSync,existsSync,
    acct:()=>({logFile:path,portfolioValue:1000}),
    sanitizeLog:value=>value,
    parseExistingTradingState,assertPaperEventHistoryPreserved,
    EXCHANGE_WRITES_ALLOWED:live,
    STATE_DIR:join(path,'..'),
    console,
    process:{env:configuredEnv},
  };
  return new Function(...Object.keys(env),stateSource+'\nreturn {loadLog,saveLog};')
    (...Object.values(env));
}
function withStateFile(content,fn) {
  const dir=mkdtempSync(join(tmpdir(),'alphabot-ledger-integrity-'));
  const path=join(dir,'safety-check-log.json');
  try{
    writeFileSync(path,content);
    fn({path,dir});
  }finally{rmSync(dir,{recursive:true,force:true});}
}

test('parse existing state accepts a BOM but refuses missing/invalid trade history',()=>{
  const state={trades:[],dayStartDate:new Date().toISOString().slice(0,10),portfolioValue:1000};
  assert.deepEqual(parseExistingTradingState(Buffer.from('\uFEFF'+JSON.stringify(state))),state);
  assert.deepEqual(parseExistingTradingState(JSON.stringify(state)),state);
  assert.throws(()=>parseExistingTradingState('{'),/STATE_LEDGER_CORRUPT_JSON/);
  assert.throws(()=>parseExistingTradingState('null'),/STATE_LEDGER_INVALID_SHAPE/);
  assert.throws(()=>parseExistingTradingState('[]'),/STATE_LEDGER_INVALID_SHAPE/);
  assert.throws(()=>parseExistingTradingState('{}'),/STATE_LEDGER_INVALID_SHAPE/);
  assert.throws(()=>parseExistingTradingState(JSON.stringify({trades:{}})),/STATE_LEDGER_INVALID_SHAPE/);
  assert.throws(()=>parseExistingTradingState(null),/STATE_LEDGER_INVALID_BYTES/);
});

test('parse refuses invalid open position records without sanitizing them away',()=>{
  for(const invalid of [null,[],10,'bad']) {
    const payload={trades:[],positions:{BTCUSDT:invalid}};
    assert.throws(()=>parseExistingTradingState(JSON.stringify(payload)),/STATE_LEDGER_INVALID_POSITION_RECORD/);
  }
  assert.throws(()=>parseExistingTradingState(JSON.stringify({trades:[],swingPositions:[]})),/STATE_LEDGER_INVALID_POSITION_STORE/);
  assert.throws(()=>parseExistingTradingState(JSON.stringify({trades:[null]})),/STATE_LEDGER_INVALID_TRADE_RECORD/);
});
test('paper-event continuity rejects deleted, rewritten or duplicated persisted fills',()=>{
  const event={timestamp:'2026-10-30T01:00:00Z',type:'entry',symbol:'BTCUSDT',
    orderId:'PAPER-123',paperTrading:true,orderPlaced:true,price:100,tradeSize:10};
  const old={trades:[event,event]};
  assert.throws(()=>assertPaperEventHistoryPreserved(old,{trades:[event]}),/PAPER_TRADE_HISTORY_LOSS_OR_MUTATION/);
  assert.throws(()=>assertPaperEventHistoryPreserved(old,{trades:[event,{...event,price:99}]}),/PAPER_TRADE_HISTORY_LOSS_OR_MUTATION/);
  assert.doesNotThrow(()=>assertPaperEventHistoryPreserved(old,{trades:[event,event,{...event,orderId:'PAPER-456'}]}));
  assert.doesNotThrow(()=>assertPaperEventHistoryPreserved({trades:[]},{trades:[]}));
});
test('actual saveLog rejects stale writers deleting prior PAPER history (no file modification)',()=>{
  const first={timestamp:'2026-10-30T02:00:00.000Z',type:'entry',paperTrading:true,
    orderPlaced:true,symbol:'BTCUSDT',orderId:'PAPER-1',price:100};
  const second={timestamp:'2026-10-30T03:00:00.000Z',type:'exit',paperTrading:true,
    orderPlaced:true,symbol:'BTCUSDT',orderId:'PAPER-2',price:105};
  const state={trades:[first,second],portfolioValue:1000,dayStartDate:new Date().toISOString().slice(0,10)};
  withStateFile(JSON.stringify(state),({path,dir})=>{
    const f=stateFunctions(path,false,{STATE_FILE:path});
    const before=readFileSync(path);
    assert.throws(()=>f.saveLog({...state,trades:[first]}),/PAPER_TRADE_HISTORY_LOSS_OR_MUTATION/);
    assert.throws(()=>f.saveLog({...state,trades:[first,{...second,price:106}]}),/PAPER_TRADE_HISTORY_LOSS_OR_MUTATION/);
    assert.deepEqual(readFileSync(path),before);
    assert.deepEqual(readdirSync(dir),['safety-check-log.json']);
    const fresh=f.loadLog();
    fresh.trades.push({timestamp:'2026-10-30T04:00:00.000Z',type:'entry',
      paperTrading:true,orderPlaced:true,symbol:'ETHUSDT',orderId:'PAPER-3'});
    f.saveLog(fresh);
    assert.equal(parseExistingTradingState(readFileSync(path)).trades.length,3);
  });
});
for(const mode of ['PAPER','LIVE']) {
  test(mode+': corrupt existing ledger blocks reads AND writes without deleting or rotating bytes',()=>{
    withStateFile('{"trades":[{"type":"entry"}],',({path,dir})=>{
      const before=readFileSync(path);
      const f=stateFunctions(path,mode==='LIVE');
      assert.throws(()=>f.loadLog(),/Trading locked: unreadable\/corrupt state ledger/);
      assert.throws(()=>f.saveLog({trades:[],portfolioValue:1000}),/Refusing to overwrite unreadable\/corrupt safety ledger/);
      assert.deepEqual(readFileSync(path),before);
      assert.deepEqual(readdirSync(dir),['safety-check-log.json']);
    });
  });
  test(mode+': missing explicitly configured persistent state refuses implicit reset or save',()=>{
    const dir=mkdtempSync(join(tmpdir(),'alphabot-missing-state-'));
    const path=join(dir,'persisted-state.json');
    try {
      const f=stateFunctions(path,mode==='LIVE',{STATE_FILE:path});
      assert.throws(()=>f.loadLog(),/CONFIGURED_STATE_LEDGER_MISSING/);
      assert.throws(()=>f.saveLog({trades:[]}),/CONFIGURED_STATE_LEDGER_MISSING/);
      assert.equal(existsSync(path),false);
      assert.deepEqual(readdirSync(dir),[]);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  test(mode+': invalid existing ledger shape never gets reset',()=>{
    withStateFile('{"portfolioValue":1000}',({path,dir})=>{
      const f=stateFunctions(path,mode==='LIVE');
      assert.throws(()=>f.loadLog(),/STATE_LEDGER_INVALID_SHAPE/);
      assert.throws(()=>f.saveLog({trades:[]}),/STATE_LEDGER_INVALID_SHAPE/);
      assert.deepEqual(readdirSync(dir),['safety-check-log.json']);
      assert.equal(readFileSync(path,'utf8'),'{"portfolioValue":1000}');
    });
  });
}
test('valid existing state reads and updates atomically while preserving halted order evidence',()=>{
  const state={trades:[],portfolioValue:1000,dayStartDate:new Date().toISOString().slice(0,10),
    dayStartValue:1000,_tradingHaltReason:'UNCONFIRMED_SELL',
    unconfirmedOrders:[{symbol:'BTCUSDT',reason:'unknown fill'}]};
  withStateFile(JSON.stringify(state),({path,dir})=>{
    const f=stateFunctions(path,false,{STATE_FILE:path});
    const loaded=f.loadLog();
    assert.equal(loaded._tradingHaltReason,'UNCONFIRMED_SELL');
    loaded._tradingHaltReason=undefined;
    loaded.unconfirmedOrders=[];
    loaded.trades.push({type:'entry',paperTrading:true,orderPlaced:true});
    f.saveLog(loaded);
    const saved=parseExistingTradingState(readFileSync(path));
    assert.equal(saved.trades.length,1);
    assert.equal(saved._tradingHaltReason,'UNCONFIRMED_SELL');
    assert.equal(saved.unconfirmedOrders.length,1);
    assert.deepEqual(readdirSync(dir),['safety-check-log.json']);
  });
});
