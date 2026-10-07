# Plan: the board, and approve (2026-10-07)

Status: **proposed**, waiting for the owner. Replaces the earlier versions of this plan (kept in git history).
Nothing is built except `Project.historyEntries()` (additive, 4 lines).

## Why

The human never opens Michelangelo. They watch Claude Code or Codex edit a video and get an `.mp4` plus the
agent's summary. To trust it today they must rewatch the whole video after every round, or believe the summary.

Trust comes from **inspectability** (I can see what was done) and **diff** (I can see what changed since I said
it was good). What a human needs to do is two things: **see what changed, and say "good".** So the design has
two concepts and nothing else.

## Two concepts

### 1. The board

One tile per line of the script (or per shot when there is no script). Tiles that changed since you last said
"good" show **after ⇄ before** and one line saying what changed. Everything else is plain.

```
 "Three tips to focus"   "Put your phone in another room"   "Work in 25-minute blocks"   "Follow for more"
 [frame]                 ● [after ⇄ before]                   ● [after ⇄ before]           [frame]
 0.0–2.5s                2.5–5.8s · title higher (y 420→380)  5.8–9.1s · new b-roll       9.1–11.0s
─────────────────────────────────────────────────────────────────────────────────────────────────────
 2 of 4 lines changed since you approved at 14:02 · QA: no new problems
```

The same board serves every stage, so there is no separate storyboard, contact sheet or review:

- **Before you approve anything**, the first draft is the storyboard. `mgl new shorts --script` builds a whole
  draft in one call, so the first board already shows every line with a picture.
- **During the work**, it is the map you point at: "the phone line, make the text smaller".
- **After the work**, it is the review: what changed, before and after.

### 2. Approve

"I've seen it; it's good; compare against this from now on." `mgl edit <file> approve` (the agent runs it when
you say so). Until the first approval the board compares against the start of the recorded history and says
`not approved yet`.

That is the whole interface. To change something already approved, ask; the board will show it changed.

## How the board decides things (none of this is a concept the human learns)

**Tiles.** When the video has captions, one tile per spoken sentence: consecutive caption cues grouped until a
cue ends in `.`, `!` or `?`, labelled with the sentence. Any project made from a script has these
(`recipe.short` captions every sentence; `captions.from-text` and `captions.import` too). Otherwise one tile per
clip on the bottom visual track of the main comp (a shot), labelled with its id; otherwise 5-second chunks. At
most 12 tiles in the image (changed ones first, the rest counted in the footer); the page shows all.

**Matching a tile across versions.** Sentences match by text, then by position (an edited line shows
`line edited: "old" → "new"`). Shots match by clip id. A new line is marked `new`; a removed line is listed
under the board.

**Changed.** The approved file is saved (`.mgl/<p>/approved.json`: the project, each asset's content hash and
the time). The board diffs it against the current file, entity by entity, and maps each change to the tiles
whose time range it touches: a clip by its span, a cue by its sentence, a style by the clips that use it, an
asset whose content hash changed by the clips that use it. A change to the whole video (comp size, fps, the
project's settings) is one line in the header, not every tile lit. Because the saved file is compared, every
change counts: commands, hand edits of the file, other tools.

**Moves are not changes.** Inserting a line pushes later tiles in time. A tile whose content is unchanged and
only moved stays plain, with a small `moved 2.0s later`. Otherwise one insert would light up the whole board.

**Before ⇄ after frames** are rendered at the middle of the line in both versions (board size, tiles ≤ 640 px
tall, about 1–2 s for 12 tiles at 1080×1920).

**What changed, in words.** Field-level, from the diff: `title higher (y 420→380)`, `new b-roll`,
`captions restyled`, `line edited`. When a recorded step made it, the page names the step; when none did:
`changed by hand`.

**QA.** The existing no-pixel checks run on both versions; the header says `QA: 1 new problem` (with it, under
the board) or `QA: no new problems`. Problems that were already there are not repeated: what matters here is
whether the agent broke something.

## Where it appears (no new verb, one new flag)

- **`mgl look`**: without `--at` / `-n`, the contact sheet is laid out as the board (`sheet.png`, plus
  `board.html`). The agent already runs `look`, so it checks the same picture the human will. With `--at` / `-n`,
  unchanged. QA crops unchanged.
- **`mgl render`**: every video or GIF render writes `<out>.board.png` and `<out>.board.html` next to the output
  and prints the board in text. `--no-board` turns it off. Stills, audio and subtitles skip it. The board comes
  from stills made before encoding, so `--detach` writes it too.
- **`mgl edit <file> approve`**: next to `undo`, `redo` and `history`. `history` gains a first line:
  `since you approved at 14:02: 3 steps, 2 lines changed`.

**The page** (`board.html`) is the same board, self-contained, with one interaction: click a tile to flip
after ⇄ before. Under the board, collapsed: the steps the agent took and the raw file diff.

**The text** (what the agent relays in chat, ≤ 8 lines, valid Markdown):

```
**2 of 4 lines changed** since you approved at 14:02 · QA: no new problems
- "Put your phone in another room" (2.5–5.8s): title higher (y 420→380)
- "Work in 25-minute blocks" (5.8–9.1s): new b-roll
board: out.board.png · out.board.html · approve: `mgl edit video.mgl.json approve`
```

## Where humans see it

| Surface | What the human sees |
|---|---|
| Claude Code, terminal | the text in the transcript; `board.png` / `.html` as paths |
| Claude Code, desktop / web / mobile app | the board inline in the side panel (the agent sends it as a file) |
| Claude Code, IDE extension | plus native diffs when the agent edits the one-entity-per-line file directly |
| Codex CLI | the text in the final message; the board as paths |
| Codex cloud / any PR | the `.mgl.json` diff, with the text and board in the description |

**The instruction** (one line in SKILL.md, and an `AGENTS.md` snippet in the README for Codex): "Hand over every
render with its board text and `board.png`, after looking at the board yourself. Run `approve` only when the
human says so. Never claim a change the board does not show."

**For people who want a hard gate** (a tip in the docs, not a concept): a host permission rule that makes
`mgl edit * approve` ask before running (Claude Code: an `ask` rule in settings; Codex: the approval policy).

## What we learned from Instagram's Edits storyboards

Edits (Instagram's editor, 2025) turns idea stickies into a storyboard: one slot per line, clips and notes
attached, the plan laid over the edit, several takes per slot, one-tap to teleprompter
([Social Media Today](https://www.socialmediatoday.com/news/edits-adds-improved-storyboard-functionality-expanded-templates/807501/),
[FrameOS](https://frameos.studio/blog/instagram-edits-app)). What we take: **one tile per line** (the unit the
creator thinks in) and **plan and edit as one object** (one board at every stage). What we leave: its growing
list of modes (stickies, storyboards, scripts, cues, takes, teleprompter, templates). Edits plans and shoots but
has no review: no "what changed since I looked", because the creator is the editor. Here someone else edits,
so that is the part we build.

## Not doing, and why

| Not doing | Because |
|---|---|
| A `review` verb | the agent would decide when to run it; `look` and `render` already sit at the right moments |
| A storyboard command, planned tiles, markers as scenes | the first draft (one call) is the storyboard |
| Per-line approve, reopen, locks | to change a finished line, ask; the board shows it changed. `approve <line>` can come later if wanted |
| Broken state, pixel and loudness verification | the saved approved file and asset hashes catch every change; pixels are shown as evidence |
| `render --final` refusing | the board goes out with every render |
| QA fixed / still open | only new problems answer "did the agent break something?" |
| Hover, copy reference, comments, scrubbing, drag-to-edit | tiles are labelled with their line, which you say in chat; one click to flip is enough |
| Takes (pick one of several versions per line) | a third concept; add it if "make it better" round trips turn out common |
| A track timeline picture | `mgl show` prints tracks as text for those who want them |

**Known gaps, accepted:** a plugin's new version can change pixels with no change in the file (its version is
saved with the approval and shown in the header when it differs). A change confined to frames far from the
middle of a line shows in the words but not in the before ⇄ after frame.

## Build steps

| # | Step | Where |
|---|---|---|
| 1 | Tiles: sentences from caption cues, else shots, else chunks; matching across versions (pure, unit-tested) | `src/qa/tiles.ts` |
| 2 | Approval: `approve()` saves project, asset hashes, plugin versions, time; `edit approve`; `history` line (`historyEntries()` done) | `src/sdk/project.ts`, `src/cli/edit.ts` |
| 3 | Board engine: baseline, entity diff mapped to tiles, moves, words for changes, QA new problems | `src/qa/board.ts` |
| 4 | Outputs: `board.png` (Skia, like the contact sheet), `board.html` (one inline click handler), the text | `src/qa/board.ts` |
| 5 | `look` lays its sheet out as the board; `render` writes it, `--no-board`; SDK `p.board()` | `src/qa/look.ts`, `src/cli/`, `src/sdk/index.ts` |
| 6 | Docs: README (one word, one flag), DESIGN §6.1 and §8, SKILL.md line, AGENTS.md snippet, the permission tip | docs |
| 7 | Tests: tiles from cues / shots / chunks; a scenario from `new shorts --script`: board shows 4 lines, not approved; approve; edit one line's title + hand-edit another's caption → 2 changed, one `changed by hand`; insert a line → later tiles `moved`, not changed | `tests/unit/` |
| 8 | Evals: run the main set before and after step 5 (the agent's `look` sheet changes) and compare | `evals/run.mjs` |

Each step lands with `npm run test:fast` passing, on a branch off `main`.

## Decisions for the owner

- **(Ask)** `look`'s default sheet becomes the board (recommended: agent and human check the same picture), or
  the board is written next to it?
- **(R)** 12 tiles in the image; tiles ≤ 640 px tall; approval data in `.mgl/<p>/approved.json` (git-ignored);
  `<out>.board.*` next to the output the human receives.
