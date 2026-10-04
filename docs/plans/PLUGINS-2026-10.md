# Plan: open media, svg-prop, cutout, safe-zone, laya plugins (2026-10-04)

Status: **proposal, awaiting the owner's go-ahead**. Nothing here is built yet.

Seven requests, judged against DESIGN §17 (cost per high-quality video for an agent in a CPU-only container that
cannot browse, watch or listen) and the rules in CLAUDE.md (additive schema, public plugin API only, no GPL, no
bundled assets, no browser).

| # | Plugin | Kind(s) | Needs from core (plugin API 1.3 → 1.4, additive) |
|---|---|---|---|
| 1 | `open-audio` | provider `stock` + command | `stock` provider kind; core `media.search` / `media.fetch` / `media.credits` |
| 2 | `open-video` | provider `stock` + command | same |
| 3 | `open-image` | provider `stock` + command | same |
| 4 | `svg-prop` | generator + command | generators may read an asset's bytes; opt-in device-resolution drawing |
| 5 | `cutout` | provider `segment` + command | `segment` provider kind; core `image.cutout` |
| 6 | `safe-zone` | checks + generator + command | `CheckContext.uiZones()` (the table already exists in `src/qa/safezones.ts`) |
| 7 | `laya` | provider `decide` + checks + commands | `decide` provider kind; `media.search rank=true` uses it when present |

All seven live in `examples/plugins/<name>/` (package.json, `src/index.ts`, tests via `michelangelo/testing`, an
eval task, README), like the existing seven.

---

## Why core changes are needed (and why they are small)

Today a plugin **command** cannot write a file into the project folder: `CommandContext` has no project dir and
`services.writeFile` only accepts `media/generated/*.wav`. A **generator** cannot read a file: `draw` gets params
and the frame, nothing else, and is rendered at its box size, then scaled as a raster. Those are the two gaps.

The pattern already exists: `audio.speak` is a core command, the TTS engine is a `speak` provider in a plugin
(`flite-voice`), and core owns the file confinement, caching and sidecar metadata. The new features follow it
exactly, so licence handling, paths and caching are written once and every provider stays a thin adapter.

All API changes are additive (minor bump to **1.4.0**); no schema field changes. New optional fields only.

---

## 1–3. open-audio, open-video, open-image

**Goal.** An agent can find, fetch and use openly licensed media without a browser, and the project always
knows each file's licence, author and source, so the deliverable can carry correct credits. No asset is bundled:
everything is fetched at run time into the project's `media/stock/`.

### Core (API 1.4)

```ts
interface StockProvider {
  kind: 'stock'; id: string; describe: string;
  media: ('audio' | 'video' | 'image')[];
  search(q: { kind; query; limit?; orientation?; minSeconds?; maxSeconds?; minWidth?; licences?: LicenceClass[] }):
    Promise<StockItem[]>;
  fetch(args: { item: StockItem; out: string }): Promise<void>;   // core gives a temp path inside media/stock/
}
interface StockItem {
  id: string;                 // provider-scoped, stable (e.g. "openverse:9f1c...")
  kind; title; url /* landing page */; file /* direct download */; ext;
  licence: { id: string /* "cc0" | "pdm" | "cc-by-4.0" | ... */; url: string };
  author?: string; authorUrl?: string; source: string /* "Wikimedia Commons" */;
  seconds?: number; width?: number; height?: number; bytes?: number; preview?: string;
}
```

Commands (core, group `media`):

- `media.search kind=audio query="rain on window" [limit=8 provider= orientation=portrait minSeconds= ...]`
  changes nothing; prints at most 8 numbered results, one line each (`id · title · 0:42 · 1920x1080 · CC BY 4.0 ·
  author`), full list in `.mgl/<p>/search.json`. Agents can't preview audio/video, so results also carry the
  facts that let them choose without one: duration, size, orientation, tags; images get a contact sheet
  (`.mgl/<p>/search.png`, thumbnails fetched from `preview`) the agent can look at.
- `media.fetch id=openverse:9f1c [as=rain] [track= at= len=]` downloads to `media/stock/<provider>-<hash>.<ext>`
  (reused if present), writes `<file>.json` (licence, author, title, url, fetched date, sha256), adds the asset with
  a `note` naming the licence, optionally adds a clip. Probes the file and refuses HTML error pages / wrong kind.
- `media.credits [out=credits.txt] [card=true]` writes the attribution lines (TASL: title, author, source, licence)
  for every stock asset in use, and with `card=true` applies the `end-card` template with them.

Licence policy, in core so all providers obey it:

| Class | Licences | Default |
|---|---|---|
| `free` | CC0, Public Domain Mark, US-gov PD (NASA) | allowed |
| `attribution` | CC BY 2.0–4.0 | allowed; `media.credits` required |
| `share-alike` | CC BY-SA | refused unless `licences=[...,share-alike]` (the whole video would inherit it) |
| `non-commercial` / `no-derivatives` | NC, ND variants | refused unless asked; ND is never allowed (editing *is* a derivative) |
| unknown | anything else | refused |

QA check `stock-credits` (built-in, project stage): a CC BY asset in use with no credits written → warning with
the fix `mgl edit <file> media.credits card=true`. Another, `stock-licence`: an asset whose sidecar licence is NC
when `project.settings.commercial` is true → error.

### The providers (keyless sources first; keys optional via env)

| Plugin | Sources, no key | Optional with a key |
|---|---|---|
| `open-audio` | Openverse audio (`api.openverse.org`, CC music/SFX from Jamendo, Freesound, Wikimedia), Wikimedia Commons (ogg/wav/flac) | Freesound (`FREESOUND_API_KEY`) for more SFX |
| `open-video` | Wikimedia Commons video (webm/ogv, transcodes picked by height), NASA Image and Video Library (US-gov PD), Internet Archive (only items with a PD or CC licence URL) | Pexels (`PEXELS_API_KEY`), Pixabay (`PIXABAY_API_KEY`) |
| `open-image` | Openverse images, Wikimedia Commons, NASA, Art Institute of Chicago (CC0 only) | Pexels, Unsplash (`UNSPLASH_ACCESS_KEY`) |

Reachability measured from this container (2026-10-04): Openverse, Commons, NASA and Internet Archive return 200;
Freesound and Pexels return 401 without a key (expected).

Each provider maps the source's licence strings to the canonical ids above and drops anything it cannot map
(fail closed). Sources with their own non-CC licence (Pexels, Pixabay, Unsplash) map to `free` with
`licence.id: "pexels"` etc. and the licence URL, since they allow commercial use without attribution, and they are
off unless their key is set. Requests send a `User-Agent: michelangelo/<v> (+repo url)` as Wikimedia and
Openverse ask. Results are cached in `~/.cache/michelangelo/stock/` for a day.

Tests use recorded JSON responses (a few KB each, API metadata only, no media) through an injected `fetch`; one
optional live test runs with `MGL_LIVE=1`. Fixture media for the fetch path is generated by ffmpeg in the test.

---

## 4. svg-prop

**Goal.** An SVG (logo, icon, sticker) becomes a layer that stays sharp at any scale and can be recoloured, instead
of being rasterised at decode size like today's `image` path (ffmpeg's svg decoder, then raster scaling).

### Core (API 1.4, both opt-in, nothing changes for existing generators)

- `GeneratorDef.assets?(params): string[]` — asset ids the generator reads (as `audioSource` already does for
  sound). The renderer resolves and confines the paths, reads each file once (cached by content hash) and passes
  `files: Map<assetId, Uint8Array>` to `draw`. `check` reports a missing asset with the usual fix. `draw` stays a
  pure function of (params, frame, seed, file contents).
- `GeneratorDef.resolution?: 'box' | 'device'` — `device` renders the generator surface at the layer's on-screen
  scale `k` (the same `k` media uses, capped by `MAX_SURFACE`) and passes `pixelRatio: k`; a scaled-up logo then
  is redrawn as vectors, not upscaled.

### The plugin

- Generator `svg-prop`: params `{ asset, fit: contain|cover|fill, color?, colors?: {"#1d1d1b": "#ffffff"},
  stroke?, strokeWidth?, opacity? }`. `color` recolours every fill and stroke (a one-colour icon); `colors` maps
  specific colours (a brand logo). Colour params are animatable like any other.
- Its own small SVG interpreter (no dependency): `svg`/`g`/`use`/`defs`, `path`, `rect` (rx/ry), `circle`,
  `ellipse`, `line`, `polyline`, `polygon`; `transform` (matrix/translate/scale/rotate/skew); presentation
  attributes, `style=""` and simple `<style>` class/element rules; `fill-rule`, opacity, stroke caps/joins/dash;
  linear and radial gradients; `viewBox` + `preserveAspectRatio`. Arcs converted to beziers. Parsed once per file
  hash. Unsupported features (text, filters, masks, clipPath, embedded raster `image`, CSS selectors beyond
  class/element) are **reported, not silently dropped**.
- Command `svg-prop.add file=logo.svg [id= track= at= len= width=]`: adds the asset and a clip sized from the
  viewBox, and prints the colours found (`#1d1d1b ×12, #e30613 ×3`) and any unsupported features, so the agent
  knows what `colors` to remap and whether to trust the result.
- Tests: a rect/circle/path SVG drawn at 1× and at 8× compared with an analytic edge (no blur ramp wider than
  1 px at 8×), recolour by `color` and `colors`, transforms, gradients, unsupported-feature report.

## 5. cutout

**Goal.** Remove a photo's background into a transparent PNG, and make it hard to keep a cut-out of the wrong
subject: the agent can't see the result unless it is shown one, so the command always produces a verdict sheet.

### Core (API 1.4)

- Provider kind `segment` (DESIGN §9.1 already lists segmentation as an AI hook):
  `segment({ file, out, model? }) → { mask: out /* 8-bit PNG */ }`.
- Command `image.cutout asset=photo [point=[x,y] | box=[x,y,w,h]] [expect="a brown dog"] [feather=1]` writes
  `media/generated/cutout-<hash>.png` (+ `.json` with engine, model, stats), adds it as an asset (and replaces
  the clip's asset with `swap=true`). Cached by (file hash, engine, model, point/box).

### The verdict sheet ("does this still show what I think it shows")

Written to `.mgl/<p>/cutout-<id>.png` and printed with the result, one image ≤ 1568 px wide for the agent's
viewer: original with the kept region outlined | mask | cut-out on a checkerboard | cut-out on black and on white.
With the stats in the result text and as warnings:

- foreground coverage (warn < 3 % or > 90 %: "almost nothing / almost everything kept");
- connected components; share of the largest (warn when the kept subject is split or a second large blob exists:
  "2 subjects of similar size; pick one with point=[x,y]");
- the kept region's box and centre (warn when the subject touches 2+ image edges: "cropped subject?");
- with `point`/`box`, only the component(s) under it are kept, which fixes the "wrong subject" case directly;
- `expect` is echoed at the top of the sheet so the reviewer (the agent, or a vision judge) compares the picture
  against the stated intent, and the result says "look at <sheet>; if it is not <expect>, re-run with point=".

### The plugin

- Provider `cutout` with engines, picked by `engine=auto|rembg|key`:
  - `rembg` (MIT; U²-Net / isnet / u2net_human_seg / birefnet models, MIT/Apache, downloaded by rembg itself on
    first use, never by us): runs the `rembg` CLI if on PATH (`rembg i -om -m <model> in out` for the mask);
    `mgl doctor` reports whether it is installed and the install line (`pip install "rembg[cli]"`).
  - `key` (zero downloads, deterministic): background estimated from the border pixels, flood-filled in Lab
    colour space with a tolerance, then cleaned (morphological open/close, small holes filled). Good for studio
    and plain backgrounds; the sheet makes its failures visible.
  - `auto`: rembg when available, else `key` with a note saying so.
- Tests: synthetic photos (a disc on a plain background, two discs, a subject touching the edges) for coverage,
  components, point selection and every warning; rembg mocked by a fake executable on PATH.

## 6. safe-zone

**Goal.** Catch captions **and stickers** under the TikTok, Reels or Shorts interface every time, without
relying on the project's `platform` setting.

Why v3 slipped through today: the built-in `text-outside-safe` only checks text and captions, only against the
one platform in `project.platform` (default `none` = 5 % title-safe margins), and only against the margin
rectangle, not the UI panels. The per-platform UI rectangles already exist (`uiZones` in `src/qa/safezones.ts`)
but no check uses them.

### Core (API 1.4)

- `CheckContext.uiZones(platform?)` → the named UI rectangles in comp px (exposes the existing table; one source
  of truth).

### The plugin

- Check `ui-overlap` (project stage, so it runs in `check` and `look`): for a vertical comp, tests every visual
  layer that is a caption, text, or a **sticker** (an image/svg-prop/generator/shape layer covering < 40 % of the
  frame, or tagged `sticker`) against the UI zones of **all three** platforms at every rest/sample frame, including
  every caption cue. One finding per clip naming the platforms and panels it hits:
  `caption cue "wait for it" (caps, 4.2s) sits under TikTok "caption and sound" and Reels "caption and audio" by
  86 px; fix: mgl edit <file> clip.set caps y=1418`. The fix moves into the intersection of the three safe
  areas (the strictest), and is checked to converge with `check --fix`.
  Severity: error for captions/text (unreadable), warning for stickers. Platforms configurable with
  `project.settings.safeZone.platforms` (default `["tiktok","reels","shorts"]`).
- Generator `safe-zone-guide`: draws the three platforms' UI panels as translucent outlines with labels, for
  stills and `look` contact sheets, so the agent sees what the check sees.
- Check `safe-zone-guide-left-on`: the guide generator is on an enabled track in the comp being rendered → error
  (it must not reach a final render).
- Command `safe-zone.fit [clips=...]`: moves every offending clip into the shared safe area in one undoable step.
- Tests: a caption at y = 1700 on 1080x1920 flagged for all three with a fix that clears them; a sticker in the
  TikTok action column flagged for TikTok only; a full-frame background not flagged; a moving crawl not flagged;
  horizontal comps skipped; guide-left-on fires.

---

## 7. laya (calibrated text decisions)

Source: [convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya), Apache-2.0 (weights and the
`laya` PyPI runtime, 0.3.27, Python ≥ 3.10, torch + transformers). It answers **typed questions** about a text
state (`choice` among labelled options, `score` on an ordered scale, `noul` yes/no) with calibrated probabilities,
in one forward pass, in 100+ languages; it never generates text. Measured by its authors: 193–464 ms per call
on CPU (the `Router`), 7.4 s to load a checkpoint, 421M params (English) / 322M (multilingual).

**Where it helps an agent making video.** An agent already *is* a language model, so laya earns its place only
where a cheap, calibrated, repeatable judgement over many small texts saves turns and tokens, or where the decision
must be the same on every run (QA). Three places do that:

1. **Ranking stock results it cannot preview (with 1–3).** An agent can't listen to 20 Openverse audio hits.
   `media.search rank=true` asks the `decide` provider, per result, how well its title, tags and description fit
   the query and an optional `brief` ("calm rain ambience, no music, no voices") and sorts by that probability,
   printed on each line (`p=0.91`). It also answers typed filters such as `has vocals?` from the metadata. Without
   a provider, `rank=true` is an error naming the fix; `media.search` without it is unchanged.
2. **Text guard QA (deterministic, every run).** Check `text-guard` (project stage): every on-screen text and
   caption cue is asked a fixed set of questions: profanity, slurs or harassment, sexual content, medical or
   financial guarantees ("cures", "guaranteed returns"), and calls to action that platforms limit. A finding above
   a threshold names the clip, cue, time, question and probability, with a fix (`clip.set <id> text=...` or
   `cue.set`). Thresholds and the question set are in `project.settings.textGuard`; it is a warning by default
   (calibrated, but zero-shot), error with `--strict`.
3. **Transcript-based editing.** `laya.tag-cues clip=<captions> [questions=...]` labels each cue of a
   transcribed talk (`captions.from-speech`) with a default set: `filler` (um, false start), `retake` (a
   repeated attempt at the previous line), `off-topic` against an optional `topic=`, and `hook` (score: how
   strongly it opens the video). It writes markers (`marker.add` with the label and probability) and prints a
   suggested cut list as ready-to-run `clip.split` / `clip.remove --ripple` commands. It never cuts by itself;
   the agent decides. A `laya.decide state="..." questions='{...}'` command exposes the raw provider for anything
   else (changes nothing, returns the answers).

### Core (API 1.4)

```ts
interface DecideProvider {
  kind: 'decide'; id: string; describe: string;
  decide(args: { states: (string | Record<string, unknown>)[];       // batched
                 questions: Record<string, DecideQuestion>; lang?: string }):
    Promise<Record<string, DecideAnswer>[]>;                          // one per state
}
type DecideQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string };
type DecideAnswer = { choice?: string; probs?: Record<string, number>; score?: number; noul?: number };
```

`services.decide` (first `decide` provider, like `speak`), answers cached in `.mgl/cache/decide/` by
(provider, model, state, questions), so `check` re-runs cost nothing for unchanged text.

### The plugin

- Provider `laya`: one long-lived Python child (`python3 -m` a ~60-line JSON-lines bridge written in the plugin,
  loading `laya.Router` once), started on first use and kept for the process's life, so the 7 s load is paid once
  per `mgl` run; batched calls. Alternatively, `LAYA_URL` points at a running `laya-serve` (the
  `POST /v1/systemone` HTTP API) and no Python is spawned. The model is downloaded by laya itself from Hugging
  Face on first use (into the HF cache), never by us and never bundled; `mgl doctor` reports Python, the `laya`
  package, the cached checkpoint and the install line (`pip install laya`; CPU torch wheel).
- `model=english|multilingual|typed-decisions|auto` (default `auto`: laya's own router by language).
- Built-in questions use the workaround the model card gives for its known `noul` issue (#156: a yes/no can
  follow its `false:`/`true:` labels instead of the text on the English checkpoint): every yes/no is asked as a
  two-option `choice` with neutral keys.
- Licence: Apache-2.0 (laya), BSD (torch), Apache-2.0 (transformers): all outside the npm package; no GPL.
- Tests: the bridge protocol, batching, caching, the `noul`→`choice` rewrite, every command and check against a
  fake provider (deterministic answers); one live test with `MGL_LIVE=1` that runs the real model on CPU.
- Honest limits, stated in the README: zero-shot accuracy is modest on unfamiliar decisions (its authors report
  0.362 on their typed-decisions benchmark for the base English checkpoint, 0.766 fine-tuned), so findings are
  warnings and suggestions, and the plugin is optional for everything else in this plan.

---

## Order of work, and checks

1. Core API 1.4 (`stock`, `segment`, `decide` providers; generator `assets`/`resolution`; `CheckContext.uiZones`), with
   unit tests, docs (`mgl docs plugins`), schema regenerated, `PLUGIN_API_VERSION = 1.4.0`.
2. `safe-zone` (smallest, highest payoff: it prevents the v3 failure).
3. `svg-prop`.
4. `open-image`, then `open-audio`, `open-video` (shared core first, then three thin providers).
5. `cutout`.
6. `laya` (after open-media, since its first use is ranking search results).
7. An eval task per plugin (in the plugin's `evals/`, never in `evals/heldout*`), README per plugin, LESSONS.md
   entry for any borrowed idea (FrameCraft had safe zones; concept only, already recorded).

Before each push: `npm run typecheck`, `npm test`, `npm run docs:check`, `mgl plugin test examples/plugins/<x>`.

## Decisions for the owner

1. **Core vs plugin-only.** Recommended: the small API 1.4 additions above. The alternative (plugins writing
   files themselves from `process.cwd()`) breaks path confinement, caching and licence tracking.
2. **Share-alike default.** Recommended: refused unless asked, because it would bind the whole video.
3. **cutout default engine.** Recommended: `auto` (rembg if installed, else the colour-key engine), with no
   automatic `pip install`.
4. **Keyed sources** (Pexels, Pixabay, Unsplash, Freesound): off unless their key is in the environment.
5. **laya scope.** Recommended: the three uses above (search ranking, text guard, cue tagging), all advisory;
   no automatic cuts. It adds a Python + torch dependency (roughly 1–2 GB installed with CPU torch, plus about 1.3–1.7 GB of
   weights), so it stays an optional plugin and nothing else depends on it.
