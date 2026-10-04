# Eval m2b-heldout2-baseline · heldout2

2026-10-04T05:30:45.195Z · model claude-opus-5-5 · package 0.1.0

**8/10 passed (80 %)**, mean score 0.9667 (baseline 0 on untouched sandboxes, delta 0.9667), mean turns 23.3, mean tokens 1M (total 10.03M, cost $5.71), mean wall 125.3 s, agent timeouts 0, shell timeouts 0, failed edits 0, permission denials 40, violations 0 (0 fatal; 0 run(s) failed for them).

| task | pass | score | baseline | delta | turns | tokens | time s | shell timeouts | failed edits | denials | violations | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h-5aeddf | yes | 1 | 0 | 1 | 19 | 776.5k | 97 | 0 | 0 | 1 | 0 |  | new×1 edit×4 show×2 check×2 render×1 |
| h-f588b5 | yes | 1 | 0 | 1 | 21 | 921.5k | 90 | 0 | 0 | 3 | 0 | E_OVERLAP×2 | docs×1 new×1 check×3 look×1 render×1 |
| h-bc55ae | yes | 1 | 0 | 1 | 15 | 596.7k | 88 | 0 | 0 | 4 | 0 |  | docs×1 new×1 check×4 render×1 |
| h-2e8455 | no | 0.83 | 0 | 0.83 | 64 | 3.1M | 363 | 0 | 0 | 9 | 0 | E_UNKNOWN_TOPIC×1 | docs×14 new×2 edit×18 show×3 check×3 render×3 look×2 |
| h-5448fc | yes | 1 | 0 | 1 | 22 | 990.8k | 108 | 0 | 0 | 6 | 0 | E_PATH×1 E_REF×3 E_ARG×3 | docs×6 new×7 edit×24 check×2 render×1 look×1 |
| h-bc0685 | no | 0.83 | 0 | 0.83 | 18 | 720.6k | 82 | 0 | 0 | 4 | 0 |  | docs×9 new×3 edit×12 show×3 check×1 look×1 render×1 |
| h-8a9ace | yes | 1 | 0 | 1 | 19 | 755.9k | 103 | 0 | 0 | 4 | 0 |  | docs×6 new×2 edit×5 show×3 check×2 look×1 render×1 |
| h-3eb317 | yes | 1 | 0 | 1 | 18 | 708.5k | 85 | 0 | 0 | 4 | 0 |  | docs×3 new×1 edit×2 check×1 show×1 render×2 |
| h-57705e | yes | 1 | 0 | 1 | 11 | 383.6k | 67 | 0 | 0 | 1 | 0 |  | docs×3 new×1 edit×1 check×2 look×2 render×1 |
| h-f918af | yes | 1 | 0 | 1 | 26 | 1.08M | 171 | 0 | 0 | 4 | 0 |  | docs×3 new×1 edit×1 check×1 render×1 |

Most common errors: E_REF (3), E_ARG (3), E_OVERLAP (2), E_UNKNOWN_TOPIC (1), E_PATH (1)
CLI verbs used: edit (67), docs (46), check (21), new (20), render (13), show (12), look (8)
