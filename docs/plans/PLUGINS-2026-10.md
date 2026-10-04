# Plan: platform safe zones in core, and the open-media plugin (2026-10-04)

Status: **proposal, awaiting the owner's go-ahead**. Nothing here is built yet. Revised 2026-10-04 after review:
one `open-media` plugin (images, video, music, sound effects) instead of three, safe zones moved into core, svg-prop
and cutout deferred, laya dropped for now, public-domain archives and Smithsonian access added.

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
| **music** | Openverse → Jamendo, ccMixter; Internet Archive **Musopen** (public-domain classical recordings, CC0 / PD, items without a licence URL skipped) | CC BY tracks (measured: "Upbeat Corporate", 1:40, Jamendo, CC BY); `license_type=commercial,modification` filtering |
| **image** | Openverse images, Wikimedia Commons, NASA, plus the public-domain archives in the next table | Pexels (`PEXELS_API_KEY`), Unsplash (`UNSPLASH_ACCESS_KEY`) optional |
| **video** | Wikimedia Commons (webm/ogv; the transcode closest to the comp's height), NASA Image and Video Library, Internet Archive (items with a PD or CC licence URL only), including the **Prelinger Archives** (10,468 ephemeral, industrial and educational films, measured: marked public domain) | Pexels, Pixabay (`PIXABAY_API_KEY`) optional |

**Public-domain archives for images** (old scanned books, prints, maps, photographs, paintings). Measured from this
container on 2026-10-04:

| Archive | What it has | Access | Licence filter |
|---|---|---|---|
| **Smithsonian Open Access** | CC0 art, design, portraits, history and nature photography (details below) | live `api.si.edu` search with a free key (`SMITHSONIAN_API_KEY`, tested); without a key, a local index built from the public metadata dump on S3. Images from `ids.si.edu` at full resolution, no key | `media_usage:CC0` |
| **Library of Congress** | photographs, prints, posters, maps (Prints & Photographs, FSA/OWI, HABS) | `loc.gov/photos/?fo=json`, keyless | only items whose rights say "No known restrictions on publication" (read per item; anything else dropped) |
| **Metropolitan Museum** | open-access paintings, prints, photographs, objects | keyless; `v1.1/search?isPublicDomain=true` (the old `v1/search` was retired on 2026-10-01, measured) | `isPublicDomain` |
| **Art Institute of Chicago** | public-domain paintings, prints, photographs | keyless (`api.artic.edu`), IIIF images | `is_public_domain` |
| **Cleveland Museum of Art** | CC0 paintings, prints, objects | keyless (`openaccess-api.clevelandart.org`) | `cc0=1` |
| **Rijksmuseum** | Dutch Golden Age paintings, prints, drawings | keyless Linked Art search (`data.rijksmuseum.nl`) + IIIF | CC0 / PD statement |
| **Wellcome Collection** | medicine and science history: anatomy plates, botanical prints, old book scans | keyless (`api.wellcomecollection.org`), IIIF | PDM / CC0 / CC BY only |
| **SMK (National Gallery of Denmark)** | paintings and prints | keyless (`api.smk.dk`) | `public_domain:true` |
| **Europeana** | items from European libraries and museums (13.8M of them already indexed by Openverse) | `api2demo` key works for testing; real use needs a free key (`EUROPEANA_API_KEY`) | `reusability=open` |

**Smithsonian with a key: the live API** (tested 2026-10-04 with a key from `edan.si.edu/openaccess/signup/form`):

- 1,000 requests an hour per key (`x-ratelimit-limit: 1000`), against 10 for the shared `DEMO_KEY`.
- Query `<terms> AND media_usage:CC0 AND online_media_type:Images` returns only records with a CC0 image (without
  the second clause, CC0 records without an image come back). Measured: "locomotive" 2,340 results (NMAH, Cooper
  Hewitt, Archives); "jazz" 148 (NMAAHC posters, an NPG portrait of Louis Armstrong); "moon landing" 25 (Air and
  Space). `category/art_design/search` narrows to art and design ("botanical": 1,097 from SAAM and Cooper Hewitt).
- Titles can contain HTML (`Steam Locomotive, <I>John Bull</I>`); the provider strips tags.
- Smithsonian Libraries has 53 CC0 records with images (sheet-music covers), which confirms the dump finding:
  the book scans are not in Smithsonian Open Access.
- Full-size image downloads (`ids.si.edu`) need no key: the Armstrong portrait came back at 3114×4000 px.
- The key is read from `SMITHSONIAN_API_KEY` and is never written to the project, its sidecars, logs or results.
  With a key the live API is the default and the local index is optional; without one, the index is used.

**Smithsonian without a key: the open-access dump.** The Smithsonian publishes all its open-access metadata on S3
(`smithsonian-open-access.s3-us-west-2.amazonaws.com/metadata/edan/index.txt`). Measured on 2026-10-04:

- 37 units (museums and archives), each split into 256 newline-delimited JSON shards; about **46 GB** in total
  (estimated from shard sizes). Too big to search live, so the plugin builds a small local index once.
- Most CC0 images are specimens, not footage material. In a sample of 18 units (14.3M records), 4.6M records carry
  a CC0 image, and 3.6M of those are herbarium sheets (`nmnhbotany`). Bird, insect and fossil specimen photos
  follow. **Smithsonian Libraries (`sil`) has almost no images** in the dump: about 930k catalogue records, about 256
  with an image. Its book scans live in the Biodiversity Heritage Library and Internet Archive, not here.
- The units that matter for video are small: Cooper Hewitt design (`chndm`, about 57k CC0 images, 0.23 GB of
  metadata), Portrait Gallery (`npg`, ~12.5k), American Art (`saam`, ~11k), American History (`nmah`, ~14k, but
  2.5 GB of metadata), Asian Art (`fsg`, ~5k), African American History (`nmaahc`, ~4.6k), the Archives (`sia`,
  ~4k, 2 GB), plus Air and Space, Hirshhorn and the Zoo. Counts are from shard `00` × 256.
- Images download keyless at full resolution: `ids.si.edu/ids/deliveryService?id=<idsId>&max=4000` gave
  2283×3000 px.
- Shards carry `Last-Modified` and `ETag` (latest refresh 2026-09-28), and the bucket can be listed with S3
  `ListObjectsV2`, so a rebuild re-reads only the shards that changed.
- Some records lack `descriptiveNonRepeating`; the indexer skips any record without a CC0 image instead of
  failing.

How the plugin uses it:

- `open-media.index smithsonian [units=chndm,npg,saam,fsg,nmaahc] [refresh=true]` (changes nothing in the project)
  streams the chosen units' shards
  once (never stored whole) and keeps only records with a CC0 image. Each entry holds the ids image id, title,
  unit, date, object type, topics and place, written to `~/.cache/michelangelo/stock/smithsonian/<unit>.jsonl.gz`.
  The default units are the five above: about 0.5 GB to stream, a few minutes, an index of roughly 10–15 MB. The
  command prints the estimate first and runs detached (`--detach`, like `render`) when it is longer than about
  a minute. `nmah`, `sia` and nature units (`nmnhbirds`, `nmnhento`, …) are opt-in, with their own estimate.
  Herbarium sheets are never indexed by default.
- `media.search kind=image source=smithsonian query=...` searches that index locally (token match on title, topics,
  object type and place, ranked by field), with no network until fetch. Without an index, the result says so and
  gives the build command and its estimate. With `SMITHSONIAN_API_KEY` set, the live API is used and the index is
  optional.
- The index is metadata built on the user's machine from the public dump. Nothing is bundled, and image files are
  fetched only on `media.fetch`.

Not added: **Biodiversity Heritage Library** and **NYPL Digital Collections** need registered keys (401 without);
their best material is also reachable through Smithsonian, Openverse or Wikimedia Commons. **Internet Archive Book
Images**, **British Library** and Flickr Commons sit on Flickr, whose API needs a key (a later keyed source).
**Public Domain Image Archive** (Public Domain Review) has no API. **National Gallery of Art** publishes open data
but no search API. **David Rumsey** maps are CC BY-NC-SA (refused by the licence rules).

**Why query these directly when Openverse indexes some of them:** Openverse's coverage of the old-book material is
thin (Smithsonian Libraries: 55 images; NYPL: 1,281) and its copies can be small (Biodiversity Heritage Library
results came back 575–624 px wide). A vertical video needs at least 1920 px on the long side, so archive sources
fetch the full-resolution IIIF image and `media.search` shows each result's real size and drops images under
`minWidth` (default: the comp's long side ÷ 2, with a note when an image will be upscaled).

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
3. `examples/plugins/open-media`: sfx and music first (Openverse, Musopen), then images (Openverse, Commons,
   Smithsonian live API, then the other public-domain archives, then the keyless Smithsonian index), then video
   (Commons, NASA, Prelinger).
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
3. **Keyed sources** (Freesound API, Pexels, Pixabay, Unsplash, Europeana; Smithsonian's live API): off unless
   their key is in the environment. Smithsonian works without a key through the local index; with
   `SMITHSONIAN_API_KEY` (free, tested) the live API is used.
4. **Network in evals:** allow the open-media hosts for the `open-media-short` eval only.
5. **Smithsonian index default units:** `chndm`, `npg`, `saam`, `fsg`, `nmaahc` (about 0.5 GB to stream once).
