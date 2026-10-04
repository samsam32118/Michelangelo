# Eval m3-round2 · heldout2

2026-10-04T07:58:26.951Z · model claude-opus-5-5 · package 0.1.0

**8/10 passed (80 %)**, mean score 0.9667 (baseline 0 on untouched sandboxes, delta 0.9667), mean turns 19.6, mean tokens 831k (total 8.31M, cost $5.37), mean wall 113.6 s, agent timeouts 0, shell timeouts 0, failed edits 0, permission denials 36, violations 1 (0 fatal; 0 run(s) failed for them).

| task | pass | score | baseline | delta | turns | tokens | time s | shell timeouts | failed edits | denials | violations | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h-388eb6 | yes | 1 | 0 | 1 | 19 | 803.9k | 107 | 0 | 0 | 3 | 1 |  | docs×5 new×1 edit×8 show×5 check×3 render×2 |
| h-c1b94c | yes | 1 | 0 | 1 | 20 | 816k | 107 | 0 | 0 | 4 | 0 | E_OVERLAP×1 | docs×5 new×1 edit×12 show×4 check×3 look×5 render×1 |
| h-3f561a | yes | 1 | 0 | 1 | 12 | 545.5k | 75 | 0 | 0 | 1 | 0 |  | docs×4 new×1 edit×2 show×2 check×2 render×1 |
| h-5f5ba2 | no | 0.83 | 0 | 0.83 | 35 | 1.77M | 268 | 0 | 0 | 6 | 0 |  | docs×8 new×1 edit×14 show×2 check×4 render×3 |
| h-426a7a | yes | 1 | 0 | 1 | 30 | 1.08M | 122 | 0 | 0 | 5 | 0 |  | docs×1 new×1 edit×7 plugin×9 check×1 render×1 look×1 |
| h-b618bd | no | 0.83 | 0 | 0.83 | 14 | 586.1k | 69 | 0 | 0 | 3 | 0 |  | docs×3 new×2 show×2 edit×11 check×1 look×1 render×1 |
| h-d81eb4 | yes | 1 | 0 | 1 | 15 | 593.8k | 96 | 0 | 0 | 3 | 0 |  | docs×5 new×2 show×3 edit×3 check×2 look×2 render×1 |
| h-20111d | yes | 1 | 0 | 1 | 20 | 762.1k | 99 | 0 | 0 | 5 | 0 |  | docs×4 new×3 edit×3 check×1 show×1 render×2 |
| h-204129 | yes | 1 | 0 | 1 | 6 | 250.4k | 42 | 0 | 0 | 0 | 0 |  | docs×3 new×1 edit×2 check×1 render×1 look×1 |
| h-ef12d8 | yes | 1 | 0 | 1 | 25 | 1.1M | 151 | 0 | 0 | 6 | 0 |  | docs×3 show×2 check×2 render×1 look×2 |

Most common errors: E_OVERLAP (1)
CLI verbs used: edit (62), docs (41), show (21), check (20), render (14), new (13), look (12), plugin (9)
