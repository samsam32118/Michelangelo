# Eval m4-final · main

2026-10-04T09:46:32.475Z · model claude-opus-5-5 · package 0.1.0

**28/30 passed (93.3 %)**, mean score 0.9667 (baseline 0.0556 on untouched sandboxes, delta 0.9111), mean turns 11.4, mean tokens 434.7k (total 13.04M, cost $9.89), mean wall 58.5 s, agent timeouts 0, shell timeouts 0, failed edits 0, permission denials 36, violations 4 (0 fatal; 0 run(s) failed for them).

| task | pass | score | baseline | delta | turns | tokens | time s | shell timeouts | failed edits | denials | violations | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| beat-cut | yes | 1 | 0 | 1 | 10 | 437.7k | 58 | 0 | 0 | 1 | 0 |  | docs×3 new×2 show×4 edit×6 look×2 render×2 |
| captions-from-srt | yes | 1 | 0 | 1 | 15 | 498k | 83 | 0 | 0 | 2 | 0 | E_REF×1 | docs×4 edit×4 check×4 look×1 render×1 |
| captions-vtt-words | yes | 1 | 0 | 1 | 8 | 344.4k | 32 | 0 | 0 | 0 | 0 | E_REF×1 E_ARG×1 | docs×3 edit×2 check×2 show×1 render×2 |
| color-match | yes | 1 | 0 | 1 | 21 | 791k | 110 | 0 | 0 | 4 | 0 |  | docs×3 render×8 edit×2 check×1 |
| csv-variants-sdk | yes | 1 | 0 | 1 | 8 | 263.3k | 35 | 0 | 0 | 1 | 0 |  | docs×2 |
| cta-end | yes | 1 | 0 | 1 | 10 | 345.3k | 49 | 0 | 0 | 0 | 0 | E_REF×1 | docs×3 edit×5 show×2 check×2 look×2 render×1 |
| cut-silences | yes | 1 | 0 | 1 | 5 | 205.2k | 32 | 0 | 0 | 0 | 0 |  | docs×3 new×1 edit×2 show×2 check×1 render×1 |
| duck-music-under-vo | yes | 1 | 0 | 1 | 16 | 655.9k | 73 | 0 | 0 | 4 | 0 |  | docs×2 edit×1 check×1 render×4 look×1 |
| edit-200-clips | yes | 1 | 0.25 | 0.75 | 7 | 265.6k | 33 | 0 | 0 | 1 | 2 |  | docs×2 check×2 |
| fix-broken-file | yes | 1 | 0 | 1 | 8 | 312.5k | 45 | 0 | 0 | 0 | 1 | E_UNKNOWN_KEY×1 E_REF×1 E_OVERLAP×1 | docs×2 check×4 show×1 render×1 look×1 |
| fix-caption-logo-overlap | yes | 1 | 0.75 | 0.25 | 6 | 242.7k | 28 | 0 | 0 | 0 | 0 |  | check×2 look×3 |
| gif-export | yes | 1 | 0 | 1 | 18 | 866.3k | 83 | 0 | 0 | 3 | 1 |  | docs×7 show×1 render×2 |
| green-screen | yes | 1 | 0 | 1 | 10 | 360.8k | 40 | 0 | 0 | 1 | 0 |  | docs×2 new×1 edit×4 show×1 check×1 render×1 |
| import-hevc | yes | 1 | 0 | 1 | 15 | 524.2k | 64 | 0 | 0 | 1 | 0 | E_UNKNOWN_OP×1 | new×1 edit×3 show×2 check×1 look×1 render×1 |
| import-prores | yes | 1 | 0 | 1 | 12 | 470.9k | 61 | 0 | 0 | 2 | 0 |  | docs×5 new×2 show×5 edit×3 check×2 look×1 render×1 |
| intro-template | yes | 1 | 0 | 1 | 9 | 301.3k | 57 | 0 | 0 | 0 | 0 |  | docs×2 new×2 edit×2 show×1 check×1 look×1 render×1 |
| j-and-l-cuts | yes | 1 | 0.67 | 0.33 | 10 | 420.1k | 36 | 0 | 0 | 1 | 0 |  | docs×1 edit×1 check×1 look×2 |
| keyframed-title | yes | 1 | 0 | 1 | 10 | 451.2k | 65 | 0 | 0 | 1 | 0 |  | docs×3 edit×7 check×3 render×6 look×1 |
| loudness-normalize | no | 0.67 | 0 | 0.67 | 20 | 896.5k | 107 | 0 | 0 | 3 | 0 | E_ARG×1 | docs×7 edit×6 render×11 look×2 |
| lower-third | yes | 1 | 0 | 1 | 8 | 257.1k | 32 | 0 | 0 | 0 | 0 |  | docs×3 edit×1 show×1 render×2 check×1 look×1 |
| masks-and-blend | yes | 1 | 0 | 1 | 7 | 209.3k | 24 | 0 | 0 | 0 | 0 |  | docs×3 edit×2 check×1 render×1 |
| nested-comp | no | 0.33 | 0 | 0.33 | 10 | 402.1k | 64 | 0 | 0 | 1 | 0 | E_SCHEMA×1 | docs×2 check×3 show×3 look×3 render×1 |
| per-word-animation | yes | 1 | 0 | 1 | 10 | 389.2k | 59 | 0 | 0 | 1 | 0 |  | docs×2 new×2 edit×4 check×3 look×2 render×2 |
| pip | yes | 1 | 0 | 1 | 10 | 457.1k | 93 | 0 | 0 | 1 | 0 |  | docs×1 new×1 edit×5 check×1 look×1 render×1 |
| plugin-effect-new | yes | 1 | 0 | 1 | 25 | 608.8k | 68 | 0 | 0 | 3 | 0 |  | docs×1 plugin×5 edit×2 render×1 |
| plugin-transition-new | yes | 1 | 0 | 1 | 12 | 412.6k | 67 | 0 | 0 | 1 | 0 |  | docs×2 plugin×4 edit×2 check×1 look×1 render×1 |
| reframe-16-9-to-9-16 | yes | 1 | 0 | 1 | 8 | 338.8k | 46 | 0 | 0 | 0 | 0 |  | docs×2 edit×2 check×1 look×1 render×1 |
| short-from-script | yes | 1 | 0 | 1 | 21 | 823.6k | 142 | 0 | 0 | 3 | 0 |  | docs×7 new×2 edit×11 show×2 check×5 look×4 render×1 |
| slip-roll | yes | 1 | 0 | 1 | 5 | 184.3k | 25 | 0 | 0 | 0 | 0 |  | docs×3 edit×2 check×1 |
| speed-and-freeze | yes | 1 | 0 | 1 | 7 | 304.1k | 43 | 0 | 0 | 1 | 0 |  | docs×3 edit×8 show×2 check×1 look×1 render×1 |

Most common errors: E_REF (4), E_ARG (2), E_UNKNOWN_KEY (1), E_OVERLAP (1), E_UNKNOWN_OP (1), E_SCHEMA (1)
CLI verbs used: edit (87), docs (83), render (55), check (46), look (32), show (28), new (14), plugin (9)

## Failed checks

- **loudness-normalize**: the mix project (speech + tones) carries the normalisation: a -14 LUFS loudness target, platform or gains (mix.mgl.json: invalid (buses "master": unknown key "fx"))
- **nested-comp**: frames: the badge is visible at 3 different scales at a time when all three overlap (the three badge clips never overlap in time)
- **nested-comp**: rotation differs between two frames 0.5 s apart (no badge frame)

## Sandbox violations

Fatal ones (the repository, evals/, another sandbox or scratchpad) are marked **fatal**.

- edit-200-clips: `Bash: cp big.mgl.json "$TMPDIR_X" 2>/dev/null; cp big.mgl.json /tmp/claude-0/-tmp-mgl-eval-edit-200-clips-UlUaao/7bfc27cd-f80d-56c5-a33a-82740a693a5c/scratchpad/big.orig.json
cat > e.mjs <<'EOF'
import { open } from 'michelangelo';
const p = await open('big.mgl.json');
const short = p.clips({ track:`
- edit-200-clips: `Bash: cp big.mgl.json /tmp/claude-0/-tmp-mgl-eval-edit-200-clips-UlUaao/7bfc27cd-f80d-56c5-a33a-82740a693a5c/scratchpad/big.orig.json && cp /tmp/claude-0/-tmp-mgl-eval-edit-200-clips-UlUaao/7bfc27cd-f80d-56c5-a33a-82740a693a5c/scratchpad/e.mjs ./e.mjs && node e.mjs; rm -f e.mjs; npx mgl check big.mg`
- fix-broken-file: `Bash: cd /tmp/mgl-eval-fix-broken-file-qnzvVH; cp broken.mgl.json /tmp/claude-0/-tmp-mgl-eval-fix-broken-file-qnzvVH/7bfc27cd-f80d-56c5-a33a-82740a693a5c/scratchpad/orig.json; sed -i 's/"opactiy"/"opacity"/; s/"label", "y": 650},$/"label", "y": 650}/' broken.mgl.json; npx mgl check broken.mgl.json`
- gif-export: `Bash: node .gif-export.mjs; rm -f .gif-export.mjs; ffmpeg -v error -i out/clip.gif -vf "select=not(mod(n\,15)),tile=3x1" -frames:v 1 -y /tmp/claude-0/-tmp-mgl-eval-gif-export-lj9LQ3/7bfc27cd-f80d-56c5-a33a-82740a693a5c/scratchpad/tiles.png; ffprobe -v error -show_entries stream=width,height,r_frame_`
