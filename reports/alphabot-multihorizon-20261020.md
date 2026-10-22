# AlphaBot read-only historical strategy replay: 1 / 3 / 6 / 12 months

**Evidence:** [GitHub Actions run 39829916973](https://github.com/PKGOLDENBOY/claude-tradingview-mcp-trading/actions/runs/39829916973) (all four matrix jobs succeeded, 22 October 2026).

**Period end:** 20 October 2026 00:00 UTC, with approximate 30-, 90-, 180- and 365-day windows. **Initial virtual capital:** $150. Simulated two-sided 0.1% per-side fees and 0.1% adverse slippage per side. All results are hypothetical, not brokerage or Railway paper-ledger profits.

| Horizon | Strategy net return | BTC buy & hold after estimated costs | Fully closed simulated positions | Simulated sell events | Sell-event win rate | Sell-event profit factor | Sampled max DD |
|---|---:|---:|---:|---:|---:|---:|---:|
| 30 days | -0.38% | 0.44% | 19 | 22 | 63.64% | 1.473 | 3.25% |
| 90 days | 2.81% | 22.64% | 48 | 57 | 70.18% | 2.874 | 3.84% |
| 180 days | 5.70% | 4.39% | 72 | 89 | 68.54% | 2.781 | 3.73% |
| 365 days | -3.17% | -24.88% | 102 | 121 | 56.20% | 0.861 | 11.01% |

**Coverage:** 45 configured assets requested, 40 eligible in each test, 5 excluded and 15 data-fetch errors per horizon. Bitcoin benchmark is price change after assumed entry/exit costs; exposure and risk differ between approaches.

**Decision: NO VALIDATED EDGE.** The 365-day result lost 3.17%, with sell-event profit factor 0.861. Over 90 days the strategy gained 2.81% while the BTC comparator gained 22.64%. The six-month period looks better, but selecting only favorable windows would be overfitting.

**Cautions:** The six-hour open-tick shadow engine approximates long-term production behavior; it cannot prove the true intrabar stop performance, executable spread, or exact P&L. Survivorship bias, missing prices, risk-limit history and partial sell events remain limitations. **102 fully closed HISTORICAL SIMULATED positions over 365 days are not 100 verified forward paper trades** and cannot satisfy the real-market paper-trading validation requirement.

**Safety:** Public BitGet market-data GET endpoints only; no exchange credentials or order requests. Production was not modified.

**Next gates:** fee-adjusted *actual* persisted PAPER ledger with at least 100 independently reconciled closed round trips; no limit violations; out-of-sample performance across regimes; safe deployment review and separate explicit approval before real money.
