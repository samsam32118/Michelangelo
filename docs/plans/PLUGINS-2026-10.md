# Plan: platform safe zones in core, and the open-media plugin (2026-10-04)

Status: **proposal, awaiting the owner's go-ahead**. Nothing here is built yet.

Judged against DESIGN §17: an agent in a CPU-only container, which cannot browse, watch or listen, should make
better videos for less with Michelangelo than without it. So each item below says who needs it and how it lowers
cost per high-quality video. Rules from CLAUDE.md hold throughout: schema changes only add fields, built-ins use
only the public plugin API, no GPL, no bundled assets, no browser.

| # | What | Where | Who needs it | Why |
|---|---|---|---|---|
| A | Platform safe zones checked by default | core (built-in QA) | everyone making vertical video | captions under the TikTok / Reels / Shorts interface are a quality failure the agent cannot see; v3 shipped one |
| B | `open-media`: images, video, music and sound effects | plugin + small core API (1.3 → 1.4) | anyone without their own footage or sound (script-only briefs) | `docs/FRAMECRAFT-GAP.md` rates "no real imagery" a high-impact gap (FrameCraft's Reel scored 4.5/10 for it) |
| – | svg-prop, cutout | deferred | brand videos; occasional sticker work | niche; build when a task needs them (notes at the end) |

---

## A. Safe zones (core, always on)

**Why v3 slipped through.** The built-in `text-outside-safe` check only looks at text and captions, only for the
one platform in `project.platform` (default `none`, which means 5 % title-safe margins), and only against that
margin rectangle. The per-platform interface rectangles (header, action buttons, caption panel) already exist in
`src/qa/safezones.ts` (`uiZones`) but no check uses them. A plugin would not fix this: plugins load only when a
project names them, so the projects that need it most would not have it.

**Changes (`src/qa/`, `src/builtin/checks/`, plugin API 1.4, all additive):**

- `CheckContext.uiZones(platform?)`: the named interface rectangles in comp px (exposes the existing table).
- New check `ui-overlap` (project stage, so it runs in `check` and `look`): on a vertical comp (height > width),
  tests captions (every cue), text, and **stickers** (image, generator or shape layers covering < 40 % of the
  frame, or clips tagged `sticker`) against the interface zones of **tiktok, reels and shorts together** unless
  `project.platform` names one, at every rest and sample frame. One finding per clip, naming the platforms and
  panels and by how much:
  `caption cue "wait for it" (caps, 4.2s) is under the TikTok caption-and-sound panel and the Reels caption
  area by 86 px; fix: mgl edit <file> clip.set caps y=1418`.
  The fix moves the clip into the area that is clear on all three, and `check --fix` is tested to converge on it.
  Error for captions and text, warning for stickers. Moving layers (crawls, fly-ins) pass through on purpose, as
  in `text-outside-safe` today.
- `look --safe` draws the interface panels of each platform as labelled outlines on the contact sheet and crops,
  so the agent sees what the check sees. Drawn on the QA images only; it can never reach a render.
- Docs: SKILL.md and `mgl docs qa` say vertical projects are checked against all three platforms by default.

**Tests:** a caption at y = 1700 on 1080x1920 flagged for all three, with a fix that clears them; a sticker in the
TikTok action column flagged for TikTok only; a full-frame background and a moving crawl not flagged; a horizontal
comp skipped; `project.platform: "shorts"` checks Shorts only; `look --safe` output has the outlines and the
render does not.

---

## B. open-media (one plugin: images, video, music, sound effects)

**Goal.** An agent finds, fetches and uses openly licensed media in one or two commands, without a browser, and
the project always knows each file's licence, author and source, so the video carries correct credits. Nothing is
bundled: every file is fetched at run time into the project's `media/stock/`.

### Why a small core addition is needed

A plugin command today cannot write into the project folder (`CommandContext` has no project dir, and
`services.writeFile` accepts only `media/generated/*.wav`). The same problem was solved for speech: `audio.speak`
is a core command, and the engine is a `speak` provider in a plugin (`flite-voice`). open-media follows that
pattern: core owns paths, caching, licence rules and credits; the plugin is the source adapters.

### Core (plugin API 1.4, additive)

```ts
interface StockProvider {
  kind: 'stock'; id: string; describe: string;
  media: StockKind[];                                     // 'image' | 'video' | 'music' | 'sfx'
  search(q: { kind: StockKind; query: string; limit?: number; orientation?: 'portrait' | 'landscape' | 'square';
              minSeconds?: number; maxSeconds?: number; minWidth?: number; licences?: LicenceClass[] }):
    Promise<StockItem[]>;
  fetch(args: { item: StockItem; out: string }): Promise<void>;   // core gives a temp path inside media/stock/
}
interface StockItem {
  id: string;                     // provider-scoped and stable, e.g. "openverse:9f1c…"
  kind: StockKind; title: string; url: string /* landing page */; file: string /* download */; ext: string;
  licence: { id: string /* "cc0" | "pdm" | "cc-by-4.0" | … */; url: string };
  author?: string; authorUrl?: string; source: string /* "Freesound via Openverse" */;
  seconds?: number; width?: number; height?: number; bytes?: number; preview?: string; tags?: string[];
}
```

Commands (core, group `media`):

- `media.search kind=sfx query=whoosh [maxSeconds=2 limit=8 orientation= minWidth= licences=]` changes nothing.
  Prints at most 8 numbered results, one per line (`id · title · 0:01.4 · CC0 · author · tags`); the full list
  goes to `.mgl/<p>/search.json`. Images and video also get a contact sheet of thumbnails
  (`.mgl/<p>/search.png`) the agent can look at.
- `media.fetch id=openverse:9f1c [as=whoosh] [track= at= len= gain=]` downloads to
  `media/stock/<kind>/<provider>-<hash>.<ext>` (reused if already there), writes `<file>.json` (licence, author,
  title, url, fetch date, sha256), probes it and refuses an HTML error page or the wrong kind, and adds the asset
  with a `note` naming the licence. With `at=` it also adds a clip: music on the music bus, sfx on the sfx bus
  (like `audio.sfx`), images and video on a new visual track.
- **Sound described as text**, because the agent can't listen: for music and sfx, the fetch result reports
  duration, integrated loudness and peak, where the sound starts (first onset, so a whoosh lands on the cut and not
  80 ms late), whether it is tonal or noisy, bright or dark, and for music the tempo. All from the existing audio
  analysis (`src/media/analysis.ts`). `media.fetch … align=onset` places the clip so its onset falls on `at`.
- `media.credits [out=credits.txt] [card=true]` writes attribution lines (title, author, source, licence) for
  every stock asset in use, and with `card=true` applies the `end-card` template with them.

**Licence rules (in core, so every source obeys them):**

| Class | Licences | Default |
|---|---|---|
| `free` | CC0, Public Domain Mark, US-government public domain (NASA) | allowed |
| `attribution` | CC BY 2.0–4.0 | allowed; credits required |
| `share-alike` | CC BY-SA | refused unless asked (`licences=[…,share-alike]`): the whole video would inherit it |
| `non-commercial` | any NC | refused unless asked |
| `no-derivatives` | any ND | always refused (an edit is a derivative) |
| unknown | anything else | refused |

QA (built-in, project stage): `stock-credits` warns when a CC BY asset is used and no credits were written
(fix: `mgl edit <file> media.credits card=true`); `stock-licence` errors when an NC asset is used and
`project.settings.commercial` is true.

### The plugin: sources (no key needed unless stated)

| Kind | Sources | Notes |
|---|---|---|
| **sfx** | Openverse → Freesound | Measured from this container: keyless search returns Freesound CC0 / CC BY effects with HQ MP3 previews on `cdn.freesound.org` (downloads work). Openverse's `category=sound_effect` filter returns nothing, so sfx means source Freesound plus a duration cap (default ≤ 10 s). |
|  | Freesound API (`FREESOUND_API_KEY`, optional) | original WAV/FLAC files, duration and tag filters |
| **music** | Openverse → Jamendo, ccMixter | CC BY tracks (measured: "Upbeat Corporate", 1:40, Jamendo, CC BY); `license_type=commercial,modification` filtering |
| **image** | Openverse images, Wikimedia Commons, NASA, Art Institute of Chicago (CC0 only) | Pexels (`PEXELS_API_KEY`), Unsplash (`UNSPLASH_ACCESS_KEY`) optional |
| **video** | Wikimedia Commons (webm/ogv; the transcode closest to the comp's height), NASA Image and Video Library, Internet Archive (items with a PD or CC licence URL only) | Pexels, Pixabay (`PIXABAY_API_KEY`) optional |

Measured reachability (2026-10-04): Openverse, Freesound CDN, Wikimedia Commons, NASA and Internet Archive return
200. Commons needs a descriptive `User-Agent`, which every request sends (`michelangelo/<v> (+repo url)`). Freesound
and Pexels APIs return 401 without a key, as expected; keyed sources stay off unless their key is set.

Each source maps its licence strings to the canonical ids above and drops anything it cannot map (fail closed).
Pexels, Pixabay and Unsplash have their own licences (commercial use, no attribution required); they map to
`free` with their own licence id and URL. Search results are cached in `~/.cache/michelangelo/stock/` for a day.

**Tests:** recorded API responses (metadata only, a few KB, no media) through an injected `fetch`; fetch path with
ffmpeg-generated fixture files; licence mapping for every source; refusals; sidecar and credits; onset alignment;
reuse of a fetched file. One live test runs with `MGL_LIVE=1`.

### Measuring it (DESIGN §17.3)

Today's eval sandboxes have no network, and `script-only-short` says "make or generate every visual and sound
yourself", so no current task can show open-media's effect. Add a plugin eval `open-media-short`
(`examples/plugins/open-media/evals/`, never in `evals/heldout*`): a 20–30 s script-only Short that may use open
media, run with network allowed for the open-media hosts only, graded on the deliverable plus the vision score and
a credits check, and compared with `script-only-short` on cost per high-quality video.

---

## Order of work, and checks

1. **A. Safe zones in core** (smallest, everyone benefits, prevents the v3 failure).
2. Core API 1.4 for open-media: `stock` provider kind, `media.search` / `media.fetch` / `media.credits`, licence
   rules, sound-as-text on fetch, the two QA checks, docs (`mgl docs media`, `mgl docs plugins`), schema
   regenerated, `PLUGIN_API_VERSION = 1.4.0`.
3. `examples/plugins/open-media`: sfx and music first (Openverse), then images, then video.
4. The `open-media-short` eval, run with and without the plugin.

Before each push: `npm run typecheck`, `npm test`, `npm run docs:check`, `mgl plugin test examples/plugins/open-media`.

## Deferred (build when a task needs them)

- **svg-prop**: an SVG layer drawn as vectors at its on-screen size, recolourable (`color`, `colors` map). Needs
  generators that may read an asset (`GeneratorDef.assets`) and draw at device resolution. SVGs already load as
  images today; they only blur when scaled up a lot.
- **cutout**: background removal (rembg when installed, else a colour-key engine for plain backgrounds), with a
  verdict sheet (original with the kept region outlined, mask, result on checkerboard / black / white) and warnings
  for near-empty masks, two similar subjects and edge-cropped subjects; `point=[x,y]` keeps the subject under it.
  Needs a `segment` provider kind.

## Decisions for the owner

1. **Safe zones in core, not a plugin.** Recommended, so every vertical project is checked.
2. **Share-alike media:** refused unless asked (it would bind the whole video).
3. **Keyed sources** (Freesound API, Pexels, Pixabay, Unsplash): off unless their key is in the environment.
4. **Network in evals:** allow the open-media hosts for the `open-media-short` eval only.
