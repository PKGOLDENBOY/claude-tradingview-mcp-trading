# AlphaBot frozen ML-068 prospective SPOT strategy - paper-only specification

**Status at 2026-11-08:** Implementation and offline tests complete; **NOT DEPLOYED**, **NO INDEPENDENT FORWARD RESULTS**, **NO REAL-MONEY PERMISSION**. All future live-money claims require a separate independent performance and safety audit. The older one-time 29 October historical OOS was consumed and is NEVER reused as an independent test.

## Candidate and freeze

- Candidate: `ml-068` (earlier selected in repeated historical validation, not independently OOS-verified). Fixed logistic regression trained on public Bitget 1H SPOT candles for **BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, ADAUSDT**.
- Frozen training window ends **2026-11-08 20:00 UTC**; 180-day data set fingerprint `21ca7752351dff157318241a182a4712a6e0e993946552314434ae45e2cf06b8` with a 24h label embargo. Model has **20,870** supervised examples. Training complete **before** observations it will score; no online parameter retuning.
- Frozen artifact: `models/frozen-ml068-20261108.json`, manifest SHA-256 `75f4945e7e48553309afd91135dffd4d7a92130e0c25b066d8c47e71767736e1`, model SHA-256 `96aabf2d6fec52f3e2066d0afe44ac23cbfb4fa691333560301f1405bfe1177c`. The SHA-256 is validated before using the model; published source versions are pinned by code hashes.
- First permitted candidate signal: only after **2026-11-09 00:00 UTC**; no retroactive simulated fills on earlier bars, and a service must not act before its deployment.

## Exact deterministic logic

1. Wait until the hourly Bitget SPOT candle is **closed**. Require >=500 contiguous, valid closed 1H bars and the unmodified frozen model.
2. Compute nine lag-only features: 1/6/24-bar log returns, EMA10/50 spread, RSI14, 1H high-low range, volume ratio, 12-bar realized volatility and EMA80 distance. Use fixed 12h forward target, learning rate 0.003, L2 0.001, 24 epochs.
3. Candidate entry signal when logistic probability >= **0.51**. Never signal on candles before activation, malformed bars, missing quotes or stale data.
4. After the closed-bar signal, use **contemporaneous PUBLIC ask** at observation time for a synthetic PAPER entry; no actual order. Assume 0.1% fees/side, 0.1% adverse slippage/side and 0.05% additional assumed half-spread/side. If bid/ask is missing or the observed spread exceeds 0.3%, do not open.
5. Virtual exit on observed PUBLIC bid crossing **4% stop**, **8% take-profit**, or after **72 hours**, whichever observed trigger occurs first; stop takes priority. After a quote gap, evidence is downgraded, never claimed verified.
6. At most **two** simultaneous synthetic positions, **10% equity per asset**, **20% total exposure**, estimated stop-risk+cost budget **0.5% equity per position**, never pyramid an asset; estimated risk may be exceeded due to gaps. Deny new positions if daily realized loss >=2%, portfolio realized drawdown >=8%, journal errors or market-data gaps exist.
7. Every evaluation and synthetic entry/exit is hash-chained and appended to a dedicated volume event journal. Corrupt journals, duplicate IDs and concurrent writes fail closed. Event timestamps come from current quote observation, not a historical backfilled bar.

## Performance status

Historical ML research reported `ml-068` **+$98.4617 on 29 retrospective simulated validation trades** with profit factor **4.866**, but the model is selected from a large explored grid. This is subject to selection bias and **is not a guaranteed or independently validated profitable strategy**. A separate predeclared rule-based trend-pullback v1 **FAILED** historical validation: -$8.9251 over 18 simulated exits and was rejected (PR #30).

## Proposed isolated Railway deployment (NOT APPLIED)

- Create a **separate** service (do not modify the production bot, research service or existing shadow service) sourced from the reviewed research branch with `Dockerfile.ml068-forward`.
- Cron `*/5 * * * *`, restart NEVER; each invocation exits after running once. Dedicated **new** persistent volume mounted at `/forward-data`. The image intentionally does not contain `bot.js`, exchange auth code or any trading API. It performs only public Bitget GET requests.
- Review operational cost, Docker/CI checks and security first. Confirm volume is mounted, writable and backed up before first test. Do not reset the volume on reconnect. A leftover exclusive lock or inconsistent journal is a stop condition requiring careful manual diagnosis, not a reason to delete history.
- No deployment has been initiated from this PR. Railway's explicit deployment approval would be required.

## Known limitations and mandatory NO-GO findings

- A 5-minute public-bid sampler can miss transient intrabar stop/take touches. Historical OHLC models and 5-minute quote snapshots cannot reproduce real exchange execution, spread depth, partial fills or gaps. No claim of exchange fill verification.
- A local SHA-256 chain is **tamper-evident within its own records**, not an off-volume independent receipt. It cannot establish 100 independently reconciled completed live exchange-paper trades without separate authenticated exchange/account and market-receipt evidence.
- A single network/market-data gap correctly blocks new entries until a separate evidence review. This may reduce trade count or halt simulation; **do not bypass halts** merely to accelerate progress.
- Realized P&L-only daily/portfolio limits are not a full mark-to-market equity or exposure stress test; correlations, adverse gaps, funding/borrowing (not used) and taxes are not fully measured.
- **Go/no-go:** remain NO-GO for real money. Need a clean prospective independently observed sample (at least 100 *verified*, fee-adjusted round trips if feasible), robust positive expectancy after all friction, resolved halt/gap issues, immutable receipts and complete risk audit. The previously consumed Oct 29 holdout cannot be recycled.
