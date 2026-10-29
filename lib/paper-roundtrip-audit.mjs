/**
 * Strict READ-ONLY independent reconstruction of simulated forward PAPER
 * round trips from durable, uniquely identified fill records.
 *
 * It never touches exchange credentials or production state. Its output is
 * provisional: model-generated paper fills and equity marks must still be
 * independently verified against immutable telemetry. Never use this to
 * authorize live trading or claim statistically proven profitability.
 */
const money = x => typeof x === 'number' && Number.isFinite(x);
const positive = x => money(x) && x > 0;
const timestamp = x => typeof x === 'string' ? Date.parse(x) : NaN;
const url = x => typeof x === 'string' && /^https:\/\/[^\s]+$/.test(x);
const rounded = x => { const n = Math.round((x + Number.EPSILON) * 1e6) / 1e6; return n === 0 ? 0 : n; };
const closeQty = (a,b) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-7);

function provisional() {
  return {
    basis: 'FORWARD_PAPER_RECONSTRUCTION_ONLY',
    completedIndependentRoundTrips: 0,
    excludedPositionIds: [],
    incompleteOpenPositionIds: [],
    realizedFeeAdjustedPnlUsd: 0,
    winRatePct: null, profitFactor: null,
    maxSampledPortfolioDrawdownPct: null,
    equityCurveValidated: false, riskLimitsReviewed: false,
    riskLimitViolations: null, auditReadyForHumanReview: false,
    profitabilityDemonstrated: false, liveMoneyReady: false,
    limitations: [
      'Paper fills, quotes and marks are simulated; input authenticity requires independent review.',
      'Sampled mark-to-market drawdown can miss movements between observations.',
      'This auditor does not place orders or verify external exchange balances.',
    ],
  };
}

export function auditForwardPaperRoundTrips(ledger, {
  maxEquityGapSeconds = 3600,
} = {}) {
  const result = provisional();
  if (!ledger || ledger.mode !== 'PAPER' || ledger.source !== 'FORWARD_PAPER'
    || !Array.isArray(ledger.positions)) {
    result.rejectionReason = 'REQUIRES_DURABLE_FORWARD_PAPER_POSITIONS_NOT_HISTORICAL_EXITS';
    return result;
  }
  if (!Number.isSafeInteger(maxEquityGapSeconds) || maxEquityGapSeconds < 1)
    throw new RangeError('INVALID_MARK_INTERVAL');

  const positionIds = new Set(), globalFillIds = new Set(), complete = [];
  let firstFillAt = Infinity, lastFillAt = -Infinity;
  for (const position of ledger.positions) {
    const id = position?.positionId;
    const fills = position?.fills;
    const symbol = position?.symbol;
    let error = null;
    if (typeof id !== 'string' || !id || positionIds.has(id)
      || typeof symbol !== 'string' || symbol.length < 4
      || !Array.isArray(fills) || fills.length < 2) error = 'MISSING_OR_DUPLICATE_POSITION';
    if (typeof id === 'string') positionIds.add(id);
    if (error) {
      result.excludedPositionIds.push({ positionId: id ?? null, reason: error });
      continue;
    }

    let bought = 0, sold = 0, spend = 0, receipts = 0, fees = 0;
    let lastTs = -Infinity, hasSell = false, previouslyFlat = false;
    for (const fill of fills) {
      const ts = timestamp(fill?.timestamp);
      const key = fill?.fillId;
      if (typeof key !== 'string' || !key || globalFillIds.has(key)
        || !Number.isFinite(ts) || ts < lastTs
        || fill.paperTrading !== true
        || (fill.side !== 'BUY' && fill.side !== 'SELL')
        || !positive(fill.quantity) || !positive(fill.executionPriceUsd)
        || !money(fill.feeUsd) || fill.feeUsd < 0) {
        error = 'INVALID_DUPLICATE_OR_UNADJUSTED_FILL';
        break;
      }
      globalFillIds.add(key);
      lastTs = ts;
      firstFillAt = Math.min(firstFillAt,ts);
      lastFillAt = Math.max(lastFillAt,ts);

      const notional = fill.quantity * fill.executionPriceUsd;
      fees += fill.feeUsd;
      if (fill.side === 'BUY') {
        if (hasSell && previouslyFlat) { error = 'REOPENED_POSITION_ID'; break; }
        bought += fill.quantity;
        spend += notional;
      } else {
        hasSell = true;
        sold += fill.quantity;
        receipts += notional;
        if (sold > bought && !closeQty(sold,bought)) {
          error = 'SELL_WITHOUT_MATCHING_BUY';
          break;
        }
        if (closeQty(sold,bought)) previouslyFlat = true;
      }
    }
    if (error) {
      result.excludedPositionIds.push({positionId:id,reason:error});
      continue;
    }
    if (!hasSell || !closeQty(bought,sold)) {
      result.incompleteOpenPositionIds.push(id);
      continue;
    }
    const net = rounded(receipts - spend - fees);
    if (!money(position.reportedNetPnlUsd)
      || Math.abs(net-position.reportedNetPnlUsd) > 0.01) {
      result.excludedPositionIds.push({positionId:id,reason:'ACCOUNTING_DISAGREEMENT'});
      continue;
    }
    complete.push({id,net});
  }

  const wins = complete.filter(x=>x.net>0), losses = complete.filter(x=>x.net<0);
  const sum = arr => arr.reduce((s,x)=>s+x.net,0);
  const gains=sum(wins), lossMagnitude=-sum(losses);
  result.completedIndependentRoundTrips=complete.length;
  result.realizedFeeAdjustedPnlUsd=rounded(sum(complete));
  result.winRatePct=complete.length ? rounded(wins.length / complete.length * 100) : null;
  result.profitFactor=lossMagnitude > 0 ? rounded(gains / lossMagnitude) : null;

  const marks = ledger.equityMarks;
  if (Array.isArray(marks) && marks.length >= 2
    && Number.isFinite(firstFillAt) && Number.isFinite(lastFillAt)) {
    let good = true, peak = -Infinity, maxDd = 0, prev = -Infinity;
    for (const mark of marks) {
      const ts = timestamp(mark?.timestamp);
      if (!Number.isFinite(ts) || ts <= prev
        || (prev !== -Infinity && (ts-prev)/1000 > maxEquityGapSeconds)
        || !positive(mark?.portfolioEquityUsd)
        || mark.markToMarket !== true) { good = false; break; }
      peak = Math.max(peak,mark.portfolioEquityUsd);
      maxDd = Math.max(maxDd,(peak-mark.portfolioEquityUsd)/peak*100);
      prev=ts;
    }
    if (timestamp(marks[0]?.timestamp) > firstFillAt
      || timestamp(marks.at(-1)?.timestamp) < lastFillAt) good=false;
    if (good) {
      result.equityCurveValidated=true;
      result.maxSampledPortfolioDrawdownPct=rounded(maxDd);
    }
  }

  const risk = ledger.riskReview;
  if (risk?.limitsReviewed === true
    && Number.isSafeInteger(risk.violations) && risk.violations >= 0
    && url(risk.reportUrl)) {
    result.riskLimitsReviewed=true;
    result.riskLimitViolations=risk.violations;
  }
  // This only queues a MANUAL AUDIT. A full positive sample requires review of
  // the authentic event stream, actual cost model, mark cadence and controls.
  result.auditReadyForHumanReview =
    complete.length >= 100 && result.excludedPositionIds.length === 0
    && result.equityCurveValidated && result.riskLimitsReviewed
    && result.riskLimitViolations === 0 && result.profitFactor !== null;
  return result;
}
