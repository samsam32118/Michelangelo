# Board: a shared canvas for a person and an agent making a video

Status: design for the first build (2026-10-09). Owner: samsam32118. Decisions marked **(R)** are reversible and
were taken without asking.

## 1. Why

Rendering video costs CPU minutes, and an agent can't watch video. Today an agent guesses what the person wants,
renders a full video, and learns it guessed wrong. The board is an infinite canvas, served by `mgl board` and
opened in the person's own browser, where a person and an agent:

1. **agree on the intent** before spending anything (a brief: goal, audience, tone, references, must-haves,
   things to avoid, what success looks like);
2. **think in cheap material first**: notes, sketches, arrows, reference images, then stills of the real project
   (milliseconds each), then a contact sheet, then a draft render, then the final render. This is the
   **fidelity ladder** (§4). Each step up costs more, and the board shows what each step costs and what it
   has cost so far;
3. **work in rounds**: each round has a goal and a fidelity. The agent proposes 2–3 options with explicit
   tradeoffs (cost, risk, taste). The person chooses, or pins feedback on a frame. The decision is recorded,
   and only then does the work move up the ladder;
4. **point at things**. The person pins a comment on a still at a time. The agent reads it with the clip ids
   visible at that time, and resolves it with a reply that says what changed.

The outcome we judge it by: videos that match what the person meant, with taste, for less CPU and fewer wasted
renders (DESIGN §17).

The board is a **clean-room** build inspired by infinite-canvas whiteboards such as tldraw. Only the concepts are
borrowed: an infinite canvas, shapes, frames, arrows bound to shapes, a tool bar, and an editor API that is
reachable from the browser console. No code was read or copied, and nothing is a dependency. LESSONS.md records
the borrowed ideas.

## 2. Constraints from the repository

- **No browser in the package (R6).** Nothing in the package starts, bundles or needs a browser. `mgl board
  serve` is a plain `node:http` server. The page it serves is optional, and the person opens it in their own
  browser. Every board feature an agent needs also works without a browser: `mgl board show`, `edit`, `view`,
  `snapshot` (the snapshot is drawn by Skia, so the agent can look at the board as a PNG). **(R)**: this reading
  of "no browser" (the package never runs one) is recorded in DESIGN §18.
- **No new runtime dependencies.** The page is hand-written TypeScript compiled to ESM with no bare imports and
  served as-is: no bundler, no framework.
- **One API, three doors.** One set of board ops (§5), reached by `mgl board edit` (CLI), `POST /api/ops`
  (HTTP, which the page uses), and `mgl.op(...)` in the browser console. Ops are validated and undoable in the
  same way as project commands.
- **The file is the truth.** `<name>.board.json` sits next to `<name>.mgl.json`. It is written one entity per
  line, ids come first, defaults are omitted, and it holds no derived data. Stills, sheets and renders are
  caches in `.mgl/board/`, keyed by project content plus the request.
- **Small output.** CLI output is ≤ 40 lines, every subcommand takes `--json`, and exit codes are 0/1/2.

## 3. The file

```json
{"michelangeloBoard": 1, "project": "video.mgl.json",
"brief": {"goal": "30 s Short that makes people try the 2-minute focus trick", "audience": "students, 16-24", "platform": "shorts", "length": "30s", "tone": ["calm", "warm"], "mustHave": ["the trick in the first 3 s"], "avoid": ["stock-photo look"], "success": ["a viewer could do the trick after one watch"], "budget": {"cpuMin": 10}},
"shapes": [
{"id": "f-brief", "type": "frame", "x": 0, "y": 0, "w": 900, "h": 600, "label": "Brief"},
{"id": "n1", "type": "note", "x": 40, "y": 60, "text": "Open on the phone going into a drawer", "color": "yellow", "by": "human", "parent": "f-brief"},
{"id": "s1", "type": "still", "x": 1000, "y": 60, "w": 270, "t": "0s", "fidelity": "thumb", "by": "ai"},
{"id": "a1", "type": "arrow", "from": "n1", "to": "s1", "label": "becomes"},
{"id": "p1", "type": "pin", "target": "s1", "u": 0.5, "v": 0.2, "text": "title too small", "by": "human"}
],
"rounds": [
{"id": "r1", "goal": "pick the opening", "fidelity": 1, "status": "decided", "options": [{"id": "r1a", "title": "Drawer close-up", "shapes": ["s1"], "tradeoffs": "strong hook; needs a new shot", "cost": "0.2 s"}], "chosen": "r1a", "why": "the hook is the trick itself"}
],
"log": [
{"id": "m1", "by": "ai", "text": "Brief drafted; two questions on tone in the Brief frame.", "at": "2026-10-09T10:00:00Z"}
],
"spend": [
{"id": "c1", "level": 1, "what": "still s1 thumb", "ms": 180, "round": "r1"}
]
}
```

- Tables (`shapes`, `rounds`, `log`, `spend`) hold one entity per line. `brief` is a single line. Order in
  `shapes` is the z-order (later = on top).
- The `project` path is relative to the board file. A board without a project is allowed: sketching before any
  media exists.
- Ids follow the project's rules (`[a-z0-9][a-z0-9_-]*`, readable, generated short: `n3`, `s4`, `r2`).
- Unknown keys are errors with did-you-mean, the same as in the project file.

### 3.1 Shapes

Every shape has: `id`, `type`, `x`, `y` (board px, top-left), optional `w`, `h`, `rot` (degrees), `parent`
(a frame id; x/y stay absolute **(R)** so a hand edit never has to know the parent's origin), `label`, `color`
(a palette name: `yellow`, `blue`, `green`, `red`, `violet`, `grey`, `black`, `white`), `by` (`human` | `ai`),
`locked`, `tags`.

| type | extra fields | default size | notes |
|---|---|---|---|
| `frame` | — | 800×500 | a titled region; moving it moves its children |
| `note` | `text` | 200×200 | sticky note |
| `text` | `text`, `size` (px, 24) | auto | free text |
| `rect`, `ellipse` | `text`, `fill` (`none`/`solid`/`tint`) | 200×120 | geo shapes with a centred label |
| `arrow` | `from`, `to` (a shape id or `[x, y]`), `text` | — | bound ends follow the shapes they point at |
| `draw` | `points` (`[[x, y], ...]` relative to x/y) | — | freehand |
| `image` | `src` (a path relative to the board file) | from the file | references, mood |
| `still` | `t` (a time in any edge form of DESIGN §3), `comp`, `fidelity` (`thumb` 270 px, `half`, `full`) | 270×(by aspect) | a frame of the linked project, rendered lazily and cached; shows the timecode and which clips are visible |
| `timeline` | `comp`, `from`, `to` | 1200×160 | a live strip of the project's tracks and clips |
| `pin` | `target` (a shape id), `u`, `v` (0..1 within the target), `text`, `status` (`open` / `resolved`), `reply` | — | feedback pinned to a point on a shape |

A shape's kind is a module (`src/board/shapes/<type>.ts`) that has a schema, defaults, bounds and a `draw(ctx,
shape, env)` written against the Canvas 2D subset in `src/board/shared/canvas.ts`. The page draws with the
browser's canvas and the snapshot draws with Skia, so the **same draw code** runs in both. New shape types
are added by registering one more module.

### 3.2 Brief

The brief has these fields, all optional strings or lists of strings: `goal`, `audience`, `platform`, `length`,
`tone[]`, `references[]` (shape ids or paths), `mustHave[]`, `avoid[]`, `success[]`, `questions[]` (open
questions the agent is asking the person), and `budget: {cpuMin?, maxLevel?}`.

### 3.3 Rounds

A round has these fields: `id`, `goal`, `fidelity` (0–4), `status` (`open` | `proposed` | `decided` |
`dropped`), `options[]`, `chosen`, `why`, and `notes`. An option has `id`, `title`, `summary`, `shapes[]` (the
shapes that show it), `tradeoffs` (free text: what this costs, risks, gives up), `cost` (the estimated cost of
making it real at the next level), and `taste` (why it is good, not just correct).

## 4. Fidelity ladder and spend

| level | name | what it makes | typical cost (1080×1920, 4 vCPU) |
|---|---|---|---|
| 0 | sketch | board shapes only | free |
| 1 | frames | stills of chosen times (`thumb` or `half`) | 0.05–0.5 s each |
| 2 | sheet | `look`: a contact sheet, QA findings and a sound report | 2–10 s |
| 3 | draft | a draft render of a range or of the whole video (half size) | ≈ 0.3–2.5× real time |
| 4 | final | the final render | ≈ 1–3× real time |

Every render the board makes (a still, a sheet, a draft, a final) appends a `spend` row with the measured
milliseconds. Before levels 3 and 4, `mgl board render` prints the estimate first, using the same estimator as
`mgl render`.

## 5. Ops

Ops are plain JSON objects (`{"op": "shape.add", ...}`), validated with zod, applied atomically in a batch, and
undoable (`.mgl/board-history.jsonl`, using the same scheme as the project history).

| op | fields |
|---|---|
| `shape.add` | `shape` (a shape without an id gets a generated one) |
| `shape.set` | `id`, `props` (a partial shape; `null` removes an optional key) |
| `shape.remove` | `id` or `ids` (removing a frame removes its children; arrows bound to a removed shape keep their last point) |
| `shape.move` | `ids`, `dx`, `dy` (moving a frame moves its children) |
| `shape.order` | `ids`, `to`: `front` / `back` / `forward` / `backward` |
| `brief.set` | any brief field (lists are replaced; `add` / `remove` with a list field append / remove items) |
| `round.open` | `goal`, `fidelity`, optional `id` |
| `round.option` | `round`, `option` (`title` required) |
| `round.decide` | `round`, `chosen`, `why` |
| `round.set` | `round`, `props` (`status`, `notes`, `goal`, `fidelity`) |
| `pin.add` | `target`, `u`, `v`, `text` |
| `pin.resolve` | `id`, `reply` |
| `say` | `text` (appends to `log`; `by` comes from the caller) |
| `still.add` | `t`, optional `comp`, `fidelity`, `x`, `y`, `parent` (placed next to the last still when x/y are omitted) |
| `storyboard.make` | `frame` (a new frame label, default `Storyboard`), `every` (a time) or `cuts: true`, `fidelity` (lays out stills in a grid inside a new frame) |
| `spend.add` | `level`, `what`, `ms`, `round` (written by the server and CLI after renders; allowed by hand) |

Every op carries `by` (`human` | `ai`) from its door: the page sends `human`, and the CLI and console default
to `ai` (`--by human` overrides).

## 6. The doors

### 6.1 CLI (`mgl board ...`)

| subcommand | does |
|---|---|
| `mgl board serve <file> [--port 4477] [--host 127.0.0.1]` | starts the server and prints the URL; writes `.mgl/board/server.json` (`{port, pid, url}`) so other subcommands find it. Long-running: agents run it in the background |
| `mgl board show <file>` | ≤ 40 lines: the brief (and what it lacks), the current round and its options, open pins (with the clips visible at each pin's time), the spend against the budget, what the person is looking at (when a server runs), and **next**: the advice of §7 |
| `mgl board edit <file> <op> [k=v ...] \| '<json>' \| --batch f.jsonl [--dry-run] [--by human]` | applies ops; `undo` / `redo` |
| `mgl board view <file>` | what the person sees right now: viewport, selection, the shapes in view, and the last 5 log lines (needs a server) |
| `mgl board focus <file> <id...>` | moves every open page's camera to the shapes and highlights them (needs a server) |
| `mgl board say <file> "text"` | a `say` op; it also appears as a toast on the page |
| `mgl board snapshot <file> [-o board.png] [--frame id] [--ids a,b]` | draws the board (or a frame) with Skia, with stills rendered, long edge ≤ 1568 px |
| `mgl board render <file> --level 1..4 [--ids s1,s2] [--range a-b]` | climbs the ladder: renders stills, a sheet (look), a draft or the final; records spend; prints the estimate first for 3–4 |

`<file>` may be the project file or the board file. `mgl board show video.mgl.json` uses `video.board.json`
and creates it (with an empty brief) if it does not exist.

### 6.2 HTTP (served by `mgl board serve`, 127.0.0.1 only by default)

| route | |
|---|---|
| `GET /` | the page |
| `GET /app/<path>.js` | page modules (compiled from `src/board/client` and `src/board/shared`) |
| `GET /api/state` | `{board, version, project: Outline \| null, view}` |
| `POST /api/ops` | `{ops, by}` → `{ok, version, changed[]}` or `{ok: false, error: {code, message, fix}}` (status 400) |
| `POST /api/undo`, `POST /api/redo` | |
| `GET /api/events` | Server-Sent Events: `state` (`{board, version}` after every change, whatever the door), `project` (an outline after the project file changes), `view` (presence: `{by, camera?, selection?, cursor?}`), `focus` (`{ids}`), `toast` (`{by, text}`) |
| `POST /api/view` | `{by, camera?, selection?, cursor?, inView?}` presence from a page (or from an agent: `by: "ai"`) |
| `GET /api/view` | the last presence of each party |
| `GET /api/still?t=&comp=&w=` | a PNG, cached; `X-Mgl-Cost-Ms` header; appends spend when it was not a cache hit |
| `POST /api/render` | `{level, ids?, range?}` → `{ok, files[], ms, estimate?}` |
| `GET /files/<path>` | files under `.mgl/board/` (sheets, drafts) |

The server watches both files. A hand edit, or a `mgl edit` on the project, reaches every page within ~300 ms.

### 6.3 Browser console (`window.mgl`)

Typing `mgl.help()` in the console prints the API. Every call returns a Promise of plain JSON.

```js
mgl.help()                          // this list
mgl.state()                         // {board, project, view}
mgl.op({op: 'shape.add', shape: {type: 'note', x: 0, y: 0, text: 'hi'}})   // any op; mgl.ops([...]) for a batch
mgl.note('text', {x, y, color}), mgl.text(...), mgl.rect(...), mgl.arrow(fromId, toId, {text})
mgl.still('2.5s', {fidelity: 'half'}), mgl.storyboard({every: '3s'})
mgl.brief({goal: '...'}), mgl.round('pick the opening', 1), mgl.option('r1', {title, tradeoffs, shapes})
mgl.decide('r1', 'r1a', 'why'), mgl.pin(targetId, u, v, 'text'), mgl.say('text')
mgl.select(['n1']), mgl.selection(), mgl.focus(['s1']), mgl.camera({x, y, zoom})
mgl.find({type: 'still'}), mgl.get('n1'), mgl.undo(), mgl.redo()
mgl.snapshot()                      // PNG data URL of the viewport
mgl.timeline()                      // the project outline
```

Calls made from the console are tagged `by: "ai"` by default (`mgl.as('human')` switches). This is the door
for an agent that drives a browser (Playwright, a browser extension, a browser pane), and the console door
and the CLI door see the same state.

## 7. Advice: keeping the person and the agent aligned

`advise(board, outline) → Advice[]` is a pure function, shown as **next** in `mgl board show` and in the
page's side panel. Each piece of advice has a `level` (`ask` | `do` | `wait` | `warn`) and one line. These
are the rules:

- The brief has no goal, audience or success criteria → `ask` the person (it names the missing fields). No
  draft or final render until the goal and the success criteria exist.
- `brief.questions` is not empty → `ask` (it lists them).
- An open round has fewer than 2 options → `do`: propose alternatives with tradeoffs. An option without
  `tradeoffs` → `do`: say what it costs and what it gives up.
- A round is `proposed` → `wait` for the person's choice. Do not climb the ladder.
- Open pins → `do` (each pin with its time and the clips visible there).
- A request for level N + 2 or more with nothing decided at level N + 1 → `warn` (skipping rungs wastes
  renders).
- Spend > 80 % of `budget.cpuMin` → `warn`.
- The last log message is from the person and has no reply → `do`: answer it.

The skill section (SKILL.md → "Working with a person on the board") teaches the loop: brief → round at
level 0/1 with 2–3 options and tradeoffs → wait → decide → climb → pins → resolve → repeat. It also says to
talk about tradeoffs and taste, not only about correctness.

## 8. The page

The page is one `index.html` with a full-window `<canvas>`, a top-left tool bar, a right panel (tabs: Brief,
Rounds, Chat, Next), and a bottom timeline strip of the linked comp with a scrubbable playhead that shows a
still preview. The page has no framework, and the DOM is built by hand.

- Tools and keys: select `V`, hand `H` (or hold space), note `N`, text `T`, rect `R`, ellipse `O`, arrow `A`,
  draw `D`, still `S` (click on the board to place a still at the playhead time), pin `P`, frame `F`.
- Editing: delete or backspace, ⌘/Ctrl-Z and ⌘/Ctrl-Shift-Z, ⌘/Ctrl-D (duplicate), ⌘/Ctrl-A, arrow keys
  (nudge 1 px, or 10 px with Shift), double-click to edit text, drag to marquee-select, Shift-click to add to
  the selection, resize handles on the selection box, wheel or pinch to zoom at the cursor, ⌘/Ctrl-0 (fit).
- Collaboration: each op flashes an outline on the shapes it changed, coloured by who made it (human: blue,
  AI: violet). The AI's presence shows as a labelled cursor. Toasts show `say` messages. `focus` animates
  the camera.
- Option cards in the Rounds tab have **Choose** and **Comment** buttons. Choose sends `round.decide` with
  `by: "human"`.
- Every change goes through `POST /api/ops`. The page applies the change optimistically and then reconciles
  with the server's `state` event.

## 9. Code layout (ownership: `src/board/`, plus `src/cli/board.ts`)

```
src/board/shared/   no imports outside this folder, no Node, no DOM: types, palette, geometry, canvas subset,
                    shape modules (schema-free defs + draw), ids. Compiled for both Node and the browser
src/board/model/    zod schemas, load/format/save, ops + history, advice (Node)
src/board/server/   http server, SSE, file watching, stills/sheets/renders through the SDK, snapshot (Skia)
src/board/client/   the page (DOM types via tsconfig.board-client.json); compiled to dist/board/client
src/cli/board.ts    the `board` verb
```

## 10. Evaluation

- **Unit** (`tests/unit/board-*.test.ts`): format round-trip, ops and undo, advice rules, a server end to end
  on port 0 (ops, SSE, still, view), a snapshot PNG that is not blank, and a test that `src/board/shared`
  imports nothing outside itself.
- **Browser end to end** (`evals/board/e2e.mjs`, not a package dependency: it uses a Playwright found on the
  machine and the preinstalled Chromium). It drives the page with the mouse and keyboard as a person would,
  and through `window.mgl` as an agent would, and checks that both doors and the CLI agree.
- **Collaboration scenarios** (`evals/board/scenarios/`): a brief plus a scripted person (their answers and
  pins live in the fixture and are released as the agent asks). Graders score alignment (brief complete
  before level 3, every round with ≥ 2 options with tradeoffs, every pin resolved with a reply, decisions
  recorded), economy (spend before the first decided round, renders skipped), and the outcome (the final
  render passes the task's objective checks, plus a vision score).
