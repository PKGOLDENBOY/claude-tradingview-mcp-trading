#!/usr/bin/env node
/**
 * Explicitly offline, READ-ONLY inventory of original and active AlphaBot files.
 *
 * Usage:
 * node scripts/reconcile-trade-history.mjs \
 *   --historical-state /data/safety-check-log.json \
 *   --current-state /data/paper-hardening-20261019.json \
 *   --historical-csv /data/trades.csv \
 *   --current-csv /data/trades-paper-hardening-20261019.csv
 *
 * Reads snapshots only. It never imports bot.js, calls an exchange, modifies
 * positions or writes to the volume. stdout contains aggregates, no trade IDs.
 */
import { readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { reconcileTradeHistory } from "../lib/trade-history-reconciliation.mjs";

const activeState = process.env.STATE_FILE || "/data/paper-hardening-20261019.json";
const root = dirname(activeState);
const paths = {
  historicalState: join(root, "safety-check-log.json"),
  currentState: activeState,
  historicalCsv: join(root, "trades.csv"),
  currentCsv: process.env.PAPER_CSV_FILE || join(root, "trades-paper-hardening-20261019.csv"),
};
const flags = {
  "--historical-state": "historicalState",
  "--current-state": "currentState",
  "--historical-csv": "historicalCsv",
  "--current-csv": "currentCsv",
};
function usage() {
  return "Usage: node scripts/reconcile-trade-history.mjs " +
    "[--historical-state PATH] [--current-state PATH] " +
    "[--historical-csv PATH] [--current-csv PATH]\n" +
    "Defaults use /data and STATE_FILE/PAPER_CSV_FILE when available. No files are changed.";
}
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === "--help") { console.log(usage()); process.exit(0); }
  if (!(flag in flags) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) {
    console.error(usage());
    process.exit(2);
  }
  paths[flags[flag]] = process.argv[++i];
}
const inputs = {};
const fileEvidence = {};
let missingOrInvalid = false;
for (const [role, path] of Object.entries(paths)) {
  const kind = role.endsWith("State") ? "json" : "csv";
  try {
    const text = readFileSync(path, "utf8");
    inputs[role] = kind === "json" ? JSON.parse(text.replace(/^\uFEFF/, "")) : text;
    fileEvidence[role] = { status: "READ", filename: basename(path), format: kind };
  } catch (err) {
    missingOrInvalid = true;
    // Deliberately suppress parser traces or file contents: state can be sensitive.
    const status = err?.code === "ENOENT" ? "MISSING" :
      err instanceof SyntaxError ? "INVALID_JSON" : "UNREADABLE";
    fileEvidence[role] = { status, filename: basename(path), format: kind };
  }
}
let report;
try {
  report = reconcileTradeHistory(inputs);
} catch {
  // Even when a parse succeeds, schema mismatch must not fabricate statistics.
  missingOrInvalid = true;
  report = { status: "INVALID_RECORD_FORMAT", noMetricsClaimed: true, readOnly: true };
}
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  label: "OFFLINE_RECORD_RECONCILIATION_NOT_LIVE_PROFIT_VALIDATION",
  files: fileEvidence,
  report,
}, null, 2));
if (missingOrInvalid) process.exitCode = 2;
