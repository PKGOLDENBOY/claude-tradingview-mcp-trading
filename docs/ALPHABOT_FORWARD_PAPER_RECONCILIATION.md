# AlphaBot forward-paper round-trip audit — research prototype (NOT DEPLOYED)

**Status:** Draft offline auditor only. No trade data was created or modified by this PR. No real orders, production configuration changes, or profitability claims.

## Why this is necessary

The current production ledger's hourly `PAPER_LEDGER_EVIDENCE` record on **29 October 2026 15:28 UTC** reported **zero auditable fee-adjusted exit events**, with no independently verified completed round trips, account drawdown or risk violations. An earlier recovery inventory referenced 330 historical bot exit log events. Neither count is equivalent to 100 independently reconciled **closed paper positions**. Existing `lib/paper-ledger-evidence.mjs` deliberately refuses this unsupported inference.

## What the isolated tool validates

`auditForwardPaperRoundTrips(ledger)` expects a **forward** simulation ledger:

- `mode: 'PAPER'`, `source: 'FORWARD_PAPER'`; a list of uniquely identified positions.
- Each position has `positionId`, `symbol`, `reportedNetPnlUsd`, and individually ID'd fills with `fillId`, `timestamp`, `side` (BUY/SELL), `quantity`, `executionPriceUsd`, `feeUsd`, and `paperTrading: true`.
- Fills must be chronological; sells cannot exceed buys; a position ID cannot be reused after closing; duplicate fill identifiers are rejected; partial exits count only when the original full position has closed.
- Computes net USD P&L directly from entry/exit fill notionals less **both-side fees**, compares it to the application's reported P&L, and reports completed **position count**, win rate and profit factor. Adverse slippage must already be reflected in execution prices; do not subtract it twice.
- Optional sampled account-level drawdown requires chronological **marked-to-market portfolio equity** observations covering all fills, valid positive equity, and at most 60-minute observation gaps. Reports **sampled** drawdown only; cannot know true between-sample extremes.
- Requires an explicit reviewed risk-limit report, zero reported violations, **and zero unresolved open paper positions** before marking a dataset **ready for an independent human audit**. Even when 100 historic positions are fully closed, one remaining open position can carry unrecognized risk, so the gate now fails closed. Even then, `profitabilityDemonstrated: false` and `liveMoneyReady: false` remain mandatory: this tool cannot authenticate or corroborate source events by itself.

## Not evidence of profitability

The tests generate **synthetic** positions, including a fabricated set of 100 round trips. Those are unit-test fixtures, **not** observed paper trades. A passing test demonstrates accounting logic, not a trading edge. The production event stream currently lacks the durable fill/position identifiers and full equity marks necessary to construct this audit: do **not** synthesize fake records or silently promote old logs. Any production telemetry changes require a separate reviewed, tested **PAPER-only** change and explicit deployment approval.

## Run tests without network

```sh
node --test test/paper-roundtrip-audit.test.mjs test/paper-ledger-evidence.test.mjs
```

The independent candidate still needs leak-free untouched OOS, ≥100 reconciled **genuine forward paper** closed positions, reviewed execution costs, safety review, and final findings before the milestone can be declared complete. An adequately documented independent no-validated-edge conclusion is an alternative, but a passing accounting test is not.
