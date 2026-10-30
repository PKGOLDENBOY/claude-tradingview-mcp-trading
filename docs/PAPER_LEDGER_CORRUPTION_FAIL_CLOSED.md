# AlphaBot PAPER state integrity — fail-closed corruption handling

**Status: isolated research/quality patch, not approved or deployed.** No changes to exchange endpoints, live-money authorisation, risk limits, strategy signals, position sizing or Railway settings.

## Confirmed issue

The existing `bot.js` state reader previously renamed an unreadable **PAPER** state file to a `.bak.<time>` copy and silently created a fresh empty state. Its save routine also swallowed existing-file parse errors in PAPER mode and overwrote the damaged ledger. This could break trade/position continuity, misstate capital and risk history and invalidate an attempted 100-trade forward-paper audit, even if a backup existed.

## Changes in this branch

- Both PAPER and LIVE modes now **fail closed** if an existing persisted ledger cannot be read, parsed, or does not contain a trades array.
- Bad source bytes remain untouched at their original path. **No renames, truncation, overwrite, trade resets or blind recovery.**
- The previous write-time preservation of `_tradingHaltReason` and `unconfirmedOrders` is retained and regression-tested.
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

This patch does **not** detect a **missing** ledger or a detached volume where `existsSync` returns false: the pre-existing fresh-state behaviour for an absent file remains unchanged. A durable presence sentinel, volume checks, redundant backups and fsync/restart tests are necessary before relying on uninterrupted paper evidence. The patch also does **not** provide unique independent position IDs, full forward paper round-trip fee reconciliation or marked-to-market drawdown; those remain separate tasks.

**No real trading authorization or deployment is implied by green CI.**
