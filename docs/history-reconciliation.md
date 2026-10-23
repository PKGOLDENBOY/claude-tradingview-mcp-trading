# AlphaBot: historical + active trading record reconciliation (read only)

**Purpose:** compare the legacy state/CSV and the current isolated paper state/CSV
without merging, modifying, or reclassifying their records. The report is an
offline audit, **not** an equity statement, exchange reconciliation, or trading
approval. This branch does not modify `bot.js` and must not be used to authorize
real-money trading.

## Run only where the existing files are readable

On the existing Railway volume, use the Node.js runtime (no npm install or
exchange credentials are needed):

```sh
PAPER_TRADING=true LIVE_TRADING_ENABLED=false node scripts/reconcile-trade-history.mjs \
  --historical-state /data/safety-check-log.json \
  --current-state /data/paper-hardening-20261019.json \
  --historical-csv /data/trades.csv \
  --current-csv /data/trades-paper-hardening-20261019.csv
```

The script reads each file exactly as it exists, prints privacy-safe aggregate
JSON to stdout, and never creates, rewrites, renames, migrates, or deletes a
file. Do not point it to a copy that omits transactions. The paths above were
observed in Railway runtime logs on October 19–23, 2026; verify the active
`STATE_FILE` and `PAPER_CSV_FILE` names before running if deployments changed.
Use explicit CLI paths to avoid accidental fallback to a different ledger.

If one file is absent, unreadable, or corrupt, the CLI prints a partial
inventory and exits with code 2. This is an evidence gap, **not** a zero-trade
result. It outputs only counts and aggregates, never order IDs or individual
prices.

## Interpretation

- **Historical state** is inventoried by explicitly tagged PAPER, LIVE, and
  UNKNOWN mode; unknown legacy activity is never silently called paper.
- **Current state** is independently inventoried with the same strict mode
  rules. Its fee-adjusted realized PAPER exit-event metrics reuse the tested
  `auditPaperLedger` logic and require `paperTrading=true`,
  `orderPlaced=true`, `feeAdjusted=true`, valid timestamps, positive
  quantity, symbol, and finite recorded `pnlUSD`.
- **CSV** rows are independently counted by mode and side. CSV net cash amount
  is **not** a profit calculation; its fee column is an estimate and does
  not independently prove round-trip P&L.
- **Reconciliation candidates** match an order ID, symbol, and side between
  state/CSV or across state snapshots. Counts can flag potentially overlapping
  identifiers, mode conflicts, and records that cannot be joined. Matching
  alone is not proof of a confirmed fill, globally unique order, or a fully
  closed position. The report never prints order identifiers.
- **No combined P&L** is claimed across files, since periods and legacy state
  can overlap. The combined sample size, full-equity drawdown, and risk-limit
  compliance remain unknown without immutable fills, position IDs, and a
  time-stamped equity/risk ledger.
- **Zero auditable PAPER exits** is reported as `realizedExitPnlUsd: null`,
  not as proof of break-even performance or a successful strategy.

## Verification and rollout

Run `node --test test/trade-history-reconciliation.test.mjs`.
The GitHub workflow `history-reconciliation.yml` runs deterministic offline
tests on this branch / PR with **no exchange credentials**. No deployment,
paper account reset, live order, or trading-risk change is part of this PR.
A report generated against the actual Railway volume requires read-only
access to those files; Railway log/search access by itself does not expose
their complete contents.
