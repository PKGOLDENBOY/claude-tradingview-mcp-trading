/**
 * Cross-check an EXPORTED versioned public-GET shadow signal-proxy journal
 * against its durable checkpoint. Strictly offline and read-only.
 *
 * Legacy positions without entry receipts cannot be independently reconciled,
 * and these are NOT production forward PAPER trades under any circumstances.
 */
import {shadowEntryEvidence} from './shadow-auditable-events.mjs';

const STRATEGIES=['scalp','swing','breakout','momentum','longterm','sniper'];
const COUNT=v=>Number.isSafeInteger(v)&&v>=0;
const MONEY=v=>typeof v==='number'&&Number.isFinite(v);
const close=(a,b)=>MONEY(a)&&MONEY(b)&&
  Math.abs(a-b)<=Math.max(1e-7,Math.max(Math.abs(a),Math.abs(b))*1e-9);
const v2=e=>e?.eventSchemaVersion===2;
const validId=id=>typeof id==='string'&&id.startsWith('shadow-');

export function compareShadowCheckpointJournal(checkpoint,events,journalAudit){
  if(!checkpoint||!Array.isArray(events)||!journalAudit||
    checkpoint.safetyMode!=='PUBLIC_MARKET_READ_ONLY_SHADOW')
    throw new Error('SHADOW_CHECKPOINT_COMPARISON_INVALID_INPUT');

  const mismatches=[];
  const fail=(type,strategy,detail)=>mismatches.push({
    type,strategy:strategy??null,detail:detail??null
  });
  const summaries=checkpoint.summary??{};
  const positions=checkpoint.positions??{};
  const entries=new Map(),exits=new Map();
  const counts=new Map(STRATEGIES.map(s=>[s,{entries:0,exits:0}]));
  const unknownStrategies=new Set();

  for(const event of events){
    const s=event?.strategy;
    const tag=event?.tag;
    if(!STRATEGIES.includes(s)||!counts.has(s)){
      unknownStrategies.add(s??'<missing>');
      continue;
    }
    if(tag==='SHADOW_ENTRY')counts.get(s).entries++;
    else if(tag==='SHADOW_EXIT')counts.get(s).exits++;
    if(v2(event)&&validId(event.positionId)){
      const map=tag==='SHADOW_ENTRY'?entries:tag==='SHADOW_EXIT'?exits:null;
      if(map){
        const key=event.positionId;
        if(map.has(key))fail('DUPLICATE_V2_EVENT',s,key);
        else map.set(key,event);
      }
    }
  }
  for(const s of Object.keys(summaries))if(!STRATEGIES.includes(s))
    unknownStrategies.add(s);
  for(const s of Object.keys(positions))if(!STRATEGIES.includes(s))
    unknownStrategies.add(s);
  for(const s of unknownStrategies)fail('UNKNOWN_STRATEGY',s,null);

  const openV2=new Map();
  let legacyOpen=0,countsMatch=true,opensMatch=true;
  let allV2=true;
  for(const strategy of STRATEGIES){
    const summary=summaries[strategy],rows=positions[strategy];
    const found=counts.get(strategy);
    if(!summary||!Array.isArray(rows)||
      !COUNT(summary.entries)||!COUNT(summary.exits)||
      !COUNT(found.entries)||!COUNT(found.exits)||
      summary.entries!==found.entries||summary.exits!==found.exits||
      summary.entries<summary.exits||
      summary.entries-summary.exits!==rows.length){
      countsMatch=false;
      fail('CHECKPOINT_JOURNAL_COUNTER_MISMATCH',strategy,{
        expectedEntries:summary?.entries??null,actualEntries:found.entries,
        expectedExits:summary?.exits??null,actualExits:found.exits,
        openPositions:Array.isArray(rows)?rows.length:null,
      });
    }
    if(!Array.isArray(rows))continue;
    const symbols=new Set();
    for(const item of rows){
      if(!Array.isArray(item)||item.length!==2||
        typeof item[0]!=='string'||!item[1]||typeof item[1]!=='object'){
        opensMatch=false;fail('INVALID_CHECKPOINT_POSITION',strategy,null);continue;
      }
      const [symbol,position]=item;
      if(symbols.has(symbol)){
        opensMatch=false;fail('DUPLICATE_OPEN_SYMBOL',strategy,symbol);
      }
      symbols.add(symbol);
      if(position.auditEvidence===undefined){
        legacyOpen++;
        allV2=false;
        continue;
      }
      let expected;
      try{expected=shadowEntryEvidence(position,{strategy,symbol});}
      catch(error){
        opensMatch=false;fail('INVALID_PERSISTED_V2_POSITION',strategy,
          String(error?.message??error).slice(0,120));continue;
      }
      const id=expected.positionId;
      if(openV2.has(id)){
        opensMatch=false;fail('DUPLICATE_OPEN_V2_POSITION',strategy,id);
        continue;
      }
      openV2.set(id,{strategy,symbol,expected});
      const entry=entries.get(id);
      if(!entry||exits.has(id)||
        entry.strategy!==strategy||entry.symbol!==symbol||
        entry.fillId!==expected.fillId||entry.fillTimestamp!==expected.fillTimestamp||
        !close(entry.quantity,expected.quantity)||
        !close(entry.executionPriceUsd,expected.executionPriceUsd)||
        !close(entry.feeUsd,expected.feeUsd)||
        !close(entry.feeRate,expected.feeRate)){
        opensMatch=false;fail('OPEN_POSITION_MISSING_OR_MISMATCHED_ENTRY',strategy,id);
      }
    }
  }
  for(const [id,entry] of entries){
    if(!exits.has(id)&&!openV2.has(id)){
      opensMatch=false;fail('ORPHAN_V2_ENTRY_NOT_IN_CHECKPOINT',entry.strategy,id);
    }
    if(exits.has(id)&&openV2.has(id)){
      opensMatch=false;fail('CLOSED_V2_POSITION_STILL_OPEN',entry.strategy,id);
    }
  }
  for(const [id,exit] of exits){
    if(!entries.has(id)){
      opensMatch=false;fail('V2_EXIT_WITHOUT_ENTRY',exit.strategy,id);
    }
  }

  // Pure V2 journals permit a separate accounting check against checkpoint
  // totals. Legacy exits/positions carry unverifiable historical baseline.
  if(journalAudit.legacyEventsExcluded!==0||legacyOpen>0){
    allV2=false;
  }
  let realizedPnlMatches=null;
  if(allV2&&journalAudit.structuralIntegrityIssues.length===0){
    realizedPnlMatches=true;
    for(const strategy of STRATEGIES){
      const summary=summaries[strategy];
      const independentlySummed=[...exits.values()]
        .filter(e=>e.strategy===strategy)
        .reduce((sum,e)=>sum+e.reportedNetPnlUsd,0);
      if(!MONEY(summary?.realizedUSD)||
        !close(summary.realizedUSD,independentlySummed)){
        realizedPnlMatches=false;
        fail('CHECKPOINT_PNL_MISMATCH',strategy,{
          reported:summary?.realizedUSD??null,
          journal:independentlySummed,
        });
      }
    }
  }
  const crossCheckPassed=mismatches.length===0 &&
    countsMatch&&opensMatch&&realizedPnlMatches===true &&
    journalAudit.structuralIntegrityIssues.length===0 &&
    journalAudit.legacyEventsExcluded===0;
  return {
    checkpointCountersMatch:countsMatch,
    checkpointV2OpenPositionsMatch:opensMatch,
    checkpointRealizedPnlMatchesV2Journal:realizedPnlMatches,
    legacyOpenPositionsUnauditable:legacyOpen,
    checkpointJournalCrossCheckPassed:crossCheckPassed,
    checkpointMismatches:mismatches,
    independentlyReconciledProductionPaperRoundTrips:0,
    tradingEdgeDemonstrated:false,
  };
}
