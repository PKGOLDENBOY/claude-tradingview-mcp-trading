import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../bot.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = src.indexOf(start);
  assert.notEqual(first, -1, 'Missing start marker ' + start);
  const last = src.indexOf(end, first + start.length);
  assert.notEqual(last, -1, 'Missing end marker ' + end);
  return src.slice(first, last);
}
const policySource = section('const EXCHANGE_WRITES_ALLOWED =', 'const EMAIL_TO =');
function policy(env) {
  return new Function('process', policySource + '\nreturn {allowed:EXCHANGE_WRITES_ALLOWED, requireExchangeWrites};')({ env });
}

test('both explicit flags are required to enable real orders', () => {
  for (const env of [{}, { PAPER_TRADING:'true' }, { LIVE_TRADING_ENABLED:'true' },
                     { PAPER_TRADING:'false' }, { PAPER_TRADING:'true', LIVE_TRADING_ENABLED:'true' },
                     { PAPER_TRADING:'false', LIVE_TRADING_ENABLED:'false' }]) {
    const p = policy(env);
    assert.equal(p.allowed, false);
    assert.throws(() => p.requireExchangeWrites('test order'), /LIVE_TRADING_LOCKED/);
  }
  const authorized = policy({ PAPER_TRADING:'false', LIVE_TRADING_ENABLED:'true' });
  assert.equal(authorized.allowed, true);
  assert.doesNotThrow(() => authorized.requireExchangeWrites('test order'));
});

const capSource = section('const MAX_ENTRIES_PER_DAY =', '// Per-coin latest scan data');
function entryGate(cap, trades, loadError = false) {
  const loadLog = () => { if (loadError) throw new Error('ledger missing'); return { trades }; };
  return new Function('process', 'loadLog',
    capSource + '\nreturn {entryCapReached, countTodaysEntries, MAX_ENTRIES_PER_DAY};'
  )({ env:{ MAX_ENTRIES_PER_DAY:String(cap) } }, loadLog);
}
const today = new Date().toISOString().slice(0,10);
const paperBuy = {timestamp: today+'T14:00:00.000Z',type:'entry',orderPlaced:true,paperTrading:true};
const exit = {timestamp: today+'T15:00:00.000Z',type:'exit',orderPlaced:true,paperTrading:true};

test('zero daily entry cap must block every paper buy', () => {
  assert.equal(entryGate(0,[]).entryCapReached(), true);
  assert.equal(entryGate(0,[paperBuy]).entryCapReached(), true);
});

test('daily cap counts paper buys, but not exits or unplaced signals', () => {
  assert.equal(entryGate(2,[paperBuy,exit]).countTodaysEntries({trades:[paperBuy,exit]}), 1);
  assert.equal(entryGate(2,[paperBuy,exit]).entryCapReached(), false);
  assert.equal(entryGate(2,[paperBuy,paperBuy,exit]).entryCapReached(), true);
  assert.equal(entryGate(2,[exit,{...paperBuy,orderPlaced:false}]).entryCapReached(), false);
  assert.equal(entryGate(2,[{...paperBuy,timestamp:'2020-01-01T14:00:00Z'}]).entryCapReached(), false);
});

test('unavailable position ledger fails closed for buying', () => {
  assert.equal(entryGate(2, [], true).entryCapReached(), true);
});

test('every exchange order path has an independent write lock', () => {
  for (const action of ['BitGet order','BitMart order','BitGet limit buy','BitGet limit sell',
    'Cancel order','Cancel all orders','New listing sniper','Direct sniper buy']) {
    assert.ok(src.includes('requireExchangeWrites("'+action+'")'), 'Missing hard lock for '+action);
  }
});

test('all strategies apply cap in paper mode; exits bypass entry-only blockers', () => {
  assert.match(src, /if \(isNewScalpEntry && entryCapReached\(\)\)/);
  assert.match(src, /const withinLimits = !isNewScalpEntry \|\| checkTradeLimits\(log\)/);
  assert.match(src, /if \(_tradingPaused && isNewScalpEntry\)/);
  assert.match(src, /if \(drawdown.paused && isNewScalpEntry\)/);
  const guard = 'if (_tradingPaused || entryCapReached() || checkDailyDrawdown(log).paused)';
  assert.equal(src.split(guard).length - 1, 2, 'Swing and breakout each need entry guard');
  assert.match(src, /if \(slippageOk && entryCapReached\(\)\)/);
});

test('historical production CSV stays distinct from simulated trade CSV', () => {
  assert.ok(src.includes('trades-paper.csv'));
  assert.ok(src.includes('trades.csv'));
  assert.ok(src.includes('historicalRecoverySummary()'));
});

test('webhooks and private status endpoints require authentication', () => {
  assert.ok(src.includes('crypto.timingSafeEqual'));
  assert.equal(src.split('Unauthorized webhook').length-1, 2);
  assert.ok(src.includes('if (!checkPin(req.url)) { res.writeHead(401)'));
});
