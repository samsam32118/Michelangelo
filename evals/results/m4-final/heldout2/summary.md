# Eval m4-final · heldout2

2026-10-04T10:03:41.053Z · model claude-opus-5-5 · package 0.1.0

**8/10 passed (80 %)**, mean score 0.9667 (baseline 0 on untouched sandboxes, delta 0.9667), mean turns 17.9, mean tokens 769k (total 7.69M, cost $5.15), mean wall 126.3 s, agent timeouts 0, shell timeouts 0, failed edits 0, permission denials 29, violations 2 (0 fatal; 0 run(s) failed for them).

| task | pass | score | baseline | delta | turns | tokens | time s | shell timeouts | failed edits | denials | violations | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h-388eb6 | yes | 1 | 0 | 1 | 13 | 550.6k | 90 | 0 | 0 | 3 | 0 |  | docs×4 new×1 edit×3 check×1 render×1 |
| h-c1b94c | yes | 1 | 0 | 1 | 14 | 599.2k | 100 | 0 | 0 | 3 | 2 | E_OVERLAP×1 | docs×7 new×1 edit×17 check×3 look×5 render×1 |
| h-3f561a | yes | 1 | 0 | 1 | 15 | 724.1k | 87 | 0 | 0 | 2 | 0 |  | docs×2 new×1 edit×3 check×2 show×2 render×1 look×1 |
| h-5f5ba2 | no | 0.83 | 0 | 0.83 | 40 | 1.75M | 395 | 0 | 0 | 5 | 0 | E_UNKNOWN_TOPIC×1 | docs×7 new×3 edit×16 show×6 check×3 render×4 look×2 |
| h-426a7a | yes | 1 | 0 | 1 | 23 | 1.04M | 128 | 0 | 0 | 2 | 0 |  | docs×2 new×1 edit×4 plugin×3 check×1 render×1 look×2 |
| h-b618bd | no | 0.83 | 0 | 0.83 | 13 | 557.6k | 73 | 0 | 0 | 3 | 0 |  | docs×5 new×2 edit×13 check×1 look×1 render×1 |
| h-d81eb4 | yes | 1 | 0 | 1 | 15 | 574.9k | 101 | 0 | 0 | 3 | 0 |  | docs×5 new×2 edit×6 show×2 check×2 look×1 render×1 |
| h-20111d | yes | 1 | 0 | 1 | 19 | 777.6k | 95 | 0 | 0 | 4 | 0 |  | docs×1 new×1 edit×4 show×1 check×3 look×3 render×2 |
| h-204129 | yes | 1 | 0 | 1 | 6 | 245.4k | 50 | 0 | 0 | 0 | 0 |  | docs×2 new×1 edit×2 check×1 look×1 render×1 |
| h-ef12d8 | yes | 1 | 0 | 1 | 21 | 868.3k | 144 | 0 | 0 | 4 | 0 |  | docs×2 new×1 edit×1 check×1 render×1 look×2 |

Most common errors: E_OVERLAP (1), E_UNKNOWN_TOPIC (1)
CLI verbs used: edit (69), docs (37), check (18), look (18), new (14), render (14), show (11), plugin (3)
