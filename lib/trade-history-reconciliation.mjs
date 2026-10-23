/**
 * Offline, read-only reconciliation of historical and active AlphaBot records.
 *
 * Does not access exchange APIs, invoke bot.js, write files, deduce missing trade
 * modes, or sum potentially overlapping state files. Identifiers remain internal
 * and never appear in the resulting report.
 */
import { auditPaperLedger } from "./paper-ledger-evidence.mjs";

const MODES = ["PAPER", "LIVE", "UNKNOWN"];
const round = n => Number(n.toFixed(4));
const clean = v => typeof v === "string" ? v.trim() : "";
const modeOfState = t => t?.paperTrading === true ? "PAPER" :
  t?.paperTrading === false ? "LIVE" : "UNKNOWN";
const emptyEvents = () => ({ entry: 0, exit: 0, other: 0, executedEntry: 0, executedExit: 0 });

export function summarizeState(state) {
  if (!state || !Array.isArray(state.trades)) throw new Error("MISSING_PERSISTED_TRADE_EVENTS");
  const eventCounts = Object.fromEntries(MODES.map(mode => [mode, emptyEvents()]));
  let botEstimatedTotal = 0, botEstimatedCount = 0;
  for (const t of state.trades) {
    const mode = modeOfState(t), kind = t?.type === "entry" ? "entry" :
      t?.type === "exit" ? "exit" : "other";
    eventCounts[mode][kind]++;
    if (t?.orderPlaced === true && kind !== "other")
      eventCounts[mode][kind === "entry" ? "executedEntry" : "executedExit"]++;
    // Legacy figure is deliberately segregated: it can mix LIVE/PAPER/UNKNOWN,
    // lack fees, and include partial exits. NEVER call it actual account P&L.
    if (kind === "exit" && t?.orderPlaced === true && t.pnlUSD !== null &&
        t.pnlUSD !== undefined && Number.isFinite(Number(t.pnlUSD))) {
      botEstimatedTotal += Number(t.pnlUSD);
      botEstimatedCount++;
    }
  }
  const audited = auditPaperLedger(state);
  return {
    status: "READ",
    rawEventCount: state.trades.length,
    eventCounts,
    botEstimatedAllModeExitPnl: {
      amountUsd: botEstimatedCount ? round(botEstimatedTotal) : null,
      includedExitEvents: botEstimatedCount,
      verified: false,
      description: "Unverified app-reported sum across all modes; NOT account performance",
    },
    paperFeeAdjustedExitEvidence: {
      recordedPaperExitEvents: audited.paperExitEventsSeen,
      auditableExitEvents: audited.auditableExitEvents,
      rejectedExitEvents: audited.excludedExitEvents,
      rejectedReasons: audited.excludedReasons,
      realizedExitPnlUsd: audited.auditableExitEvents ? audited.realizedExitPnlUsd : null,
      wins: audited.wins,
      losses: audited.losses,
      breakeven: audited.breakeven,
      winRatePct: audited.winRatePct,
      profitFactor: audited.profitFactor,
      fullPortfolioMaxDrawdownPct: null,
      verifiedIndependentRoundTrips: null,
      riskLimitViolations: null,
      exchangeVerified: false,
      description: "App-recorded fee-adjusted PAPER exit EVENTS only; not completed positions",
    },
  };
}

/** Parse RFC4180-like CSV, including commas/newlines and escaped quotes. Fail closed. */
export function parseCsv(text) {
  if (typeof text !== "string") throw new Error("INVALID_CSV_INPUT");
  const lines = [], row = [];
  let value = "", quoted = false, closedQuote = false, started = false;
  const field = () => { row.push(value); value = ""; closedQuote = false; started = false; };
  const finish = () => { field(); lines.push(row.splice(0)); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else value += c;
    } else if (c === '"' && !started && !closedQuote) {
      quoted = true; started = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      field();
      if (c !== ',') {
        lines.push(row.splice(0));
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
    } else {
      if (c === '"' || closedQuote) throw new Error("MALFORMED_CSV_QUOTING");
      value += c; started = true;
    }
  }
  if (quoted) throw new Error("UNTERMINATED_CSV_QUOTE");
  if (started || closedQuote || row.length || value) finish();
  if (!lines.length) throw new Error("EMPTY_CSV");
  const headers = lines.shift();
  if (headers[0]) headers[0] = headers[0].replace(/^\uFEFF/, "");
  if (new Set(headers).size !== headers.length) throw new Error("DUPLICATE_CSV_HEADERS");
  for (const h of ["Mode", "Side", "Symbol", "Order ID"])
    if (!headers.includes(h)) throw new Error("MISSING_CSV_COLUMN_" + h);
  return lines.map((values, i) => {
    if (values.length !== headers.length) throw new Error("INVALID_CSV_FIELD_COUNT_ROW_" + (i + 2));
    return Object.fromEntries(headers.map((h, j) => [h, values[j]]));
  });
}
export function summarizeCsv(text) {
  const rows = parseCsv(text);
  const modes = { PAPER: emptyEvents(), LIVE: emptyEvents(), NON_EXECUTED: emptyEvents(), UNKNOWN: emptyEvents() };
  let buy = 0, sell = 0;
  for (const row of rows) {
    const raw = clean(row.Mode).toUpperCase();
    const mode = raw === "PAPER" || raw === "LIVE" ? raw :
      raw === "HELD" || raw === "BLOCKED" ? "NON_EXECUTED" : "UNKNOWN";
    const side = clean(row.Side).toUpperCase();
    const kind = side === "BUY" ? "entry" : side === "SELL" ? "exit" : "other";
    modes[mode][kind]++;
    if (kind !== "other" && (mode === "PAPER" || mode === "LIVE"))
      modes[mode][kind === "entry" ? "executedEntry" : "executedExit"]++;
    if (kind === "entry") buy++;
    if (kind === "exit") sell++;
  }
  return {
    status: "READ", rawRowCount: rows.length, modes, buyRows: buy, sellRows: sell,
    realizedPnlUsd: null, winRatePct: null, profitFactor: null,
    description: "CSV contains transaction cash flows and estimated fees; not independently reconciled realized P&L",
  };
}

function usableId(value) {
  const id = clean(value);
  return id && !["HELD", "BLOCKED", "N/A", "NONE", "NULL", "UNKNOWN", "-"].includes(id.toUpperCase()) ? id : null;
}
function keyFromState(t) {
  const id = usableId(t?.orderId), sym = clean(t?.symbol).toUpperCase();
  const side = t?.type === "entry" ? "BUY" : t?.type === "exit" ? "SELL" : "";
  return t?.orderPlaced === true && id && sym && side ? JSON.stringify([id, sym, side]) : null;
}
function keyFromCsv(t) {
  const id = usableId(t["Order ID"]), sym = clean(t.Symbol).toUpperCase();
  const side = clean(t.Side).toUpperCase();
  return id && sym && (side === "BUY" || side === "SELL") ? JSON.stringify([id, sym, side]) : null;
}
function buildIndex(events, getKey, getMode) {
  const byId = new Map();
  let unjoinable = 0, repeatedIdentities = 0;
  for (const t of events) {
    const key = getKey(t);
    if (!key) { unjoinable++; continue; }
    if (byId.has(key)) repeatedIdentities++;
    if (!byId.has(key)) byId.set(key, new Set());
    byId.get(key).add(getMode(t));
  }
  return { byId, unjoinable, repeatedIdentities };
}
function compareIndexes(a, b) {
  if (!a || !b) return { status: "UNAVAILABLE" };
  let shared = 0, modeConflictCandidates = 0, matchingModeCandidates = 0;
  for (const [key, modes] of a.byId) {
    const other = b.byId.get(key);
    if (!other) continue;
    shared++;
    if ([...modes].some(m => other.has(m) && (m === "PAPER" || m === "LIVE")))
      matchingModeCandidates++;
    if ([...modes].some(m => m !== "UNKNOWN" && [...other].some(n => n !== "UNKNOWN" && m !== n)))
      modeConflictCandidates++;
  }
  return {
    status: "CANDIDATE_ONLY",
    sharedOrderIdentifiers: shared,
    matchingModeCandidates,
    modeConflictCandidates,
    firstOnlyIdentifiers: a.byId.size - shared,
    secondOnlyIdentifiers: b.byId.size - shared,
    firstUnjoinableEvents: a.unjoinable,
    secondUnjoinableEvents: b.unjoinable,
    firstRepeatedIdentifierEvents: a.repeatedIdentities,
    secondRepeatedIdentifierEvents: b.repeatedIdentities,
    note: "Order identifiers are not proven globally unique; matching does NOT verify fills, distinct positions, or missing transactions",
  };
}

/**
 * accepts optional parsed records for four sources. Missing snapshots are
 * explicitly unavailable. Reports NEVER add P&L across historical/current.
 */
export function reconcileTradeHistory({ historicalState, currentState, historicalCsv, currentCsv } = {}) {
  const result = {
    schemaVersion: 1, readOnly: true, exchangeAccess: false,
    sources: {
      historicalState: historicalState == null ? { status: "UNAVAILABLE" } : summarizeState(historicalState),
      currentState: currentState == null ? { status: "UNAVAILABLE" } : summarizeState(currentState),
      historicalCsv: historicalCsv == null ? { status: "UNAVAILABLE" } : summarizeCsv(historicalCsv),
      currentCsv: currentCsv == null ? { status: "UNAVAILABLE" } : summarizeCsv(currentCsv),
    },
    combinedAcrossSources: {
      feeAdjustedPaperPnlUsd: null,
      completedIndependentTrades: null,
      fullPortfolioMaxDrawdownPct: null,
      riskLimitViolations: null,
      livePnlUsd: null,
      note: "Files may overlap or omit trades; never sum snapshots or paper and live activity",
    },
    limitations: [
      "PAPER/LIVE classification requires explicit record tags, never file names.",
      "A CSV sell and an app-recorded exit may describe the same event; neither is added twice.",
      "Estimated CSV fees and net proceeds are not equivalent to verified round-trip profit.",
      "App-recorded fee-adjusted exits are not independently exchange-verified.",
      "Partial exits are events, not independent completed positions; portfolio drawdown needs equity snapshots.",
      "Risk-limit violations cannot be assessed from execution counts without time-stamped risk/equity evidence.",
    ],
  };
  const stateIndex = state => state == null ? null : buildIndex(state.trades, keyFromState, modeOfState);
  const csvIndex = raw => raw == null ? null : buildIndex(parseCsv(raw), keyFromCsv, row => {
    const m = clean(row.Mode).toUpperCase();
    return m === "PAPER" || m === "LIVE" ? m : "UNKNOWN";
  });
  const hs = stateIndex(historicalState), cs = stateIndex(currentState);
  result.reconciliation = {
    historicalStateVsCsv: compareIndexes(hs, csvIndex(historicalCsv)),
    currentStateVsCsv: compareIndexes(cs, csvIndex(currentCsv)),
    historicalVsCurrentState: compareIndexes(hs, cs),
  };
  return result;
}
