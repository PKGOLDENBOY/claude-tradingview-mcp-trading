# AlphaBot independent read-only strategy evaluation — 29 October 2026

**Scope completed:** evaluate the currently losing momentum and scalp *shadow signal proxies* and the swing signal proxy, and record why the existing evidence cannot establish a profitable edge. This satisfies the **observational strategy review**, **not** the overall five-part milestone, statistically sufficient forward validation, or production-bot strategy certification.

## Immutable evidence and methodology

- Source: Railway project `db3fa753-bcc2-4427-a0e8-c8eedafa890a`, environment `79094063-dd60-4b81-902f-ba67fd9cd9fc`, independent `alphabot-readonly-shadow` service `04c04c6c-16da-4399-a8e6-8b137de74ecf`, deployment `6486d324-b056-4592-aedc-cd21e3c4ccd0`.
- Single **cumulative** `SHADOW_CYCLE` at **2026-10-29 16:28:25.376800947 UTC**, cycle **1703**, `errors=0`, `safety=PUBLIC_MARKET_READ_ONLY_SHADOW`. Original structured `stats` values copied from the Railway service's actual log attributes into [frozen machine-readable snapshot](../reports/shadow-strategy-snapshot-20261029.json), not reconstructed from historical backtests.
- Running source: [read-only script on deployed branch](https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/blob/fix/continuous-readonly-shadow-20261023/scripts/market-shadow-test.mjs), revision `1c68bcae89b3e0cf7642a908d48d780edffd9285`. These are six **signal proxies**, not the complete production trading strategy.
- Model: publicly observed Bitget spot bid/ask when available, estimated **0.1% taker fee per side** plus **0.1% adverse slippage per side**, $100 **independent virtual position budget** for the shadow model. No exchange credentials, actual fills or orders. For conservatism, these figures must remain labelled **application-reported simulated P&L after modelled costs**, not externally reconciled broker/account P&L.
- [Deterministic shape/counter audit](../lib/shadow-strategy-review.mjs) and [offline regression tests](../test/shadow-strategy-review.test.mjs) inspect entry/exit/open and win/loss counts, reported P&L sums and win-rate consistency. Unit tests cannot independently verify quote executions or underlying market history.

## Strategy-by-strategy evidence

| Signal proxy | Cumulative repeated evaluations | Entries | Completed simulated exits | Wins / losses | Simulated realized P&L USD | Reported win rate | Reported profit factor | Open mark P&L USD | Assessment |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **Scalp** | 8,515 | 21 | 21 | 7 / 14 | **-$7.6831** | 33.33% | **0.215** | $0 | **Observed losing sample** |
| **Momentum** | 8,515 | 21 | 21 | 4 / 17 | **-$75.3685** | 19.05% | **0.325** | $0 | **Observed losing sample** |
| **Swing** | 8,515 | 2 | **0** | 0 / 0 | $0 | **N/A** | **N/A** | **-$3.0940** across 2 open | **Realized performance inconclusive** |
| Breakout | 8,515 | 4 | 4 | 0 / 4 | -$4.7626 | 0% | 0 | $0 | Losing, very small sample |
| Sniper | 3 | 2 | 2 | 0 / 2 | -$54.5062 | 0% | 0 | $0 | Losing, tiny sample |
| Long-term | 8,515 | 0 | 0 | 0 / 0 | $0 | N/A | N/A | $0 | No observed executed sample |

**Readout.** Scalp's 21 closed simulated positions returned -$7.68 and momentum's 21 closed simulated positions -$75.37 with profit factor below 1 in both cases. That is sufficient to identify poor **observed** samples and **reject any claim that these shadow versions have demonstrated a profitable edge**. Twenty-one trades per strategy are not sufficient to conclude that *no possible market regime* could ever work. The swing proxy was evaluated for signals and mark-to-market risk, but has **two open positions and zero completed exits**. Neither swing win rate, profit factor nor realized net profitability can be inferred.

## Risk and data-quality review

- App-reported **realized-only peak-to-trough drawdowns** are **$8.7812 scalp** and **$82.6727 momentum**. These are **not** full portfolio max drawdown and must not be relabelled as percentages of account equity.
- The swing open positions are marked -$3.0940, but an open mark may change and is not a realized exit or a position reconciliation.
- `qualifyingSignals` (252 scalp, 3,474 momentum and 6,270 swing) count repeated evaluations/signals across cycles and must **not** be described as distinct opportunities or trades.
- `errors=0` applies only to the observed service snapshot, not proof of zero data quality issues throughout all history.
- No immutable per-position fills, account-wide marked equity curve, risk-limit ledger, or independent source-data checks were supplied with this frozen snapshot. App-estimated profit factors and execution costs remain **unverified against fills**.
- The source branch contains the original signal/exit proxy logic. Additional spread controls and executable-bid stop/cooldown fixes exist separately in [draft PR #16](https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/pull/16), with [passing isolated regression CI](https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/actions/runs/40864405350); those changes **have not been deployed to this running shadow service**. No retroactive claim of those fixes is made.
- The broader annual read-only strategy replay [report](https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/blob/main/reports/alphabot-multihorizon-20261020.md) concluded **NO VALIDATED EDGE** for that *different historical replay*, with a -3.17% return over 365 days and 102 historical completed simulated positions. Different tests/strategies cannot be combined into 100 genuine *forward-paper* independent completed round trips.

## Findings / stage decision

1. **Scalp: evaluated, presently losing.** No basis to promote into live funds or to label the approach profitable.
2. **Momentum: evaluated, presently losing.** Risk-adjusted improvement must be demonstrated through separate unseen data and genuine paper trade evidence, not by changing parameters against this already-known sample.
3. **Swing: evaluated, but no realized conclusion possible.** Keep tracking *existing* open shadow positions, without increasing entry caps, risk or changing production; evaluate only after genuine exits and cost/mark reconciliation.
4. **Milestone 2 interpretation:** The three strategies have all been **observed and evaluated against available evidence**. This does **not** mean swing profitability is decided, other risk defects are closed, untouched OOS is complete, or the five-part strategy-improvement milestone is satisfied.
5. **Profitability demonstrated: NO.** This report is a completed observational review, not a completed system validation.

**No production deployments, config changes, history deletion, new positions, authentic orders, or holdout unsealing were performed.**
