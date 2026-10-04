# Eval m3-round2 · main

2026-10-04T07:42:17.069Z · model claude-opus-5-5 · package 0.1.0

**29/30 passed (96.7 %)**, mean score 0.9917 (baseline 0.0556 on untouched sandboxes, delta 0.9361), mean turns 10.6, mean tokens 403.1k (total 12.09M, cost $9.27), mean wall 50.8 s, agent timeouts 0, shell timeouts 0, failed edits 0, permission denials 40, violations 0 (0 fatal; 0 run(s) failed for them).

| task | pass | score | baseline | delta | turns | tokens | time s | shell timeouts | failed edits | denials | violations | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| beat-cut | yes | 1 | 0 | 1 | 9 | 342.2k | 45 | 0 | 0 | 1 | 0 |  | docs×3 new×2 edit×9 show×2 check×1 look×1 render×1 |
| captions-from-srt | yes | 1 | 0 | 1 | 11 | 486.3k | 58 | 0 | 0 | 1 | 0 | E_REF×1 E_DUPLICATE_ID×1 | docs×5 edit×8 show×3 check×3 look×1 render×1 |
| captions-vtt-words | yes | 1 | 0 | 1 | 7 | 299.1k | 29 | 0 | 0 | 0 | 0 |  | docs×3 edit×1 show×1 check×1 render×1 |
| color-match | yes | 1 | 0 | 1 | 27 | 1.11M | 115 | 0 | 0 | 6 | 0 |  | docs×1 render×9 edit×4 check×2 |
| csv-variants-sdk | yes | 1 | 0 | 1 | 8 | 262k | 34 | 0 | 0 | 1 | 0 |  | docs×2 |
| cta-end | yes | 1 | 0 | 1 | 9 | 307k | 39 | 0 | 0 | 0 | 0 |  | docs×3 edit×1 show×1 check×1 look×1 render×1 |
| cut-silences | yes | 1 | 0 | 1 | 9 | 376k | 39 | 0 | 0 | 0 | 0 |  | docs×3 new×2 edit×2 show×2 check×1 render×1 |
| duck-music-under-vo | yes | 1 | 0 | 1 | 13 | 427.8k | 61 | 0 | 0 | 4 | 0 |  | docs×2 edit×1 render×4 check×1 look×1 |
| edit-200-clips | yes | 1 | 0.25 | 0.75 | 13 | 491k | 49 | 0 | 0 | 5 | 0 |  | docs×1 check×4 |
| fix-broken-file | yes | 1 | 0 | 1 | 9 | 307.3k | 42 | 0 | 0 | 1 | 0 | E_USAGE×1 E_OVERLAP×1 | validate×1 docs×1 check×3 show×1 look×2 render×2 |
| fix-caption-logo-overlap | yes | 1 | 0.75 | 0.25 | 7 | 245.1k | 26 | 0 | 0 | 1 | 0 |  | check×3 look×3 |
| gif-export | yes | 1 | 0 | 1 | 8 | 303.9k | 35 | 0 | 0 | 1 | 0 |  | docs×4 help×1 show×1 render×1 |
| green-screen | yes | 1 | 0 | 1 | 15 | 460.1k | 53 | 0 | 0 | 3 | 0 |  | docs×3 new×2 edit×8 show×2 check×4 render×2 look×2 |
| import-hevc | yes | 1 | 0 | 1 | 10 | 431.4k | 61 | 0 | 0 | 0 | 0 |  | new×1 edit×2 show×2 check×1 look×1 render×1 |
| import-prores | yes | 1 | 0 | 1 | 9 | 381.1k | 51 | 0 | 0 | 1 | 0 |  | docs×4 new×1 edit×4 show×2 check×1 look×1 render×1 |
| intro-template | yes | 1 | 0 | 1 | 7 | 295.2k | 39 | 0 | 0 | 0 | 0 |  | docs×1 new×1 edit×2 show×1 check×1 look×1 render×1 |
| j-and-l-cuts | yes | 1 | 0.67 | 0.33 | 4 | 154.2k | 21 | 0 | 0 | 0 | 0 |  | edit×1 check×1 |
| keyframed-title | yes | 1 | 0 | 1 | 13 | 451.1k | 49 | 0 | 0 | 2 | 0 |  | docs×3 edit×8 check×2 render×5 look×1 |
| loudness-normalize | yes | 1 | 0 | 1 | 8 | 323k | 36 | 0 | 0 | 1 | 0 |  | docs×2 edit×2 check×2 render×4 look×1 |
| lower-third | yes | 1 | 0 | 1 | 7 | 258.3k | 30 | 0 | 0 | 0 | 0 |  | docs×3 edit×1 show×1 check×1 render×2 look×1 |
| masks-and-blend | yes | 1 | 0 | 1 | 5 | 207.1k | 25 | 0 | 0 | 0 | 0 |  | docs×3 edit×2 check×1 render×1 |
| nested-comp | yes | 1 | 0 | 1 | 9 | 360.9k | 65 | 0 | 0 | 1 | 0 |  | docs×3 check×3 show×2 look×2 edit×1 render×1 |
| per-word-animation | yes | 1 | 0 | 1 | 8 | 292.3k | 34 | 0 | 0 | 0 | 0 |  | docs×2 new×1 edit×3 check×1 look×2 render×2 |
| pip | yes | 1 | 0 | 1 | 12 | 549.2k | 90 | 0 | 0 | 1 | 0 |  | docs×2 new×1 edit×5 check×1 look×1 render×1 |
| plugin-effect-new | yes | 1 | 0 | 1 | 18 | 452.9k | 53 | 0 | 0 | 2 | 0 |  | docs×1 plugin×5 edit×4 check×2 render×2 |
| plugin-transition-new | yes | 1 | 0 | 1 | 18 | 624.9k | 76 | 0 | 0 | 3 | 0 |  | docs×2 plugin×6 edit×2 check×1 render×1 look×1 |
| reframe-16-9-to-9-16 | yes | 1 | 0 | 1 | 10 | 335.8k | 42 | 0 | 0 | 1 | 0 |  | docs×2 edit×1 check×3 look×2 render×1 |
| short-from-script | no | 0.75 | 0 | 0.75 | 20 | 995.3k | 161 | 0 | 0 | 3 | 0 |  | docs×9 new×2 edit×16 show×3 check×3 look×2 render×1 |
| slip-roll | yes | 1 | 0 | 1 | 6 | 223k | 29 | 0 | 0 | 0 | 0 |  | docs×5 edit×2 check×1 |
| speed-and-freeze | yes | 1 | 0 | 1 | 8 | 342.9k | 39 | 0 | 0 | 1 | 0 |  | docs×3 edit×7 show×3 check×1 render×1 look×1 |

Most common errors: E_REF (1), E_DUPLICATE_ID (1), E_USAGE (1), E_OVERLAP (1)
CLI verbs used: edit (97), docs (76), check (50), render (48), look (28), show (27), new (13), plugin (11)

## Failed checks

- **short-from-script**: out/short.mp4: 1080x1920, H.264 + AAC, duration within 0.5 s of vo.wav (1080x1920 h264/aac 11.5 s (vo 10.935 s))
