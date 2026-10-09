# The board: deciding a video together before rendering it

Rendering costs minutes, and an agent cannot watch video. The board is an infinite canvas next to the project
(`video.board.json` beside `video.mgl.json`) where the person and the agent agree on what the video should be, and
spend renders only on what they have agreed. It works without a browser (`mgl board show`, `edit`, `snapshot`);
`mgl board serve` adds a page for the person, opened in their own browser. Design: `docs/plans/BOARD.md`.

## The loop

1. **Brief first.** Goal, audience and what success looks like (plus tone, must-haves, things to avoid, a render
   budget). Ask the person; put open questions in `brief.questions`. No draft or final render without a goal and
   success criteria (`mgl board render --level 3` refuses; `--force` overrides).
2. **A round per decision**, at one rung of the ladder: 2–3 options, each with **tradeoffs** (what it costs, risks
   and gives up), a **cost** (to make it real at the next rung) and **taste** (why it is good, not only correct).
3. **Wait.** A round with 2 options is `proposed`. The person chooses (Choose on the page, or tells you); record it
   with `round.decide ... why=...`. Do not climb while a round is proposed.
4. **Climb one rung** after a decision. Skipping rungs is warned about: it wastes renders.
5. **Pins.** The person pins feedback on a still. `mgl board show` lists each open pin with its time and the clips
   visible there. Fix it, then `pin.resolve` with a reply that says what changed.
6. **Show the spend.** Every render adds a `spend` row; `show` compares it with the budget. Price a draft or final
   before committing to it: `mgl board render <file> --level 3 --dry-run` prints the estimate and the share of the
   budget, renders nothing and records no spend. Tell the person the cost, then render.
7. **Answer by id.** `show` lists every message of the person no agent message has answered. A reply typed within a
   second of their message is not counted as an answer; name what you answer: `say "..." re=m4` (or `re=m2,m4`).
8. **One shared history, two parties (undo by party).** Every step records who made it. `undo` takes back your own
   latest step; when the newest step is the person's, it is refused (`E_UNDO_OTHER`) unless `--force` (the page's
   undo works the same way for the person). `edit history` shows who made each step, and `show` lists what the
   person changed since your last op.

`mgl board show` ends with **next:** lines (ask / warn / do / wait) computed from the board: follow them.

## The fidelity ladder

| level | name | makes | typical cost |
|---|---|---|---|
| 0 | sketch | notes, arrows, frames, references | free |
| 1 | frames | stills at chosen times (`thumb` 270 px, `half`, `full`) | 0.05–0.5 s each, cached |
| 2 | sheet | `mgl look`: a contact sheet, QA findings, a sound report | 2–10 s |
| 3 | draft | a half-size draft render of a range or the whole video | ≈ 0.3–2.5× real time |
| 4 | final | the final render | ≈ 1–3× real time |

The board's `project` field links it to its project (a path relative to the board file, written when the board is
created through `video.mgl.json`; edit it by hand to re-link). Stills, the timeline strip and pin contexts render from
it; a board without one is for sketching.

Stills are cached by project content (the project file and the size and time of every media file it references),
comp, frame and width, so asking again is free until something they show changes. Spend rows are a ledger: they
are not undo steps, and undo keeps them. Spend is measured **wall-clock** render time (`ms` per row), so the budget
key `budget.cpuMin` (named so for compatibility) means **wall-clock minutes of rendering**, not CPU minutes: on a
4-core machine a draft uses more CPU time than it takes.

Every rung that was paid for shows on the board: `render --level 2` adds the contact sheet as an image (labelled
with its QA summary and the round), and levels 3 and 4 add a poster still labelled with
`/files/renders/<name>.mp4`, where the page and the person can watch it (`HEAD` works too). After the final render,
**next** says to share it and ask the person to approve it, not to climb again.

**Variants: options pictured side by side.** Make the option as a sibling project (`mgl new shorts ... -o
calm.mgl.json`, or a copy changed with `mgl edit`), then `still.add 1s project=calm.mgl.json` (and `project=` on the
round option). Variant stills go through the same cache, captions and spend as the main project's.

## CLI

`<file>` is the project (`video.mgl.json`, whose board is `video.board.json`, created on first use) or the board
file. Every subcommand takes `--json`; `mgl board` alone prints the guide.

| command | does |
|---|---|
| `mgl board show <file>` | brief and its gaps, the current round and options, open pins with clips, spend vs budget, next |
| `mgl board edit <file> <op> [k=v ...]` | one op; also `'<json>'`, `--batch ops.jsonl` (atomic), `--dry-run`, `--by human`, `undo [n] [--force]`, `redo [n]`, `history` |
| `mgl board serve <file> [--port 4477] [--host h --allow-host name]` | the page and HTTP API; long-running (run it in the background) |
| `mgl board view <file>` | what the person sees now: camera, selection, shapes in view, last log lines (needs serve) |
| `mgl board focus <file> <id...>` | moves every open page to those shapes (needs serve) |
| `mgl board say <file> "text"` | a chat line; a toast on the page |
| `mgl board snapshot <file> [-o b.png] [--frame id] [--ids a,b]` | the board as a PNG drawn by Skia, long edge ≤ 1568 px |
| `mgl board export <file> [-o b.html]` | one offline HTML file, stills embedded; edits there are queued as JSONL |
| `mgl board render <file> --level 1..4 [--ids s1,s2] [--range a-b] [--dry-run] [--force]` | climbs the ladder; prints the estimate first for 3–4; records spend; `--dry-run` prices it only. Refused without `--force`: 3–4 before goal and success, a level above `budget.maxLevel`, an estimate over the budget left |
| `mgl board help <sub>` (or `mgl board <sub> --help`) | one subcommand's flags and an example |

Ops (`k=v` like `mgl edit`; dotted keys nest, `ids`/`shapes`/`tags` split on commas, `null` removes a key):
`shape.add <type>`, `shape.set <id>`, `shape.remove <id>`, `shape.move ids= dx= dy=`, `shape.order ids= to=`,
`brief.set` (`add.tone=bold` appends, `remove.avoid=...` removes), `round.open <goal> fidelity=`,
`round.option <round> title= tradeoffs= cost= taste= shapes=`, `round.decide <round> chosen= why=`,
`round.set <round> status=`, `pin.add <target> u= v= text=`, `pin.resolve <id> reply=`, `say <text> re=m4`,
`still.add <t> fidelity= project=variant.mgl.json`, `storyboard.make every=3s` (or `cuts=true`), `spend.add`. Shapes: `frame`, `note`,
`text`, `rect`, `ellipse`, `arrow` (`from`/`to` a shape id or `[x, y]`), `draw`, `image` (`src` next to the board),
`still` (`t`, `comp`, `fidelity`), `timeline`, `pin`.

## A session, end to end

The brief, a storyboard of stills, and a round with two options:

```sh
printf 'Most people waste their mornings. Here are three habits that changed mine.\n' > script.txt
mgl new shorts --script script.txt -o video.mgl.json
mgl board edit video.mgl.json brief.set goal="8 s Short that makes people try one morning habit" audience="students 16-24" success="a viewer can name the habit after one watch" tone=calm budget.cpuMin=5
mgl board edit video.mgl.json storyboard.make every=2s
mgl board edit video.mgl.json round.open "pick the opening" fidelity=1
mgl board edit video.mgl.json round.option r1 title="Bold hook" tradeoffs="loud and fast; may feel generic" cost="0 s" taste="type-led and confident" shapes=s1
mgl board edit video.mgl.json round.option r1 title="Quiet open" tradeoffs="matches the calm tone; a weaker hook" cost="0 s" taste="lets the habit speak" shapes=s2
mgl board say video.mgl.json "Two openings in round r1: bold or quiet?"
mgl board show video.mgl.json
```

The person decides and pins feedback (here typed for them with `--by human`); the agent resolves, renders the
stills, looks at the board and climbs to the contact sheet:

```sh
mgl board edit video.mgl.json round.decide r1 chosen=r1b why="calm matches the brief" --by human
mgl board edit video.mgl.json pin.add s1 u=0.5 v=0.3 text="title too small" --by human
mgl board edit video.mgl.json pin.resolve p1 reply="hook title is 1.3x larger"
mgl board render video.mgl.json --level 1
mgl board snapshot video.mgl.json -o board.png
mgl board edit video.mgl.json round.open "check pacing on the sheet" fidelity=2
mgl board render video.mgl.json --level 2
printf '{"op": "shape.add", "shape": {"type": "note", "text": "keep the calm open", "color": "green"}}\n{"op": "say", "text": "sheet is up"}\n' > ops.jsonl
mgl board edit video.mgl.json --batch ops.jsonl
mgl board edit video.mgl.json undo
mgl board show video.mgl.json
```

## The server and the page

`mgl board serve` is a plain `node:http` server on 127.0.0.1 (port 4477, or the next free one). It writes
`.mgl/board/server.json`, so `show`, `edit`, `say`, `view` and `focus` find it and send their ops through it (one
writer; the page updates at once). A hand edit of either file reaches the page within ~300 ms. Run it in the
background and give the person the URL:

```sh
mgl board serve video.mgl.json --port 0 --json > serve.json &
SRV=$!
trap 'kill $SRV' EXIT
for i in $(seq 50); do grep -q url serve.json && break; sleep 0.2; done
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("serve.json", "utf8")).url)')
curl -s "$URL/api/state" | head -c 120; echo
curl -s -X POST "$URL/api/ops" -H 'content-type: application/json' -d '{"ops": [{"op": "say", "text": "hello from curl"}], "by": "ai"}'; echo
curl -s -o still.png "$URL/api/still?t=1s&w=270"
mgl board say video.mgl.json "The board is open"
mgl board view video.mgl.json
mgl board focus video.mgl.json s1
```

| route | |
|---|---|
| `GET /` | the page (with a strict `Content-Security-Policy`); `GET /app/{client,shared}/<name>.js` its modules |
| `GET /api/state` | `{board, version, project, view, advice}` |
| `POST /api/ops` | `{ops, by}` (`by` defaults to `ai`; the page sends `human`) → `{ok, version, changed, created}`, or `{ok: false, error: {code, message, fix}}` (400; the browser console also logs that 400 as a network line) |
| `POST /api/undo`, `/api/redo` | `{n, by?, force?}`; with `by`, undo refuses the other party's step (`E_UNDO_OTHER`) |
| `GET /api/events` | Server-Sent Events: `state`, `project`, `view`, `focus`, `toast` |
| `GET` / `POST /api/view` | presence: `{by, camera?, selection?, cursor?, inView?}` |
| `POST /api/focus`, `/api/toast` | `{ids}`, `{by, text}` |
| `GET /api/still?t=&comp=&w=&project=` | a PNG, cached (`X-Mgl-Cache`, `X-Mgl-Cost-Ms`), at most the comp's width; a miss adds spend; `project` names a variant |
| `POST /api/render` | `{level, ids?, range?, dryRun?}` → `{ok, files, ms, shape?, summary?, estimate?}` |
| `GET` / `HEAD /files/<path>` | sheets and renders under `.mgl/board/` |

Only loopback Host names (and `--allow-host` names) are answered, a browser request that changes something must
come from the page's own origin, and a request another site's page makes (`Sec-Fetch-Site: cross-site` or
`same-site`, even a GET such as an `<img>`) is refused, except navigating to `/`. `--host 0.0.0.0` has no
authentication: use it only on a network you trust; the URL printed (and in `server.json`) stays
`http://127.0.0.1:<port>`, and from another machine you use this machine's name or your tunnel's, allowed with
`--allow-host`. The page carries a strict CSP (scripts and requests from the server only, no eval) and may be framed
only by loopback pages (any port) and `--allow-host` names. A stopped server (Ctrl-C, `kill`) exits 0.

The page: tools `V` select, `H` hand, `N` note, `T` text, `R` rect, `O` ellipse, `A` arrow, `D` draw, `F` frame,
`S` still at the playhead, `P` pin; a right panel (Brief, Rounds with **Choose**, Chat, Next), the ladder and spend
at the top, and a timeline strip of the comp with a scrubbable still preview. Changes flash in the colour of who
made them (person blue, agent violet).

## The console door (`window.mgl`)

An agent that drives a browser (Claude in Chrome, the Claude app's browser pane, Codex's browser, Playwright) uses
`window.mgl` in the page console. Every call returns a Promise of plain JSON; calls are by `ai` unless
`mgl.as('human')`. `mgl.help()` lists them all.

```text
await mgl.state()                                  // {board, version, project, view, advice, selection, camera}
await mgl.note('Open on the alarm', {color: 'yellow'})
await mgl.storyboard({every: '2s'})
await mgl.round('pick the opening', 1)
await mgl.option('r1', {title: 'Quiet open', tradeoffs: 'calm; weaker hook', cost: '0 s', taste: 'lets the habit speak', shapes: ['s2']})
await mgl.resolve('p1', 'hook title is 1.3x larger')
await mgl.focus(['s2']); await mgl.say('Round r1 is ready')
await mgl.find({type: 'pin', status: 'open'})
await mgl.op({op: 'shape.set', id: 'n1', props: {color: 'green'}})
```

Pages read by text (`get_page_text`, accessibility trees) get the whole board from a hidden
`#mgl-outline` section: every shape, the brief, rounds and next advice. Controls carry `data-mgl` names
(`tool-note`, `brief-goal`, `choose-r1b`).

## Using the board from Claude Code and Codex

Which way in depends on whether the person's browser can reach the machine `mgl` runs on.

- **Local session** (the agent runs on the person's computer): `mgl board serve <file> --port 0 --json > serve.json &`,
  give the person the URL (or open it in your browser pane), and drive it: `mgl board focus <file> s3` moves their
  view to what you are talking about, `mgl board view` tells you what they are looking at, and every CLI edit shows
  on the page at once.
- **Cloud session** (the Claude app's browser pane, or any browser on the person's computer, cannot reach a server
  the session started): `mgl board export <file> -o board.html` and publish the file as an Artifact, or send it.
  It is one offline page (one inline script, stills embedded, no requests), and it runs under an Artifact's CSP. The
  person's edits there queue: they press **Copy changes** and paste the JSONL to you, or you read it from the page.
  Save it as `changes.jsonl` and apply it as theirs: `mgl board edit <file> --batch changes.jsonl --by human`. Then
  export again to show the result.
- **Console door.** In any page with JavaScript access, `mgl.help()` returns the API as text; `await mgl.state()`
  gives the whole board; on an exported page `await mgl.pending()` returns the queued ops (`[{op, by}]`).
- **Reading the page as text.** `get_page_text`, `read_page` or `document.body.innerText` include the hidden
  `#mgl-outline` section: every shape (type, id, text, who, frame; stills with time and visible clips), open pins
  with their time, the brief, rounds with options and tradeoffs, the **next** advice, and, on an exported page, the
  queued changes as JSONL. `document.title` names the board and its open items (`Board · video · 1 open pin · 1 to
  choose`). Controls have labels (`getByLabel('Goal')`, `getByRole('button', {name: /choose/i})`) and `data-mgl`
  names.
- The page needs no `EventSource` (it polls when there is none), shows no dialogs, works from 360 px wide, and
  works in an iframe of a loopback page. `evals/board/agent-browsers.mjs` checks all of this in Chromium.

## For Codex and other agents

Running `mgl` from a source checkout in another folder: `tsx` must be found from the checkout, not from your work
folder, so give the loader as an absolute file URL:
`node --import file:///path/to/Michelangelo/node_modules/tsx/dist/loader.mjs /path/to/Michelangelo/src/cli/main.ts board show video.mgl.json`
(`node --import tsx ...` only works inside the checkout). A built package needs none of this: `mgl board ...`.

Everything works from a shell: `mgl board show` (read the **next** lines), `mgl board edit` (ops), and
`mgl board snapshot` (open the PNG with your image viewer to see the board). Start the server in the background
(`mgl board serve <file> --port 0 --json > serve.json &`), read the URL from `serve.json` and give it to the person;
the CLI then routes through it, so the person sees your edits live. If the person's browser cannot reach your
machine (a cloud session), write `mgl board export <file> -o board.html` and share the file: it runs offline with
the stills embedded; the person's edits queue, **Copy changes** copies them as JSONL, and you apply them with
`mgl board edit <file> --batch changes.jsonl --by human`. Talk with the person in terms of options, tradeoffs and
taste, wait for their choice, and climb the ladder one rung at a time.
