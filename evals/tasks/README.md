# Main eval set (30 tasks)

Written before the features they test (DESIGN.md §11). Each task: `task.md` (the prompt), `meta.json`
(fixtures, objective checks, tags, timeout), and later `setup.mjs` + `grade.mjs`. Tasks marked *weak*
are ones we expect Michelangelo to be bad at.

| # | id | tags | checks |
|---|---|---|---|
| 1 | [short-from-script](short-from-script/task.md) | core, captions, render | 4 |
| 2 | [captions-from-srt](captions-from-srt/task.md) | captions | 3 |
| 3 | [captions-vtt-words](captions-vtt-words/task.md) | captions, text | 2 |
| 4 | [fix-caption-logo-overlap](fix-caption-logo-overlap/task.md) | qa, captions | 4 |
| 5 | [reframe-16-9-to-9-16](reframe-16-9-to-9-16/task.md) | reframe | 3 |
| 6 | [duck-music-under-vo](duck-music-under-vo/task.md) | audio | 3 |
| 7 | [cut-silences](cut-silences/task.md) | audio, editing | 3 |
| 8 | [import-hevc](import-hevc/task.md) | media | 3 |
| 9 | [import-prores](import-prores/task.md) | media, transitions | 3 |
| 10 | [csv-variants-sdk](csv-variants-sdk/task.md) | sdk, batch | 4 |
| 11 | [edit-200-clips](edit-200-clips/task.md) | scale, editing | 4 |
| 12 | [plugin-effect-new](plugin-effect-new/task.md) | plugins | 3 |
| 13 | [plugin-transition-new](plugin-transition-new/task.md) | plugins, transitions | 3 |
| 14 | [lower-third](lower-third/task.md) | templates, text | 3 |
| 15 | [intro-template](intro-template/task.md) | templates | 3 |
| 16 | [cta-end](cta-end/task.md) | templates | 4 |
| 17 | [keyframed-title](keyframed-title/task.md) | motion | 3 |
| 18 | [per-word-animation](per-word-animation/task.md) | motion, text | 3 |
| 19 | [nested-comp](nested-comp/task.md) | comps | 3 |
| 20 | [masks-and-blend](masks-and-blend/task.md) | motion, compositing | 3 |
| 21 | [j-and-l-cuts](j-and-l-cuts/task.md) | editing, audio | 3 |
| 22 | [speed-and-freeze](speed-and-freeze/task.md) | editing | 2 |
| 23 | [loudness-normalize](loudness-normalize/task.md) | audio, export | 2 |
| 24 | [gif-export](gif-export/task.md) | export | 2 |
| 25 | [fix-broken-file](fix-broken-file/task.md) | robustness | 2 |
| 26 | [beat-cut](beat-cut/task.md) | audio, editing, weak (weak) | 2 |
| 27 | [slip-roll](slip-roll/task.md) | editing | 2 |
| 28 | [pip](pip/task.md) | compositing | 3 |
| 29 | [green-screen](green-screen/task.md) | effects, weak (weak) | 2 |
| 30 | [color-match](color-match/task.md) | color, weak (weak) | 2 |

Every grader also asserts the output is not empty, black, static or silent (evals/lib `assertNotEmpty`).
