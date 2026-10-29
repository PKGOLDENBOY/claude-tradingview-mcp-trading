# AlphaBot one-time untouched OOS audit — 29 October 2026

**DECISION: The previously best validation-only rule `reversion-0192` FAILED its one-time untouched historical out-of-sample test. It is NOT a validated profitable candidate. No actual trades were placed.**

## Source and pre-registration

- Source code + frozen preregistration: [draft PR #22](https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/pull/22) with separate branch `research/one-time-frozen-oos-20261029`, commit `5401631384b171667e88fabdaeb3ec47b5897916`. The preselected hypothesis was **only `reversion-0192`** and the as-of was fixed **2026-10-29T16:00:00.000Z** BEFORE any holdout access.
- Immutable CI proof: [GitHub Actions run #40917479432](https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/actions/runs/40917479432), completed **SUCCESS** with no network writes or trade requests. [Download complete raw research evidence and checksummed candles](https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/actions/runs/40917479432/artifacts/12916368158). Artifact retention is 90 days; the source report here preserves headline facts and dataset checksum.
- Checks that passed in order: 23 offline tests, validation with sealed last 20%, frozen selected-candidate/dataset-hash receipt, one-time holdout gate (`GITHUB_RUN_NUMBER=1`, `GITHUB_RUN_ATTEMPT=1`), unchanged selected candidate and hash BEFORE opening, post-OOS independent equality review, and evidence artifact upload.
- **Research dataset SHA-256:** `fcebee6b382df53f3d3fd55fda858e9002dd41789703cf9ff72de655d41d0138`; `reversion-0192` config/score receipt SHA-256 `433f1ba5915a4eb50dc1dba4f8ea6d968207fd4bb0a15037ca17bfad5f8ffa2a`.
- Independent artifact verification **after** the one-time job: all **nine SHA256SUMS file hashes matched**; each of the five cached datasets contained **4,320 chronologically contiguous completed one-hour candles**, matched its embedded SHA-256 and the matching per-asset report digest; the combined checksum matched the frozen pre-registration. These validations were read-only file/hash checks, **not repeated OOS backtests**.

## Result — same candidate, unchanged dataset and costs

| Metric | Walk-forward validation (selection only) | One-time unseen historical OOS |
| --- | ---: | ---: |
| Candidate | `reversion-0192` | `reversion-0192` (frozen) |
| Closed **historically simulated** trades | 24 | 25 |
| Cost-model-adjusted simulated P&L | **+$37.4203** | **−$38.2268** |
| Reported simulated return on nominal $1,000 | +3.7420% | **−3.8227%** |
| Simulated profit factor | 3.5614 | **0.3913** |
| Simulated win rate | Not recorded in validation aggregate | **36.0% (9 wins / 16 losses)** |
| Max reported drawdown | $5.8888 maximum of validation-fold realized drawdowns | **$47.8619 realized-only peak-to-trough**, 4.7862% of nominal initial capital |
| Positive validation folds | 2 of 3 | Not applicable |
| Exit reasons in OOS | Not material to selection | 8 take-profit, **13 stop**, 4 time-based |
| Worst losing streak in OOS | Not published in selection summary | **6 consecutive losses** |
| Average simulated net P&L per OOS exit | Not published | **−$1.5291** |

**Interpretation:** The apparently promising validation result **did not generalize** to the untouched OOS. With just 25 OOS simulated trades, it cannot demonstrate a consistently profitable edge. `reversion-0192` is **REJECTED for promotion** into production or live trading. This is not proof that every possible trading approach is unprofitable; it is direct evidence against the one preselected hypothesis under these historical cost and execution assumptions.

## Methodology and limits

- Five Bitget public SPOT assets: BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, ADAUSDT. 180 completed days of 1h candles per asset, from 2 May 2026 16:00 UTC through 29 October 2026 15:00 UTC. Final 20% holdout began **no earlier than 24 September 2026 16:00 UTC** after the scheduled chronological embargo.
- The rule's parameters were frozen: `length=9`, `oversold=20`, `trendFilter=true`, stop 4%, take profit 3.5%. No holdout-driven parameter changes or re-evaluation were performed.
- Candidate selection considered 420 fixed-rule configurations plus 96 **trained regularized logistic-ML** configurations on three expanding folds. **Four fixed-rule configurations passed development eligibility; zero ML configurations passed.** Only the originally preregistered `reversion-0192` was allowed to use the OOS. Do **not** use the consumed 20% holdout to rank the other three configurations, tune the failed rule, or search for a positive outcome.
- The simulated cost model assumed **0.1% fee per side**, **0.1% adverse slippage per side**, and **0.05% half spread per side**. Historical OHLC does NOT establish true executable spreads, market impact, order-book depth, partial fills or slippage. Per-trade nominal exposure was $100. Nominal initial capital for reported strategy return was $1,000, **not an actual funded account**.
- The simulation's `maxDrawdownUSD` and `maxDrawdownPct` are based on **realized closed-trade P&L only**, not a marked-to-market full portfolio drawdown; they understate potential intra-position exposure.
- One OOS segment of five currently listed assets is not a delisted/point-in-time universe or comprehensive 10-year altcoin test. The independent hourly research service has tested rolling datasets; repeated validation observations can create selection bias.
- A GitHub Actions **SUCCESS** means tests and the research process executed correctly. It emphatically does **NOT** mean market profitability.
- Data source remains historical public API candles, verified by hashes and continuity but not independently verified against another venue.
- The production PAPER-ledger status remains **zero auditable fee-adjusted completed exits** in the last examined log, not 100 genuine reconciled closed forward-paper positions. No real-money readiness has been established.

## Milestone implication and next permitted research

**Complete:** the formerly sealed 20% OOS was opened exactly once for **one fixed, preregistered candidate**, and an evidence-backed negative conclusion is documented. This decisively advances the original strategy-improvement research evaluation but **does not complete all five user acceptance conditions**.

**Still required:** consider a **new future untouched forward validation period and separate candidate selection** without reusing this consumed OOS, or a transparent adequate independent no-edge conclusion. Verify risk/accounting and data quality across other regimes; collect and reconcile genuine 100+ forward PAPER completed positions **only for a candidate that has actually qualified**; document whole-portfolio marked equity, drawdown, fees, safety limits and limitations. **Do not increase trading risk or place live orders.**

**Safety:** GitHub run was isolated on a draft research branch; no Railway settings, deployments, production order code, trade permissions, historical evidence or existing holdings were modified. `PAPER_TRADING=true`, `LIVE_TRADING_ENABLED=false`, `RESEARCH_ONLY=true` were enforced in the isolated GitHub Actions job. Actual production Railway variable values were not readable through the current connected OAuth tool.
