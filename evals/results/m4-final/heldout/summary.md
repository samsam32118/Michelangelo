# Eval m4-final · heldout

2026-10-04T09:55:13.476Z · model claude-opus-5-5 · package 0.1.0

**7/10 passed (70 %)**, mean score 0.8933 (baseline 0.04 on untouched sandboxes, delta 0.8533), mean turns 19.8, mean tokens 828k (total 8.28M, cost $5.48), mean wall 118.8 s, agent timeouts 0, shell timeouts 0, failed edits 0, permission denials 30, violations 12 (0 fatal; 0 run(s) failed for them).

| task | pass | score | baseline | delta | turns | tokens | time s | shell timeouts | failed edits | denials | violations | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h-3975d1 | yes | 1 | 0 | 1 | 18 | 772k | 83 | 0 | 0 | 2 | 0 |  | docs×2 new×2 edit×15 show×2 check×2 look×2 render×1 |
| h-196311 | no | 0.8 | 0 | 0.8 | 36 | 1.68M | 235 | 0 | 0 | 6 | 7 |  | docs×7 edit×2 check×4 render×6 look×2 |
| h-a70a9d | yes | 1 | 0.2 | 0.8 | 13 | 397.6k | 76 | 0 | 0 | 2 | 1 | E_ARG×1 | docs×1 check×2 render×6 |
| h-4f4e79 | yes | 1 | 0 | 1 | 19 | 785.9k | 95 | 0 | 0 | 2 | 1 |  | show×1 check×1 look×2 render×1 |
| h-39c107 | no | 0.33 | 0 | 0.33 | 19 | 887.8k | 160 | 0 | 0 | 2 | 0 |  | docs×11 new×3 show×1 check×1 look×2 |
| h-74418a | yes | 1 | 0 | 1 | 15 | 646.3k | 83 | 0 | 0 | 5 | 0 |  | docs×3 new×1 edit×3 show×1 render×1 check×1 look×1 |
| h-7305d1 | yes | 1 | 0 | 1 | 22 | 772.3k | 115 | 0 | 0 | 2 | 1 |  | docs×3 show×8 new×1 check×2 look×2 render×1 |
| h-040ad4 | yes | 1 | 0.2 | 0.8 | 30 | 1.33M | 155 | 0 | 0 | 5 | 0 |  | docs×9 plugin×10 edit×3 show×2 check×2 render×4 |
| h-eef6e4 | no | 0.8 | 0 | 0.8 | 12 | 421.2k | 64 | 0 | 0 | 1 | 0 | E_OVERLAP×18 | docs×3 check×3 look×3 render×1 |
| h-8f98bf | yes | 1 | 0 | 1 | 14 | 589.5k | 121 | 0 | 0 | 3 | 2 | E_FORMAT×1 | docs×5 edit×5 show×3 check×4 render×4 look×1 |

Most common errors: E_OVERLAP (18), E_ARG (1), E_FORMAT (1)
CLI verbs used: docs (44), edit (28), render (25), check (22), show (18), look (15), plugin (10), new (7)
