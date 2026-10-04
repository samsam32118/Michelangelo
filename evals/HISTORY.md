# Eval history

Main and held-out sets are reported separately. One row per run (`node evals/run.mjs`); details in `evals/results/<label>/<set>/summary.md`.

| date | label | set | model | tasks | passed | success | mean score | mean turns | mean tokens | mean wall s | shell timeouts | failed edits | violations | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-04 | m1-slice | main | claude-opus-5-5 | 30 | 25 | 83.3 % | 0.9056 | 14 | 533k | 99.2 | 0 | 0 | 0 | M1 vertical slice baseline (audit isolation) |
