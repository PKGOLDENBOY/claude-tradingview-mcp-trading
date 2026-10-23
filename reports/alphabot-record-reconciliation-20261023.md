# AlphaBot ledger reconciliation — observed Railway evidence
**Observed:** 2026-10-23 (UTC). **Status:** PARTIAL — log evidence, not direct volume-file reconciliation.

## Source evidence (no raw trades copied)
| Ledger / service | Evidence in Railway logs | Interpretation |
| --- | --- | --- |
| Historical `/data/safety-check-log.json` and `/data/trades.csv` | `RECOVERY INVENTORY` at 2026-10-22T18:52:36Z says both files exist; 918 bot-recorded entries, 330 bot-recorded exits, and **-$12.58** bot-reported exit P&L | **Unverified mixed/unknown-mode estimate.** Not proof of real losses or fee-adjusted paper performance. |
| Active `/data/paper-hardening-20261019.json` | `PAPER_LEDGER_EVIDENCE` at 2026-10-23T04:52:39Z: 0 recorded PAPER exits, 0 auditable fee-adjusted PAPER exits, 0 excluded PAPER exits | No auditable sample from current isolated paper JSON ledger at that observation. **0 is not a verified break-even result.** |
| Active `/data/trades-paper-hardening-20261019.csv` | Startup/runtime log names file as active simulated CSV | **Row contents not available from Railway log connector**; no trade/fee/position claims possible. |
| Railway production `inspiring-education` | Online, 1 replica running / 0 crashed, 0 failed deployments in queried window | Service health is not trade profitability or risk compliance. |

## Missing verification
- Unknown how many historical trades were PAPER, LIVE, or unlabelled; cannot reclassify from filename.
- No access to raw volume files using the Railway log connector; therefore source-to-source joins, mode mismatches and duplicate identifiers are **not yet evaluated against the live files**.
- Cannot derive trustworthy fee-adjusted realized PAPER P&L across periods, round-trip sample size, overall win rate, profit factor, full portfolio drawdown, or risk-limit violations from these logs alone.
- Do not sum the historical **-$12.58** with current PAPER telemetry. The periods, modes and accounting evidence differ.
- No automatic trade execution, account reset, risk increase, or production deployment was performed for this report.

## Repeatable safe next step
The separate branch includes `scripts/reconcile-trade-history.mjs` and
`lib/trade-history-reconciliation.mjs`, plus deterministic tests. Run the
read-only CLI with the four existing file paths on a machine/container
with access to the original Railway volume, then review the resulting
aggregate JSON; see `docs/history-reconciliation.md`. This branch must
not be merged/deployed blindly.
