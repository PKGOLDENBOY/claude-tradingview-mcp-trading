#!/usr/bin/env node
/**
 * Strictly read-only offline audit of an EXPORTED shadow NDJSON journal.
 * No Railway connection, no exchange credentials, no orders and no file writes.
 * Even 100 perfectly paired SHADOW proxies are NOT 100 production PAPER trades.
 */
import {lstatSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {reconcileShadowEventJournal} from '../lib/shadow-journal-reconcile.mjs';
import {loadShadowCheckpoint} from '../lib/shadow-checkpoint.mjs';
import {compareShadowCheckpointJournal} from '../lib/shadow-checkpoint-audit.mjs';

const MAX_JOURNAL_BYTES=32*1024*1024;
export function auditShadowJournalFile(path,checkpointPath=null){
  if(typeof path!=='string'||!path.trim()||path.includes('\0'))
    throw new Error('SHADOW_AUDIT_FILE_PATH_INVALID');
  const full=resolve(path);
  const st=lstatSync(full);
  if(st.isSymbolicLink()||!st.isFile()||st.size>MAX_JOURNAL_BYTES)
    throw new Error('SHADOW_AUDIT_FILE_UNSAFE_OR_TOO_LARGE');
  const bytes=readFileSync(full);
  if(bytes.length>MAX_JOURNAL_BYTES)
    throw new Error('SHADOW_AUDIT_FILE_CHANGED_DURING_READ');
  const data=bytes.toString('utf8');
  const rows=data.split('\n');
  if(rows.at(-1)==='')rows.pop();
  if(rows.length>500000)throw new Error('SHADOW_AUDIT_TOO_MANY_EVENTS');
  const events=rows.map((row,i)=>{
    if(!row.trim())throw new Error('SHADOW_AUDIT_EMPTY_EVENT_LINE_'+(i+1));
    try{return JSON.parse(row);}
    catch{throw new Error('SHADOW_AUDIT_CORRUPT_JSON_LINE_'+(i+1));}
  });
  const audit=reconcileShadowEventJournal(events);
  const report={
    sha256:createHash('sha256').update(bytes).digest('hex'),
    sourceFile:full,
    ...audit,
    checkpointCountersMatch:null,
    checkpointMismatches:[],
  };
  if(checkpointPath!==null){
    if(typeof checkpointPath!=='string'||!checkpointPath.trim()||checkpointPath.includes('\0'))
      throw new Error('SHADOW_AUDIT_CHECKPOINT_PATH_INVALID');
    const checkpoint=loadShadowCheckpoint(checkpointPath);
    if(!checkpoint)throw new Error('SHADOW_AUDIT_CHECKPOINT_MISSING');
    const comparison=compareShadowCheckpointJournal(checkpoint,events,audit);
    Object.assign(report,comparison);
    if(!comparison.checkpointJournalCrossCheckPassed){
      report.structuralIntegrityIssues.push({
        type:'CHECKPOINT_JOURNAL_INCOMPLETE_OR_UNVERIFIED',
        positionId:null
      });
      report.structurallyReconciledClosedProxies=false;
      report.locallyPairedV2JournalNoLegacy=false;
    }
  }
  return report;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==3&&process.argv.length!==4)
      throw new Error('USAGE: node scripts/audit-shadow-journal.mjs /local/exported/shadow-events.ndjson [/local/exported/shadow-checkpoint.json]');
    const report=auditShadowJournalFile(process.argv[2],process.argv[3]??null);
    console.log(JSON.stringify(report,null,2));
    if(report.structuralIntegrityIssues.length)process.exitCode=1;
  }catch(error){
    console.error('SHADOW_AUDIT_FAILED: '+String(error?.message??error));
    process.exitCode=2;
  }
}
