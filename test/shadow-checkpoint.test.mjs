import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadShadowCheckpoint, saveShadowCheckpoint, appendShadowEvidence, SHADOW_MODE } from "../lib/shadow-checkpoint.mjs";

function fixture(callback) {
  const dir=mkdtempSync(join(tmpdir(),"shadow-checkpoint-"));
  try { callback(dir); } finally { rmSync(dir,{recursive:true,force:true}); }
}
test("shadow checkpoint survives restart and uses atomic snapshot", () => fixture(dir=>{
  const path=join(dir,"shadow.json");
  assert.equal(loadShadowCheckpoint(path),null);
  const state={startedAt:1_800_000_000_000,endsAt:1_805_000_000_000,cycles:22,errors:0,
    quotes:4000,positions:{scalp:[["BTCUSDT",{opened:1_800_000_000_001,quantity:1,entryPrice:100,totalCost:100.1}]]},
    summary:{scalp:{entries:1,exits:0,realizedUSD:0}}};
  saveShadowCheckpoint(path,state);
  assert.equal(existsSync(path+".tmp"),false);
  assert.deepEqual(loadShadowCheckpoint(path).positions,state.positions);
  assert.equal(loadShadowCheckpoint(path).cycles,22);
  assert.equal(loadShadowCheckpoint(path).safetyMode,SHADOW_MODE);
}));
test("shadow evidence accepts ONLY simulated entry/exit records",()=>fixture(dir=>{
  const path=join(dir,"events.ndjson");
  appendShadowEvidence(path,{tag:"SHADOW_ENTRY",safety:SHADOW_MODE,symbol:"BTCUSDT"});
  appendShadowEvidence(path,{tag:"SHADOW_EXIT",safety:SHADOW_MODE,simulatedPnlUSD:-1.2});
  assert.equal(readFileSync(path,"utf8").trim().split("\n").length,2);
  assert.throws(()=>appendShadowEvidence(path,{tag:"LIVE_ORDER",safety:SHADOW_MODE}),/NOT_A_TRADE/);
  assert.throws(()=>appendShadowEvidence(path,{tag:"SHADOW_ENTRY",safety:"LIVE"}),/UNSAFE_MODE/);
}));
test("bad prior shadow checkpoint fails closed, never silently resets",()=>fixture(dir=>{
  const path=join(dir,"state.json");
  writeFileSync(path,"{broken");
  assert.throws(()=>loadShadowCheckpoint(path),/SHADOW_CHECKPOINT_CORRUPT/);
  writeFileSync(path,JSON.stringify({schemaVersion:1,safetyMode:"LIVE",startedAt:1,endsAt:2,positions:{},summary:{},cycles:0}));
  assert.throws(()=>loadShadowCheckpoint(path),/SHADOW_CHECKPOINT_INVALID/);
}));
