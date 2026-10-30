import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseExistingTradingState} from '../lib/state-ledger-integrity.mjs';

const botSource=readFileSync(new URL('../bot.js',import.meta.url),'utf8');
const begin=botSource.indexOf('function loadLog() {');
const end=botSource.indexOf('function countTodaysTrades(log) {',begin);
assert.ok(begin>=0&&end>begin,'Production state I/O functions must be found');
const stateSource=botSource.slice(begin,end);

// Execute the real application state functions in a controlled sandbox without
// importing the server, exchange clients, API credentials, or network capabilities.
function stateFunctions(path,live=false) {
  const env={
    readFileSync,writeFileSync,renameSync,existsSync,
    acct:()=>({logFile:path,portfolioValue:1000}),
    sanitizeLog:value=>value,
    parseExistingTradingState,
    EXCHANGE_WRITES_ALLOWED:live,
    STATE_DIR:join(path,'..'),
    console,
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
    const f=stateFunctions(path);
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
