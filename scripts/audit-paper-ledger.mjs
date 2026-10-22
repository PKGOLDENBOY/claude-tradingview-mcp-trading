/**
 * Read-only auditor for an existing persistent AlphaBot JSON state export:
 *
 *   node scripts/audit-paper-ledger.mjs /data/safety-check-log.json 100
 *
 * A missing volume/file is an error. It NEVER fabricates sample trades,
 * accesses exchanges, places orders or modifies account state.
 */
import { readFileSync } from "node:fs";
import { auditPaperLedger } from "../lib/paper-ledger-evidence.mjs";
const path=process.argv[2] || process.env.STATE_FILE;
if(!path){console.error("LEDGER_UNAVAILABLE: pass the exact existing STATE_FILE path");process.exit(2);}
try{
  const state=JSON.parse(readFileSync(path,"utf8"));
  const starting=process.argv[3]===undefined?null:Number(process.argv[3]);
  const result=auditPaperLedger(state,{initialEquityUsd:starting});
  console.log(JSON.stringify({source:path,report:result},null,2));
}catch(e){console.error("LEDGER_AUDIT_FAILED: "+String(e.message).slice(0,200));process.exitCode=2;}
