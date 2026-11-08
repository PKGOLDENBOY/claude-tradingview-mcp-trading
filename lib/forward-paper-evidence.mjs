/**
 * Evidence-only checks for a proposed FROZEN prospective paper experiment.
 * Does not generate trades, access markets or reconcile independently.
 * A caller's JSON timestamps are NOT trusted proof of contemporaneous capture.
 */
const ms=v=>typeof v==='string' ? Date.parse(v) : Number.NaN;
const money=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const positive=x=>money(x)&&x>0;
const round=x=>Math.round(x*1e4)/1e4;

export function auditProspectivePaper({manifest,events,now=new Date().toISOString()}={}) {
  if(!manifest || !Array.isArray(events))throw new Error('FORWARD_EVIDENCE_INPUT_MISSING');
  const freezeTime=ms(manifest.frozenAt),nowTime=ms(now);
  if(!Number.isFinite(freezeTime)||!Number.isFinite(nowTime)||freezeTime>=nowTime ||
     !/^[a-z]+-[0-9]{3,4}$/.test(manifest.candidateId||'') ||
     !/^[0-9a-f]{64}$/.test(manifest.modelSha256||'') ||
     !/^[0-9a-f]{64}$/.test(manifest.trainingDataSha256||''))
    throw new Error('FORWARD_MANIFEST_INVALID');
  const rejected=[],entries=new Map(),completed=[],ids=new Set(),exitIds=new Set();
  // Never reorder the event stream: preserved arrival order is essential.
  for(let i=0;i<events.length;i++) {
    const v=events[i];
    if(!v || !['ENTRY','EXIT'].includes(v.type) ||
       v.source!=='FORWARD_PAPER' || v.candidateId!==manifest.candidateId ||
       v.modelSha256!==manifest.modelSha256 ||
       typeof v.positionId!=='string'||!/^[A-Za-z0-9_-]{8,64}$/.test(v.positionId) ||
       typeof v.eventId!=='string'||!/^[A-Za-z0-9_-]{8,64}$/.test(v.eventId) ||
       !/^[A-Z0-9]{4,24}$/.test(v.symbol||'') ||
       !positive(v.qty)||!positive(v.priceUSD)||!money(v.feeUSD)||!money(v.slippageUSD) ||
       !Number.isFinite(ms(v.observedAt))||!Number.isFinite(ms(v.recordedAt)) ||
       ms(v.observedAt)<=freezeTime||ms(v.recordedAt)<ms(v.observedAt) ||
       ms(v.recordedAt)>nowTime ||
       ms(v.recordedAt)-ms(v.observedAt)>3600000 || ids.has(v.eventId)) {
      rejected.push({index:i,reason:'EVENT_UNVERIFIED_OR_MALFORMED'});continue;
    }
    ids.add(v.eventId);
    if(v.type==='ENTRY') {
      if(entries.has(v.positionId)||exitIds.has(v.positionId)) {
        rejected.push({index:i,reason:'DUPLICATE_POSITION_ENTRY'});continue;
      }
      entries.set(v.positionId,v);
      continue;
    }
    const entry=entries.get(v.positionId);
    if(!entry||exitIds.has(v.positionId)||entry.symbol!==v.symbol ||
       entry.qty!==v.qty || ms(v.observedAt)<=ms(entry.observedAt) ||
       ms(v.recordedAt)<ms(entry.recordedAt)) {
      rejected.push({index:i,reason:'UNMATCHED_OR_NONCHRONOLOGICAL_EXIT'});continue;
    }
    exitIds.add(v.positionId);entries.delete(v.positionId);
    const entryCash=entry.qty*entry.priceUSD+entry.feeUSD+entry.slippageUSD;
    const exitCash=v.qty*v.priceUSD-v.feeUSD-v.slippageUSD;
    completed.push({positionId:v.positionId,exitAt:v.observedAt,
      pnlUSD:round(exitCash-entryCash)});
  }
  const wins=completed.filter(x=>x.pnlUSD>0), losses=completed.filter(x=>x.pnlUSD<0);
  const grossProfit=round(wins.reduce((s,x)=>s+x.pnlUSD,0));
  const grossLoss=round(-losses.reduce((s,x)=>s+x.pnlUSD,0));
  const net=round(completed.reduce((s,x)=>s+x.pnlUSD,0));
  return {
    basis:'SELF_RECORDED_FORWARD_PAPER_EVENTS_AWAITING_INDEPENDENT_RECEIPT_RECONCILIATION',
    selectedCandidate:manifest.candidateId,
    internallyMatchedRoundTrips:completed.length,
    openPositions:entries.size,rejectedEvents:rejected,
    realizedPnlUSD:net,profitFactor:grossLoss>0?round(grossProfit/grossLoss):null,
    winRatePct:completed.length?round(wins.length/completed.length*100):null,
    independentlyReconciledRoundTrips:null,
    independentlyVerifiedPaperTrades100:false,
    fullPortfolioMaxDrawdownPct:null,
    liveMoneyReady:false,realOrdersAuthorized:false,
    limitations:['Self-recorded timestamps can be fabricated: independent append-only receipts and public quote snapshots are required.',
      'Does not reconcile account balances, partial fills or portfolio mark-to-market drawdown.',
      'No event in this journal may be a retrospective backtest or shadow proxy event.'],
  };
}
