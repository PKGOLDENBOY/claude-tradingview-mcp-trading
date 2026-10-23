import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseCsv, summarizeState, summarizeCsv, reconcileTradeHistory
} from "../lib/trade-history-reconciliation.mjs";

const ts = "2026-10-20T12:00:00Z";
const exit = (orderId, pnlUSD, paperTrading = true, overrides = {}) => ({
  type: "exit", timestamp: ts, symbol: "BTCUSDT", quantity: 0.01,
  orderId, orderPlaced: true, paperTrading, feeAdjusted: true, pnlUSD, ...overrides,
});
const entry = (orderId, paperTrading = true) => ({
  type: "entry", timestamp: ts, symbol: "BTCUSDT", quantity: 0.01,
  orderId, orderPlaced: true, paperTrading,
});
const header = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";
const csvRow = (orderId, mode = "PAPER", side = "SELL", notes = "sample") =>
  ["2026-10-20", "12:00:00", "BitGet", "BTCUSDT", side,
    "0.01", "80000", "800", "0.8", "799.2", orderId, mode, notes].join(",");

test("legacy LIVE, PAPER and unknown are never mixed in fee-adjusted paper P&L", () => {
  const state = { trades: [
    exit("P1", -1),
    exit("P2", -5, true, { feeAdjusted: false }),
    exit("L1", 100, false),
    exit("U1", -20, null),
    entry("A1", true),
  ] };
  const out = summarizeState(state);
  assert.equal(out.eventCounts.PAPER.executedExit, 2);
  assert.equal(out.eventCounts.LIVE.executedExit, 1);
  assert.equal(out.eventCounts.UNKNOWN.executedExit, 1);
  assert.equal(out.botEstimatedAllModeExitPnl.amountUsd, 74);
  assert.equal(out.botEstimatedAllModeExitPnl.verified, false);
  assert.equal(out.paperFeeAdjustedExitEvidence.auditableExitEvents, 1);
  assert.equal(out.paperFeeAdjustedExitEvidence.realizedExitPnlUsd, -1);
  assert.equal(out.paperFeeAdjustedExitEvidence.winRatePct, 0);
  assert.equal(out.paperFeeAdjustedExitEvidence.fullPortfolioMaxDrawdownPct, null);
  assert.equal(out.paperFeeAdjustedExitEvidence.riskLimitViolations, null);
});

test("duplicates and missing fee evidence are excluded, not double-counted", () => {
  const t1 = exit("ONE", 3);
  const out = summarizeState({ trades: [
    t1, { ...t1 },
    exit("TWO", -1, true, { timestamp: "2026-10-20T13:00:00Z" }),
    exit("THREE", 10, true, { feeAdjusted: false }),
  ] });
  const a = out.paperFeeAdjustedExitEvidence;
  assert.equal(a.recordedPaperExitEvents, 4);
  assert.equal(a.auditableExitEvents, 2);
  assert.equal(a.rejectedExitEvents, 2);
  assert.equal(a.realizedExitPnlUsd, 2);
  assert.equal(a.winRatePct, 50);
  assert.equal(a.profitFactor, 3);
});

test("CSV quoting: commas, line breaks, embedded quotes and BOM are handled", () => {
  const content = "\uFEFF" + header + "\r\n" +
    csvRow("P1", "PAPER", "SELL", '"Profit, then ""exit""\nnext line"') + "\r\n";
  const rows = parseCsv(content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Notes, 'Profit, then "exit"\nnext line');
  assert.equal(summarizeCsv(content).modes.PAPER.executedExit, 1);
  assert.equal(summarizeCsv(content).realizedPnlUsd, null);
  assert.throws(() => parseCsv(header + "\n\"unterminated"), /UNTERMINATED_CSV_QUOTE/);
});

test("state/CSV joins are candidate-only, count mode conflicts, and leak no IDs", () => {
  const hist = { trades: [exit("MATCH-P", 3), exit("MODE-CLASH", -2)] };
  const current = { trades: [exit("MATCH-P", 3), exit("NEW-LIVE", 999, false)] };
  const histCsv = [header, csvRow("MATCH-P"), csvRow("MODE-CLASH", "LIVE")].join("\n");
  const currentCsv = [header, csvRow("MATCH-P"), csvRow("NEW-LIVE", "LIVE")].join("\n");
  const report = reconcileTradeHistory({
    historicalState: hist, currentState: current, historicalCsv: histCsv, currentCsv,
  });
  assert.equal(report.reconciliation.historicalStateVsCsv.sharedOrderIdentifiers, 2);
  assert.equal(report.reconciliation.historicalStateVsCsv.modeConflictCandidates, 1);
  assert.equal(report.reconciliation.currentStateVsCsv.modeConflictCandidates, 0);
  assert.equal(report.reconciliation.historicalVsCurrentState.sharedOrderIdentifiers, 1);
  assert.equal(report.combinedAcrossSources.feeAdjustedPaperPnlUsd, null);
  assert.equal(report.combinedAcrossSources.livePnlUsd, null);
  assert.equal(report.sources.historicalState.paperFeeAdjustedExitEvidence.auditableExitEvents, 2);
  assert.equal(report.sources.currentState.paperFeeAdjustedExitEvidence.auditableExitEvents, 1);
  assert.ok(!JSON.stringify(report).includes("MATCH-P"));
  assert.ok(!JSON.stringify(report).includes("MODE-CLASH"));
  assert.ok(!JSON.stringify(report).includes("NEW-LIVE"));
});

test("no paper exits = unknown realized P&L, not an invented zero-profit sample", () => {
  const out = reconcileTradeHistory({ historicalState: { trades: [] } });
  assert.equal(out.sources.historicalState.paperFeeAdjustedExitEvidence.auditableExitEvents, 0);
  assert.equal(out.sources.historicalState.paperFeeAdjustedExitEvidence.realizedExitPnlUsd, null);
  assert.equal(out.sources.currentState.status, "UNAVAILABLE");
  assert.equal(out.reconciliation.historicalStateVsCsv.status, "UNAVAILABLE");
});

test("CLI reads only four files and leaves every source intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "alphabot-audit-"));
  try {
    const paths = {
      "--historical-state": join(dir, "legacy.json"),
      "--current-state": join(dir, "current.json"),
      "--historical-csv": join(dir, "legacy.csv"),
      "--current-csv": join(dir, "current.csv"),
    };
    const data = {
      [paths["--historical-state"]]: JSON.stringify({ trades: [exit("A", 2)] }),
      [paths["--current-state"]]: JSON.stringify({ trades: [exit("B", -1)] }),
      [paths["--historical-csv"]]: header + "\n" + csvRow("A") + "\n",
      [paths["--current-csv"]]: header + "\n" + csvRow("B") + "\n",
    };
    for (const [p, content] of Object.entries(data)) writeFileSync(p, content);
    const args = Object.entries(paths).flatMap(([flag, path]) => [flag, path]);
    const run = spawnSync(process.execPath,
      [new URL("../scripts/reconcile-trade-history.mjs", import.meta.url).pathname, ...args],
      { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.report.readOnly, true);
    assert.equal(result.report.sources.historicalState.paperFeeAdjustedExitEvidence.realizedExitPnlUsd, 2);
    assert.equal(result.report.sources.currentState.paperFeeAdjustedExitEvidence.realizedExitPnlUsd, -1);
    assert.equal(readdirSync(dir).length, 4);
    for (const [p, content] of Object.entries(data)) assert.equal(readFileSync(p, "utf8"), content);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI missing file produces partial data with nonzero exit; never writes defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "alphabot-audit-missing-"));
  try {
    const missing = join(dir, "missing.json");
    const run = spawnSync(process.execPath,
      [new URL("../scripts/reconcile-trade-history.mjs", import.meta.url).pathname,
        "--historical-state", missing, "--current-state", missing,
        "--historical-csv", missing, "--current-csv", missing],
      { encoding: "utf8" });
    assert.equal(run.status, 2);
    const report = JSON.parse(run.stdout);
    assert.equal(report.files.historicalState.status, "MISSING");
    assert.equal(report.report.combinedAcrossSources.feeAdjustedPaperPnlUsd, null);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
