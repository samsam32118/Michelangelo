# Eval m3-round2 · heldout

2026-10-04T07:49:45.477Z · model claude-opus-5-5 · package 0.1.0

**8/10 passed (80 %)**, mean score 0.9133 (baseline 0.04 on untouched sandboxes, delta 0.8733), mean turns 17.5, mean tokens 740.3k (total 7.4M, cost $5.06), mean wall 100 s, agent timeouts 0, shell timeouts 0, failed edits 0, permission denials 27, violations 0 (0 fatal; 0 run(s) failed for them).

| task | pass | score | baseline | delta | turns | tokens | time s | shell timeouts | failed edits | denials | violations | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h-c65dba | yes | 1 | 0 | 1 | 19 | 760.5k | 78 | 0 | 0 | 1 | 0 |  | docs×4 new×2 edit×11 show×3 check×1 look×3 render×1 |
| h-56fd42 | no | 0.8 | 0 | 0.8 | 18 | 757.5k | 109 | 0 | 0 | 4 | 0 |  | docs×7 edit×2 render×5 check×2 look×1 |
| h-555d7b | yes | 1 | 0.2 | 0.8 | 9 | 393.6k | 68 | 0 | 0 | 2 | 0 |  | docs×1 check×1 render×5 |
| h-99bda2 | yes | 1 | 0 | 1 | 21 | 858.3k | 104 | 0 | 0 | 3 | 0 |  | docs×1 show×1 check×1 look×1 render×1 |
| h-9de888 | no | 0.33 | 0 | 0.33 | 15 | 653.1k | 131 | 0 | 0 | 1 | 0 |  | docs×15 new×1 show×1 look×2 |
| h-3f70db | yes | 1 | 0 | 1 | 15 | 668.7k | 76 | 0 | 0 | 4 | 0 |  | docs×3 new×1 edit×3 show×1 check×1 render×1 look×1 |
| h-36cdc6 | yes | 1 | 0 | 1 | 25 | 991.8k | 107 | 0 | 0 | 5 | 0 |  | docs×3 show×5 new×1 check×2 look×1 render×1 |
| h-b661ba | yes | 1 | 0.2 | 0.8 | 26 | 1.2M | 138 | 0 | 0 | 3 | 0 |  | docs×9 plugin×8 edit×1 render×4 check×1 look×2 show×1 |
| h-6540d9 | yes | 1 | 0 | 1 | 15 | 576k | 82 | 0 | 0 | 2 | 0 | E_OVERLAP×13 | docs×2 new×2 check×5 show×1 look×2 render×2 |
| h-0b9ac2 | yes | 1 | 0 | 1 | 12 | 541.4k | 106 | 0 | 0 | 2 | 0 |  | docs×5 show×3 check×2 look×2 render×3 |

Most common errors: E_OVERLAP (13)
CLI verbs used: docs (50), render (23), edit (17), show (16), check (16), look (15), plugin (8), new (7)
