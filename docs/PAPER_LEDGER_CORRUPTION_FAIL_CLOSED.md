# AlphaBot PAPER state integrity — fail-closed corruption handling

**Status: isolated research/quality patch, not approved or deployed.** No changes to exchange endpoints, live-money authorisation, risk limits, strategy signals, position sizing or Railway settings.

## Confirmed issue

The existing `bot.js` state reader previously renamed an unreadable **PAPER** state file to a `.bak.<time>` copy and silently created a fresh empty state. Its save routine also swallowed existing-file parse errors in PAPER mode and overwrote the damaged ledger. This could break trade/position continuity, misstate capital and risk history and invalidate an attempted 100-trade forward-paper audit, even if a backup existed.

## Changes in this branch

- Both PAPER and LIVE modes now **fail closed** if an existing persisted ledger cannot be read, parsed, or does not contain a trades array.
- Bad source bytes remain untouched at their original path. **No renames, truncation, overwrite, trade resets or blind recovery.**
- The previous write-time preservation of `_tradingHaltReason` and `unconfirmedOrders` is retained and regression-tested.
- **Corrupt position entries** (null, array, invalid type) and malformed trade records now fail closed, rather than silently deleting a possibly-open holding on load. Incoming in-memory state is also validated before writes.
- An existing confirmed PAPER entry/exit event may **not disappear or be silently rewritten** by a stale or overlapping save. The save routine checks the multiset of previously persisted entry/exit event snapshots against the next state and refuses a mismatch; duplicates matter. This protects continuity but does **not** authenticate fill provenance or guarantee process-external atomic compare-and-swap.

- The parsing helper is deterministic and local-only; it has no exchange, network or account access.
- An offline CI test extracts and executes the **real** application read/save functions against isolated temp files in both PAPER and LIVE modes, and checks the original bytes and directory listings after failure.
- Safety source checks keep real exchange writes gated on all three explicit live authorisations.

## Operational response to an integrity failure

1. **Keep PAPER and live orders disabled.** Do not delete the original ledger or click a reset control.
2. Snapshot the full original mounted volume and take a SHA-256 checksum; handle any account-identifying details privately.
3. Inspect a copy with an offline read-only verifier and check the latest known good backup and checkpoint chronology.
4. Repair only through an independently reviewed recovery procedure. Do not silently resume with an empty file or infer missing fills.
5. Record the outage as an **evidence gap**. Previously closed paper trades cannot be treated as independently reconciled unless entry/exit evidence and equity continuity survive intact.

## Boundaries

**Missing-volume protection:** When `STATE_FILE` is explicitly configured (as on Railway), both reads and writes now **fail closed** if that exact persisted file is missing. This prevents silently recreating the account if the volume detaches or is empty; do not repeatedly restart the service or initialize a new ledger without a reviewed recovery. An installation with no pre-existing persistent state now requires deliberate manual initialization before this patch can run. Local development without `STATE_FILE` still has the pre-existing fresh-state fallback. A durable off-volume presence witness, redundant backups, checksum/fsync verification and restart tests are still required to rule out all storage faults. A syntactically valid but stale or semantically incorrect ledger also needs separate reconciliation. The continuity guard is not a cross-process filesystem lock, and a missing/truncated historic snapshot cannot be invented or backfilled. The patch also does **not** provide unique independent position IDs, full forward paper round-trip fee reconciliation or marked-to-market drawdown; those remain separate tasks.

**No real trading authorization or deployment is implied by green CI.**

## Verified CI evidence (31 October 2026)

- Isolated ledger integrity workflow: https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/actions/runs/41242611737 — **27/27 tests passed**, including missing configured state, corrupt positions, stale paper-history overwrites and valid append.
- Full risk hardening workflow: https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/actions/runs/41242611659 — **112/112 regression tests passed**; not a production integration or independent financial audit.
- Recovery safety workflow: https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/actions/runs/41242611680 — completed successfully.
- **No Railway changes or rollout.** Do not merge to the active service without a separate checked state-backup/migration rehearsal. This does not establish profitable strategy performance or 100 genuine reconciled forward paper trades.
