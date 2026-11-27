# token-radar-v2

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/mhmmdzildan03/token-radar-v2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/mhmmdzildan03/token-radar-v2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar that earns its numbers. It reads the sealed DefiLlama snapshot of 758 protocols and ranks the ones that record no token yet by **expected launch value**: a value curve fitted in log space on the snapshot's own tokenised protocols (comps with a recorded cap of $5M or more), multiplied by a cohort launch-odds estimate (category × age band, shrunk toward the base rate, leave-one-out Brier-scored against that base rate).

Nothing in the model is hand-set. Every candidate term — 7-day growth, age, chain breadth, curvature, a shrunk per-category shift — is kept only when it lowers the held-out miss on **both** tests: leave-one-out over the comps and a walk-forward split (fit on the earliest-tracked comps, predict the later ones). The dashboard prints the fitted misses, the ablation table with the rejected terms, a measured range-honesty figure (how many comps' recorded caps fall inside their own bootstrap P25–P75 bands), and a full accounting of the snapshot: 416 protocols record a token, 201 are ranked, 141 are set aside with the reason named.

Each board row carries a P25–P75 expected-value range from a seeded residual bootstrap, a rank range, and a farm verdict (FARM / MARGINAL / SKIP) netted at the range's P10 for a standard $1,000 position over 90 days against the plan's own step costs and hours. Every protocol's farm plan is written for its category archetype with a cost and a time on every step. The static dashboard is sortable, filterable, has a detail view per protocol with its full derivation, a model-and-validation view, and a small portfolio planner — and it recomputes the board checksum and the verdicts live in the page, so what it shows is what the program computed.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18 or later, standard library only. The run writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory, deterministically: the same snapshot writes the same bytes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=n8m845w8&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
