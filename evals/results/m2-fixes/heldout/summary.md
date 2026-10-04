# Eval m2-fixes · heldout

2026-10-04T04:39:06.862Z · model claude-opus-5-5 · package 0.1.0

**5/10 passed (50 %)**, mean score 0.8433 (baseline 0.04 on untouched sandboxes, delta 0.8033), mean turns 22.4, mean tokens 984.6k (total 9.85M, cost $6.29), mean wall 133.6 s, agent timeouts 0, shell timeouts 0, failed edits 0, permission denials 37, violations 1 (0 fatal; 0 run(s) failed for them).

| task | pass | score | baseline | delta | turns | tokens | time s | shell timeouts | failed edits | denials | violations | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h-3975d1 | no | 0.75 | 0 | 0.75 | 25 | 1.13M | 128 | 0 | 0 | 3 | 1 |  | docs×1 new×1 show×1 check×1 look×5 edit×1 render×1 |
| h-196311 | no | 0.8 | 0 | 0.8 | 21 | 991.3k | 167 | 0 | 0 | 3 | 0 | E_UNKNOWN_TOPIC×1 | docs×9 render×11 check×4 edit×2 look×2 |
| h-a70a9d | yes | 1 | 0.2 | 0.8 | 11 | 472.6k | 79 | 0 | 0 | 3 | 0 |  | docs×1 check×2 doctor×2 render×4 |
| h-4f4e79 | yes | 1 | 0 | 1 | 27 | 1.03M | 128 | 0 | 0 | 4 | 0 |  | docs×1 new×1 edit×2 show×1 check×4 look×6 render×2 |
| h-39c107 | no | 0.33 | 0 | 0.33 | 17 | 763.7k | 121 | 0 | 0 | 2 | 0 |  | docs×8 show×1 look×2 |
| h-74418a | no | 0.75 | 0 | 0.75 | 49 | 2.39M | 294 | 0 | 0 | 10 | 0 | E_ARG×1 E_UNKNOWN_TOPIC×1 | docs×8 new×1 plugin×8 edit×4 check×4 render×4 look×1 |
| h-7305d1 | yes | 1 | 0 | 1 | 21 | 854.5k | 122 | 0 | 0 | 4 | 0 |  | docs×3 new×1 show×2 check×2 look×1 render×1 |
| h-040ad4 | yes | 1 | 0.2 | 0.8 | 24 | 1.02M | 100 | 0 | 0 | 4 | 0 |  | docs×9 plugin×8 edit×3 show×1 check×1 render×2 look×1 |
| h-eef6e4 | no | 0.8 | 0 | 0.8 | 14 | 550.2k | 65 | 0 | 0 | 1 | 0 |  | docs×7 new×1 show×3 check×3 look×1 render×1 |
| h-8f98bf | yes | 1 | 0 | 1 | 15 | 638.9k | 133 | 0 | 0 | 3 | 0 |  | docs×6 check×4 look×1 edit×1 render×1 |

Most common errors: E_UNKNOWN_TOPIC (2), E_ARG (1)
CLI verbs used: docs (53), render (27), check (25), look (20), plugin (16), edit (13), show (9), new (5)
