# AlphaBot five-gate review - 8 November 2026 (NO-GO)

**Status:** INCOMPLETE. No live-money permission. Read-only public-market research, synthetic shadow results and production PAPER telemetry are different types of evidence.

## Directly observed Railway evidence

- Research service deployment `53109e534fb1a8d0cea1f8ddb54200d4c3f8791d` succeeded; 13:16 UTC run used 180 days of 1-hour Bitget public SPOT candles, 516 tested configurations (420 deterministic rules plus 96 ML configurations); 5 validation-eligible **rule** configurations, 14 qualified ML configurations. Selected `ml-068` from validation, **29 retrospective simulated validation trades**, +$98.4617 modelled USD, profit factor 4.866. Not independent OOS or forward profit. Next-hour candidate selection can change and repeated rolling validation creates selection bias.
- The 29 October 2026 one-time frozen historical OOS was consumed and FAILED for `reversion-0192` (-$38.2268 on 25 simulated exits, PF 0.3913). **Never rerun it or retune against its period**. Source: prior OOS research Actions run 40917479432 / PR #22.
- Shadow 13:58 UTC 8 Nov reports cumulative realized simulated P&L: scalp -$20.2235 (51 exits), swing -$19.2367 (4 exits), breakout -$15.6493 (11 exits), momentum -$179.8473 (51 exits), sniper -$110.7254 (8 exits), longterm 0 closed, 2 open. These rule proxies do not constitute the production bot or real paper round-trips.
- Shadow cumulative `errors=14`. Investigated logs: a 3 Nov 19:50 UTC transient request timeout and twelve repeated 4 Nov warnings for newly listed `KORUSDT` with fewer than 22 closed 15-minute bars; at least one prior error predates Nov 3. No new error increment was observed 5-8 Nov. PR #28 proposes classifying not-yet-mature candles separately from genuine errors, preserving historical errors and avoiding partial-bar signals. It is NOT merged or deployed.
- Production PAPER telemetry 13:28 UTC 8 Nov: `recordedExitEvents=0`, `auditableFeeAdjustedExitEvents=0`, `independentCompletedRoundTrips=null`, `all100PaperTradesVerified=false`, `exchangeVerified=false`, `liveMoneyReady=false`. Zero evidence of fee-adjusted completed account exits, not proof of profit or no profit.

## Five requested workstreams and remaining strict gates

1. **Shadow errors** - identified recurrent insufficient-history noise (12 of 14 errors) and at least one timeout; code fix isolated in PR #28. Review, test, back up persistent shadow checkpoint before branch merge/deploy; investigate the remaining historical error and network retry telemetry; ensure no new errors accrue.
2. **Independent ML/strategy testing** - validation candidate `ml-068` is **not clean independent OOS**. Freeze candidate and model *before* fresh bars arrive; collect contemporaneous, append-only data and model predictions. No recycled Oct 29 holdout or repeated selection against the future stream.
3. **Fee-adjusted profitability** - no proven positive edge. Reject or quarantine losing strategies; compare net expectancy/PF and worst-case drawdown across a sufficiently broad new-data sample including trading costs, gaps, partial fills, stale prices, real bid/ask and outages. A positive historical figure is not enough.
4. **100 verified forward PAPER round-trips** - 0 independently reconciled. Only genuine forward entry/exit events with unique IDs, timestamps, costs, P&L, position/account reconciliation and independently reviewable append-only receipts can count. Historical validation trades and shadow proxy exits NEVER count toward 100.
5. **Final independent risk audit** - fail closed until every unresolved abnormality is triaged; paper ledger backups/recovery, negative equity checks, idempotent order handling, halt/circuit breakers, max position/portfolio exposure, fee-drawdown telemetry and independent risk-limit review must be evidenced. Existing fail-closed paper-ledger PR #27 is still unmerged and requires off-volume backup and restoration rehearsal.

## Automated diagnostic

`lib/readiness-diagnostic.mjs` is **read-only** and refuses to authorize live orders regardless of its observations. The accompanying unit tests confirm current observed telemetry is **NO-GO**, and that 100 simulated exits cannot be substituted for 100 genuinely reconciled forward paper round-trips.

**Do not** enable real funds, merge PR #27 without ledger backup/recovery, overwrite volume records, promote `ml-068` to production, or announce all five conditions met. **Completion requires new time-dependent evidence, not another retrospective backtest.**
