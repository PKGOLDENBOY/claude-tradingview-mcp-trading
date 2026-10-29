# AlphaBot OOS pre-registration — frozen before ANY new holdout view
Date: 29 October 2026. Status: research only; no actual trades, no production changes.

## Preselected hypothesis
- **reversion-0192** only. It qualified in earlier rolling walk-forward validation snapshots, but this is NOT proof of edge.
- Dataset: Bitget public spot BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, ADAUSDT, one-hour **closed** candles.
- **Immutable `asof`: 2026-10-29T16:00:00.000Z**, lookback 180 days.
- Immutable code base: the existing separately deployed accelerator source branch `research/parallel-accelerator-20261025`. The new isolated OOS branch changes only review gates/workflow and does not touch production or any Railway service.
- Fixed grid: 420 fixed-rule parameter choices and 96 logistic ML configurations. Three expanding chronological training/validation folds and a 24-hour purge/embargo. The last 20% has never been opened by the deployed accelerator.
- Holdout may be evaluated **one time** only, after a validation-only preregistration saves exact candidate ID, parameter set, and SHA-256 hash of the public candle dataset. In the second invocation, dataset SHA and selected ID are rechecked **before** holdout evaluation. If either differs, stop without opening OOS.
- The one-time OOS workflow must have `GITHUB_RUN_NUMBER=1` and `GITHUB_RUN_ATTEMPT=1`. There is NO `workflow_dispatch`, scheduled trigger, or live trading. A rerun is deliberately prohibited. Repeated source/parameter searches on the same OOS data are also prohibited.
- Store raw validation and holdout JSON reports, preregistered candidate/data hashes, an evaluation summary, and SHA256SUMS in one immutable GitHub Actions artifact.
- Any ML model that failed to qualify in validation must **not** be tried on the sealed data simply to find a positive curve.
- If the candidate's validation identity changes on this frozen snapshot, **do not** open the OOS merely to force an outcome. Report the rejection and keep OOS sealed.

## Hypothesis and conservative acceptance criteria
A mean-reversion rule might retain a positive, after-modelled-cost return in the previously unseen 20% period, with tolerable drawdown and enough independent observations. A negative return, zero/very few trades, unstable execution-cost sensitivity, or unreasonable drawdown invalidates the claim. Even a favorable result is at most **one retrospective OOS observation**, **not** demonstration of future profitability. Every research result must report full trades, return, profit factor, drawdown, and modelled fees/slippage.

A formal profitability decision additionally requires **at least 100 reconciled fully closed forward PAPER round trips**, independent account equity/drawdown and risk-limit audit or an adequately documented no-validated-edge conclusion. No retrospective count may be substituted. No optimization based on this OOS will follow.

## Important limitations to report
- Today's five-asset spot cohort is not a point-in-time delisted-asset universe and not all altcoins.
- Hourly OHLC candles do not contain executable order-book depth, true spreads, partial fills or exchange outages; historical costs are estimates.
- The original accelerator has been rerunning every hour as new candles arrive. Candidate stability under rolling validation does not fix multiple-testing/selection bias.
- Sampled market regimes and a single OOS slice cannot imply guaranteed real-money profit.
- The workflow has no exchange keys or order-writing code. `PAPER_TRADING=true`, `LIVE_TRADING_ENABLED=false`, and `RESEARCH_ONLY=true` are explicitly set only for its isolated process; **the actual Railway production variable values are not readable using the current OAuth connection**.

This pre-registration is deliberate. No user-facing milestone completion notification is authorized by opening the holdout.
