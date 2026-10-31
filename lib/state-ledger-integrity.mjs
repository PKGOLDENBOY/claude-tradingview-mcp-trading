/**
 * Fail-closed parsing of existing trading/paper state.
 *
 * A damaged persisted ledger must never silently become an empty portfolio:
 * doing so would erase evidence of paper entries/exits and risk-limit history.
 * This module has no network, exchange or order capabilities.
 */
export function parseExistingTradingState(raw) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw))
    throw new Error('STATE_LEDGER_INVALID_BYTES');
  const text = (Buffer.isBuffer(raw) ? raw.toString('utf8') : raw).replace(/^\uFEFF/, '');
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw new Error('STATE_LEDGER_CORRUPT_JSON');
  }
  return assertTradingStateObject(state);
}

export function assertTradingStateObject(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !Array.isArray(state.trades)) {
    throw new Error('STATE_LEDGER_INVALID_SHAPE');
  }
  // Deleting an invalid position record would erase evidence of an open holding.
  for (const store of ['positions','swingPositions','breakoutPositions','sniperPositions','ltPositions']) {
    if (state[store] === undefined) continue;
    const positions = state[store];
    if (!positions || typeof positions !== 'object' || Array.isArray(positions))
      throw new Error('STATE_LEDGER_INVALID_POSITION_STORE: '+store);
    for (const value of Object.values(positions)) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('STATE_LEDGER_INVALID_POSITION_RECORD: '+store);
    }
  }
  if (state.trades.some(t => !t || typeof t !== 'object' || Array.isArray(t)))
    throw new Error('STATE_LEDGER_INVALID_TRADE_RECORD');
  return state;
}

/**
 * Prevent an overlapping read/modify/write from dropping or rewriting historic
 * PAPER entry/exit evidence. Comparison is a multiset (duplicates matter).
 * Existing app logs lack immutable position IDs, so this is a continuity guard,
 * NOT proof that any closed event is a reconciled paper round trip.
 */
export function assertPaperEventHistoryPreserved(persisted, incoming) {
  if (!Array.isArray(persisted?.trades) || !Array.isArray(incoming?.trades))
    throw new Error('STATE_LEDGER_INVALID_TRADE_HISTORY');
  const isPaperEvent = t => t?.paperTrading === true && t?.orderPlaced === true &&
    (t.type === 'entry' || t.type === 'exit');
  const occurrences = new Map();
  for (const event of incoming.trades.filter(isPaperEvent)) {
    const key = JSON.stringify(event);
    occurrences.set(key,(occurrences.get(key) || 0)+1);
  }
  for (const event of persisted.trades.filter(isPaperEvent)) {
    const key = JSON.stringify(event);
    const count = occurrences.get(key) || 0;
    if (count === 0) throw new Error('PAPER_TRADE_HISTORY_LOSS_OR_MUTATION');
    occurrences.set(key,count-1);
  }
  return true;
}
