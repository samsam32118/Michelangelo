# Plan: the `storyboard` plugin: a script linked to the timeline (2026-10-08)

Status: **built** on branch `claude/storyboard-plugin` (2026-10-08). The owner's decisions on §10: approve
`ctx.run` (API 1.6), a Markdown storyboard, keep it in `examples/plugins`, no stock shots in v1. The plan below is
kept as approved. "As built" at the end says what changed while building it.

Judged against DESIGN §17: an agent that cannot watch or listen should make better videos for less. Rules from
CLAUDE.md hold: the schema is extended only additively (this plan needs **no** schema change), plugins use only
`michelangelo/plugin`, no GPL, no browser, `evals/heldout*/` is never opened.

## 1. The problem

Today a script reaches the timeline in two ways, and neither keeps the two linked:

- `mgl new --from script.txt` and `recipe.short` turn plain narration into a whole Short in one call. That is
  fast, but the script has no structure: one sentence becomes one background, picked in rotation. The agent
  cannot say "this line goes over the drone shot, put 'Step 2' on screen here, cut on the word *three*".
  The recipe also needs an empty comp, and it is built for vertical video.
- Hand-building: `clip.add` per shot, with the times worked out from `captions.from-speech` output. That costs
  many turns, and the link is lost once the clips are placed. When a line of the voice-over changes, or a
  re-recorded take runs 0.4 s longer, every later clip has to be moved by hand. Agents get this wrong, and they
  can't watch the result to notice.

A storyboard fixes both. Each **beat** in the script says what is heard (voice-over), what is seen (a shot) and
what is on screen (text). The plugin turns the beats into a timed timeline, records which clip came from which
beat, and later re-times those clips when the voice or the script changes.

**Who needs it:** explainers, product demos, tutorials, ads and documentary-style edits (any brief that comes
with a shot list or a two-column A/V script), in every aspect ratio.
**Cost lever:** one command instead of 20–60 `clip.add`/`clip.trim` calls. Re-sync in one command instead of
a hand re-time. A project-stage QA check that catches desync without rendering anything.

## 2. Shape

```
examples/plugins/storyboard/
  package.json        "michelangelo": { "api": "^1.6.0", "kinds": ["command", "check", "importer"] }
  src/index.ts        definePlugin({ name: 'storyboard', commands, checks, importers })
  src/parse.ts        storyboard text → Storyboard (zod), with line numbers in every error
  src/timing.ts       Storyboard + timing source → beat ranges in frames (pure, unit-tested)
  src/build.ts        beat ranges → commands / entities (tags + markers)
  src/sync.ts         diff of tagged entities vs. new ranges → moves/trims/adds/removes
  test/*.test.ts      parser, timing, build, sync, check
  evals/storyboard-basic/   meta.json + task.md (main-set format, §11)
  README.md
```

It is a project-named plugin (`"plugins": {"storyboard": "^1.0.0"}`), like `open-media` and `lower-third-pro`,
and not a built-in. Built-ins are effects, transitions and so on that every project needs. A storyboard is a way
of working that some projects use.

## 3. The storyboard file (source of truth for the script)

A Markdown sidecar, `<name>.storyboard.md`, next to the project. Markdown because agents edit it with exact
string replacement, people can read it, and it maps onto a two-column A/V script. A JSON form (same zod schema)
is accepted too, for SDK users.

```markdown
# Morning habits            ← title (optional)

## hook                     ← scene id (readable id rules, §4.1)
> Most people waste their mornings.
shot: media/alarm.mp4 in=2s
text: Stop wasting mornings | style=title

> Here are three habits that changed mine.
shot: gen:gradient #1e3c72 #2a5298
cut-on: three

## habit1
> First, no phone for the first hour.
shot: media/phone-drawer.mp4 motion=kenburns
shot: media/coffee.jpg                         ← two shots in one beat: split at the sentence's midpoint
text: 1. No phone | at=+0.3s
sfx: media/whoosh.wav | at=start
dur: min 2.5s
```

- A **beat** is one `>` line (the voice-over text), plus the directive lines under it, up to the next `>` or
  `##`. A beat with no `>` line is a silent beat; it needs `dur:`.
- Directives: `shot:` (a path, an asset id, `gen:<type> ...` or, with open-media, `stock:"query"`), `text:`,
  `sfx:`, `dur:` (fixed / min / max), `cut-on:` (a word in the line), `transition:`, `note:` (kept and ignored).
  Unknown directives are errors with a did-you-mean, as for the project file.
- Beat ids are generated and stable: `<scene>-<n>` (`hook-1`, `hook-2`). An author can pin one with `{#id}` at
  the end of the `>` line, so that inserting a beat does not renumber the ones after it in `sync`.

## 4. How the script is linked to the timeline (no schema change)

- Every clip the plugin makes is tagged `sb:<beat-id>` plus a role, `sb-role:shot|text|vo|sfx`. Tags already
  exist on clips.
- Every beat gets a **range marker**, `sb-<beat-id>` (`at`, `len`, `note` = the voice-over line). Every scene
  gets one too, `sbs-<scene>`. Markers with `len` already exist. So `mgl show` lists the script on the timeline,
  and `grep '"sb:habit1-1"'` finds a beat's clips.
- The storyboard path and a hash of its parsed form go into a marker note on `sbs-*` (or `project.notes`, if
  that exists), so `sync` and the check can tell when the file changed.

## 5. Timing (the core of "appropriately")

`src/timing.ts` is a pure function: (beats, word times or none, comp rate, options) → `[at, len]` per beat and per
shot, in integer frames. Word times come from the first source available:

1. **A voice made from the script.** `voice=<id|default>` speaks each beat through the speak provider
   (`audio.speak`), one clip per beat, so a re-take changes only that beat. Word times come from the stored
   timings.
2. **A recorded voice-over.** `vo=<clip|path>`: the whole script is aligned to the recording, using the
   transcribe provider if there is one, else `alignWords` on the loudness envelope (both API 1.4). Beats
   are matched to word spans.
3. **No voice.** Reading speed (`WORDS_PER_SECOND` = 2.6, as in `mgl new`), then the `dur:` limits.

Rules, each one unit-tested:

- A beat starts at its first word, minus `lead` (default 3 frames: the picture cuts just before the word), and
  ends where the next beat starts. So shots tile the track with no gaps. The last beat ends at the last word,
  plus `tail` (default 0.5 s).
- `dur: min/max` stretches a beat by holding on the picture (the voice is not moved; later beats shift) or
  trims it. A conflict is an error naming the beat and its line.
- `cut-on: <word>` puts a cut inside the beat on that word's onset, for a beat with two shots. Without it, two
  shots split at the nearest pause to the midpoint.
- `snap=beats`: cuts within ±4 frames of a `marker.beats` marker move onto it (music-led edits).
- A shot is never shorter than `minShot` (default 0.6 s); a shorter one is merged into its neighbour, with a
  note. Video shots are checked against the probed source length. If too short: loop, freeze or warn
  (`fit=` policy, default warn).
- Exact at 30000/1001: seconds go to frames once, through `ctx.time`; ranges are summed as integers.

## 6. Commands

| Command | What it does |
|---|---|
| `storyboard.apply file= [comp=] [voice=\|vo=] [tracks=new\|reuse] [lead= tail= minShot= snap=]` | Parse, time, build: shots on a picture track, text on a text track, voice and sfx on the dialogue and sfx buses, beat and scene markers, optional `captions.from-speech`. Works on a non-empty comp: it adds its own tracks and touches nothing untagged. Re-running it is the same as `sync`. |
| `storyboard.sync [file=]` | Re-parse and re-time, then diff against the tagged clips: move or trim clips whose beat moved, add clips for new beats, remove clips of deleted beats, re-speak only changed lines. Edits the agent made by hand to non-timing properties (`x`, `y`, `fx`, `style`, ...) are kept. Timing edits to tagged clips are reported, then overwritten (or kept with `keep=timing`). |
| `storyboard.retime beat= at=\|len=` | Move one beat and ripple the later beats, keeping every tagged clip in step. |
| `storyboard.detach [beat=]` | Remove the `sb:` tags (and markers) so that `sync` leaves those clips alone from now on. |

All of these are ordinary commands, so `--dry-run`, undo/redo and batches work with nothing extra. `ctx.out` returns
a beat table (`beat`, `frames`, `seconds`, `clips`, `words`) for the SDK. The summary prints it compactly, so the
agent can check the timing without rendering.

**Importer:** the `.storyboard.md` extension, so `mgl import p.mgl.json script.storyboard.md` gives
`[{op: 'storyboard.apply', file}]`.

## 7. QA check: `storyboard-sync` (project stage, so it runs in `mgl check` with no render)

- **error:** a tagged clip lies outside its beat's marker range (a hand edit desynced it). The fix is
  `mgl edit <file> storyboard.sync`.
- **warning:** the storyboard file changed since the last apply/sync (hash mismatch).
- **warning:** a gap or overlap in shot coverage on the storyboard's picture track; a text card shown for less
  time than its words take to read (`CUE_TIMING` reading speed); a beat whose voice runs past its shots.
- **info:** beats that have no shot. These fall back to the previous shot held, or a generator.

## 8. A small core addition: plugin API 1.6 (core/ and plugin/; needs the owner's OK)

A plugin command can't run other commands today. `lower-third-pro` writes entities by hand. `recipe.short`
uses an internal `step()` that plugins can't reach. Without it, the storyboard would have to copy `audio.speak`
(cache, timings, provider checks), `captions.from-speech`, `transition.set` and `clip.add`'s probing.

**Proposal (additive):** `CommandContext.run(cmd): Promise<{ summary, out }>`. It applies a nested command to
the same project, inside the same undo step, and validates it the same way. This is `recipe.ts`'s `step()`,
moved to the registry and exported. `PLUGIN_API_VERSION` goes 1.5.0 → 1.6.0. One test checks that a nested
command undoes as part of its parent. Other plugins (`lower-third-pro`, `collage-kit`) could use it later.

Fallback if this is declined: the plugin writes clips and markers directly (as `lower-third-pro` does) and calls
`ctx.services.speak` / `ctx.services.transcribe` itself. That is more code, it duplicates caching, and the
captions step is dropped (the agent runs `captions.from-speech` after it).

## 9. Build order

1. `parse.ts` + tests: the format, line-numbered errors, did-you-mean, stable beat ids.
2. `timing.ts` + tests: the three timing sources, lead/tail, min/max, cut-on, snap, NTSC exactness.
   (Pure: no project, no media.)
3. API 1.6 `ctx.run` in core (step 8), with its undo test.
4. `build.ts` + `storyboard.apply`: tracks, tags, markers, voice per beat, captions. Fixture test on a
   1920×1080 and a 1080×1920 comp; line-count budget (§4.2) kept.
5. `sync.ts` + `storyboard.sync` / `retime` / `detach`. Tests: idempotent (sync twice = no change), one line
   edited (only that beat re-spoken; later clips shifted), hand-moved `y` kept, beat deleted, beat inserted
   with pinned ids.
6. `storyboard-sync` check and the importer.
7. README, an entry in `mgl docs plugins`, the eval task `storyboard-basic` (a 6-beat explainer with a recorded
   VO: graded on cut times within ±2 frames of word onsets, text on screen during its beat, no gaps).
   Main-set format only.
8. Measure: run the eval with and without the plugin, compare against a hand-built baseline (turns, cost,
   cut accuracy), and record the result in "As built".

## 10. Decisions for the owner

1. **API 1.6 `ctx.run`** (§8): approve the small core change, or build the plugin without it? *Recommended:
   approve.*
2. **Format:** Markdown sidecar (recommended), JSON only, or also Fountain screenplay import (deferred to a
   later importer)?
3. **Location:** `examples/plugins/storyboard` (opt-in, recommended), or ship it as a built-in?
4. **Scope of v1:** include `stock:"query"` shots through open-media now, or later? *Recommended: later. Paths,
   asset ids and generators first.*

## Out of scope (v1)

Picking footage by content (that needs vision), Fountain/FDX import, multi-language versions of one storyboard,
and changes to `recipe.short`. A later step could have the recipe write a storyboard, so recipe Shorts become
syncable too.

## As built (2026-10-08)

- **Core, API 1.6.** `CommandContext.run(cmd, { note? })` runs a nested command. It is validated by the same code
  as `runCommand` (`parseCommand`, split out of it), is part of the caller's undo step, and returns the nested
  command's `out`. `fail` is exported from `michelangelo/plugin`. `runCommandOn` takes `services`, so plugin
  tests can use stand-in services offline.
- **Code removed by the same change.** `recipe.short`'s private `step()` and `optional()` sub-contexts, and
  `audio.cut-silences`' hand-made "quiet" context around `clip.split`, now use `ctx.run`. The `E_RECIPE` error
  is gone: a refused step now reports the real `E_ARG` of the command that refused it.
- **One file, tested through commands.** Example plugins are a single `src/index.ts`, and their tests import only
  `michelangelo/plugin` and `michelangelo/testing` (a test enforces this). So `parse.ts`/`timing.ts`/`build.ts`/
  `sync.ts` became sections of one file, and the tests drive `storyboard.apply` and read its beat table.
- **One command instead of two.** `storyboard.sync` is just `storyboard.apply` run again: the file and options are
  remembered in the `storyboard` marker. Re-speaking only the changed lines comes free from `audio.speak`'s cache.
- **Dropped:**
  - `storyboard.retime`: edit `dur:` in the file and apply again.
  - `snap=beats` and `keep=timing`.
  - `tail`: a recording's own end ends the last beat.
  - Pause-aware splitting of two shots: shots split evenly unless `cut-on:` names the words.
  - `storyboard.detach beat=`: detaching is all or nothing, because a re-apply would collide with the ids of a
    half-detached storyboard.
  - The importer: importers are registered, but no CLI verb calls them yet.
  - The "file changed since apply" warning: checks have no file access.
- **Text cards** default to the `title` style at 80 % of the frame width, as `mgl new --from` does.
- **Tests:** `examples/plugins/storyboard/test/storyboard.test.ts` covers:
  - reading speed, shot holds, markers and growing the comp;
  - speech per line: cut-on frames, re-speaking only the changed line, hand edits kept, the old voice asset
    dropped, and the check before and after;
  - a recording: lead-in silent beats, captions, and the silent-beat error;
  - parse errors with line numbers;
  - gap and readability findings, and detach.

  `tests/unit/commands-run.test.ts` covers `ctx.run`: one undo step, and nested validation.
- **Not done yet:** the eval task (`evals/storyboard-basic`) is written, but its fixtures and a with/without run
  (step 8) are still to do.
