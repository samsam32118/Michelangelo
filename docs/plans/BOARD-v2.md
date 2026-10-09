# Board v2: one video, two views, made by a person and an agent together

Status: plan for review (2026-10-09). Replaces the UI and the data split of [BOARD.md](BOARD.md); it keeps that
plan's server, ops, live sync, Skia drawing and console API. Owner: samsam32118. **(R)** marks a decision that
is reversible and was taken without asking.

## 0. What the review of v1 found

v1 works (tests and evals pass), but it feels like a tool, not like magic:

- **Two files and a link.** `video.board.json` points at `video.mgl.json`. Stills and the timeline need
  "a linked project", and a blank board says so in an error toast.
- **A side panel with four tabs** (Brief, Rounds, Chat, Next), a brief form with 12 fields, round cards and a
  cost ladder. The person fills in forms before anything appears on the board.
- **Eleven tools on day one.** A tool bar with 11 icons and 25 shortcuts, shown to everyone.
- **Phone is a squeezed desktop.** The panel becomes a bottom sheet covering 38 % of the screen, and the tool
  bar covers the canvas.
- **Saving is ad hoc.** There are two history files, edits are queued in a detached page and pasted back by
  hand, and there are no versions to go back to.

## 1. Principles

1. **One source of truth.** The video *is* the project file. Notes, questions, choices and the storyboard
   live in it. The board and the timeline are two **views** of the same data, with nothing to link.
2. **Talk on the canvas.** The person writes **notes**. The agent asks **questions**, some with choices.
   Both appear where they are about: on a scene, at a moment, or on the video as a whole. There is no side
   panel and no form.
3. **One verb at a time.** As in a good game, the first minute teaches one action (write a note). Everything
   else appears when it becomes useful, and every tool for professionals is one shortcut away.
4. **Phone first.** It is designed for a thumb on a 390 px screen, then scaled up to a desktop. It is never a
   squeezed desktop.
5. **Nothing is ever lost.** Every change is saved at once, every meaningful moment becomes a version, and any
   version can be opened, compared, previewed or restored.
6. **Spend only after agreement.** Cheap previews are automatic. Anything that costs real CPU is a question the
   agent asks, with the time it will take, and the person answers with one tap.

## 2. Data: the project file grows a conversation

Additive to `src/core/schema/` (CLAUDE.md: never break a field). One new table, `notes`, plus an optional
`intent` on `project`.

```json
"project": {"name": "Focus trick", "intent": "30 s Short that makes students try the 2-minute trick"},
"notes": [
{"id": "n1", "by": "human", "text": "Open on the phone going into a drawer", "at": 0},
{"id": "q1", "by": "ai", "kind": "question", "text": "Calm or punchy music?", "choices": ["calm", "punchy"], "answer": "calm"},
{"id": "q2", "by": "ai", "kind": "question", "text": "Two openings: which one?", "clip": "shot1", "choices": [{"label": "Drawer close-up", "version": "v7"}, {"label": "Timer first", "version": "v8"}], "cost": "draft ≈ 40 s"},
{"id": "n2", "by": "human", "text": "title too small", "clip": "title", "at": 45, "u": 0.5, "v": 0.2, "done": "title is 20 % larger"}
]
```

| field | meaning |
|---|---|
| `kind` | `note` (default), `question`, `answer`, or `decision`. Three or four kinds, never a new table for each idea |
| `by` | `human` or `ai` |
| `at` | a frame in the main comp. The note is about this moment, so it shows on the timeline and next to the scene that contains it |
| `clip` | the clip the note is about. When that clip moves or is trimmed, the note follows it |
| `u`, `v` | a point inside the frame, for a pin on the picture |
| `choices` | for questions: plain strings, or `{label, version}` where each choice is a **version** (§5) that can be previewed |
| `answer`, `done` | an answered question, or a note the agent has handled (its reply says what changed) |
| `x`, `y` | only for notes the person drags to a free spot on the canvas. Everything else is placed by the view |

**Scenes are not stored.** A scene is derived from the main comp: the clips on its lowest visual track, split
at markers when there are markers. Thumbnails are derived too, rendered and cached under `.mgl/cache`. So the
board can never disagree with the timeline: both draw the same project.

The `intent` is the old brief reduced to one sentence the person writes first. The other brief fields
(audience, tone, avoid, success) become notes and answers, created when the agent asks about them. They are not
form fields.

Freeform drawing (sketches, arrows, frames, sticky notes placed at x/y) stays for professionals as
`kind: "sketch"` notes holding a `shape` (the v1 shape types, drawn by the same `src/board/shared` code). It is
never shown in the first-run path.

`video.board.json` goes away. Its rounds become questions with choices, its log becomes notes, its spend
becomes `.mgl/spend.jsonl` (derived data, outside the file, the same rule as caches), and its shapes become
sketch notes. A one-time migration (`mgl board migrate`) converts v1 files.

## 3. Two views of one video

```
 BOARD (scenes as cards, notes around them)        TIMELINE (the same scenes on a time axis)
 ┌──────┐  ┌──────┐  ┌──────┐                      |0s    |2s     |4s      |6s
 │ s1   │  │ s2   │  │ s3   │   pinch / swipe ↕     [ s1   ][ s2    ][ s3     ]   V1
 │ img  │  │ img  │  │ img  │  ◀──────────────▶    [  title    ]                 T1
 └──────┘  └──────┘  └──────┘                      ~~~~~~~~ voice ~~~~~~~~~~~    A1
  ● "drawer"   ? calm/punchy                          ●n1          ?q2            notes as markers
```

- **One gesture switches views: semantic zoom.** Pinch out (or press `Tab`) and the scenes, laid out as cards
  on a canvas, slide into a row and become the timeline's main track. The other tracks fold out beneath, and
  notes become markers at their times. Pinch in and the timeline becomes cards again. The same object animates
  between the two layouts, so it never feels like a page change.
- **The board** shows scenes as cards in story order, wrapping on the phone and in rows on a desktop. Notes
  and questions attach to the card they are about. The intent sits above the first card, and notes about the
  whole video gather around it.
- **The timeline** is a real, editable timeline: trim, split and move. It is a simple view of the existing
  commands (`clip.trim`, `clip.split`, `clip.move`), never a second model.
- **The preview** is the scene card itself. Tap a card and it plays: a cached draft when one exists, otherwise
  its stills as a flip-book with the audio. While anything is playing, a playhead runs across both views.

## 4. Interaction: how complexity is introduced

The patterns come from games and from the best tools: one verb at a time (Portal, Mario 1-1), learning by doing
instead of reading a tutorial, contextual prompts, unlocks, a command palette for experts (Linear, Raycast,
Figma), and the message composer as the universal input (iMessage, Slack).

### 4.1 The first minute (beginner)

1. An empty board shows one large line: **"What's the video about?"**, and a composer at the bottom.
2. The person types a sentence. That becomes the `intent`.
3. The agent answers on the board: one or two **question cards** with tappable choices ("Who is it for?
   students · professionals · everyone"; "Calm or punchy?"), and a first rough set of scene cards. These are
   sketches: titles and colours, no render, free.
4. Each tap on a choice answers the question. The agent updates the scenes, and stills fade in (milliseconds
   each).
5. When the agent wants to spend real CPU, it asks: **"Make a draft to watch? ~40 s"** with **Yes** / **Not
   yet**. Nothing costly happens without that tap.

By then the person has used one input (the composer) and one gesture (a tap), and has a video they can watch.

### 4.2 Unlocks (shown once, when they first become useful)

| when | what appears | how it is taught |
|---|---|---|
| there are scenes | long-press (or right-click) a scene to pin a note on a point of the picture | a one-line hint on the first card, shown once |
| there is a draft | the scene card plays; drag across it to scrub | the play icon pulses once |
| a question has versions | tap a choice to preview that version before choosing | "Preview" on the choice |
| there are 4 or more scenes | pinch out (or `Tab`) for the timeline | a hint at the edge of the screen |
| the 3rd session, or the person types `/` | the command palette | a hint in the composer placeholder |

### 4.3 Professionals (always there, never in the way)

- **Command palette** (`⌘K` or `/` in the composer): every project command and board op by name, with fuzzy
  search and inline arguments. These are the same commands as `mgl edit`, so whatever the CLI can do, the
  palette can do.
- **Keys:** `Tab` switches views, `N` adds a note at the playhead, `J`/`K`/`L` shuttle, `I`/`O` mark in and
  out, `S` splits, `Space` plays, `⌘Z` undoes, `⌘S` names a version. Sketch tools come from the palette or
  from `D`.
- **Full timeline:** every track, keyframe lanes on demand, snapping and ripple. The expert edits the video
  here. It is never a mock-up.
- **Agent tools are the person's tools.** `window.mgl` in the console and `mgl board`/`mgl edit` in the
  terminal call the same commands, and the outline mirror reads both views as text.

### 4.4 What is removed

The side panel and its tabs, the brief form, round cards, the "Next" list (advice now arrives as questions on
the board), the 11-icon tool bar (replaced by the composer plus the palette), the separate board file, the
`--project` link, and "Copy changes" (see §6).

## 5. Saving and versions

**Every change is an op in an append-only log, and every meaningful moment is a version in git.**

1. **Op log, the truth for live collaboration.** Each command (from the page, the CLI, the console, or the
   agent) is appended to `.mgl/ops/<date>.jsonl` with the author, the time, its inverse, and the version it
   applied to. The server writes the project file after each batch (atomically, one entity per line as now).
   Undo and redo walk this log, per party.
2. **Versions, checkpoints a person can name.** A version is created automatically at meaningful moments: a
   question answered, a draft or final rendered, a batch from the agent, or 2 minutes of quiet after edits.
   It is also created when someone presses `⌘S` or runs `mgl board version "before the new hook"`. A version
   is a **git commit on a private ref** (`refs/mgl/versions`), written with git plumbing (`hash-object`,
   `mktree`, `commit-tree`, `update-ref`). It never touches the person's working tree, index or branch, it
   works whether or not they commit, and `git log refs/mgl/versions` shows the history. When the folder is not
   a git repository, the same objects go into `.mgl/versions/`, a small content-addressed store, and the
   person never needs git. **(R)**
3. **Choices are versions.** When the agent offers alternatives, each choice is a version branched from the
   current one (`v7`, `v8`). Its scenes and draft can be previewed without changing the main line. Choosing
   moves the main line to that version, and the others stay one tap away. This replaces v1's rounds and makes
   "show me both" real instead of described.
4. **Renders belong to versions.** A render (still, sheet, draft, final) is cached by content hash and
   recorded against the version it was made from. "This draft is from v12" is always known, and spend is
   measured per version.
5. **Media is referenced, not copied.** Versions store the project file and the notes. Media files are
   referenced by content hash, so restoring an old version that needs a deleted file says which file it
   needs.
6. **Version history UI.** Long-press the undo button (or `⌘⇧Z` held, or the palette's "Versions") to get a
   strip of versions with thumbnails. Tap one to preview it, then **Restore**. Restoring is itself a new
   version, so nothing is lost.

## 6. Same truth everywhere: transports

| where the person is | how the page talks to the truth |
|---|---|
| Same machine as the agent (Claude Code or Codex on a laptop) | `mgl board` serves the page and syncs live over SSE, as in v1 |
| The agent is in a cloud container and the person is in the Claude app | the board is published as an **Artifact with shared state**. The page writes the person's ops to the Artifact's database, and the agent reads and applies them with `ArtifactData`, then writes back its own ops and new stills. There is no pasting. This needs the Artifact runtime capability for shared data; check it in the build's first step, and fall back to v1's export and "Copy changes" if it is unavailable |
| A tunnel or forwarded port | `serve --host --allow-host`, as in v1 |

In every case the agent applies ops through the same command registry, and the project file plus versions
stay the one truth.

## 7. Phone first

- **Layout:** the scene cards are a vertical story feed (one column, full width, 9:16 cards for Shorts).
  The composer sits at the bottom like a messaging app and rises above the keyboard. There is no bar over the
  canvas: undo and versions sit in a slim top bar.
- **Gestures:** tap plays, long-press pins a note, swipe a card left to see its notes, pinch out to the
  timeline (horizontal, with the main track large and other tracks as thin lanes), two-finger scrub, and pull
  down to see versions.
- **Context-aware composer:** a note is attached to whatever is in view or selected (the scene in the middle
  of the screen, or the playhead's time). The chip above the composer shows the target ("on Scene 2 · 0:04")
  and can be tapped to change it.
- **Performance budget:** first paint under 1 s on a mid-range phone, 60 fps scrolling with 50 scenes, and
  stills as small JPEG/WebP thumbnails (`thumb` 270 px) with lazy loading.
- **Touch targets** are at least 44 px. Safe areas, the keyboard and Dynamic Type are respected, and it works
  in one hand.

## 8. Architecture changes

| keep | change | remove |
|---|---|---|
| server, SSE and polling, CSP, Host checks, export bundle | board ops become project commands (`note.add`, `note.set`, `question.ask`, `question.answer`, `version.make`, `version.restore`) in `src/core/commands` | `video.board.json`, the board model's separate schema and history |
| `src/board/shared` drawing (scene cards and sketches) | the page: composer, semantic-zoom canvas, scene cards, timeline view, palette, version strip | side panel, brief form, rounds UI, tool bar |
| console `window.mgl`, outline mirror | `mgl board` becomes a thin verb: `serve`, `show`, `ask`, `say`, `version`, `export` | `round.*`, `brief.*` and the panel-only ops (migrated to notes) |
| advice engine | it now writes questions to the board instead of a list | the "Next" tab |

## 9. Evals for v2 (run along the way)

- **Beginner first run** (Playwright, phone viewport 390×844, touch emulation, a scripted beginner): it must
  take under 60 s and 5 taps to go from an empty board to a watchable draft (the agent's side is scripted).
  There must be no dead ends, and every hint must be shown at most once.
- **Professional speed:** common edits by keyboard and palette only (split, trim, move a note, restore a
  version), with a step count and timing compared against v1.
- **One truth:** a CLI `mgl edit` appears on both views within 300 ms, a timeline trim moves the attached
  notes, and the board and the timeline never disagree (a property test over random command sequences).
- **Versions:** restore, branch into choices, and preview a choice without touching the main line. History
  survives a crash mid-write. Working without git and inside a git repo both work, and the person's branch
  and index stay untouched.
- **Phone quality:** fps with 50 scenes, first paint, no horizontal overflow at 320–430 px, 44 px targets, and
  the keyboard never covers the composer.
- **Agent ergonomics:** Claude Code and Codex each run a collaboration scenario through the CLI only and
  through the browser console only, with the same alignment and economy graders as v1 (questions asked before
  spend, choices previewed, notes answered).
- **Taste:** a vision judge scores screenshots of both views on phone and desktop against a rubric (hierarchy,
  calm, legibility, delight), with a target of at least 8 out of 10.

## 10. Build order

1. **Data and saving:** `notes`, `intent` and the commands; op log; versions (git plumbing plus a fallback
   store); migration from v1. Unit tests and the version eval.
2. **Views:** scene derivation, the board view, the timeline view, semantic zoom, the composer, and question
   cards with choices. Phone first, then desktop.
3. **Unlocks and professionals:** hints, the palette, keys, the version strip, and sketches.
4. **Transports:** check the Artifact shared-state route; keep local SSE and export.
5. **Evals and polish:** the evals in §9 at each step. Fix until they pass, then a taste pass.

## 11. Open decisions for the owner

1. **Notes in the project file** (this plan) or in a sibling file the views load together. A single file means
   no link and one version history. The cost is a longer project file: notes are one line each, and
   resolved notes can be folded into versions. **Recommended: in the project file.**
2. **Versions in git** (a private ref when the folder is a repo) with the built-in store as the fallback. The
   alternative is always using the built-in store. **Recommended: git when present.**
3. **Sketch tools in v2:** kept behind the palette (this plan), or dropped until someone asks.
