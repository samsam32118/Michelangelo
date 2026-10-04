# The project file (`*.mgl.json`)

A project is one JSON file written **one entity per line**, grouped in tables, `id` first, keys in a
fixed order, defaults omitted. It is valid JSON (trailing commas and comments are accepted when you edit
by hand, and removed on the next save). The JSON Schema is `schema/v1.json` (`mgl docs schema`).

```json
{"michelangelo": 1,
"project": {"name": "Focus tips", "platform": "shorts", "plugins": {"glitch": "^1.0.0"}},
"assets": [
{"id": "vo-wav", "src": "media/vo.wav"},
{"id": "beach", "src": "media/beach.mov"}
],
"styles": [
{"id": "brand", "base": "caption", "color": "#00e5ff"}
],
"comps": [
{"id": "main", "size": [1080, 1920], "fps": 30, "bg": "#000000"}
],
"tracks": [
{"id": "V1", "comp": "main"},
{"id": "T1", "comp": "main"},
{"id": "A1", "comp": "main", "audio": true, "bus": "dialogue"}
],
"clips": [
{"id": "shot1", "track": "V1", "at": 0, "len": 120, "asset": "beach", "in": 48, "fit": "cover"},
{"id": "shot2", "track": "V1", "at": 120, "len": 90, "asset": "beach", "in": 300, "transition": {"in": {"type": "crossfade", "len": 10}}},
{"id": "title", "track": "T1", "at": 0, "len": 75, "text": "Three tips", "style": "title", "y": 420, "scale": [[0, 0.8], [12, 1, "outBack"]]},
{"id": "subs", "track": "T1", "at": 75, "len": 135, "captions": true, "style": "brand"},
{"id": "vo", "track": "A1", "at": 0, "len": 210, "asset": "vo-wav"}
],
"cues": [
{"id": "c1", "clip": "subs", "at": 0, "len": 45, "text": "Put your phone away", "words": [0, 6, 14, 22]}
],
"buses": [
{"id": "music", "duck": {"by": "dialogue", "db": 9}}
],
"markers": [
{"id": "drop", "comp": "main", "at": 150}
]
}
```

## Rules

- **Tables, not nesting.** Tracks point to their comp, clips to their track, cues to their captions clip.
  `grep '"track": "V1"'` finds a track's clips. Order inside `tracks` is the stacking order (later = on
  top; audio tracks mix). Order inside `clips` is free; the writer sorts by comp, track, start.
- **Ids** are unique across the project: letters, digits, `_`, `-`, `.`, starting with a letter or digit.
  Ids you give are kept; generated ones are readable (`title`, `shot-2`, `c17`). Rename with
  `id.rename <old> to=<new>` (it updates every reference).
- **Times are integer frames** at the comp's `fps` (an integer or `"30000/1001"`). When writing by hand
  you may use `"2.5s"`, `"1:02.5"`, `"00:01:02:15"` (timecode) or `"75f"`; saving stores frames.
  Clip `at`/`len`/`in`, keyframe times, cue times and fades are frames. Keyframe and cue times are
  local (0 = the clip's first frame); cue `words` are offsets from the cue start.
- **Defaults are omitted** (opacity 1, scale 1, speed 1, blend normal, in 0, anchor [0.5, 0.5] ...).
- **Nothing derived is stored**: media durations, sizes, layouts, thumbnails live in `.mgl/` caches next
  to the project. Deleting `.mgl/` is always safe (it also holds undo history and `look` output).
- **Unknown keys are errors** with the closest valid key (`"opactiy"` → did you mean `opacity`?).

## Entities

| Table | Fields |
|---|---|
| `project` | `name`, `platform` (shorts, tiktok, reels, youtube, none: safe zones and loudness target), `main` (default comp), `plugins` (name → semver range) |
| `assets` | `id`, `src` (path relative to the project file), `kind` (override), `note` |
| `styles` | `id`, `base` (inherit another style), and any text style field (below) |
| `comps` | `id`, `size` [w, h], `fps`, `length` (frames or `"auto"` = end of the last clip), `bg` |
| `tracks` | `id`, `comp`, `audio`, `bus`, `hidden`, `muted`, `locked` |
| `clips` | `id`, `track`, `at`, `len`, one source, then properties (below) |
| `cues` | `id`, `clip`, `at`, `len`, `text`, `words`, `speaker` |
| `buses` | `id`, `gain`, `muted`, `duck` {by, db, attack, release}, `loudness` {lufs, peak}, `to` |
| `markers` | `id`, `comp`, `at`, `len`, `note` |

**Clip sources (exactly one):** `asset` (video, image, audio), `text`, `shape` {type: rect, ellipse, line,
polygon, star, path, size, radius, fill, stroke, strokeWidth, gradient, trim}, `color` (a solid),
`comp` (nested comp), `captions: true` (shows its cues), `adjustment: true` (its fx apply to the tracks
below), `gen` {type, ...params} (a generator: gradient, particles, counter, ...).

**Clip properties:** `x`, `y` (where the anchor sits, comp px; default the centre), `anchor`, `scale`
(number or [sx, sy]), `rotate` (degrees), `opacity`, `blend` (normal, multiply, screen, overlay, add, ...),
`fit` (contain, cover, fill, none), `crop` [l, t, r, b], `in` (source offset, frames), `speed` (2, 0.5,
"3/2"; 0 = freeze), `remap` (source frame by clip frame, keyframed), `loop`, `gain` (dB), `fade` [in, out],
`muted`, `style` (a style id or an inline object), `animate` {in, out, by, stagger, len}, `fx` (ordered
effects `[{type, ...params}]`), `masks`, `matte` {clip, mode}, `transition` {in, out}, `parent`, `link`,
`clock`, `hidden`, `locked`, `tags`, `note`.

**Text style fields:** `font` (Inter, Noto Sans, Anton, JetBrains Mono, or a font asset id), `size`,
`weight`, `italic`, `color`, `align`, `lineHeight`, `letterSpacing`, `stroke`, `strokeWidth`, `shadow`,
`shadowBlur`, `shadowOffset`, `bg`, `bgPadding`, `bgRadius`, `maxWidth`, `maxLines`, `box` [w, h],
`uppercase`, `highlight` (captions: the spoken word), `maxWords` (captions: words shown at once), `base`.

**Keyframes** replace a constant with `[[frame, value, easing?], ...]`: `"x": [[0, 540], [15, 700, "outCubic"]]`.
The easing belongs to the segment that starts at that key: `linear`, `hold`, `in|out|inOut` ×
`Sine|Quad|Cubic|Quart|Expo|Back|Elastic|Bounce`, or a bezier `[x1, y1, x2, y2]`.

## Editing by hand

Change one value on its line; everything is re-validated on the next load and every problem names the
line and a fix. A file with errors blocks every verb except `check`:

```sh
mgl new square -o hand.mgl.json
sed -i 's/"fps": 30/"fps": 30, "opactiy": 1/' hand.mgl.json
mgl check hand.mgl.json || echo "exit $?"
sed -i 's/, "opactiy": 1//' hand.mgl.json
mgl check hand.mgl.json
```

Time strings written by hand are normalised to frames on the next save; seconds that fall between frames
are rounded with a note (`W_TIME_ROUNDED`).
