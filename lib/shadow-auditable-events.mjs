/**
 * Research-only, versioned fill evidence for the independent Bitget public-GET
 * shadow SIGNAL PROXIES. These are NEVER exchange fills or production PAPER
 * accounting records and MUST NOT count toward a live-profitability milestone.
 *
 * New positions have cryptographically random durable position IDs. Existing
 * pre-upgrade open positions keep their legacy/unauditable status instead of
 * having invented entry records or IDs.
 */
import { randomUUID } from 'node:crypto';

const STRATEGIES=new Set(['scalp','swing','breakout','momentum','longterm','sniper']);
const SYMBOL=/^[A-Z0-9]{4,24}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const finite=v=>typeof v==='number' && Number.isFinite(v);
const positive=v=>finite(v)&&v>0;
const validMs=ms=>Number.isSafeInteger(ms)&&ms>0;
const fail=message=>{throw new Error('SHADOW_EVENT_AUDIT_'+message)};
const within=(a,b)=>finite(a)&&finite(b)&&
  Math.abs(a-b)<=Math.max(1e-8,Math.abs(a)*1e-9);

export const SHADOW_EVIDENCE_SOURCE='PUBLIC_GET_SHADOW_PROXY_NOT_PRODUCTION_PAPER';

export function createShadowPositionEvidence({
  strategy,symbol,openedMs,quantity,entryPrice,feeRate,idFactory=randomUUID
}) {
  if(!STRATEGIES.has(strategy)||!SYMBOL.test(symbol??'')||
    !validMs(openedMs)||!positive(quantity)||!positive(entryPrice)||
    !finite(feeRate)||feeRate<0||feeRate>0.02||typeof idFactory!=='function')
      fail('ENTRY_INPUT_INVALID');
  const uuid=idFactory();
  if(typeof uuid!=='string'||!UUID.test(uuid))
    fail('POSITION_UUID_INVALID');
  const positionId='shadow-'+uuid;
  return {
    evidenceVersion:2,
    source:SHADOW_EVIDENCE_SOURCE,
    positionId,
    entryFillId:positionId+':buy:1',
    exitFillId:positionId+':sell:1',
    strategy,symbol,
    openedMs,
    feeRate,
  };
}
function validateAudit(position,expectStrategy,expectSymbol){
  const a=position?.auditEvidence;
  if(a===undefined) return null; // Old checkpoint, no trustworthy entry receipt.
  if(a?.evidenceVersion!==2||a.source!==SHADOW_EVIDENCE_SOURCE||
    typeof a.positionId!=='string'||!a.positionId.startsWith('shadow-')||
    !UUID.test(a.positionId.slice(7))||
    a.entryFillId!==a.positionId+':buy:1'||
    a.exitFillId!==a.positionId+':sell:1'||
    a.strategy!==expectStrategy||a.symbol!==expectSymbol||
    !validMs(a.openedMs)||a.openedMs!==position.opened||
    !finite(a.feeRate)||a.feeRate<0||a.feeRate>0.02||
    !positive(position.quantity)||!positive(position.entryPrice)||
    !positive(position.totalCost)||
    !within(position.totalCost,
      position.quantity*position.entryPrice*(1+a.feeRate)))
      fail('PERSISTED_POSITION_INCONSISTENT');
  return a;
}
function legacy(){
  return {
    eventSchemaVersion:1,auditEligible:false,legacyMissingOriginalEntry:true,
    evidenceSource:SHADOW_EVIDENCE_SOURCE,
    noIndependentlyReconciledFills:true,
  };
}
export function shadowEntryEvidence(position,{strategy,symbol}){
  const a=validateAudit(position,strategy,symbol);
  if(!a)fail('NEW_ENTRY_MISSING_AUDIT_ID');
  return {
    eventSchemaVersion:2,auditEligible:true,
    evidenceSource:SHADOW_EVIDENCE_SOURCE,
    positionId:a.positionId,fillId:a.entryFillId,
    fillTimestamp:new Date(a.openedMs).toISOString(),
    side:'BUY',paperTrading:true,spotLongOnly:true,
    quantity:position.quantity,executionPriceUsd:position.entryPrice,
    feeUsd:position.quantity*position.entryPrice*a.feeRate,
    feeRate:a.feeRate,
  };
}
export function shadowExitEvidence(position,{
  strategy,symbol,exitPrice,closedMs,reportedNetPnlUsd
}){
  const a=validateAudit(position,strategy,symbol);
  if(!a)return legacy();
  if(!validMs(closedMs)||closedMs<a.openedMs||
    !positive(exitPrice)||!finite(reportedNetPnlUsd))
    fail('EXIT_INPUT_INVALID');
  const feeUsd=position.quantity*exitPrice*a.feeRate;
  const independentNet=position.quantity*exitPrice-feeUsd-
    position.quantity*position.entryPrice*(1+a.feeRate);
  if(!within(reportedNetPnlUsd,independentNet))
    fail('EXIT_PNL_ACCOUNTING_MISMATCH');
  return {
    eventSchemaVersion:2,auditEligible:true,
    evidenceSource:SHADOW_EVIDENCE_SOURCE,
    positionId:a.positionId,fillId:a.exitFillId,
    entryFillId:a.entryFillId,
    fillTimestamp:new Date(closedMs).toISOString(),
    side:'SELL',paperTrading:true,spotLongOnly:true,
    quantity:position.quantity,executionPriceUsd:exitPrice,
    feeUsd,feeRate:a.feeRate,
    reportedNetPnlUsd,
  };
}
