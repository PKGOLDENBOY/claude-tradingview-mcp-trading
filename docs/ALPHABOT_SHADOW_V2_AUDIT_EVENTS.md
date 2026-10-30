# AlphaBot shadow proxy fill journaling — proposed isolated upgrade (NOT DEPLOYED)

**Status: DRAFT research-only code.** This change is stacked on [draft PR #16](https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/pull/16), not on production or any running Railway service. Its purpose is to make *future independent public-market shadow observations* reconstructable from actual stored simulation events, **not to claim a profitable trading bot**.

## Observed gap

The current running shadow service (`fix/continuous-readonly-shadow-20261023`) writes journal entries like:

```json
{"tag":"SHADOW_ENTRY","strategy":"scalp","symbol":"BTCUSDT","simulatedNotionalUSD":100,"entryPrice":100}
{"tag":"SHADOW_EXIT","strategy":"scalp","symbol":"BTCUSDT","simulatedPnlUSD":-1.2}
```

This lacks a durable per-position ID, per-fill ID, exact exit fill price, quantity, precise fee amounts, original fill timestamp and unrounded reconciliation amount. Existing cumulative `SHADOW_CYCLE` counters **cannot** be verified as 100 independently closed positions, nor used to prove actual production trading P&L.

## New future-entry receipts (v2, append-only)

- New independent shadow position receives a UUID v4 with `shadow-` prefix, stored in the persistent checkpoint **at entry**. No old position is silently given a synthetic UUID or original entry.
- New `SHADOW_ENTRY` records include the original `positionId`, deterministic `fillId`, exact quantity, simulated execution price including adverse slippage, entry fee in USD, fee rate, fill timestamp, `eventSchemaVersion:2`, and `evidenceSource:PUBLIC_GET_SHADOW_PROXY_NOT_PRODUCTION_PAPER`.
- `SHADOW_EXIT` for the same position has the same position ID, a unique exit fill ID and the original entry fill ID, exact simulated executable bid-side price with slippage, exit fee and **unrounded** modelled net P&L after *both* fees.
- Old pre-upgrade checkpoints with no original evidence ID retain `eventSchemaVersion:1`, `auditEligible:false` and `legacyMissingOriginalEntry:true` on exit. It is dishonest to relabel them as independently auditable v2 fills.
- No pricing, sizing, position cap, order behavior, strategy selection or execution permission changes were made. This is a passive reporting/schema extension to the already independent shadow signal proxy, with explicit validation of amount consistency before a position is removed.
- Existing append-only `SHADOW_ENTRY/SHADOW_EXIT` NDJSON remains intact. No backfill, deletion, overwrite, deduplication or historical event rewriting.

## Durable crash safety and limitations

An append-only event journal and a checkpoint cannot be made one atomic transaction without a separate transactional store. For example, a crash between journaling an exit and committing the checkpoint might result in a second exit record after restart. The offline auditor **fails closed on duplicated fills or unmatched exit events** rather than treating them as two trades.

The code does not reconstruct corrupted or missing events and cannot prove that a full event-history export was captured. For additional detection, the optional second CLI argument is the separately exported original checkpoint; aggregate per-strategy entry/exit and open counts must match all journal events. Even when local counts match, externally verifying the completeness of the export, quote authenticity and durable storage still requires human review.

## Offline read-only audit of EXPORTED research evidence

```sh
node scripts/audit-shadow-journal.mjs /safe/export/shadow-events.ndjson /safe/export/shadow-checkpoint.json
```

The utility only reads local exported files. It rejects symlinks, oversized files, invalid NDJSON, duplicate `fillId`, malformed v2 records, fee rate/fee amount mismatches, mismatched entry/exit IDs, differing symbols, unrecognized safety mode and P&L discrepancies. Its output explicitly fixes these fields to **zero/false**, even for 100 synthetic matched shadow round trips:

```json
{
  "independentlyReconciledProductionPaperRoundTrips": 0,
  "realMoneyProfitabilityDemonstrated": false,
  "forwardCandidateValidationComplete": false,
  "liveTradingReady": false
}
```

**Absolutely do not transform these shadow signal-proxy fills into genuine production forward-PAPER trades.** These strategy proxies run on public market data and their executions are only approximations; they do not have exchange-authenticated fills, actual market impact, full account equity marks, or risk-limit verification.

## Additional checkpoint reconciliation (30 October 2026, draft only)

The first offline verifier compared only the journal entry/exit **counts** to checkpoint totals. Identical counts are insufficient: a journal's outstanding v2 entry could refer to **a different position or quantity** from the checkpoint, and cumulative reported P&L might be altered while all counts still agree.

[New offline comparator](../lib/shadow-checkpoint-audit.mjs) now requires:
- Every **open v2 position** in the checkpoint must match the originally journaled entry's persistent UUID, strategy, symbol, timestamp, quantity, execution price, fee rate, and fee amount; **no exit** for that ID can already exist.
- Every unmatched v2 journal entry must correspond to exactly one still-open checkpoint position. Orphaned openings, duplicated open symbols, closed IDs reported as open, and unknown/missing strategy records fail closed.
- When the entire exported journal is **v2-only**, every strategy's checkpoint cumulative `realizedUSD` is independently checked against the sum of paired, fee-adjusted exit receipts. A legacy event or old open position prevents this all-v2 accounting certification; **no invented historical baseline** is used.
- Exported checkpoint counter comparison, open-position identity comparison, and net accounting comparison are reported **separately** to expose the precise source of an inconsistency. A passing test is still **not** proof of a continuous journal or genuine production PAPER profitability.

Regression tests deliberately alter quantities and reported P&L **without changing entry/exit counts** and prove that the new gate detects them. No effect on the running shadow service and no deployment is requested.

## Verification and rollout restrictions

```sh
node --test test/shadow-auditable-events.test.mjs test/shadow-journal-reconcile.test.mjs test/shadow-journal-cli.test.mjs test/shadow-checkpoint.test.mjs test/shadow-execution-safety.test.mjs test/shadow-price-risk.test.mjs test/shadow-wide-spread-incident.test.mjs
```

- No exchange credentials, authenticated APIs, orders, production deployments, Railway variables, or real-money trading changes.
- Do not deploy the stacked PR without reviewing PR #16's complete executable-bid/spread/stop behavior, checkpoint compatibility, crash recoverability and write ordering. The **currently running** shadow service does **not** yet emit these v2 fields.
- The previously selected `reversion-0192` failed its one-time untouched historical OOS ([evidence](https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/actions/runs/40917479432)). Its holdout is consumed; do not use these new proxy receipts to retune it against that same OOS.
