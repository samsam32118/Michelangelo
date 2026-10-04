# Eval history

Main and held-out sets are reported separately. One row per run (`node evals/run.mjs`); details in `evals/results/<label>/<set>/summary.md`.

| date | label | set | model | tasks | passed | success | mean score | mean turns | mean tokens | mean wall s | shell timeouts | failed edits | violations | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-04 | m1-slice | main | claude-opus-5-5 | 30 | 25 | 83.3 % | 0.9056 | 14 | 533k | 99.2 | 0 | 0 | 0 | M1 vertical slice baseline (audit isolation) |
| 2026-10-04 | m2-fixes | main | claude-opus-5-5 | 30 | 27 | 90 % | 0.9556 | 11.2 | 426k | 51.5 | 0 | 0 | 0 | baseline 0.0556, delta 0.9; 38 permission denials; M2 after fix round 1 (audit isolation) |
| 2026-10-04 | m2-fixes | heldout | claude-opus-5-5 | 10 | 5 | 50 % | 0.8433 | 22.4 | 984.6k | 133.6 | 0 | 0 | 1 | baseline 0.04, delta 0.8033; 37 permission denials; M2 held-out (audit isolation) |

Notes:
- m1-slice: the held-out set was not run at M1 (first held-out run is m2-fixes).
- After m2-fixes, the beat-cut grader was corrected to accept cuts aligned with the beats as heard in the output
  (an agent may trim the silent lead-in); regraded, m2-fixes main would be 28/30. The table keeps the original grade.
- Held-out exposure (2026-10-04): the m2-fixes held-out summary printed the held-out task ids, and the builder
  saw them. The task contents were not read, but the names reveal themes, so held-out set v1 (`evals/heldout`)
  is treated as an exposed regression set from now on. A new held-out set v2 (`evals/heldout2`) was written by
  a separate agent, and the runner now hides held-out ids behind anonymous aliases in all public output.
| 2026-10-04 | m2b-heldout2-baseline | heldout2 | claude-opus-5-5 | 10 | 8 | 80 % | 0.9667 | 23.3 | 1M | 125.3 | 0 | 0 | 0 | baseline 0, delta 0.9667; 40 permission denials; held-out v2 first run, build after M2 fixes (audit isolation) |
| 2026-10-04 | m3-round2 | main | claude-opus-5-5 | 30 | 29 | 96.7 % | 0.9917 | 10.6 | 403.1k | 50.8 | 0 | 0 | 0 | baseline 0.0556, delta 0.9361; 40 permission denials; M3 after fix round 2 |
| 2026-10-04 | m3-round2 | heldout | claude-opus-5-5 | 10 | 8 | 80 % | 0.9133 | 17.5 | 740.3k | 100 | 0 | 0 | 0 | baseline 0.04, delta 0.8733; 27 permission denials; M3 held-out v1 (exposed; regression) |
| 2026-10-04 | m3-round2 | heldout2 | claude-opus-5-5 | 10 | 8 | 80 % | 0.9667 | 19.6 | 831k | 113.6 | 0 | 0 | 1 | baseline 0, delta 0.9667; 36 permission denials; M3 held-out v2 |
| 2026-10-04 | m4-final | main | claude-opus-5-5 | 30 | 28 | 93.3 % | 0.9667 | 11.4 | 434.7k | 58.5 | 0 | 0 | 4 | baseline 0.0556, delta 0.9111; 36 permission denials; M4 after fix round 3 |
| 2026-10-04 | m4-final | heldout | claude-opus-5-5 | 10 | 7 | 70 % | 0.8933 | 19.8 | 828k | 118.8 | 0 | 0 | 12 | baseline 0.04, delta 0.8533; 30 permission denials; M4 held-out v1 (exposed; regression) |
