# Plan: the storyboard, one living map of the video for people and agents (2026-10-07)

Status: **proposed**, waiting for the owner. Replaces the earlier versions of this plan (kept in git history);
the approval loop is gone. Nothing is built except `Project.historyEntries()` (additive, 4 lines).

## Why

The human never opens Michelangelo. They watch Claude Code or Codex work and get an `.mp4`. The agent never
watches the video either. Both work blind on the same thing: the human sees a summary, the agent sees a JSON
file and a few frames.

Trust comes from **inspectability** (I can see what is there and what was done) and **diff** (I can see what
changed). One view should give both to both readers: **the storyboard**, a map of the whole video that shows
every layer, stays readable at a glance, and lets you dig in when you need to.

## What the storyboard is

The video as a row of **scenes**, each with its picture, its words and its layers, at three levels of detail.
You start at the top and dig in only where you need to.

```
LEVEL 1  the whole video ───────────────────────────────────────────────────────────────────────
 1 "Three tips to focus"  2 "Put your phone in…"  3 "Work in 25-minute…"  4 [idea] "show a timer"  5 "Follow for more"
 [frame]                  [frame] ●               [frame] ⚠               [note card]               [frame]
 0.0–2.5s                 2.5–5.8s                5.8–9.1s                —                         9.1–11.0s
 picture  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇
 graphics ▇▇▇▇▇▇▇▇                                                                         ▇▇▇▇▇▇▇▇▇
 captions          ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇
 voice    ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇
 music    ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ (ducked under voice) ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▃▃▃▃▃▃▃▃▃▃
 sfx                       ▮                    ▮                                         ▮

LEVEL 2  one scene: "Work in 25-minute blocks" 5.8–9.1s ⚠ caption under the Reels buttons ─────────────
 [start] [middle] [end]       the composite at three moments
 [picture] [graphics] [captions]   each visual layer alone, at the middle
 voice: vo 5.8–9.1s · music: bed −9 dB ducked · sfx: whoosh at 5.8s
 issue: caption under the Reels buttons · fix: mgl edit video.mgl.json clip.set subs y=1300

LEVEL 3  one element: clip "bg3" (line 18) ─────────────────────────────────────────────────────
 broll.mp4 1.6–4.9s of the source · fit cover · ken-burns 1.0→1.12 (outCubic) · transition in: crossfade 0.33s
 change it: mgl edit video.mgl.json clip.set bg3 …   docs: mgl docs clip.set
```

### Scenes

Scenes are the units people think in, so they come from the story, not from tracks:

1. **Ranges you marked as scenes**: markers with a length, `{"id": "timer", "comp": "main", "at": 270, "len": 60,
   "note": "show a timer"}`. Use them to plan, to group, or to drop an idea anywhere in the video. No schema
   change: markers already have `len` and `note`.
2. Otherwise **sentences**: caption cues grouped until one ends in `.`, `!` or `?`. Every project made from a
   script has them.
3. Otherwise **shots**: each clip on the bottom picture track.
4. Otherwise 5-second chunks.

A scene is labelled with its words (its note, its sentence, or its clip id) and numbered in time order.

### Layers

Tracks are an editor's idea; the storyboard groups everything into **six lanes**, worked out from what each
clip is, never set by hand:

| Lane | Holds |
|---|---|
| picture | video, images, generators, solids, nested comps at the bottom of the stack |
| graphics | text, shapes, stickers, overlays above the picture |
| captions | captions clips and their cues |
| voice | audio on the dialogue bus |
| music | audio on the music bus (with ducking and fades drawn) |
| sfx | every other audio |

Effects, masks and transitions are not lanes: they show as small marks on the clip they belong to, and in
full at level 3. Hidden or muted tracks are drawn faded, not dropped.

### What each scene says about itself (derived, never set)

At most two marks per scene, so the top level stays calm:

| Mark | Means |
|---|---|
| `idea` | a scene you marked with nothing in it yet: drawn as a note card |
| ⚠ | QA found a problem in it (QA runs as it does in `look`) |
| ● | it changed since the previous storyboard |

● is the diff, and it needs no step from anyone: each storyboard keeps a copy of the project it was made from,
and the next one compares against it. At level 2 a ● scene can flip between now and then; the words say what
changed (`title higher (y 420→380)`, `new b-roll`, `changed by hand`).

## Not linear: one map for the whole life of the project

There is no "storyboard phase". The storyboard is rebuilt from the project file every time, so it always shows
the video as it is now, whatever mix of states it is in:

```
          ┌──────── plan: add idea scenes anywhere, reorder the story ────────┐
          │                                                                   │
  script ─┼─▶ draft ──▶ build a scene ──▶ check ──▶ fix ──▶ deliver ──▶ revise │
          │      ▲            │             │        │                   │    │
          └──────┴────────────┴─────────────┴────────┴───────────────────┘    │
                         every step reads and updates the same storyboard ◀───┘
```

- Scene 4 can be an idea while scene 2 is finished and scene 3 is being fixed.
- A new idea can be dropped in the middle of a finished video, as a scene with a note.
- After delivery, a revision starts from the same map, with ● showing what the revision touched.

## How people use it

One self-contained page, `storyboard.html` (inline script, no server, opens anywhere):

- **Level 1** on load: scene row and the six lanes. Hover a lane block to see what it is.
- **Click a scene** to open level 2: three moments, each visual layer alone, the sound in words, its issues.
  Click a layer to hide or show it in the composite (the layer images are made in advance).
- **Click an element** for level 3: its settings, its line in the project file, the command that changes it.
- **Filters**, two only: `issues` and `changed`. Everything else is visible by default.
- **Copy a reference** (`scene 3`, `bg3`) from any level to paste into chat: "scene 3, make the caption smaller".
- In the Claude Code app the agent sends the page and `storyboard.png` (level 1 as one image) to the side panel;
  in a terminal or Codex they are paths to open; in a PR the image goes in the description.

The page reads the project; it never writes it. Changes are made by asking the agent, or by editing the file,
so every change is still a command or a line in the diff.

## How agents use it

The same three levels, as text and images within the existing budgets (≤ 40 lines, images ≤ 1568 px):

| Level | Text (`mgl show`) | Image (`mgl look`) |
|---|---|---|
| 1 whole video | `show <file> --scenes`: one line per scene with its lanes in words | `look <file>`: the scene row and lanes (`storyboard.png`) |
| 2 one scene | `show <file> --scene 3` | `look <file> --scene 3`: the moments and each layer alone |
| 3 one element | `show <file> --clip bg3` (exists) | `render --still` (exists) |

A level 1 line for the agent:

```
3 "Work in 25-minute blocks" 5.8–9.1s ⚠ ● | picture bg3 broll.mp4 ken-burns | graphics — | captions c7–c9 | voice vo | music bed −9 dB ducked | sfx whoosh
```

That is the whole project, scene by scene, in about 15 lines: what an agent needs to plan its next edit without
reading the JSON. And `mgl edit` adds one line to its output naming the scenes an edit touched
(`scenes: 3 "Work in 25-minute blocks"`), so edits and the story stay connected for both readers without a
render.

**The instruction** (one line in SKILL.md, and an `AGENTS.md` snippet in the README for Codex): "Start from
`mgl show --scenes`; dig in with `--scene n`. Hand over every round with `storyboard.png` and the page, and refer
to scenes by number and words."

## Where it appears

| Command | Change |
|---|---|
| `mgl show` | `--scenes` (level 1 text), `--scene n` (level 2 text) |
| `mgl look` | its contact sheet becomes the storyboard (`storyboard.png` + `storyboard.html`); `--scene n` for level 2; `--at` / `-n` keep the old sheet; QA crops unchanged |
| `mgl render` | writes `<out>.storyboard.png` and `.html` next to every video or GIF (`--no-storyboard` turns it off) |
| `mgl edit` | one line: the scenes the edit touched |

No new verb. The storyboard's copy of the project for ● lives in `.mgl/<p>/storyboard/` (git-ignored).

## Keeping it light

| Rule | Why |
|---|---|
| Level 1 fits one screen and one image: ≤ 12 scenes per row, wrapping; lanes drawn as thin blocks | at a glance, for people and agents |
| ≤ 2 marks per scene; two filters; three levels, no more | no wall of badges |
| Lanes are fixed (six) and derived; tracks only at level 3 | nothing to configure |
| Words before numbers (`title higher`, not `y: 420→380` alone) | readable by anyone; numbers one click down |
| Images are made at the size they are shown (tiles ≤ 640 px tall) | 12 scenes with layers ≈ 3–5 s, page ≈ 2 MB |

## Not doing, and why

| Not doing | Because |
|---|---|
| Approval, locks, baselines | asked to leave them out; ● against the previous storyboard gives the diff without a loop |
| Editing on the page (drag, trim) | a second writer next to the agent; the page reads, the agent writes |
| A storyboard verb or storyboard file | the storyboard is derived from the project every time; it cannot drift |
| User-defined lanes or layer groups | six fixed lanes cover the cases; tracks stay one click down |
| Scrubbing and playback | three moments per scene and each layer alone show more than a scrub, without a video player |

Later, if wanted: commands that act on whole scenes (`scene.move 4 after=1`, `scene.split`, `scene.remove`),
built from the existing clip commands, so "swap scenes 2 and 3" is one step.

## Build steps

| # | Step | Where |
|---|---|---|
| 1 | Scenes (markers with a length, sentences, shots, chunks) and lanes (six, from clip kinds and buses); matching scenes across versions (pure, unit-tested) | `src/qa/storyboard.ts` |
| 2 | Text levels: `show --scenes`, `show --scene n`; the scenes line in `edit` | `src/cli/show.ts`, `src/cli/edit.ts` |
| 3 | Diff against the previous storyboard: entity diff mapped to scenes, moves not counted, words for changes | `src/qa/storyboard.ts` |
| 4 | Images: level 1 (`storyboard.png`, Skia, like the contact sheet), level 2 (moments + each visual lane alone) | `src/qa/storyboard.ts`, `src/render/` (layer solo via the existing stills path) |
| 5 | The page: one template, inline script for levels, layer toggles, two filters, copy reference | `src/qa/storyboard-page.ts` |
| 6 | `look` and `render` write it; `--scene`, `--no-storyboard`; SDK `p.storyboard()` | `src/qa/look.ts`, `src/cli/`, `src/sdk/index.ts` |
| 7 | Docs: README, DESIGN §6.1 and §8, SKILL.md line, AGENTS.md snippet | docs |
| 8 | Tests: scenes from each source; lanes from each clip kind; a scenario from `new shorts --script`: 4 scenes, add an idea scene in the middle, edit scene 2 by command and scene 3 by hand → ● on both, `changed by hand` on 3, insert a sentence → later scenes moved, not changed | `tests/unit/` |
| 9 | Evals: run the main set before and after step 6 (the agent's `look` sheet changes) and compare | `evals/run.mjs` |

Each step lands with `npm run test:fast` passing, on a branch off `main`.

## Decisions for the owner

- **(Ask)** `look`'s default contact sheet becomes the storyboard (recommended: agent and human read the same
  map), or the storyboard is written next to it?
- **(Ask)** Markers with a length count as scenes. Today markers with a length are rare (`marker.beats` makes
  points, not ranges); if ranges are wanted for other uses, an additive `scene: true` on markers is the
  alternative.
- **(R)** Six lanes; ≤ 12 scenes per row; three moments per scene; ● compares against the previous storyboard.
