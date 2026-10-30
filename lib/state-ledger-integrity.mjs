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
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !Array.isArray(state.trades)) {
    throw new Error('STATE_LEDGER_INVALID_SHAPE');
  }
  return state;
}
