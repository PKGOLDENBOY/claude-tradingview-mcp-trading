# AlphaBot independent accelerator (PAPER / RESEARCH ONLY)

The accelerator is a SECOND process, strictly separate from the existing Railway production and independent shadow services. It is not the production Claude/TradingView strategy, does not know your private TradingView indicator, cannot place real orders, and cannot access your exchange account. It implements public-data, offline parameter search for **four independent fixed-rule hypotheses** (trend, mean reversion, breakout, momentum) **plus a genuinely trained, regularized logistic-regression model**. It is not a neural network and does not guarantee profitable trading.

## What it does

1. Downloads 180 days of **completed** hourly BTC, ETH, SOL, LINK, and ADA spot candles through **allowlisted GET-only** Bitget v3 public market endpoints (no account credentials, authentication, live trading, POSTs, or order endpoints). Loads up to five coins and requires three including BTC. Missing, revised or corrupted candle data fail closed or explicitly exclude an affected coin.
2. Persists checksum-verified cached candles in `/research-data/cache` on a separate Railway volume, reusing history between runs and fetching only missing recent hourly bars. The first backfill may take minutes; later runs should require far fewer HTTP requests.
3. Computes technical indicators once per asset; examines **420 fixed-rule configurations** among bounded worker threads; and trains **96 ML strategy configurations** based on **48 fitted logistic-regression models across three chronological training folds**. The fixed-rule engine executes **12,600 strategy/asset/segment simulations** for five assets, three train/validation folds and 420 configurations. These are **simulated evaluations**, not real trades and not 12,600 new data points. Models use training-only feature scaling and labels that do not reach past each training boundary.
4. Enforces 24-hour chronological embargoes between train and validation windows, uses **three expanding walk-forward folds**, and keeps the final 20% of observations **sealed** by default. Indicator inputs and signals use only historical bars that closed at or before the decision, and fills cannot happen before the next bar's open.
5. Includes configurable maker-unfavourable spread estimates, taker fees and adverse slippage on **both** sides, conservative stop-first behaviour when same candle simultaneously hits stop and take profit, a six-bar post-stop cooldown, explicit end-of-partition closure and a turnover gate. **Historical OHLC does not contain executable bid/ask depth or guarantee stop prices.**
6. Requires positive performance on the expanding training sample, at least two positive validation folds, adequate trade counts, validation profit factor >=1.2, and bounded validation drawdown for **both rule and ML candidates** before any candidate is called a promising research hypothesis. If zero pass, reports **NO_VALIDATED_EDGE**, never trades harder to manufacture a win.
7. Emits a transparent JSON report, including every fold, assumptions, out-of-sample seal state, data SHA-256 provenance, speed and excluded markets. The console prints a compact evidence summary.

## Running on Railway (a separate service; no production changes)

- Git branch: `research/parallel-accelerator-20261025`.
- Service: `alphabot-accelerated-research` with no Bitget keys or TradingView secrets.
- Runs every **six hours**, not permanently; `/research-data` is its separate persistent volume.
- Configure the separate service using Railway native settings: start command `node scripts/accelerated-research.mjs --days=180 --workers=4 --cache-dir=/research-data/cache --output=/research-data/reports/latest.json`, cron `0 */6 * * *`, restart policy `NEVER`. **New Railway services can no longer opt into legacy `railway.json` as of October 2026.**
- Look for structured `ACCELERATOR_RESEARCH_START`, `ACCELERATOR_CANDLE_CACHE` and `ACCELERATOR_RESEARCH_RESULT` log records. Inspect `/research-data/reports/latest.json` when volume access is available.
- If the API is unavailable or incomplete, the run fails; it NEVER substitutes synthetic bars into the real-data report.
- GitHub Actions runs strict offline unit tests and an explicitly **synthetic** speed benchmark, and can create 30-day research artifacts. The scheduled GitHub workflow only runs automatically after it is merged into the repository's default branch; the standalone Railway service has independent scheduling.

## Verified procedure before using a candidate elsewhere

1. Keep `--holdout` **off** while tuning. The last 20% of the dataset must remain completely unseen during search; reusing it repeatedly would invalidate it.
2. Only after selecting ONE candidate from the combined ML and rule-validation results, run `ALPHABOT_UNSEAL_HOLDOUT=I_ACKNOWLEDGE_ONE_TIME_RESEARCH_REVIEW node scripts/accelerated-research.mjs --holdout`, with an immutable `--asof` for reproducibility. Never tune based on the holdout result.
3. Evaluate data-quality gaps, liquidity and robustness across regimes and symbols. Recheck fee, slippage, high-spread, latency and gap scenarios using genuine real quote data where possible.
4. Forward paper-test separately for an adequate number of completed trades and demonstrate controlled risk before even discussing a small live trial. **No automatic promotion into the current bot. No real-money trading.**

## What "100x faster" can and cannot mean

Historical replay and parallel evaluation examine **hundreds of configurations in one batch instead of waiting for a single five-minute live shadow loop**. The 516 candidates (420 rules plus 96 trained ML strategy configurations) and 12,600 rule-fold simulations are measurable, but this is not proof of "100x faster learning": the existing bot and the new offline engine measure different activities. The speed benchmark runs on **synthetic data** and reports actual candidate evaluations per second; it must never be confused with market returns or predictive skill. More optimisation can increase overfitting, not profits. No strategy is guaranteed profitable or perfect.

Official public API reference: https://www.bitget.com/docs/catalog/market/market-data

## Initial developer verification

- Offline safety and leakage tests: 15/15 passed under Node 22 before the code was published.
- Synthetic speed test (five coins x 180 days x 1h): 420 fixed-rule candidates evaluated in 0.37 seconds in one thread and 0.53 seconds with four workers on the available machine. Multiple workers are *not always faster*, because thread startup costs can dominate a short simulation.
- Synthetic ML test: 96 ML configurations with 48 independently trained models evaluated in ~1.09 seconds on the same machine. These numbers measure compute throughput only, not the live API download, not 100x faster model learning, and not profitable trades.
