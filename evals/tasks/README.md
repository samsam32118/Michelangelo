# Main eval set (33 tasks)

Written before the features they test (DESIGN.md §11). Each task: `task.md` (the prompt), `meta.json`
(fixtures, `deliverables`, objective checks, tags, timeout), `setup.mjs` + `grade.mjs`, and usually a
`reference.mjs` (a solution with plain ffmpeg / Node and hand-written JSON, no Michelangelo). Tasks marked *weak*
are ones we expect Michelangelo to be bad at; the last three were added (2026-10-04) before the features they test
and are expected to fail for now.

## Deliverable checks and library-only checks (DESIGN.md §17.2)

The same tasks run in two arms: **with** the library and **without** it (plain ffmpeg, Node, Python). So:

- A check that needs a Michelangelo project file or another library artefact (a plugin package, a `look` contact
  sheet, a render of the agent's project) is named with the prefix **`[lib] `**. It counts only in the "with" arm.
- Every other check is a **deliverable** check: it reads only the output files listed in `meta.json`
  `deliverables` (ffprobe, decoded pixels, loudness, audio envelopes, caption timing seen in the frames) and a
  correct solution made with plain ffmpeg / Node can pass it. Where a project check reads timing (a clip's span, a
  cue), a deliverable check measures the same from the output when it can (e.g. cta-end: the overlay appears only
  in the last 3 s; gif-export: the label moves; nested-comp: each instance where it is visible).
- `grader().result()` returns `deliverable: {pass, score, checks}` over the unprefixed checks
  (`deliverableResult(checks)` in evals/lib/assert.mjs). `meta.json` `library_only: true` marks the five tasks whose
  deliverable is the project file itself (fix-caption-logo-overlap, edit-200-clips, j-and-l-cuts,
  fix-broken-file, slip-roll): they have no deliverable checks and are not counted in the "without" arm.
- `meta.json` `checks` lists the grader's check names verbatim.

Graders read projects as raw JSON (evals/lib/project.mjs); `validateRaw` takes the allowed keys of every entity
from the published JSON Schema (`schema/v1.json`), so any project the library accepts passes it.

| # | id | tags | checks (lib) | deliverables |
|---|---|---|---|---|
| 1 | [short-from-script](short-from-script/task.md) | core, captions, render | 4 (1) | out/short.mp4 |
| 2 | [captions-from-srt](captions-from-srt/task.md) | captions | 3 (1) | out/draft.mp4 |
| 3 | [captions-vtt-words](captions-vtt-words/task.md) | captions, text | 2 (1) | out/still.png |
| 4 | [fix-caption-logo-overlap](fix-caption-logo-overlap/task.md) | qa, captions; library only | 4 (4) | promo.mgl.json |
| 5 | [reframe-16-9-to-9-16](reframe-16-9-to-9-16/task.md) | reframe | 3 (1) | out/tall.mp4 |
| 6 | [duck-music-under-vo](duck-music-under-vo/task.md) | audio | 4 (0) | out/pod.wav |
| 7 | [cut-silences](cut-silences/task.md) | audio, editing | 4 (1) | out/tight.wav |
| 8 | [import-hevc](import-hevc/task.md) | media | 4 (1) | out/day1.mp4 |
| 9 | [import-prores](import-prores/task.md) | media, transitions | 4 (1) | out/edit.mp4 |
| 10 | [csv-variants-sdk](csv-variants-sdk/task.md) | sdk, batch | 5-6 (1-2) | out/*.png |
| 11 | [edit-200-clips](edit-200-clips/task.md) | scale, editing; library only | 4 (4) | big.mgl.json |
| 12 | [plugin-effect-new](plugin-effect-new/task.md) | plugins | 3 (2) | out/poster.png |
| 13 | [plugin-transition-new](plugin-transition-new/task.md) | plugins, transitions | 4 (2) | out/iris.mp4 |
| 14 | [lower-third](lower-third/task.md) | templates, text | 3 (2) | out/l3.png, out/before.png |
| 15 | [intro-template](intro-template/task.md) | templates | 4 (1) | out/intro.mp4 |
| 16 | [cta-end](cta-end/task.md) | templates | 5 (2) | *.mp4 (a draft) |
| 17 | [keyframed-title](keyframed-title/task.md) | motion | 3 (2) | *.png (3 stills) |
| 18 | [per-word-animation](per-word-animation/task.md) | motion, text | 4 (3) | out/w.png |
| 19 | [nested-comp](nested-comp/task.md) | comps | 3 (1) | out/badges.mp4 |
| 20 | [masks-and-blend](masks-and-blend/task.md) | motion, compositing | 3 (2) | *.png |
| 21 | [j-and-l-cuts](j-and-l-cuts/task.md) | editing, audio; library only | 3 (3) | dialog.mgl.json |
| 22 | [speed-and-freeze](speed-and-freeze/task.md) | editing | 3 (1) | out/run.mp4 |
| 23 | [loudness-normalize](loudness-normalize/task.md) | audio, export | 3 (1) | out/mix.mp3, out/mix.wav |
| 24 | [gif-export](gif-export/task.md) | export | 4 (1) | out/clip.gif |
| 25 | [fix-broken-file](fix-broken-file/task.md) | robustness; library only | 2 (2) | broken.mgl.json |
| 26 | [beat-cut](beat-cut/task.md) | audio, editing, weak | 3 (1) | out/beat.mp4 |
| 27 | [slip-roll](slip-roll/task.md) | editing; library only | 2 (2) | trim.mgl.json |
| 28 | [pip](pip/task.md) | compositing | 4 (1) | out/pip.mp4 |
| 29 | [green-screen](green-screen/task.md) | effects, weak | 3 (1) | *.png |
| 30 | [color-match](color-match/task.md) | color, weak | 3 (2) | *.png |
| 31 | [script-only-short](script-only-short/task.md) | core, text, motion, audio, weak (new) | 7 (1) | out/short.mp4 |
| 32 | [polish-music-sfx](polish-music-sfx/task.md) | audio, sound design, weak (new) | 6 (1) | out/final.mp4 |
| 33 | [talking-head-youtube](talking-head-youtube/task.md) | editing, captions, chapters, weak (new) | 8 (1) | out/final.mp4, out/chapters.txt |

### The three tasks written ahead of their features

- **script-only-short**: only `script.txt` is given (6 sentences); everything else is made from nothing. Deliverable
  checks: 1080x1920 H.264/AAC, 20-30 s; the picture changes in every 2 s window; loudness -16..-12 LUFS, no
  silence > 1.5 s; on-screen text (an OCR-free text-line detector, `textBands` in evals/lib/frames.mjs) in
  >= 80 % of frames sampled at 4 fps and in the hook (0.5 s, 1 s); at least one stable on-screen text state per
  sentence (the text follows the script).
- **polish-music-sfx**: a finished 20 s edit (`edit.mgl.json` and its plain-ffmpeg render `edit.mp4`: cuts at 4.2,
  9.1, 13.7 s, a title at 1.3 s, a voice-over at 10.2 s). Deliverable checks: same picture (SSIM), a music bed in
  every 1 s window, a transient within 3 frames of each cut and of the title, -14 +-1 LUFS with true peak
  <= -1 dBTP, and the voice >= 6 dB above the bed in the speech band.
- **talking-head-youtube**: a 60 s interview (flite phrases, fillers, pauses up to 3 s) and `notes.txt` (speaker,
  four topics with source times). Deliverable checks: shorter by at least half the dead air, every phrase kept in
  order (envelope cross-correlation), no silence > 0.8 s after the speech starts, captions in the bottom third
  at the phrase midpoints, a left-aligned lower third in the first 10 s, an intro title in the first 4 s, and
  chapters (`out/chapters.txt` or chapter metadata) within 2 s of where each topic starts in the output.

Every media grader also asserts the output is not empty, black, static or silent (evals/lib `assertNotEmpty`).
The grader tests (tests/unit/evals-graders.test.ts) check that every grader fails on an untouched sandbox, that the
reference solutions pass, and that black / silent / unedited fakes fail.
