import test from 'node:test';
import assert from 'node:assert/strict';
import {auditForwardPaperRoundTrips} from '../lib/paper-roundtrip-audit.mjs';

const base=Date.parse('2026-10-29T00:00:00.000Z');
const iso=ms=>new Date(ms).toISOString();
function position(index, win=true) {
  const entry=base+index*60_000;
  const exitPrice=win?101:99;
  return {
    positionId:'P'+index,symbol:'BTCUSDT',
    reportedNetPnlUsd:win?0.8:-1.2,
    fills:[
      {fillId:'P'+index+'-entry',paperTrading:true,side:'BUY',
        quantity:1,executionPriceUsd:100,feeUsd:0.1,timestamp:iso(entry)},
      {fillId:'P'+index+'-exit',paperTrading:true,side:'SELL',
        quantity:1,executionPriceUsd:exitPrice,feeUsd:0.1,timestamp:iso(entry+30_000)},
    ]
  };
}
function paperLedger(count=100) {
  return {
    mode:'PAPER',source:'FORWARD_PAPER',
    positions:Array.from({length:count},(_,i)=>position(i,i<60)),
    equityMarks:[-60_000,45*60_000,90*60_000,120*60_000].map((delta,i)=>({
      timestamp:iso(base+delta),portfolioEquityUsd:[100,105,95,100][i],
      markToMarket:true
    })),
    riskReview:{limitsReviewed:true,violations:0,
      reportUrl:'https://example.invalid/risk-review'},
  };
}
test('100 distinct fully closed forward-paper position IDs generate fee-adjusted stats, never proven profit',()=>{
  const audit=auditForwardPaperRoundTrips(paperLedger());
  assert.equal(audit.completedIndependentRoundTrips,100);
  assert.equal(audit.realizedFeeAdjustedPnlUsd,0);
  assert.equal(audit.winRatePct,60);
  assert.equal(audit.profitFactor,1);
  assert.equal(audit.maxSampledPortfolioDrawdownPct,9.52381);
  assert.equal(audit.auditReadyForHumanReview,true);
  assert.equal(audit.profitabilityDemonstrated,false);
  assert.equal(audit.liveMoneyReady,false);
});
test('100 exit events without position IDs are NOT 100 round trips',()=>{
  const ledger=paperLedger();
  delete ledger.positions;
  ledger.trades=Array.from({length:100},()=>({type:'exit',feeAdjusted:true}));
  const audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.completedIndependentRoundTrips,0);
  assert.equal(audit.auditReadyForHumanReview,false);
  assert.match(audit.rejectionReason,/FORWARD_PAPER_POSITIONS/);
});
test('old historical backtest cannot be laundered as forward paper',()=>{
  const ledger=paperLedger();
  ledger.source='HISTORICAL_BACKTEST';
  assert.equal(auditForwardPaperRoundTrips(ledger).completedIndependentRoundTrips,0);
  ledger.source='FORWARD_PAPER';
  ledger.mode='LIVE';
  assert.equal(auditForwardPaperRoundTrips(ledger).completedIndependentRoundTrips,0);
});
test('partial exits count once only after full close',()=>{
  const ledger=paperLedger(2);
  const p=ledger.positions[0];
  p.fills[1].quantity=0.4;
  p.fills[1].feeUsd=0.04;
  p.fills.push({...p.fills[1],fillId:'P0-exit2',quantity:0.6,feeUsd:0.06,
    timestamp:iso(base+45_000)});
  const audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.completedIndependentRoundTrips,2);
  assert.equal(audit.realizedFeeAdjustedPnlUsd,1.6);
  assert.equal(audit.auditReadyForHumanReview,false);
  ledger.positions[0].fills.pop();
  const unclosed=auditForwardPaperRoundTrips(ledger);
  assert.equal(unclosed.completedIndependentRoundTrips,1);
  assert.deepEqual(unclosed.incompleteOpenPositionIds,['P0']);
});
test('duplicate fill IDs invalidate BOTH positions and fail the audit',()=>{
  const ledger=paperLedger();
  ledger.positions[1].fills[0].fillId=ledger.positions[0].fills[0].fillId;
  const audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.completedIndependentRoundTrips,98);
  assert.equal(audit.auditReadyForHumanReview,false);
  assert.ok(audit.excludedPositionIds.some(x=>x.positionId==='P0'));
  assert.ok(audit.excludedPositionIds.some(x=>x.positionId==='P1'));
});
test('duplicate position IDs invalidate BOTH positions rather than the first one winning',()=>{
  const ledger=paperLedger();
  ledger.positions[1].positionId=ledger.positions[0].positionId;
  const audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.completedIndependentRoundTrips,98);
  assert.equal(audit.auditReadyForHumanReview,false);
  assert.equal(audit.excludedPositionIds.filter(x=>x.positionId==='P0').length,2);
});
test('sub-cent reported PnL disagreement is rejected on small positions',()=>{
  const ledger=paperLedger();
  ledger.positions[0].reportedNetPnlUsd+=0.005;
  const audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.completedIndependentRoundTrips,99);
  assert.equal(audit.auditReadyForHumanReview,false);
  assert.ok(audit.excludedPositionIds.some(x=>x.reason==='ACCOUNTING_DISAGREEMENT'));
});
test('reported P&L disagreement, missing fees, or sell before buy are invalid',()=>{
  const ledger=paperLedger();
  ledger.positions[0].reportedNetPnlUsd=500;
  ledger.positions[1].fills[0].feeUsd=null;
  ledger.positions[2].fills.reverse();
  const audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.completedIndependentRoundTrips,97);
  assert.equal(audit.auditReadyForHumanReview,false);
  assert.ok(audit.excludedPositionIds.some(x=>x.reason==='ACCOUNTING_DISAGREEMENT'));
});
test('sparse or exit-only equity cannot claim sampled portfolio max drawdown',()=>{
  const ledger=paperLedger();
  ledger.equityMarks=[ledger.equityMarks[0],ledger.equityMarks.at(-1)];
  let audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.equityCurveValidated,false);
  assert.equal(audit.maxSampledPortfolioDrawdownPct,null);
  assert.equal(audit.auditReadyForHumanReview,false);
  ledger.equityMarks=paperLedger().equityMarks.map(x=>({...x,markToMarket:false}));
  audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.equityCurveValidated,false);
});
test('risk report must show zero violations before human review',()=>{
  const ledger=paperLedger();
  ledger.riskReview.violations=1;
  let audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.riskLimitViolations,1);
  assert.equal(audit.auditReadyForHumanReview,false);
  delete ledger.riskReview.reportUrl;
  audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.riskLimitsReviewed,false);
  assert.equal(audit.auditReadyForHumanReview,false);
});

test('tiny fractional quantity half-exit is NOT treated as fully closed',()=>{
  const ledger=paperLedger(1);
  ledger.positions[0].fills[0].quantity=0.00000001;
  ledger.positions[0].fills[1].quantity=0.000000005;
  const audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.completedIndependentRoundTrips,0);
  assert.deepEqual(audit.incompleteOpenPositionIds,['P0']);
  assert.equal(audit.auditReadyForHumanReview,false);
});

test('100 fully closed positions plus one unresolved live paper position never pass the human-review gate',()=>{
  const ledger=paperLedger();
  const unresolved=position(100);
  const first=unresolved.fills[0];
  unresolved.fills=[
    first,
    {...first,fillId:'P100-extra-entry',timestamp:iso(base+100*60_000+10_000),
      quantity:0.25,feeUsd:0.025},
  ];
  ledger.positions.push(unresolved);
  const audit=auditForwardPaperRoundTrips(ledger);
  assert.equal(audit.completedIndependentRoundTrips,100);
  assert.equal(audit.excludedPositionIds.length,0);
  assert.deepEqual(audit.incompleteOpenPositionIds,['P100']);
  assert.equal(audit.equityCurveValidated,true);
  assert.equal(audit.auditReadyForHumanReview,false);
  assert.equal(audit.profitabilityDemonstrated,false);
  assert.equal(audit.liveMoneyReady,false);
});
