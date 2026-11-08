# Frozen trend/pullback v1 - rejected by historical validation

Snapshot obtained **2026-11-08T20:13:28Z**, Actions run **42518962792**. Candidate source was committed before the run, with parameters fixed in `lib/trend-pullback-hypothesis.mjs`; it never accessed the consumed 29 October holdout. Cross-asset public 1H Bitget SPOT data, 180-day lookback; dataset SHA-256 `21ca7752351dff157318241a182a4712a6e0e993946552314434ae45e2cf06b8`. Costs: 0.1% fee + 0.1% slippage + 0.05% half spread **per side**. Not a live or account result.

| Walk-forward validation fold | Completed simulated trades | Net USD | Profit factor |
| --- | ---: | ---: | ---: |
| Fold 1 | 6 | -6.6178 | 0.3449 |
| Fold 2 | 6 | -9.4230 | 0.2119 |
| Fold 3 | 6 | +7.1157 | 2.1247 |
| **Aggregate** | **18** | **-8.9251** | **Negative expectancy** |

**Decision: REJECT as a promotion candidate.** A clear fixed rule is not proof of edge. Do not deploy to even paper trading as a recommended candidate, do not tune this configuration to these fold results, and never retest the previously consumed Oct 29 historical holdout. The independent prospective test belongs to a separately selected, time-frozen hypothesis.

The separate `lib/trend-paper-risk.mjs` expresses conservative proposed PAPER sizing constraints for possible future strategies; its code is not deployed and its unit tests cannot transform this loss-making strategy into a validated one.
