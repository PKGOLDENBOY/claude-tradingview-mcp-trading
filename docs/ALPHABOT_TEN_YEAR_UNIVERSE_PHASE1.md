# AlphaBot public spot history expansion — development status (NOT DEPLOYED)

**29 October 2026:** This branch contains executable, resumable **public-GET-only** historical candle backfill code and deterministic offline tests. It is a **small bounded research pilot**, not ten years of data already collected and **not** full-universe training. There has been no Railway rollout or expanded backtest. No live orders are authorized.

## Implemented in the research branch

1. Discovery: two unauthenticated GET requests obtain currently ONLINE Bitget SPOT USDT/USDC markets. The immutable inventory includes illiquid and new markets even if they fail research-quality filters.
2. History planning: up to 3,653 days of 1H fully closed bars, using at most 90 desired candles per window and the Bitget v3 history endpoint with a conservative 100-row response limit. Historical endpoints have a <=90-day request-range rule; query bounds include adjacent boundary candles, and any excess is explicitly audited.
3. Real-data download code: fixed public endpoint only, GET only, no API keys, authenticated methods or trading calls. Limits are 100 selected markets per pilot, 100 new pages per invocation, 500 MB maximum configured storage (default 5 MB), 60-minute maximum runtime (default two minutes), and minimum 250 ms inter-request delay.
4. Durable restart: the first execution saves a checksummed, frozen market plan and the complete current-universe inventory. Every fetched page is immutable, separately checksummed, audited for missing/duplicated/out-of-window/invalid candles, and verified before it can be skipped on resume. Changed plan parameters fail rather than silently rewriting a previously defined history cohort.
5. Paper research stays isolated: this branch changes neither the five-asset accelerator nor production nor the GET-only shadow trading service. No sealed 20% holdout has been read, amended or used for training.
6. Automated offline tests: API GET allowlist; HTTP retry vs fail-closed; invalid OHLCV; boundary handling; sparse history and gaps; resume without redownload; corruption rejection; storage caps; frozen-plan/CLI validation.

## Run a tiny real market-data pilot on a separate machine

    node scripts/research-history-pilot.mjs --output-dir=research-data/history-pilot --max-markets=2 --max-new-pages=2 --max-storage-bytes=5000000 --max-runtime-seconds=120 --lookback-days=3653 --min-delay-ms=300

This performs **two public metadata GETs on the first run** and downloads **at most two pages of historical candles** (with a max of three attempts per page on network failures or HTTP 429/5xx). Repeat the same command to resume from the frozen plan; never delete or overwrite historical evidence. As of this document, **the command is not asserted to have run against live data**.

The pilot selects the first N markets ordered by *present-day* turnover for a **small test**; the saved inventory includes all currently ONLINE USDT/USDC spot markets. This is **not** proof that all markets were backfilled, all strategies were run, or full ten-year coverage exists.

## Still outstanding — NOT DONE

- Run the small live-data pilot; inspect its oldest returned candle and gap/invalid/empty-page counts. Correct API pagination behavior from real evidence before expanding.
- Confirm long-term API/data-download availability and backfill costs; Bitget may not have ten years of history for any particular coin. Do **not** claim ten-year coverage until the actual timestamps support it.
- Choose an appropriate dedicated research history store. The existing accelerator's **1 GB** Railway volume is not sufficient to assume safe all-market, ten-year history storage.
- Scale beyond pilot batches to all current markets, evaluate historical listings/delistings and point-in-time selection to control survivorship bias, and collect historical liquidity/quotes to evaluate spreads/slippage.
- Implement offline strategy-research input integration, training with unchanged fees and fair chronological folds, sealed new holdout for the expanded dataset, and independent forward PAPER validation.
- Verify the separate shadow-risk fixes (draft PR #16) in isolation before any merge or deployment; independently confirm there is no path for authenticated exchange writes.
- Obtain passing CI, review changes, then explicitly decide whether to deploy a **separate** research-only service. Never silently merge changes into production or enable live trading.

## Safety and accuracy

- **PAPER-only and public GET-only.** No real orders, account access, private endpoints, or exchange API credentials.
- An exhausted selected-window plan means only those window requests are stored, **not** that every candle exists. Empty pages and gaps remain visible; they are never interpolated into fake data.
- The inventory reflects symbols online today, **not delisted symbols or complete historical market membership**. Today's turnover is not historical tradable liquidity.
- The 20% holdout of the original accelerator remains sealed; any expanded training must define a separate predetermined chronology and untouched holdout before fitting.
- All-market coverage, completed 10-year downloads, profit and real-money readiness **remain unverified**.

## Offline test command

    node --test test/market-universe-history.test.mjs test/historical-backfill.test.mjs

Official API documentation: https://www.bitget.com/docs/catalog/market/market-data
