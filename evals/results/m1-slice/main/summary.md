# Eval m1-slice · main

2026-10-04T03:02:43.787Z · model claude-opus-5-5 · package 0.1.0

**25/30 passed (83.3 %)**, mean score 0.9056, mean turns 14, mean tokens 533k (total 15.99M, cost $10.94), mean wall 99.2 s, agent timeouts 0, shell timeouts 0, failed edits 0, violations 0.

| task | pass | score | turns | tokens | time s | shell timeouts | failed edits | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|
| beat-cut | no | 0.5 | 23 | 886.3k | 89 | 0 | 0 |  | docs×3 new×3 show×6 edit×7 look×6 render×2 |
| captions-from-srt | no | 0.67 | 15 | 580.9k | 55 | 0 | 0 | E_REF×1 | docs×5 edit×6 check×3 look×2 render×1 |
| captions-vtt-words | yes | 1 | 7 | 295.3k | 29 | 0 | 0 |  | docs×5 edit×1 show×1 check×1 render×1 |
| color-match | yes | 1 | 38 | 1.77M | 285 | 0 | 0 |  | docs×6 render×14 show×1 edit×9 plugin×3 check×2 look×2 |
| csv-variants-sdk | yes | 1 | 8 | 254.5k | 29 | 0 | 0 |  | docs×2 show×2 |
| cta-end | yes | 1 | 8 | 246.3k | 31 | 0 | 0 |  | docs×3 edit×1 show×1 check×1 look×1 render×1 |
| cut-silences | yes | 1 | 11 | 422k | 44 | 0 | 0 |  | docs×4 new×1 edit×2 show×1 check×2 render×2 |
| duck-music-under-vo | yes | 1 | 31 | 1.17M | 115 | 0 | 0 | E_NO_FILE×1 | docs×4 edit×3 render×5 check×1 |
| edit-200-clips | yes | 1 | 15 | 466.3k | 48 | 0 | 0 |  | show×3 docs×1 check×4 |
| fix-broken-file | yes | 1 | 14 | 508.7k | 54 | 0 | 0 | E_UNKNOWN_KEY×1 E_REF×1 E_OVERLAP×1 | check×5 show×1 render×1 look×1 |
| fix-caption-logo-overlap | yes | 1 | 15 | 550.1k | 81 | 0 | 0 |  | check×7 look×5 edit×5 show×1 docs×3 |
| gif-export | yes | 1 | 10 | 368.9k | 42 | 0 | 0 |  | docs×3 show×1 render×3 |
| green-screen | no | 0 | 12 | 516.4k | 286 | 0 | 0 | E_REF×1 | docs×7 new×1 edit×6 show×2 check×2 render×1 |
| import-hevc | yes | 1 | 1 | 55.6k | 786 | 0 | 0 | E_UNKNOWN_TOPIC×1 | docs×1 new×1 edit×2 show×1 check×1 look×1 render×9 |
| import-prores | yes | 1 | 13 | 578.4k | 198 | 0 | 0 |  | docs×4 new×2 edit×7 check×2 show×1 look×1 render×1 |
| intro-template | no | 0.67 | 9 | 294.8k | 54 | 0 | 0 |  | docs×2 new×2 edit×2 show×1 check×1 look×1 render×1 |
| j-and-l-cuts | yes | 1 | 12 | 423.5k | 37 | 0 | 0 |  | docs×2 edit×1 check×1 show×1 look×1 |
| keyframed-title | yes | 1 | 18 | 558.2k | 61 | 0 | 0 |  | docs×3 edit×2 check×3 render×7 |
| loudness-normalize | yes | 1 | 9 | 384.8k | 36 | 0 | 0 |  | docs×4 edit×1 check×1 render×4 |
| lower-third | yes | 1 | 9 | 251.5k | 27 | 0 | 0 |  | docs×2 edit×1 show×1 check×1 render×2 look×1 |
| masks-and-blend | yes | 1 | 9 | 288.2k | 24 | 0 | 0 |  | docs×5 show×1 edit×2 check×1 render×1 |
| nested-comp | yes | 1 | 17 | 647.6k | 77 | 0 | 0 | E_DUPLICATE_ID×1 | docs×7 new×2 edit×5 show×6 check×4 look×3 render×1 |
| per-word-animation | yes | 1 | 9 | 330.7k | 41 | 0 | 0 |  | docs×4 new×1 edit×5 show×1 check×2 look×3 render×1 |
| pip | no | 0.33 | 23 | 890.7k | 102 | 0 | 0 | E_REF×1 | docs×8 new×1 edit×12 show×1 check×2 look×3 render×1 |
| plugin-effect-new | yes | 1 | 21 | 654.7k | 69 | 0 | 0 |  | docs×2 plugin×5 edit×2 check×1 render×1 |
| plugin-transition-new | yes | 1 | 17 | 680.4k | 72 | 0 | 0 |  | docs×4 plugin×6 edit×2 check×1 look×1 render×1 |
| reframe-16-9-to-9-16 | yes | 1 | 8 | 334.4k | 41 | 0 | 0 |  | docs×1 edit×2 check×1 look×1 render×1 |
| short-from-script | yes | 1 | 21 | 822.4k | 83 | 0 | 0 |  | docs×7 new×3 edit×21 show×4 check×3 look×4 render×1 |
| slip-roll | yes | 1 | 5 | 194k | 24 | 0 | 0 |  | docs×2 edit×2 check×1 |
| speed-and-freeze | yes | 1 | 13 | 563.9k | 55 | 0 | 0 | E_OVERLAP×1 | docs×6 edit×9 show×5 check×2 render×1 look×1 |

Most common errors: E_REF (4), E_OVERLAP (2), E_NO_FILE (1), E_UNKNOWN_KEY (1), E_UNKNOWN_TOPIC (1), E_DUPLICATE_ID (1)
CLI verbs used: edit (118), docs (110), render (64), check (56), show (43), look (38), new (17), plugin (14)

## Failed checks

- **beat-cut**: cut times (frame-colour changes) within 2 frames of the beats 0.5, 1.0, ... 4.0 s; 1080x1080 (photo starts (frames) 0,15,30,45,60,75,90,105; expected 15,30,45,60,75,90,105,120)
- **captions-from-srt**: project has 12 cues; each cue start/end within 1 frame of the SRT; texts unchanged (12 cues; valid)
- **green-screen**: still: no pixel with dominant green (g > r+60 and g > b+60) (no 16:9 PNG still)
- **green-screen**: the disc region is magenta; the former green region matches city.mp4 (no still)
- **intro-template**: frames at 0.5 s and 2.5 s differ (animated) and contain title glyphs (diff 0, edges at 2.5 s 0.0133, luma std at 0.5 s 0.127)
- **pip**: at 2 s: the bottom-right region shows smptebars, the rest testsrc2 (box 1388,760,484,286, PiP error vs smptebars 11.9, rest changed 0.1866)
- **pip**: corners of the PiP box show the background (rounded) (corner pixels checked)
