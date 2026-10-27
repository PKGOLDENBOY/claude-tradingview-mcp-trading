# AlphaBot 10-year and broad-altcoin research: Phase 1 (NOT DEPLOYED)

**Current status:** Research branch only. Metadata discovery, history-page planning, and offline tests. No historical backfill, expanded training, or Railway deployment has occurred.

## What was implemented

- research/market-discovery.js: public unauthenticated GET-only Bitget instruments and tickers discovery. Inventories all currently ONLINE SPOT USDT/USDC crypto pairs, preserving illiquid and newly listed symbols separately from the quality-screened research set.
- research/market-universe-history.js: plan requests for up to 3,653 days of completed hourly candles, bounded to 90 bars/page to remain under Bitget's 100-history-candle limit. This plans requests; it does NOT fetch the planned history.
- Historical-data auditing: detect missing, duplicate, invalid and out-of-window hourly timestamps without interpolation.
- test/market-universe-history.test.mjs: deterministic synthetic tests; no exchange credentials, orders, authenticated requests, or production imports.

## Explicit limitations

- Metadata provides CURRENT online symbols, not a complete history of delisted coins, other exchanges or 2016 market membership. Historical backtesting must avoid survivorship bias and today's liquidity rankings masquerading as past liquidity.
- Some coins are younger than ten years, and Bitget may not provide the full requested history. Check launch dates, source limitations and actual oldest available bar for each market.
- One 10-year continuously listed market contains roughly 87,672 hourly slots (3,653 days); that needs at least 975 requests at 90 bars/page. Hundreds of coins imply hundreds of thousands of calls, before retries.
- Today's 24-hour ticker turnover and spread are ONLY current research-quality screens, not past executable liquidity.
- Existing accelerator runs five markets over 180 days, with a separate 1GB Railway volume; no unvalidated modifications to that process.
- The original 20% holdout remains SEALED. A widened dataset needs a separate, precommitted chronological evaluation scheme and independent holdout.

## Development still required (NOT STARTED/NOT DONE)

1. Resumable historical candle backfill with public GET-only endpoints, strict 90-day request-range and max-100-history-candle controls, bounded request/disk budgets, rate limit/retry, checksummed pages and metadata.
2. Small real-data pilot verifying oldest available candles, gaps and estimated storage/API cost.
3. Storage migration or separate history store; assess Railway 1GB capacity before attempting broad backfills.
4. Historic delisting/point-in-time universe and liquidity datasets to reduce survivorship bias.
5. Offline evaluation across uneven listings, fee/slippage stress, regimes, chronological folds and a newly sealed expanded-data holdout.
6. Independent validation, code review and CI before ANY separate research deployment.

## Run the offline unit tests

    node --test test/market-universe-history.test.mjs

Official public API reference: https://www.bitget.com/docs/catalog/market/market-data
History downloads: https://www.bitget.com/data-download

**Safety:** PAPER-only, GET-only research metadata. No production code, shadow code, trading flags or exchange-write permissions have been changed.
