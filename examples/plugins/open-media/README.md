# open-media

A **stock provider** (plugin API 1.4) for `media.search` / `media.fetch` / `media.credits`: openly licensed images,
footage, music and sound effects from public archives. Nothing is bundled; every file is fetched when you ask for it.
The core applies the licence rules (CC0, public domain and CC BY by default; share-alike and non-commercial only when
asked; no-derivatives and unknown licences never), writes a licence sidecar next to each file and writes credits.

| Kind | Sources (no key) | With a key |
|---|---|---|
| `sfx` | Openverse → Freesound (HQ MP3 previews, ≤ 10 s by default) | Freesound API (`FREESOUND_API_KEY`; replaces the Openverse route) |
| `music` | Openverse → Jamendo, ccMixter; Wikimedia Commons audio (Musopen recordings and other public-domain music) | |
| `image` | Openverse (Flickr, museums), Wikimedia Commons, NASA, Library of Congress, The Met, Cleveland Museum of Art, Wellcome Collection, SMK; Smithsonian through a local index (below) | Smithsonian live API (`SMITHSONIAN_API_KEY`), Europeana (`EUROPEANA_API_KEY`), Pexels (`PEXELS_API_KEY`), Pixabay (`PIXABAY_API_KEY`), Unsplash (`UNSPLASH_ACCESS_KEY`) |
| `video` | Wikimedia Commons (the WebM transcode or original that reaches the comp size), NASA, Prelinger Archives (Internet Archive) | Pexels, Pixabay |

`mgl edit <file> open-media.sources` lists every source, what it serves and whether it is on.

## Use it (trusted loading)

Plugins are code that runs on your machine with no sandbox, so a project loads one only when you name it **and**
trust it. Trust is a hash of every file in the folder: re-run `mgl plugin trust` after any change.

```text
cp -r <michelangelo repo>/examples/plugins/open-media plugins/open-media
mgl plugin test plugins/open-media
mgl plugin trust plugins/open-media
mgl edit video.mgl.json project.set plugins='{"open-media": "^1.0.0"}'

mgl edit video.mgl.json media.search kind=sfx query=whoosh maxSeconds=2
mgl edit video.mgl.json media.fetch id=<id> at=2.5s align=onset
mgl edit video.mgl.json media.search kind=image query="steam locomotive"   # then look at .mgl/video/search.png
mgl edit video.mgl.json media.fetch id=<id> at=0 len=3s
mgl edit video.mgl.json media.credits card=true
```

`media.search ... source=<id>` asks one archive only (`openverse`, `commons`, `nasa`, `smithsonian`, `loc`, `met`,
`cleveland`, `wellcome`, `smk`, `prelinger`, and the keyed ones).

## The Smithsonian without a key

The Smithsonian publishes all its open-access metadata on S3 (37 units, 256 shards each, about 46 GB). The plugin
streams the units worth having for video once and keeps only records with a CC0 image, in the user cache
(`$MGL_CACHE_DIR` or `~/.cache/michelangelo/stock/open-media/smithsonian/`):

```text
mgl edit video.mgl.json open-media.index                     # chndm, npg, saam, fsg, nmaahc
mgl edit video.mgl.json open-media.index units='["nasm","hmsg"]'
```

Measured on a cloud container (2026-10-04): the five default units (Cooper Hewitt design, Portrait Gallery, American
Art, Asian Art, African American History) streamed 0.58 GB in about 13 s and indexed 91,700 CC0 images into 5.3 MB;
a search of it takes about 2 s with no network. Herbarium sheets and specimen photos (most of the dump) are never
indexed by default; `nmah` (2.5 GB) and `sia` (2 GB) are opt-in. With `SMITHSONIAN_API_KEY` set (free from
api.data.gov) the live API is used instead (1,000 requests an hour). Images download at full size (up to 4000 px)
without a key either way. Smithsonian Libraries' book scans are not in Open Access (53 images); they live in the
Biodiversity Heritage Library and Internet Archive.

## How each source decides what is usable

- **Openverse**: its licence URL or name and version; asks the API for commercial-use, modifiable results unless
  non-commercial was allowed. Anonymous requests are limited to 20 results per page.
- **Wikimedia Commons**: `LicenseUrl`, then `LicenseShortName`; "Public domain" without a URL is public domain;
  anything else (GFDL only, "copyrighted free use", ...) is dropped.
- **NASA**: US-government works are public domain, but NASA hosts third-party media too: only items credited to NASA
  or uncredited are kept, and nothing mentioning a copyright (e.g. Rocket Lab launch footage is dropped).
- **Library of Congress**: only items whose rights advisory says "No known restrictions on publication" (licence id
  `nkr`). The full-size image comes from the master TIFF through IIIF (e.g. 3355×2553 against a 640 px preview), with
  the service JPEG as the fallback.
- **The Met, Cleveland**: their CC0 / public-domain flags. **Wellcome**: PDM, CC0, CC BY (and CC BY-NC when allowed).
  **SMK**: its rights URL (Public Domain Mark), images through IIIF up to 3000 px.
- **Prelinger**: only items with a licence URL (most are marked public domain); home movies without one are skipped.
  The films are mostly 640×480, below the default size floor for a 1080×1920 comp: `minWidth=0` shows them.
- **Keyed sources** follow their documented APIs (Pexels, Pixabay and Unsplash licences allow commercial use without
  attribution; Unsplash downloads are reported to its download endpoint as its API guidelines ask).

## Not included, and why

- **Art Institute of Chicago**: its image server answers cloud networks with a bot challenge page, so downloads fail
  where agents run.
- **Rijksmuseum**: the new Linked Art API needs three requests per result; Openverse already indexes about 30,000
  Rijksmuseum images.
- **Musopen on Internet Archive**: most items are ZIP archives; Commons carries many Musopen recordings as files.
- **Biodiversity Heritage Library, NYPL, Flickr (Internet Archive Book Images, British Library)**: need registered keys;
  a later keyed source.

## Notes

- Wikimedia rate-limits busy shared IPs (HTTP 429); core retries once, and the search says which archive failed.
- Every request sends `User-Agent: michelangelo/0.1 (... +https://github.com/samsam32118/Michelangelo)`.
- Keys are read from the environment only and are never written to the project, sidecars or results.

## Files

- `src/index.ts`: the provider (one `Source` per archive), `open-media.sources` and `open-media.index`.
- `test/open-media.test.ts`: every source against recorded API answers in `test/fixtures/` (metadata only, no media),
  licence mapping and dropping, keyed sources, failures as notes, and the Smithsonian index built from a dump shard.
