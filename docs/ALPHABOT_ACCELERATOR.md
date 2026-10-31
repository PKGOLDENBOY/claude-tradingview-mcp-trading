# AlphaBot independent accelerator (PAPER / RESEARCH ONLY)

The accelerator is a SECOND process, strictly separate from the existing Railway production and independent shadow services. **This branch is a safety patch, not an automatically deployed change.** It is not the production Claude/TradingView strategy, does not know your private TradingView indicator, cannot place real orders, and cannot access your exchange account. It implements public-data, offline parameter search for **four independent fixed-rule hypotheses** (trend, mean reversion, breakout, momentum) **plus a genuinely trained, regularized logistic-regression model**. It is not a neural network and does not guarantee profitable trading.

## What it does

1. Downloads 180 days of **completed** hourly BTC, ETH, SOL, LINK, and ADA spot candles through **allowlisted GET-only** Bitget v3 public market endpoints (no account credentials, authentication, live trading, POSTs, or order endpoints). Loads up to five coins and requires three including BTC. Missing, revised or corrupted candle data fail closed or explicitly exclude an affected coin.
2. Persists checksum-verified cached candles in `/research-data/cache` on a separate Railway volume, reusing history between runs and fetching only missing recent hourly bars. The first backfill may take minutes; later runs should require far fewer HTTP requests.
3. Computes technical indicators once per asset; examines **420 fixed-rule configurations** among bounded worker threads; and trains **96 ML strategy configurations** based on **48 fitted logistic-regression models across three chronological training folds**. The fixed-rule engine executes **12,600 strategy/asset/segment simulations** for five assets, three train/validation folds and 420 configurations. These are **simulated evaluations**, not real trades and not 12,600 new data points. Models use training-only feature scaling and labels that do not reach past each training boundary.
4. Enforces 24-hour chronological embargoes between train and validation windows and uses **three expanding walk-forward folds**. The final 20% of each retrospective dataset is excluded from routine training/validation; importantly, the original independent historical holdout was **already consumed once on 29 October 2026**. This research branch refuses all repeat `--holdout` attempts, even with the old acknowledgement environment variable. Indicator inputs and signals use only historical bars that closed at or before the decision, and fills cannot happen before the next bar's open.
5. Includes configurable maker-unfavourable spread estimates, taker fees and adverse slippage on **both** sides, conservative stop-first behaviour when same candle simultaneously hits stop and take profit, a six-bar post-stop cooldown, explicit end-of-partition closure and a turnover gate. **Historical OHLC does not contain executable bid/ask depth or guarantee stop prices.**
6. Requires positive performance on the expanding training sample, at least two positive validation folds, adequate trade counts, validation profit factor >=1.2, and bounded validation drawdown for **both rule and ML candidates** before any candidate is called a promising research hypothesis. If zero pass, reports **NO_VALIDATED_EDGE**, never trades harder to manufacture a win.
7. Emits a transparent JSON report, including every fold, assumptions, out-of-sample seal state, data SHA-256 provenance, speed and excluded markets. The console prints a compact evidence summary.

## Running on Railway (a separate service; no production changes)

- Git branch: `research/parallel-accelerator-20261025`.
- Service: `alphabot-accelerated-research` with no Bitget keys or TradingView secrets.
- Runs **hourly**, at minute 15 UTC, rather than permanently; `/research-data` is a separate 1GB persistent volume. New closed 1h candles are evaluated after the market closes the hour.
- Configure the separate service using Railway native settings: start command `node scripts/accelerated-research.mjs --days=180 --workers=4 --cache-dir=/research-data/cache --output=/research-data/reports/latest.json`, cron `15 * * * *`, restart policy `NEVER`, and Dockerfile `Dockerfile.accelerator`. This Docker image deliberately EXCLUDES production bot code and all exchange trading dependencies.
- Look for structured `ACCELERATOR_RESEARCH_START`, `ACCELERATOR_CANDLE_CACHE` and `ACCELERATOR_RESEARCH_RESULT` log records. Inspect `/research-data/reports/latest.json` when volume access is available.
- If the API is unavailable or incomplete, the run fails; it NEVER substitutes synthetic bars into the real-data report.
- GitHub Actions runs strict offline unit tests and an explicitly **synthetic** speed benchmark, and can create 30-day research artifacts. The scheduled GitHub workflow only runs automatically after it is merged into the repository's default branch; the standalone Railway service has independent scheduling.

## Verified procedure before using a candidate elsewhere

1. Keep `--holdout` **off** while tuning. The last 20% of the dataset must remain completely unseen during search; reusing it repeatedly would invalidate it.
2. **Do not run `--holdout` again on this pipeline.** The one-time 29 October review has already used its historical holdout, and the research CLI and runner now fail closed if asked to reopen it. A future independent OOS experiment requires a separately designed, preregistered protocol and strictly later market observations not exposed to candidate selection. The earlier holdout is invalid as fresh evidence for any new hypothesis.
3. Evaluate data-quality gaps, liquidity and robustness across regimes and symbols. Recheck fee, slippage, high-spread, latency and gap scenarios using genuine real quote data where possible.
4. Forward paper-test separately, with **at least 100 completed trades**, exchange-fee and slippage adjusted and reconciled P&L, win rate, profit factor, drawdown, and operational safety-limit review. Do not count historical simulated exits as forward trades. Do not discuss a live-money trial until independent OOS and forward evidence, plus accounting/risk fixes, have passed review. **No automatic promotion into the current bot. No real-money trading.**

## What "100x faster" can and cannot mean

Historical replay and parallel evaluation examine **hundreds of configurations in one batch instead of waiting for a single five-minute live shadow loop**. The 516 candidates (420 rules plus 96 trained ML strategy configurations) and 12,600 rule-fold simulations are measurable, but this is not proof of "100x faster learning": the existing bot and the new offline engine measure different activities. The speed benchmark runs on **synthetic data** and reports actual candidate evaluations per second; it must never be confused with market returns or predictive skill. More optimisation can increase overfitting, not profits. No strategy is guaranteed profitable or perfect.

Official public API reference: https://www.bitget.com/docs/catalog/market/market-data

## Initial developer verification

- Offline safety and leakage tests: 15/15 passed under Node 22 before the code was published.
- Synthetic speed test (five coins x 180 days x 1h): 420 fixed-rule candidates evaluated in 0.37 seconds in one thread and 0.53 seconds with four workers on the available machine. Multiple workers are *not always faster*, because thread startup costs can dominate a short simulation.
- Synthetic ML test: 96 ML configurations with 48 independently trained models evaluated in ~1.09 seconds on the same machine. These numbers measure compute throughput only, not the live API download, not 100x faster model learning, and not profitable trades.
- **First verified Bitget real-market data run 25 October 2026 13:55 UTC:** five assets, 180 days (4,320 closed one-hour candles per asset), 516 evaluated strategy variants, 48 logistic model fits, 1 fixed-rule candidate passed validation eligibility (`reversion-0192`), zero ML candidate passes, final 20% holdout **SEALED**. These are retrospective rule checks, NOT live profit evidence; no trades or orders were placed.
- The first attempt failed safely on a gap in older Bitget data; after switching to the allowlisted history-candles endpoint for data older than 30 days, all five assets downloaded with no gaps or exclusions, and the full research report completed.
- **Running service:** `alphabot-accelerated-research` in the same Railway project as the original bot but with its own source branch and volume, absolutely no exchange API keys or order capabilities. Existing production and shadow services were not modified.

## Independent holdout review: 29 October 2026

- One-time GitHub Actions evidence: https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/actions/runs/40917479432 (PR #22).
- Candidate `reversion-0192`: **25 historical simulated exits, net -$38.2268, profit factor 0.3913, 36% wins, realized-only drawdown $47.8619**. **FAILED independent OOS; quarantined from future selection.** No real trades were executed.
- 96 logistic ML configurations: **zero eligible**. Other rolling-validation results, including `breakout-0312`, are NOT independent OOS proof, and definitely not evidence of forward profitability.
- Current isolated safety branch: `research/quarantine-failed-oos-candidate-20261030`; it records the rejection, excludes the failed candidate from promotion, hard-locks repeat holdout requests, and includes offline regression tests. This branch is not production deployment evidence.
- **Unfinished:** independently validated new strategy; at least 100 genuine forward paper trade exits with reconciled fees and limits; fully verified order, accounting, and risk repairs; and final milestone audit. Keep paper-only operation and live trading disabled.
