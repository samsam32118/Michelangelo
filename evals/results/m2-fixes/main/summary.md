# Eval m2-fixes · main

2026-10-04T04:29:39.767Z · model claude-opus-5-5 · package 0.1.0

**27/30 passed (90 %)**, mean score 0.9556 (baseline 0.0556 on untouched sandboxes, delta 0.9), mean turns 11.2, mean tokens 426k (total 12.78M, cost $9.38), mean wall 51.5 s, agent timeouts 0, shell timeouts 0, failed edits 0, permission denials 38, violations 0 (0 fatal; 0 run(s) failed for them).

| task | pass | score | baseline | delta | turns | tokens | time s | shell timeouts | failed edits | denials | violations | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| beat-cut | no | 0.33 | 0 | 0.33 | 17 | 636.8k | 68 | 0 | 0 | 2 | 0 |  | docs×4 new×1 edit×10 show×6 check×1 look×4 render×1 |
| captions-from-srt | no | 0.67 | 0 | 0.67 | 11 | 428.8k | 46 | 0 | 0 | 1 | 0 |  | show×2 docs×4 edit×5 check×2 look×1 render×1 |
| captions-vtt-words | yes | 1 | 0 | 1 | 8 | 248.9k | 23 | 0 | 0 | 0 | 0 |  | docs×3 edit×1 show×1 check×1 render×1 |
| color-match | yes | 1 | 0 | 1 | 17 | 615.3k | 71 | 0 | 0 | 2 | 0 |  | docs×3 edit×6 render×8 check×1 |
| csv-variants-sdk | yes | 1 | 0 | 1 | 8 | 301.6k | 29 | 0 | 0 | 0 | 0 |  | docs×4 |
| cta-end | yes | 1 | 0 | 1 | 11 | 416.5k | 50 | 0 | 0 | 0 | 0 | E_REF×1 E_ARG×1 | show×1 docs×4 edit×8 check×3 look×3 render×1 |
| cut-silences | yes | 1 | 0 | 1 | 6 | 242.1k | 28 | 0 | 0 | 0 | 0 |  | docs×2 new×2 edit×2 show×2 check×1 render×1 |
| duck-music-under-vo | yes | 1 | 0 | 1 | 18 | 780.9k | 87 | 0 | 0 | 5 | 0 |  | docs×2 edit×3 check×1 render×7 look×1 |
| edit-200-clips | yes | 1 | 0.25 | 0.75 | 12 | 422.5k | 53 | 0 | 0 | 4 | 0 |  | show×6 docs×1 check×5 |
| fix-broken-file | yes | 1 | 0 | 1 | 16 | 466.7k | 58 | 0 | 0 | 1 | 0 | E_USAGE×1 E_UNKNOWN_KEY×1 E_REF×1 E_OVERLAP×1 | validate×1 docs×2 check×5 show×2 look×1 render×1 |
| fix-caption-logo-overlap | yes | 1 | 0.75 | 0.25 | 25 | 1.15M | 138 | 0 | 0 | 4 | 0 |  | check×9 look×7 edit×8 docs×7 show×1 |
| gif-export | yes | 1 | 0 | 1 | 7 | 267.1k | 31 | 0 | 0 | 0 | 0 |  | docs×2 render×2 show×1 |
| green-screen | no | 0.67 | 0 | 0.67 | 12 | 484k | 47 | 0 | 0 | 2 | 0 | E_REF×1 | docs×3 new×1 edit×9 check×3 render×2 |
| import-hevc | yes | 1 | 0 | 1 | 10 | 381.4k | 55 | 0 | 0 | 0 | 0 |  | new×1 edit×2 show×2 check×1 look×1 render×1 |
| import-prores | yes | 1 | 0 | 1 | 9 | 381k | 51 | 0 | 0 | 2 | 0 |  | docs×5 new×2 edit×6 show×2 check×2 look×1 render×1 |
| intro-template | yes | 1 | 0 | 1 | 7 | 291k | 43 | 0 | 0 | 0 | 0 |  | docs×2 new×2 edit×2 show×1 check×1 look×1 render×1 |
| j-and-l-cuts | yes | 1 | 0.67 | 0.33 | 7 | 289.3k | 30 | 0 | 0 | 1 | 0 |  | edit×1 check×1 look×1 |
| keyframed-title | yes | 1 | 0 | 1 | 8 | 253.8k | 36 | 0 | 0 | 1 | 0 |  | docs×3 edit×2 check×2 render×4 look×1 |
| loudness-normalize | yes | 1 | 0 | 1 | 9 | 389.3k | 42 | 0 | 0 | 2 | 0 |  | docs×3 edit×2 render×4 look×1 |
| lower-third | yes | 1 | 0 | 1 | 7 | 209.6k | 24 | 0 | 0 | 0 | 0 |  | docs×3 edit×1 show×1 check×1 render×2 |
| masks-and-blend | yes | 1 | 0 | 1 | 6 | 246.1k | 24 | 0 | 0 | 0 | 0 |  | docs×3 edit×2 check×1 render×1 |
| nested-comp | yes | 1 | 0 | 1 | 10 | 388.3k | 61 | 0 | 0 | 1 | 0 |  | docs×2 check×2 show×2 look×1 render×1 |
| per-word-animation | yes | 1 | 0 | 1 | 11 | 433.2k | 42 | 0 | 0 | 1 | 0 |  | docs×3 new×2 show×3 edit×5 check×2 look×2 render×2 |
| pip | yes | 1 | 0 | 1 | 13 | 618.6k | 86 | 0 | 0 | 2 | 0 |  | new×1 edit×6 docs×2 check×1 look×1 render×1 |
| plugin-effect-new | yes | 1 | 0 | 1 | 18 | 514.6k | 71 | 0 | 0 | 2 | 0 |  | docs×1 plugin×7 edit×4 check×2 render×2 |
| plugin-transition-new | yes | 1 | 0 | 1 | 16 | 500.7k | 63 | 0 | 0 | 1 | 0 |  | docs×3 plugin×5 edit×2 check×1 look×1 render×1 |
| reframe-16-9-to-9-16 | yes | 1 | 0 | 1 | 8 | 342.8k | 46 | 0 | 0 | 0 | 0 |  | docs×1 edit×2 check×1 look×1 render×1 |
| short-from-script | yes | 1 | 0 | 1 | 17 | 631.4k | 82 | 0 | 0 | 3 | 0 |  | docs×5 new×3 edit×23 show×3 check×3 look×2 render×1 |
| slip-roll | yes | 1 | 0 | 1 | 4 | 149.3k | 20 | 0 | 0 | 0 | 0 |  | docs×2 edit×2 check×1 |
| speed-and-freeze | yes | 1 | 0 | 1 | 7 | 298.6k | 41 | 0 | 0 | 1 | 0 |  | docs×3 edit×8 show×2 check×1 look×1 render×1 |

Most common errors: E_REF (3), E_ARG (1), E_USAGE (1), E_UNKNOWN_KEY (1), E_OVERLAP (1)
CLI verbs used: edit (122), docs (82), check (55), render (49), show (38), look (32), new (15), plugin (12)

## Failed checks

- **beat-cut**: cut times (frame-colour changes) within 2 frames of the beats 0.5, 1.0, ... 4.0 s; 1080x1080 (photo starts (frames) 0,15,30,45,60,75,90,105; expected 15,30,45,60,75,90,105,120)
- **beat-cut**: the project (1080x1080, the 8 photos and beat.wav) starts each photo clip on its beat (beat.mgl.json: photo clips start at 0,0.5,1,1.5,2,2.5,3,3.5 s (beat.mgl.json))
- **captions-from-srt**: project has 12 cues; each cue start/end within 1 frame of the SRT; texts unchanged (12 cues; valid)
- **green-screen**: still: no pixel with dominant green (g > r+60 and g > b+60) (out/still-1s.png: 90 green pixels (sampled))
