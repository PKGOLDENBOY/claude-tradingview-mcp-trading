/**
 * Deterministic, offline interpretation of a frozen, read-only AlphaBot
 * SHADOW_CYCLE telemetry snapshot. NO market, account, or exchange calls.
 * This is a signal-PROXY evaluation, never verified production profitability.
 */
const validNum = v => typeof v === 'number' && Number.isFinite(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const near = (a,b,tolerance=0.00011) => Math.abs(a-b) <= tolerance;
const known = ['scalp','momentum','swing','breakout','longterm','sniper'];

export function evaluateShadowSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 ||
      snapshot?.evidenceType !== 'DIRECT_RAILWAY_SHADOW_LOG_CAPTURE_NO_AUTHENTICATED_EXCHANGE_ORDERS' ||
      snapshot?.event?.tag !== 'SHADOW_CYCLE' ||
      snapshot?.event?.safety !== 'PUBLIC_MARKET_READ_ONLY_SHADOW' ||
      !Number.isFinite(Date.parse(snapshot?.source?.logTimestampUtc)) ||
      !integer(snapshot?.event?.cycle) ||
      !integer(snapshot?.event?.errors) ||
      !snapshot?.event?.stats) {
    throw new Error('INVALID_SHADOW_PROVENANCE_OR_TELEMETRY');
  }
  const results = {};
  for (const name of known) {
    const v = snapshot.event.stats[name];
    if (!v || !['evaluations','qualifyingSignals','entries','exits','wins','losses','open','unpricedOpen'].every(k=>integer(v[k])) ||
        !['realizedPnlUSD','openMarkedPnlUSD','combinedSimulatedPnlUSD','realizedPeakToTroughDrawdownUSD'].every(k=>validNum(v[k])) ||
        v.realizedPeakToTroughDrawdownUSD < 0 ||
        v.exits > v.entries || v.wins+v.losses>v.exits || v.open !== v.entries - v.exits ||
        v.unpricedOpen>v.open ||
        !near(v.realizedPnlUSD+v.openMarkedPnlUSD, v.combinedSimulatedPnlUSD) ||
        (v.exits===0 && (v.winRatePct !== null || v.profitFactor !== null)) ||
        (v.exits>0 && (!validNum(v.winRatePct) || v.winRatePct<0 || v.winRatePct>100 ||
          !near(v.winRatePct,(100*v.wins)/v.exits,0.011))) ||
        (v.profitFactor!==null && (!validNum(v.profitFactor) || v.profitFactor<0))) {
      throw new Error('SHADOW_INCONSISTENT_STRATEGY_METRICS_'+name.toUpperCase());
    }
    // These counters are cumulative signal-proxy evaluations, NOT
    // independently audited unique trades or account-equity observations.
    let assessment='NO_REALIZED_VERDICT';
    if (v.exits>0 && v.realizedPnlUSD<0 && v.profitFactor!==null && v.profitFactor<1)
      assessment='LOSING_OBSERVED_SHADOW_SAMPLE';
    else if (v.exits>0 && v.realizedPnlUSD>0)
      assessment='POSITIVE_OBSERVED_SHADOW_SAMPLE_NOT_VALIDATED';
    else if (v.exits>0)
      assessment='INCONCLUSIVE_OBSERVED_SHADOW_SAMPLE';
    results[name]={
      assessment,closedProxyPositions:v.exits,openProxyPositions:v.open,
      simulatedNetRealizedPnlUSD:v.realizedPnlUSD,
      simulatedOpenMarkUSD:v.openMarkedPnlUSD,
      reportedWinRatePct:v.winRatePct,
      reportedProfitFactor:v.profitFactor,
      realizedOnlyDrawdownUSD:v.realizedPeakToTroughDrawdownUSD,
      distinctTradesIndependentlyReconciled:false,
      afterModelledCosts:true,
      historyAndOosIndependentlyValidated:false,
    };
  }
  return {
    asOfUtc:snapshot.event.time,
    evaluatedStrategies:['scalp','momentum','swing'],
    studyType:'LIVE_PUBLIC_DATA_SHADOW_SIGNAL_PROXIES',
    conclusions:{scalp:results.scalp,momentum:results.momentum,swing:results.swing},
    additional: {breakout:results.breakout,longterm:results.longterm,sniper:results.sniper},
    noStrategyProfitabilityDemonstrated:true,
    safety:{noExchangeOrdersInProxyCode:true,actualRailwayFlagValuesIndependentlyVerified:false},
    limitations:[
      'Shadow signal proxies are not the production strategy or exchange account.',
      'Reported fee/slippage estimates and profit factors are from the shadow process; no individual fill audit in this snapshot.',
      'Open swing positions cannot supply a realized win rate or profit factor.',
      'Realized-only peak-to-trough USD drawdown is NOT a full portfolio max drawdown.',
      'Small samples, regime and liquidity effects prohibit a validated-edge claim.',
      'Qualifying signals and evaluations include repeats, not unique opportunities.',
    ],
  };
}
