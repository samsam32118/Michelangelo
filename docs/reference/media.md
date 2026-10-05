# Open media: images, footage, music and sound effects you may use

Three commands find, fetch and credit openly licensed media through the project's **stock providers** (plugin
API 1.5). A provider is a plugin: `examples/plugins/open-media` in the Michelangelo repository searches Openverse
(Freesound effects, Jamendo and ccMixter music, Flickr, museum collections), Wikimedia Commons, NASA, the
Smithsonian, the Library of Congress, several museums, Internet Archive (Prelinger films, Musopen) and, with keys,
Pexels, Pixabay, Unsplash, Freesound and Europeana. Nothing is bundled: every file is fetched when you ask for it.

Without a provider the commands fail with `E_NO_PROVIDER` and the install steps. Offline alternatives:
`audio.music` and `audio.sfx` generate sound; generators (`gradient`, `noise`, `particles`) draw backgrounds.

## Use it

```text
cp -r <michelangelo repo>/examples/plugins/open-media plugins/open-media
mgl plugin trust plugins/open-media
mgl edit video.mgl.json project.set plugins='{"open-media": "^1.0.0"}'

mgl edit video.mgl.json media.search kind=sfx query=whoosh maxSeconds=2
mgl edit video.mgl.json media.fetch id=s1 at=2.5s align=onset
mgl edit video.mgl.json media.search kind=image query="steam locomotive" orientation=portrait
mgl edit video.mgl.json media.fetch id=i2 at=0 len=3s
mgl edit video.mgl.json media.credits card=true
```

## media.search

`kind` is `image`, `video`, `music` or `sfx`; `query` is words. It changes nothing in the project.

- Prints at most `limit` (default 8) lines: `handle · title · length or size · licence · author · source`. A handle is
  the kind's letter and a number (`s1` sound effect, `m1` music, `i1` image, `v1` video); `media.fetch id=i3` takes
  it. Handles are stable within a project: a later search continues the numbering and a result shown before keeps its
  handle, so you can search several times before fetching. Full ids, URLs, tags and dates are in `.mgl/<name>/search.json`; for
  images and video a preview sheet labelled with the handles is `.mgl/<name>/search.png`: **look at it** before you fetch.
- Only **CC0, public domain and CC BY** results are shown. `licences=["share-alike"]` adds CC BY-SA (the finished
  video must then be released under CC BY-SA too); `licences=["non-commercial"]` adds NC licences (never in a
  commercial video). **No-derivatives and unknown licences are never shown**: an edit is a derivative.
- `sfx` means short sounds: at most 10 s unless `maxSeconds` says otherwise.
- Images and video smaller than half the comp's long side are hidden (`minWidth=0` shows them).
- `orientation=portrait|landscape|square`, `minSeconds`, `maxSeconds`, `minWidth`, `page`, `provider` (one
  plugin) and `source` (one archive of a provider, e.g. `source=smithsonian`) narrow the search.
- The line after the list says what was hidden and why (`hidden: 2 share-alike, 1 too small`) and which providers
  failed (a failing source never stops the others).

## media.fetch

`id` is a handle from a search (`i3`) or a full id from search.json. It downloads the file to `media/stock/<kind>/<provider>-<hash>.<ext>` (reused if already
there), writes `<file>.json` next to it (title, author, source, landing page, licence id, name, URL and class,
credit line, size or length, fetch date, sha256), and adds an asset with `licence` and `credit`.

- With `at=` it also adds a clip: sound effects on an `sfx`-bus track, music on a `music`-bus track (cut at the
  comp's end), images and video on a new visual track on top. Default lengths: images 3 s, video up to 10 s,
  sounds their own length. `len=`, `track=`, `clip=` (clip id), `as=` (asset id), `gain=` and `comp=` override.
- **Sound described as text**, because you cannot listen: length, loudness (LUFS), true peak, where the sound
  starts and where it is loudest, tonal / mixed / noisy, dark / balanced / bright, and for music an estimated tempo.
  `align=onset` places the clip so the first audible moment lands on `at` (a whoosh on the cut, not 80 ms late);
  `align=peak` lands its loudest moment there (a shutter click or a hit on the beat). Sounds under 0.4 s have no
  LUFS; their loudest RMS is given instead.
- A download that is a web page, empty, or not the kind it claims (`ffprobe` decides) is deleted and refused
  (`E_MEDIA_FILE`); a licence the search would hide is refused (`E_LICENCE`).

## media.credits

Writes one line per open-media asset in use, `“Title” by Author (Source), Licence`:

- `out=credits.txt` (the default without `card`): a text file for the video description;
- `card=true`: a credits card appended after the end of the comp (dark background, the lines in legible text,
  inside the safe area; `len` default 3 s); the comp is extended when its length is a number. Running it again
  replaces the card.

It records what it credited in `project.credits` (`{"file": "credits.txt", "assets": [...]}`).

## QA rules

- `stock-credits` (warning): an attribution-licensed asset (CC BY, BY-SA, BY-NC) is used but was not credited by
  `media.credits` (re-run it after adding media). Fix: `media.credits card=true`.
- `stock-licence`: an asset with a no-derivatives licence (error), a non-commercial asset in a project with
  `project.set commercial=true` (error), a share-alike asset (info: the video inherits CC BY-SA), an unrecognised
  licence (warning).

Tag a clip `qa-ignore:credits` or `qa-ignore:licence` when you handle credits another way.

## Writing a provider

A provider is `defineProvider({ kind: 'stock', id, describe, media: ['image', 'sfx', ...], search(q, ctx), item?(id, ctx), fetch?({ item, out }, ctx) })`.
`search` returns `StockItem`s (`id`, `kind`, `title`, `url`, `file`, `ext`, `licence: { id, url? }`, `author?`,
`source`, `seconds?`, `width?`, `height?`, `preview?`, `tags?`). Use `canonicalLicence(urlOrName, version?)` from
`michelangelo/plugin` to map a source's licence to a canonical id and drop results it cannot map. Make HTTP calls
with `ctx.fetch` (it sends a descriptive User-Agent, times out, and retries a 429 or 5xx once), read API keys with
`ctx.env(name)`, and keep indexes in `ctx.cacheDir`. Core owns paths, licence rules, sidecars and credits.
