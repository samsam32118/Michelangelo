# Plan: open media, svg-prop, cutout, safe-zone plugins (2026-10-04)

Status: **proposal, awaiting the owner's go-ahead**. Nothing here is built yet.

Six requests, judged against DESIGN §17 (cost per high-quality video for an agent in a CPU-only container that
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

All six live in `examples/plugins/<name>/` (package.json, `src/index.ts`, tests via `michelangelo/testing`, an
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

## Order of work, and checks

1. Core API 1.4 (`stock`, `segment` providers; generator `assets`/`resolution`; `CheckContext.uiZones`), with
   unit tests, docs (`mgl docs plugins`), schema regenerated, `PLUGIN_API_VERSION = 1.4.0`.
2. `safe-zone` (smallest, highest payoff: it prevents the v3 failure).
3. `svg-prop`.
4. `open-image`, then `open-audio`, `open-video` (shared core first, then three thin providers).
5. `cutout`.
6. An eval task per plugin (in the plugin's `evals/`, never in `evals/heldout*`), README per plugin, LESSONS.md
   entry for any borrowed idea (FrameCraft had safe zones; concept only, already recorded).

Before each push: `npm run typecheck`, `npm test`, `npm run docs:check`, `mgl plugin test examples/plugins/<x>`.

## Decisions for the owner

1. **Core vs plugin-only.** Recommended: the small API 1.4 additions above. The alternative (plugins writing
   files themselves from `process.cwd()`) breaks path confinement, caching and licence tracking.
2. **Share-alike default.** Recommended: refused unless asked, because it would bind the whole video.
3. **cutout default engine.** Recommended: `auto` (rembg if installed, else the colour-key engine), with no
   automatic `pip install`.
4. **Keyed sources** (Pexels, Pixabay, Unsplash, Freesound): off unless their key is in the environment.
