# Michelangelo: design

Status: approved by the owner (2026-10-03); revised after the adversarial design review (§16 lists every change). Owner: samsam32118. Branch `claude/michelangelo-v1`.

Michelangelo is a TypeScript library and CLI for video editing (what people use Premiere Pro for) and
motion graphics (what people use After Effects for). It is designed first for AI coding agents working
in a cloud container: a terminal with time limits, file tools that read 2,000 lines and edit by exact
string replacement, an image viewer, and no way to watch video or hear audio.

Ideas borrowed from FrameCraft and mistakes avoided are recorded in [LESSONS.md](LESSONS.md).
Decisions marked **(R)** are reversible and were made without asking; **(Ask)** marks the ones that
need the owner.

---

## 1. Measured environment and what follows from it

Measured in this session (Linux x64, 4 vCPU Xeon, 15 GB RAM, no GPU, root, HTTPS through a proxy):

| Measurement | Result | Consequence |
|---|---|---|
| Skia (`@napi-rs/canvas` 0.1.x) composite of a 1080×1920 frame: full-frame video layer with a zoom, rounded rect, a `screen` blend, title text with a stroke, 6 animated caption words | **11 ms/frame** (540×960: 2.7 ms) | FrameCraft's SwiftShader WebGL took 210–270 ms for a similar frame. Compositing is no longer the bottleneck |
| Same frame + RGBA readback + pipe to `ffmpeg -c:v libx264 -preset veryfast`, one process | **39 ms/frame = 1.16× real time** at 1080×1920; 0.32× at 540×960 | Final ≤ 3× and draft ≤ 1× are reachable on one core-set without any parallelism; parallel frame ranges are headroom |
| System ffmpeg 6.1.1 | libx264, libx265, libvpx-vp9, prores_ks, aac, libmp3lame, libopus, gif; HEVC/H.264/ProRes decoders; `ebur128`, `loudnorm`, `silencedetect`, `sidechaincompress`, `lut3d`, `ssim`, `flite` | The system ffmpeg is good enough here; the fetched static build is the fallback |
| `flite` (ffmpeg lavfi source) | synthesises speech | Speech fixtures for evals are generated, not recorded |
| `claude -p` | works in this container | Real agent eval runs are possible here |
| npm `michelangelo` | **taken** (v0.8.0, unrelated) | A scoped name is needed (Ask, §13) |
| GitHub `samsam32118/Michelangelo` | exists, **public** | The brief asked for private (Ask, §13) |

Design rules that follow (each one traced to a measured limit or a FrameCraft lesson):

- **R1 Small, line-oriented project file.** One entity per line, readable ids, so `grep` finds a clip and
  an exact-string edit of one line is unique. A 60-clip edit stays under 150 lines.
- **R2 The file is the truth; hand edits are safe.** No derived data in the file, everything re-validated
  on load, errors name the line and the fix.
- **R3 Few verbs, short output.** 9 CLI verbs, ≤ 40 lines of text, `--json` everywhere, exit codes 0/1/2.
- **R4 Block and estimate.** Commands block. Anything that may exceed 2 minutes prints `est. N s` on its
  first line so the agent can choose to background it.
- **R5 Pictures and text, never video.** `look` makes contact sheets and zoomed crops ≤ 1568 px; sound is
  reported as numbers and words.
- **R6 No browser.** Skia (native) composites, ffmpeg (native) decodes, encodes and processes audio.
- **R7 A small surface, kept small.** One name per concept, no aliases. FrameCraft grew to 238 tools, a
  1,186-line agent guide and dozens of legacy aliases; Michelangelo's core stays under ~60 commands and
  its guide under ~3k tokens.

---

## 2. Concepts

```
Project ─┬─ settings (name, plugins, defaults)
         ├─ assets      files on disk (video, audio, image, font, LUT, subtitles), by path
         ├─ comps       compositions: size, fps, duration, background. Nestable. One is `main`
         │    └─ tracks     ordered; visual tracks stack (later = on top), audio tracks mix into a bus
         │         └─ clips     anything with a time span on a track: media, text, shape, solid,
         │                      nested comp, captions, adjustment, generator
         │              ├─ properties  constants or keyframes (with easing)
         │              ├─ effects     typed, parameterised instances (`fx`)
         │              ├─ masks       shapes that cut the clip (`masks`)
         │              └─ transitions in / out
         ├─ cues        caption cues (one per line), owned by a captions clip
         ├─ buses       audio buses: dialogue, music, sfx, master; ducking, loudness target
         └─ markers     named points or ranges on a comp
```

- **Comp vs sequence.** One type, `comp`. A comp used as an edit (Premiere) and a comp used as a motion
  graphic (After Effects) differ only in content. A clip of kind `comp` nests another comp.
- **Layer vs clip.** One type, `clip`. Its track gives its stacking order. There is no separate layer
  list inside a comp (FrameCraft had groups, layers and z-index; three orderings is two too many).
- **Effects** run in one of two stages, declared by the effect type: `source` (ffmpeg filters applied
  while decoding a media clip: colour, LUT, denoise, scale, speed) or `layer` (Skia, on the clip's
  rendered layer: blur, glow, shadow, chroma key, vignette, ...). A plugin can provide either or both.
- **Transitions** belong to the clip they lead into (`in`) or out of (`out`); a transition between two
  adjacent clips on one track is the incoming clip's `in` with the overlap computed from the cut.
- **Templates** are parameterised generators of entities (an intro is a comp plus clips), applied by a
  command. Once applied they are plain entities you can edit; the template id is kept only as a tag.

---

## 3. Time

- **Inside: integer frames at the comp's rate.** A comp has `fps` as an integer or a rational string
  (`"30000/1001"`). Every time in a comp (clip start, length, source in-point, keyframe times, cue times,
  markers) is an integer frame count. Audio is rendered at 48 kHz with sample positions computed exactly
  from frames (`frame × 48000 × den / num`, rational arithmetic, no floats).
- **At the edges: seconds and timecode, converted once.** Anywhere a time is accepted from the outside
  (CLI arguments, the SDK, and also the project file when written by hand), these forms are accepted:
  `75` (frames), `"2.5s"`, `"1:02.5"` (m:ss.s), `"00:01:02:15"` (SMPTE timecode, frames after the last
  colon). A seconds value that is not on a frame boundary is rounded to the nearest frame, and the
  result says so (`note: 2.51s rounded to frame 75 (2.500s)`). The writer stores integers.
- **Speed** is a rational (`"3/2"`, or a decimal with ≤ 3 places that is converted to one). Source time
  is `in + floor(localFrame × speed)`, exact. Freeze frames are `speed: 0` with `in` as the held frame.
- **Media at another rate** (24 fps footage in a 30 fps comp) is mapped by ffmpeg's `fps` filter in the
  decoder, so the compositor only ever sees comp frames.
- Output shows both: `show` prints `2.50s` with `f75` when asked (`--frames`).

Why integers and not rationals everywhere: rationals are needed only for the rate itself and speed;
everything a person or agent edits is "frame N", which is exact, comparable and greppable.

---

## 4. Data model and file format

### 4.1 The file

`<name>.mgl.json` (extension: Ask, §13). Valid JSON, written by a formatter with **one entity per
line**, entities grouped in tables, `id` first, a fixed key order per entity type, defaults omitted:

```json
{"michelangelo": 1, "$schema": "https://michelangelo.dev/schema/v1.json",
"project": {"name": "Focus tips", "plugins": {"glitch": "^1.0.0"}},
"assets": [
{"id": "vo-wav", "src": "media/vo.wav"},
{"id": "beach", "src": "media/beach.mov"},
{"id": "bed-mp3", "src": "media/bed.mp3"}
],
"comps": [
{"id": "main", "size": [1080, 1920], "fps": 30, "length": 900, "bg": "#000000"}
],
"tracks": [
{"id": "V1", "comp": "main"},
{"id": "V2", "comp": "main"},
{"id": "T1", "comp": "main"},
{"id": "A1", "comp": "main", "audio": true, "bus": "dialogue"},
{"id": "A2", "comp": "main", "audio": true, "bus": "music"}
],
"clips": [
{"id": "shot1", "track": "V1", "at": 0, "len": 120, "asset": "beach", "in": 48, "fit": "cover"},
{"id": "shot2", "track": "V1", "at": 120, "len": 90, "asset": "beach", "in": 300, "transition": {"in": {"type": "crossfade", "len": 10}}},
{"id": "title", "track": "T1", "at": 0, "len": 75, "text": "Three tips to focus", "style": "title", "y": 420, "scale": [[0, 0.8], [12, 1, "outBack"]], "animate": {"in": "pop", "by": "word"}},
{"id": "subs", "track": "T1", "at": 75, "len": 825, "captions": true, "style": "karaoke"},
{"id": "vo", "track": "A1", "at": 0, "len": 840, "asset": "vo-wav"},
{"id": "bed", "track": "A2", "at": 0, "len": 900, "asset": "bed-mp3", "gain": -6, "fade": [30, 60]}
],
"cues": [
{"id": "c1", "clip": "subs", "at": 0, "len": 45, "text": "Put your phone in another room", "words": [0, 6, 14, 22, 28, 34]}
],
"styles": [
{"id": "title", "font": "Anton", "size": 110, "color": "#ffffff", "stroke": "#000000", "strokeWidth": 8}
],
"buses": [
{"id": "music", "duck": {"by": "dialogue", "db": 9}}
],
"markers": [
{"id": "drop", "comp": "main", "at": 450}
]
}
```

Rules:

- **Tables, not nesting.** Tracks point to their comp, clips to their track, cues to their clip. This
  keeps every entity on one line, whatever the nesting depth, and makes `grep '"track": "V1"'` work.
  Order inside `tracks` is the stacking order; order inside `clips` is free (the writer sorts by comp,
  track, start).
- **Readable ids**, unique per project, `[a-z0-9][a-z0-9_-]*` (tracks may be upper case: `V1`, `A1`).
  Ids given by the author are kept. Generated ids are short and meaningful: `title`, `shot3`, `cue17`.
- **Defaults omitted** on write (opacity 1, scale 1, speed 1, blend normal, fit `contain` for images ...),
  filled in on read by the schema. The JSON Schema lists every default.
- **No derived data.** Not stored: asset duration, size, codec (probed, cached); comp length when it
  is `"auto"` (the end of the last clip); caption layout; thumbnails, waveforms, analysis.
- **Caches outside the file**: `.mgl/cache/` next to the project, keyed by asset content hash (size +
  mtime + hash of the first and last 1 MB). Deleting it is always safe.
- **Keyframes** use one compact form on the property itself:
  `"x": [[0, 540], [15, 700, "outCubic"], [30, 700]]` = `[frame, value, easing-of-the-segment-that-starts-here?]`.
  Frames are clip-local (0 = the clip's first frame). Easing names follow CSS / Penner
  (`linear`, `in|out|inOut` × `Sine|Quad|Cubic|Expo|Back|Elastic|Bounce`, `hold`) or a bezier
  `[x1, y1, x2, y2]`. A property is either a constant or a keyframe list; never both.
- **Common properties on visual clips** (all optional, top-level on the clip line, so an agent can
  edit `"y": 420` in place): `x`, `y` (the anchor position in comp px; default the comp centre), `anchor`
  (`[0.5, 0.5]` of the clip box), `scale` (number or `[sx, sy]`), `rotate` (degrees), `opacity`, `blend`,
  `crop`, `fit`, `parent` (a clip id), `masks`, `fx`, `transition`, `animate` (text), `style` (text,
  a style id or inline object), `hidden`, `locked`, `tags`.
- **Long lines are allowed** (a clip with many keyframes). The writer never wraps an entity: the
  one-entity-one-line invariant matters more for editing than line length. `show --clip` prints one
  clip's properties expanded when the agent needs to read a long one.
- **Unknown keys are errors**, with the closest valid key (`"opactiy"` → did you mean `opacity`?).
  Plugins add keys only inside their own effect / generator params, never at the top level.
- **Version**: `"michelangelo": 1` is the file format version. Format changes are additive within a
  major; a reader for version N reads every N.x file.

The format is defined once, as zod schemas in `src/core/schema/`, from which the TypeScript types and
the published JSON Schema (`schema/v1.json`) are generated (zod 4 `toJSONSchema`).

### 4.2 Size budget

A 60-clip Short: 1 header + project + ~5 assets + 1 comp + ~6 tracks + 60 clips + 8 table brackets +
a few buses / markers ≈ 85 lines; with 40 caption cues ≈ 125 lines. Under 150 as required, tested by a
fixture in the unit suite. A 200-clip project with 300 cues is ~520 lines: readable in one `Read`.

### 4.3 Loading, validation and errors

Load = parse (with a position-aware JSON parser so every value has a line) → normalise edge forms
(time strings, single-number scale) → zod validation → reference checks (track → comp, clip → track,
asset exists, no cycles in nesting or parenting) → semantic checks (clips on one track don't overlap
unless a transition covers it, keyframes inside the clip, cue inside its clip). Every problem is:

```
error E_REF line 14: clip "shot2" refers to track "V3", which does not exist.
  fix: use one of V1, V2, T1 (tracks of comp "main"), or add {"id": "V3", "comp": "main"} to "tracks".
```

`check` prints all problems (errors and warnings); every other command refuses to run on a file with
errors (exit 1) and prints the first 5.

---

## 5. Commands (the one API)

Every change is a **command**: a JSON object `{"op": "clip.split", ...fields}`. Commands are defined
once, each with a zod schema, a doc string with one example, and an `apply(project) → patch` function.
The CLI, the SDK and plugins all go through the same registry.

- **Validated**: unknown fields and wrong types are errors with did-you-mean; times accept the edge
  forms of §3.
- **Undoable**: applying a command produces a patch (entity-level: add / remove / replace a line) and
  its inverse. The CLI appends `{command, inverse}` to `.mgl/history.jsonl`, so `edit p undo` and
  `edit p redo` work across processes. If the file changed on disk since (a hand edit), undo refuses
  and says so instead of guessing.
- **Dry-runnable**: `--dry-run` prints the lines that would change (a unified diff of entity lines)
  and writes nothing. Commands that cannot be simulated exactly (render, import with probing) are not
  commands; they are verbs.
- **Serialisable**: a command is plain JSON; a batch is a JSON array or JSONL file applied atomically
  (one undo step).

### 5.1 Core commands (v1)

| Group | Commands |
|---|---|
| project | `project.set` |
| asset | `asset.add` (probes, picks an id), `asset.remove`, `asset.relink` |
| comp | `comp.add`, `comp.set`, `comp.remove`, `comp.reframe` (to another size: re-lays text, keeps subjects with a fit/position rule) |
| track | `track.add`, `track.set`, `track.remove`, `track.move` |
| clip | `clip.add`, `clip.set` (any property, dotted paths: `fx.blur.radius`), `clip.remove`, `clip.move`, `clip.trim`, `clip.split`, `clip.ripple-delete`, `clip.slip`, `clip.slide`, `clip.roll`, `clip.speed`, `clip.freeze`, `clip.nest` (make a comp of clips) |
| keyframes | `key.set`, `key.remove`, `key.clear` |
| effects | `fx.add`, `fx.set`, `fx.remove`, `transition.set` |
| masks | `mask.add`, `mask.set`, `mask.remove` |
| text | `text.set`, `text.animate` (per char / word / line presets) |
| captions | `captions.import` (SRT / VTT, word timing when present), `captions.from-text` (split a script into cues timed to a voice clip's speech segments), `captions.style`, `cue.set`, `cue.split`, `cue.merge` |
| audio | `bus.add`, `bus.set`, `audio.duck`, `audio.normalize` (sets a loudness target; applied at render), `audio.fade`, `audio.cut-silences` (ripple-removes silent ranges of a clip, using analysis) |
| templates | `template.apply` (intro, lower-third, cta, ...) |
| markers | `marker.add`, `marker.remove` |
| history | `undo`, `redo` |

Plugins add commands under their own prefix (`glitch.randomize`).

### 5.2 Edit semantics (frame-exact)

- `trim`: change `at`/`in` (head) or `len` (tail); clamped to media, never overlaps a neighbour unless
  `ripple: true` (then later clips on the track shift).
- `split at=F`: two clips; the second gets `in += (F - at) × speed`, keyframes and cues are divided
  and re-based, animations keep their clock (`animate` gets an offset, so a cut never restarts a
  text animation: a FrameCraft lesson).
- `ripple-delete`: remove and close the gap on that track (or `all: true`: every track of the comp,
  keeping sync).
- `slip` (shift `in`), `slide` (move between neighbours, trimming them), `roll` (move a cut point
  between two adjacent clips): standard NLE semantics, defined in `docs/reference/editing.md` with
  diagrams and tested frame by frame.
- `speed`: changes `len` to keep the same source range unless `keep: "len"`; audio pitch preserved by
  default (`atempo`).

---

## 6. CLI, SDK and file edits: three ways in

### 6.1 CLI

Binary `michelangelo` with short alias `mgl` (Ask, §13). Nine verbs:

| Verb | Does |
|---|---|
| `new [preset] [--from script.txt\|--template id] [-o file]` | create a project (`shorts` 1080×1920, `youtube` 1920×1080, `square`, `portrait`); with `--from` a first edit from a script |
| `show <file> [--at t] [--clip id] [--comp id] [--frames]` | the outline: one line per track and clip (id, kind, span, text or asset, fx); `show media.mp4` probes a media file |
| `edit <file> <op> [k=v ...] \| '<json>' \| --batch f.jsonl [--dry-run]` | apply commands; prints what changed in ≤ 10 lines |
| `check <file>` | validate + QA checks that need no pixels (overlaps, gaps, missing media, text off the safe zone by layout) |
| `look <file> [--at t,...] [-n 12] [--comp id]` | contact sheet + crops + QA with pixels + sound report |
| `render <file> [out] [--draft\|--final] [--range a-b] [--still t]` | estimate, render, verify (format from the extension: mp4, webm, mov, gif, png, wav, mp3) |
| `docs [topic\|op]` | offline docs: the skill, a topic reference, or one command's schema and example |
| `plugin new\|test\|list <...>` | scaffold, test and list plugins |
| `doctor` | node, ffmpeg (which one, version, encoders/decoders that matter), fonts, cores, memory, disk, proxy, plugins |

Arguments: `k=v` pairs parsed against the command schema (`edit p.json clip.split title at=2.5s`; the
first bare word fills the command's primary field, usually `id`). `--json` on every verb prints one JSON
object (`{"ok": true, ...}` or `{"ok": false, "error": {code, message, fix, line?}}`).

Output example:

```
$ mgl show video.mgl.json
main 1080x1920 30fps 30.00s · 5 tracks · 14 clips · 22 cues · plugins: glitch
T1  title   text  0.00–2.50  "Three tips to focus"  pop/word
T1  subs    caps  2.50–30.00 22 cues, style karaoke
V2  logo    image 0.00–30.00 logo.png  x=960 y=160 scale=0.4
V1  shot1   video 0.00–4.00  beach.mov [1.60–5.60]
V1  shot2   video 4.00–7.00  beach.mov [10.00–13.00]  ⟵crossfade 0.33
A1  vo      audio 0.00–28.00 vo.wav  bus dialogue
A2  bed     audio 0.00–30.00 bed.mp3 -6dB fade 1.00/2.00  bus music (ducked 9dB by dialogue)
```

### 6.2 SDK

```js
import { open, create } from 'michelangelo';
const p = await open('video.mgl.json');          // load + validate; throws MglError with line + fix
p.edit({ op: 'clip.add', track: 'T1', at: '2s', len: '3s', text: 'Hello' });
p.edit([{ op: 'clip.split', id: 'shot1', at: 60 }, { op: 'audio.duck', bus: 'music', by: 'dialogue', db: 9 }]);
const plan = p.dryRun({ op: 'clip.ripple-delete', id: 'shot2' });   // { changes, summary }
await p.save();                                   // the formatter; same bytes the CLI writes
const report = await p.look({ frames: 12 });      // same as the CLI verb
await p.render('out/final.mp4', { quality: 'final' });
```

The SDK object model is thin on purpose: `p.project` is the plain validated data (read it, never mutate
it directly), and every change is `p.edit(command)`. Helpers (`p.clip(id)`, `p.clips({track})`, `p.at(t)`)
are queries only.

### 6.3 Direct file edits

Agents will edit the file; the design accepts it. Value tweaks (`"y": 420` → `"y": 380`) are best done by
editing the line. Structural changes (split, ripple, captions import) are commands, because they touch
several lines consistently. The skill says exactly this.

---

## 7. Rendering

### 7.1 Pipeline

```
project ──evaluate(comp, frame)──▶ display list ──Renderer.drawFrame──▶ RGBA frame ──▶ Encoder (ffmpeg)
  (pure TS: resolves keyframes,      (layers with resolved          (Skia: layers, text,
   time remap, visibility, text       transform, opacity, blend,     shapes, masks, blends,
   layout inputs, transitions)        source refs, fx params)         layer fx)
                    ▲
       FrameSources (ffmpeg decoders, one per media clip, sequential streams; source-stage fx in the
       filter graph; seek-and-grab for stills)
Audio: the whole mix is one ffmpeg filter graph (trims, delays, gains and fades from keyframes, buses,
sidechain ducking, loudness normalisation) rendered once to 48 kHz PCM, then muxed.
```

- **`evaluate` is pure** (no Skia, no ffmpeg) and unit-tested without native code. It is also what
  `check` uses for pixel-free QA (text boxes against safe zones need text metrics, which come from a
  small font-metrics module that reads the same fonts Skia uses).
- **Renderer interface** (`src/render/renderer.ts`, part of the plugin API):

  ```ts
  interface Renderer {
    id: string;                      // 'skia' (built in); a GPU renderer is a plugin
    open(opts: { width; height; fonts: FontSet }): Promise<RenderSession>;
  }
  interface RenderSession {
    drawFrame(list: DisplayList, sources: SourceFrames): Promise<Frame>;   // Frame = RGBA bytes + size
    close(): Promise<void>;
  }
  ```
  The media side has its own interface (`MediaBackend`: `probe`, `openVideo(src, {in, rate, size,
  filters})`, `grabFrame`, `renderAudio(graph)`, `encode(opts) → FrameSink`, `analyze(audio)`), backed
  by native ffmpeg. Both are swappable; neither leaks Skia or ffmpeg types into the engine.
- **Encoding**: frames piped raw (`rgba`) to one ffmpeg process per output segment. Presets:

  | Quality | Video | Use |
  |---|---|---|
  | `still` | PNG | single frames, `look` |
  | `draft` | half size (long edge ≤ 960), x264 `ultrafast` crf 28, AAC 96k | timing and sound checks |
  | `final` | full size, x264 `veryfast` crf 20 (or `medium` with `--hq`), AAC 192k, `+faststart`, yuv420p, BT.709 tagged | delivery |
  | other | WebM VP9/Opus, ProRes 422 `.mov`, GIF (palettegen two-pass, ≤ 15 fps), WAV, MP3 | by extension |

- **Parallelism**: if the single-process estimate exceeds the target, the frame range is split into
  up to `cores` contiguous segments rendered by worker processes, each with its own encoder; segments
  are joined with the concat demuxer (no re-encode; GOP aligned at segment starts); audio is rendered
  once. This is the same split a future render cloud would use.
- **Estimates**: `render` renders 3 sample frames (start, middle, busiest by layer count), times them,
  adds measured encoder throughput for the preset, and prints `est. 24 s (final 1080x1920 30.0 s,
  ≈0.8x real time)` before starting. After the render it prints the actual time and verifies the output
  with ffprobe (duration, streams, size).
- **Determinism**: same project + same Michelangelo version + same fonts → same frames (bit-exact on the
  same platform). Fonts are bundled (open-licence: Inter, Noto Sans subsets, a display face, a mono face)
  so text renders the same everywhere; system fonts are opt-in by asset.

### 7.2 Media input

ffprobe on `asset.add` (cached): container, streams, codec, size, rate, rotation, colour, duration.
HEVC, H.264, ProRes, VP9, AV1 (if the build has it) decode through ffmpeg; iPhone rotation metadata and
HDR (HLG/PQ → SDR tone map via `zscale`/`tonemap` when available) handled in the decode graph. Images
(PNG, JPEG, WebP, SVG via Skia), audio (WAV, MP3, AAC, Opus, FLAC).

### 7.3 ffmpeg acquisition

Order: `MGL_FFMPEG` env → system `ffmpeg`/`ffprobe` on PATH if version ≥ 6.0 and it has libx264 + aac →
cached static build in `~/.cache/michelangelo/ffmpeg/<version>/` → download.

- Download: a pinned manifest (`src/media/ffmpeg-builds.json`: per platform URL, size, SHA-256) for
  linux-x64, linux-arm64 (BtbN FFmpeg-Builds / John Van Sickle static builds), darwin-x64/arm64,
  win-x64. Downloaded by Node's `fetch` with an `undici` `EnvHttpProxyAgent` (respects `HTTPS_PROXY`,
  `NO_PROXY`), with `NODE_EXTRA_CA_CERTS` honoured, a progress line, resumable, verified by checksum
  before it is made executable. Never committed, never bundled in the npm package.
- Licence: these builds are GPL (they include x264). They are downloaded by the user's machine as a
  separate program and run as a subprocess; nothing GPL is linked into or shipped with Michelangelo.
  `doctor` says which build and licence is in use.

---

## 8. look: checking work without watching it

`mgl look video.mgl.json` (target < 10 s for 12 frames at 1080×1920):

1. Pick frames: 12 evenly spaced plus the first frame of every clip change if `--cuts`, or `--at`.
2. Render them at half size (stills path, parallel decoders), assemble a **contact sheet** (grid,
   timestamp + frame number under each, long edge ≤ 1568 px) → `.mgl/look/sheet.png`.
3. **QA checks** (each a plugin-API check, so plugins can add more):
   safe zones per platform (Shorts / TikTok / Reels UI overlays), text overlapping another visible
   element (e.g. a caption over a logo, by rendered alpha, not by box), tiny text (cap height < 2.5 %
   of the frame height at rest), text cut off by the frame, black or frozen stretches (decoded luma /
   frame difference on a low-res pass), gaps on the main track, clipping audio (true peak > −1 dBTP),
   loudness off target, music louder than dialogue where both play.
   Each finding: one line with the clip id, time, file line and a suggested command; plus a zoomed crop
   (`.mgl/look/qa-<n>.png`) with the offending boxes outlined.
4. **Sound as text** (ffmpeg `ebur128`, `silencedetect`, `astats` + a JS onset detector on a mono
   11 kHz decode): integrated LUFS, true peak, loudness range, silences > 0.5 s with times, beats/tempo
   estimate, per-bus levels, and where ducking engages.

Output (≤ 40 lines):

```
wrote .mgl/look/sheet.png (12 frames 0.00–29.50, 1536x1152) in 4.1 s
QA 2 issues
  1 warn caption "subs" overlaps "logo" at 7.80s (cue c9)   .mgl/look/qa-1.png  line 21  fix: mgl edit video.mgl.json clip.set logo y=120
  2 warn music −4 LU under voice only; voice masked 12.0–15.0s   fix: mgl edit video.mgl.json audio.duck bus=music by=dialogue db=9
sound -15.8 LUFS, peak -1.2 dBTP, LRA 6.1 · silences 3.10–3.90, 19.40–20.20 · ~112 BPM
```

---

## 9. Plugins

### 9.1 What a plugin can contribute

effects (source and/or layer stage), transitions, generators (clip kinds that draw: gradients,
particles, counters, ...), templates, commands, QA checks, importers (e.g. EDL / FCPXML / Lottie),
exporters (new output formats), and later renderers and AI providers (transcription, TTS, segmentation:
hooks only in v1).

### 9.2 Shape

A plugin is an npm-style folder:

```
plugins/glitch/
  package.json            name, version, type: module, "michelangelo": { "api": "^1.0.0", "kinds": ["effect"] }
  src/index.ts            export default definePlugin({ ... })
  test/glitch.test.ts     uses michelangelo/testing (render a 1-clip comp, assert pixels)
  evals/glitch-basic/     an eval task for the plugin (same format as §11)
  README.md
```

```ts
import { definePlugin, defineEffect, z } from 'michelangelo/plugin';

export default definePlugin({
  name: 'glitch',
  effects: [
    defineEffect({
      type: 'glitch',
      params: z.object({ amount: z.number().min(0).max(1).default(0.5), seed: z.number().int().default(1) }),
      stage: 'layer',
      draw({ layer, ctx, params, frame, rng }) { /* Skia via a CanvasRenderingContext2D-compatible ctx */ },
      // or: source({ params }) => 'hue=s=0'   (an ffmpeg filter string for the source stage)
    }),
  ],
});
```

- **Stable interfaces only**: plugins see `michelangelo/plugin` types: `LayerContext` (a
  `CanvasRenderingContext2D`-compatible context: a web standard, so a GPU renderer can provide the same
  contract), `Surface` (pixel access, offscreen surfaces), `ffmpeg` filter strings for the source stage,
  `MediaBackend` for importers / exporters, the command `defineCommand`, the QA `defineCheck`. Never
  `@napi-rs/canvas` or child processes directly.
- **Parameters are animatable** if declared numeric/colour: keyframes work for plugin params with no
  plugin code.
- **Manifest**: `api` is a semver range on the plugin API (`1.0.0` at v1; minor = additive, major =
  breaking). A plugin outside the range is refused with the reason.
- **Loading**: only plugins named in the project (`"project": {"plugins": {"glitch": "^1.0.0"}}`) or in
  `mgl.config.json` load. Resolution: `./plugins/<name>` next to the project, then `node_modules`.
  Never auto-discovered from the working directory (auto-loading code from a cloned repo is an attack
  surface). Built-in plugins (core effects) are always available and listed by `doctor`.
- **`mgl plugin new effect glitch`** scaffolds the folder above with a working effect, a passing test,
  an eval task and a README; `mgl plugin test plugins/glitch` type-checks, runs its tests, renders its
  preview still and validates the manifest. An agent can write, test and register a plugin in one loop.

### 9.3 Built on the public API

Core effects and transitions live in `src/builtin/<name>/` and import only `michelangelo/plugin`
(enforced by a lint rule and a test that scans imports). Example third-party plugins in
`examples/plugins/`: **glitch** (layer effect, RGB split + slices), **clock-wipe** (transition),
**confetti** (generator with seeded particles), and **lower-third-pro** (template + command).

---

## 10. Errors and exit codes

```
MglError { code: 'E_REF', message, fix, line?, path?, did_you_mean? }
```

| Exit | Meaning | Example |
|---|---|---|
| 0 | ok (warnings may be printed) | |
| 1 | the input is wrong: file, command, arguments, media | `E_SCHEMA line 9: "opactiy" is not a clip property. fix: did you mean "opacity"?` |
| 2 | the environment is wrong: ffmpeg missing or too old, no disk, network | `E_FFMPEG: no ffmpeg found. fix: run "mgl doctor --fetch" (downloads a pinned static build, 80 MB)` |

Codes are stable strings, listed in `docs/reference/errors.md` with the fix for each. Every message
names its fix; a test asserts that every thrown error has a non-empty `fix`.

---

## 11. Evals

### 11.1 Task format

```
evals/tasks/<id>/
  task.md          the prompt the agent gets, written as a person would ask
  setup.mjs        generates fixtures into the sandbox (ffmpeg lavfi, flite speech, tones), copies inputs
  grade.mjs        objective grader: exports async function grade(sandbox) → { pass, score, checks[] }
  meta.json        { tags, expected_difficulty, timeout_min, expects_weak?: true }
```

Graders use a shared library (`evals/lib/`): `probe` (ffprobe: duration, codecs, size, streams),
`frames` (decode frames at times; pixel probes; non-black / non-static checks), `ssim` (against golden
frames rendered by a reference solution), `loudness` (ebur128, true peak), `silences`, `captions`
(parse SRT/VTT or the project's cues; timing tolerance), `project` (load + validate with the library;
queries on the model). Every grader must call `assertNotEmpty` (non-black, non-static, non-silent where
audio is expected), enforced by the runner: a grader that passes on an empty fixture output fails CI.
An optional vision grade (the contact sheet sent to the model with a rubric) is reported separately and
never turns a failed objective grade into a pass.

### 11.2 Main set (30 tasks, written before the features)

See `evals/tasks/README.md` for the full list. Coverage: a Short from a script, captions from SRT/VTT,
fix a caption overlapping a logo, reframe 16:9 → 9:16, duck music under voice-over, cut silences, HEVC
import, ProRes import, 10 variants from a CSV via the SDK, a 200-clip project edit, write a new effect
plugin, write a transition plugin, lower third, intro template, CTA, keyframed title, per-word text
animation, nested comp, masks, blend modes, J/L cuts, speed ramp and freeze, loudness normalisation to
−14 LUFS, GIF export, WAV/MP3 export, fix a broken hand-edited file, split + ripple on a music beat,
slip/roll trims, a picture-in-picture, and tasks expected to be weak (beat-synced cuts, a 3D-ish
camera move, keying a green-screen clip, matching colour between shots).

### 11.3 Held-out set (10 tasks)

Written by a separate agent into `evals/heldout/` in the same format; the builder (this session's
orchestrator and its workers) never reads that directory. Only the eval runner and graders touch it.
`CLAUDE.md` tells every agent not to open it.

### 11.4 Runner

`node evals/run.mjs [--set main|heldout] [--tasks a,b] [--parallel 3]`:

- Each task runs in a **fresh sandbox**: a new directory with `npm pack`ed Michelangelo installed from
  the tarball, its docs (`SKILL.md` in `.claude/skills/michelangelo/`), and the task's fixtures; a fresh
  `HOME` (so no session memory), no access to the repository source (the sandbox is outside it and the
  prompt says to use only the installed package; reads of the repo path are counted as violations from the
  transcript). Where available, fresh cloud sessions (`create_session`) give real separate containers
  for spot checks.
- `claude -p --output-format stream-json --verbose --model <this model> --permission-mode bypassPermissions`
  with the task prompt; no token budget limit; per-task wall-clock limit from `meta.json`.
- Recorded per run: pass/score per grader check, turns, input/output/cache tokens, wall time, shell
  timeouts (tool results with timeout markers), failed file edits (Edit tool errors), Michelangelo error
  codes seen, and the CLI verbs used. Results to `evals/results/<date>-<milestone>/` (JSONL + summary.md);
  history kept in git, summary table in `evals/HISTORY.md`, main and held-out reported separately.

---

## 12. Performance plan

| Target (this machine) | Plan | Basis |
|---|---|---|
| `look` 12 frames < 10 s | half-size stills, decoders in parallel (one ffmpeg seek per source), Skia ~3 ms/frame | 540×960 composite measured 2.7 ms |
| draft 540×960 ≤ 1× real time | `ultrafast`, single process | measured 0.32× incl. encode |
| final 1080×1920 ≤ 3× real time (30 s Short) | single process `veryfast`; split into 2–4 segments if the estimate is over target | measured 1.16× incl. encode, before decode cost |
| vs FrameCraft 6.4× | report side by side | spike numbers |

Risks: decoding 1–2 1080p video layers adds ~5–10 ms/frame each (ffmpeg, separate processes, so it
runs in parallel with compositing); RGBA pipe bandwidth (8.3 MB/frame) is fine at 30–60 fps; heavy
layer blurs in Skia are the likely hot spot (mitigate: blur at reduced resolution for large radii).

`scripts/bench.mjs` builds three reference projects (a typical 30 s Short; text-only motion graphics;
2 video layers + PiP), measures look / draft / final, and prints a table against the targets and
FrameCraft's 6.4×. Results are committed to `bench/results/`.

---

## 13. Decisions needing the owner (Ask)

1. **Repository visibility**: `samsam32118/Michelangelo` exists and is **public**. The brief said
   private. I can't change visibility with my tools; please switch it in GitHub settings if you want
   it private (also keeps the held-out eval tasks unseen by crawlers).
2. **npm name**: `michelangelo` is taken. Proposal: `@samsam32118/michelangelo` or an org scope
   (`@michelangelo-video/core`). Not needed until publishing.
3. **CLI short name and file extension**: proposal `mgl` and `*.mgl.json` (plus `michelangelo` as the
   long binary name).
4. **Bundled fonts**: Inter + Noto Sans (OFL) + a display face (e.g. Anton, OFL) + JetBrains Mono (OFL),
   about 2 MB in the package. OK?

## 14. Reversible decisions taken (R)

- zod 4 for schemas (types + JSON Schema from one source); vitest for tests; tsup/tsc for builds;
  `jsonc-parser` for line-aware parsing; `undici` for proxy-aware downloads. All MIT/BSD/Apache.
- `@napi-rs/canvas` (MIT, prebuilt Skia binaries) as the compositor.
- Tables-with-references file layout (§4.1) instead of nested JSON.
- Integer frames in the file; time strings accepted on input and normalised on save.
- History in `.mgl/history.jsonl` next to the project (git-ignored by `mgl new`'s `.gitignore`).
- Fonts bundled (pending §13.4), deterministic rendering.
- CI: GitHub Actions, one job: typecheck, unit tests, docs examples, a 2-second render smoke test,
  `npm pack` licence check (no GPL file in the tarball).
- Repository layout:

  ```
  src/core/      schema, time, ids, load/save (formatter), commands, history, evaluate (pure TS)
  src/render/    Renderer interface, Skia renderer, text layout, masks, blend modes
  src/media/     ffmpeg acquisition, probe, decode, encode, audio graph, analysis
  src/qa/        checks, contact sheet, look
  src/builtin/   core effects, transitions, generators, templates (public plugin API only)
  src/plugin/    plugin API (michelangelo/plugin), loader, scaffolder, testing helpers
  src/cli/       the 9 verbs
  src/sdk/       open/create
  docs/          SKILL.md, reference/*.md (every code block executed by tests)
  schema/        v1.json (generated)
  evals/         tasks/, heldout/ (do not read), lib/, run.mjs, results/, HISTORY.md
  examples/      plugins/, projects/
  scripts/       bench.mjs, gen-schema.mjs
  ```

## 15. Build order

1. Core: schema, time, file format (formatter + line-aware loader), commands + history, evaluate.
2. In parallel (a workflow, one agent per module, disjoint directories, the core as the contract):
   media (ffmpeg layer + audio), render (Skia), text + captions, effects/transitions (as builtin plugins),
   CLI + SDK, plugin system + scaffolder, QA + look, evals (graders + runner).
3. Vertical slice: `new → edit → look → render` here; draft PR.
4. Adversarial review at the design stage and each milestone; eval runs (main + held-out) after each.

---

## 16. Design review resolutions (binding; they override earlier sections where they differ)

An adversarial review (2026-10-03) found 24 problems. Each is resolved here; the numbers are the review's.

| # | Problem | Resolution |
|---|---|---|
| 1 | Eval sandbox not isolated: the tested agent could read graders, held-out tasks, source | The agent runs as a separate Unix user (`mgleval`) in `/home/mgleval/runs/<id>`; the repository is unreadable to that user (mode 0700, root-owned) during runs. The sandbox gets only `task.md`, fixtures and a pre-installed copy of the packed library (offline, copied from a template install, so no registry access is needed); its HOME has only the Claude credentials and a seeded ffmpeg cache. Grading runs as root after the agent exits, outside the sandbox. Fresh cloud sessions remain an optional cross-check |
| 2 | Transitions defined two ways | **Cut-centred with handles.** Clips never overlap on a track. `"transition": {"in": {"type", "len", "align"?: "center"\|"start"\|"end"}, "out": {...}}`. The transition between A and B is B's `in`, centred on the cut by default, using media beyond A's end and before B's start (handles); where a handle is missing the edge frame is held and `check` warns. `out` with no adjacent following clip fades to transparent. Comp length = sum of lengths (import-prores fixed: 6 s) |
| 3 | Styles missing | A `styles` table (one style per line; same fields as `TextStyle`, plus `base` to inherit). A clip's `style` is a style id or an inline object; an inline object may have `base: "<id>"` and overrides field by field. Built-in styles (title, subtitle, caption, karaoke, lower-third, cta, label) come from the builtin plugin. Added text fields: `maxLines`, `box` (fixed [w, h]) |
| 4 | Plugin loading not a trust boundary; ffmpeg filter injection | A plugin found next to a project loads only after `mgl plugin trust <path>` (name + content hash in `~/.config/michelangelo/trusted.json`); otherwise `show`/`check` still work and say "untrusted plugin X (fix: mgl plugin trust ...)", and `render`/`look` refuse with that fix. Plugins are trusted code with no sandbox; the docs say so. Source-stage contributions are structured (`{filter: 'hue', args: {s: 0}}`), escaped by the core and checked against an allowlist (no `movie`, `amovie`, `sendcmd`, file-reading filters) |
| 5 | Nested comp time and audio | child frame = `in + floor(local × speed × childRate / parentRate)` (rational). After the child comp's end: transparent, or repeat with `loop: true`. Audio of nested comps is flattened: every audio-bearing leaf clip is placed at its absolute time in the rendered comp and mixed into its own track's bus. Buses are project-global |
| 6 | Speed / freeze / keyframes | `clip.freeze at= len=` splits and inserts a held clip (speed 0, audio silent). `clip.speed` keeps the source range (len = range / speed) and leaves keyframes alone; `check` warns if keys fall outside. **Time remap**: a `remap` keyframe property (source frame by clip frame) is the one speed-ramp mechanism. Speed with conformed rates is computed on source PTS (see 8), not on conformed frames |
| 7 | Sample-exact audio | `sample(f) = floor(f × 48000 × den / num)` from absolute frames; spans are `[sample(at), sample(at+len))`; ffmpeg gets `atrim=start_sample/end_sample` and `adelay=<n>S` in a `-filter_complex_script`; probe normalises `start_time` and priming. Unit test: 1000 back-to-back 1-frame clips at 30000/1001 sum exactly |
| 8 | Decode not frame-accurate (VFR, B-frames, start PTS) | A per-asset frame index (PTS list, cached) built on probe; comp frame → source PTS explicitly; decode with accurate seek then select by PTS. Tested against counter fixtures at 24, 25, 29.97 and VFR |
| 9 | No A/V link | Video clips play their embedded audio by default (to their track's bus; `muted: true` silences). `clip.detach-audio` creates an audio clip on an audio track, mutes the video's audio, and links them. `link: "<group>"` on clips: trim/split/move/ripple/slip/roll act on all clips of a link group unless `unlinked: true` |
| 10 | Cue times absolute | **Cue `at` is local to its captions clip** (0 = the clip's first frame); `words` are offsets from the cue start. Moving the captions clip moves its cues |
| 11 | Undo fragile | History entries store `{command, forward, inverse, pre/post hash of each touched entity}`; undo/redo apply the stored patch when the touched entities still match, so unrelated hand edits don't block it. Redo replays the stored patch (never re-runs analysis). Writes are atomic (temp + rename) under a lock file; the SDK's `save()` refuses if the file changed since `open` (with a fix). `undo`/`redo` are CLI subcommands of `edit`, not commands |
| 12 | `.mgl/` per directory | `.mgl/<project-basename>/` holds history, look output and render state |
| 13 | Errors block the fix | Load errors (JSON, schema, references, cycles) block everything except `check`. Semantic issues (overlaps, cues/keys outside clips) are errors for `render` only; `edit` runs when it does not increase their number, and prints them |
| 14 | Commas, reformatting, duplicate ids | Trailing commas accepted (warning, removed on save). `edit` prints the changed lines with their line numbers; the skill says to re-read after `mgl edit`. Example ids fixed. Time strings are a hand-writing convenience; the writer stores integers |
| 15 | `show` > 40 lines | `show` prints at most 40 lines: comp summary, per-track counts, then clips until the budget, with `--track`, `--from/--to`, `--all` (writes `.mgl/<p>/show.txt` and prints its path). Same paging for `check` and `look` findings |
| 16 | Renders > 10 min | `render --detach` writes `.mgl/<p>/render.json` (pid, progress, ETA, result) and returns; `mgl render --status`. Segments are resumable chunk files |
| 17 | Gameable / circular graders | Graders decode outputs with plain ffmpeg and read the project as raw JSON, never through Michelangelo. Invariants added (no hiding, no opacity 0, cue text unchanged, unchanged levels where nothing should change). Goldens come from fixture sources rendered by ffmpeg, not from Michelangelo |
| 18 | TS plugins in a fresh sandbox | Node 22 strips types natively (enabled by default since 22.18); plugins are `.ts` with erasable syntax only, imported directly. `plugin test` runs `tsc` if available and says so if not. CI tests the scaffold from the packed tarball |
| 19 | Pixel plugins and decode cost | Decoders scale to the layer's rendered size and run with capped threads; the plugin API offers `pixels()` (the frame's RGBA buffer, no extra copy) and a `lut()` helper for per-channel effects; the estimate samples the busiest frame including effects; the benchmark includes 2 HEVC layers and a 4K source |
| 20 | Colour and font metrics | Explicit BT.709 matrices and ranges on encode (`scale=out_color_matrix=bt709:out_range=tv`) and per probed metadata on decode; a round-trip colour test. Text is measured with the same Skia text API everywhere; `evaluate` stays pure by taking an injected measurer |
| 21 | Feature gaps | Effects (12): blur, glow, shadow, vignette, chroma-key, color (brightness/contrast/saturation/hue/temperature), lut, denoise, sharpen, grain, pixelate, stroke. Transitions (9): crossfade, dip, wipe, slide, push, zoom, blur, spin, flash. `fx` is an ordered array, addressed `fx.0.radius` or `fx.blur.radius` (first of that type). `matte: {clip, mode: alpha\|luma\|alpha-inverted\|luma-inverted}`. Mask modes add/subtract/intersect. Alpha output: ProRes 4444 `.mov` and VP9 `.webm` with `--alpha`. SRT/VTT export (`render out.srt`). `comp.reframe` with `track: true` runs a low-res motion-centroid pass and writes `x`/`y` keyframes (smoothed); otherwise a static fit rule |
| 22 | `comp.set fps` | Rescales every time in the comp (rounded, reported) |
| 23 | QA exit codes | `look`/`check` exit 0 with findings unless `--strict` (exit 1 on any error-level finding); `--json` has `issues: N` |
| 24 | Drift | `id.rename` command rewrites references; `clip.set` of a constant on a keyframed property is an error naming `key.clear`; plugin `draw` must be a pure function of (params, frame, seed); each render segment starts with an IDR and the frame count per segment is exact; `doctor` reports whether fixture tools (flite, drawtext) exist |

### 16.1 Eval isolation as built (2026-10-04)

The user-level sandbox of #1 needs the agent's credentials copied to another Unix user, and a mount-namespace
variant needs privileged namespace tricks; both were refused by this environment's safety policy, rightly. What runs
instead ("audit" isolation, `evals/run.mjs --no-sandbox`):

- each task runs in a fresh directory outside the repository, with a fresh `HOME` (no memory, settings or skills
  other than the copied Michelangelo skill) and only the packed library installed from a tarball;
- the agent runs `claude -p` in the default permission mode with an allowlist (file tools, and the shell for `npx`,
  `mgl`, `node`, `npm`, `ffmpeg`, `ffprobe` and plain file commands; no web tools), never `bypassPermissions`;
- the agent is not technically prevented from reading the repository; every tool call touching a path outside its
  run dir (`/home`, `/root`, the scratchpad, `evals/`) is recorded as a violation and reported per task, and a run
  with a violation that reads graders or held-out tasks is counted as a failure;
- grading runs after the agent exits, with the grader-only files stashed outside the run dir while the agent works.

Fresh cloud sessions (separate containers) remain the stronger option for the held-out set when available.
- **Held-out hygiene.** The first held-out run printed task ids in its public summary, which the builder read;
  the set (`evals/heldout`) is now an exposed regression set. Held-out set v2 (`evals/heldout2`) replaces it,
  and the runner aliases held-out ids (`h-<hash>`) in every public log, directory and summary.
