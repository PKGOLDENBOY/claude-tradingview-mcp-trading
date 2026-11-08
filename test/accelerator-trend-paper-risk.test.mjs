import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PAPER_RISK,sizeProspectivePaperEntry} from '../lib/trend-paper-risk.mjs';
const q={equityUSD:1000,dayStartEquityUSD:1000,peakEquityUSD:1000,
  currentOpenNotionalUSD:0,openPositionCount:0,symbolOpenNotionalUSD:0,
  quoteAgeMs:1000,observedBidAskSpreadPct:0.0005};
test('fixed-risk healthy quote creates $100 simulated position but no order permission',()=>{
  const x=sizeProspectivePaperEntry(q);
  assert.equal(x.allowed,true);assert.equal(x.notionalUSD,100);
  assert.equal(x.liveOrderAuthorized,false);
  assert.ok(x.estimatedStopLossUSD<=q.equityUSD*.005);
  assert.equal(PAPER_RISK.maxCombinedNotionalPct,0.2);
  assert.equal(PAPER_RISK.maxConcurrentPositions,2);
});
test('simulated risk blocks stale quotes, wide spreads, correlated exposure and pyramiding',()=>{
  const cases=[
    [{quoteAgeMs:15001},'STALE_QUOTE'],
    [{observedBidAskSpreadPct:0.005},'WIDE_SPREAD'],
    [{openPositionCount:2},'POSITION_COUNT_LIMIT'],
    [{symbolOpenNotionalUSD:100},'NO_POSITION_PYRAMIDING'],
    [{currentOpenNotionalUSD:200,openPositionCount:1},'INSUFFICIENT_PAPER_RISK_BUDGET'],
  ];
  for(const [overrides,reason] of cases){const x=sizeProspectivePaperEntry({...q,...overrides});
    assert.equal(x.allowed,false,reason);assert.equal(x.reason,reason);assert.equal(x.notionalUSD,0);}
});
test('equity drawdown, daily stop and malformed risk data fail closed',()=>{
  assert.equal(sizeProspectivePaperEntry({...q,equityUSD:978}).reason,'DAILY_LOSS_LIMIT');
  assert.equal(sizeProspectivePaperEntry({...q,equityUSD:910,dayStartEquityUSD:910}).reason,'PORTFOLIO_DRAWDOWN_LIMIT');
  for(const overrides of [{quoteAgeMs:undefined},{equityUSD:NaN},
    {observedBidAskSpreadPct:-1},{openPositionCount:-1},{peakEquityUSD:0}]){
    const r=sizeProspectivePaperEntry({...q,...overrides});
    assert.equal(r.allowed,false);assert.equal(r.reason,'RISK_INPUT_MISSING_OR_INVALID');
  }
});
test('notional dynamically shrinks as account equity declines; no leverage or exchange code',()=>{
  const r=sizeProspectivePaperEntry({...q,equityUSD:600,dayStartEquityUSD:600,peakEquityUSD:600});
  assert.equal(r.allowed,true);assert.equal(r.notionalUSD,60);
  assert.equal(PAPER_RISK.noLeverage,true);assert.equal(PAPER_RISK.allowRealOrders,false);
  const src=readFileSync(new URL('../lib/trend-paper-risk.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(src,/fetch\(|axios|placeOrder|submitOrder|\bbot\.js\b/);
});
