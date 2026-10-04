# Text and captions

## Text clips

A text clip is `{"text": "...", "style": ...}` on a visual track. `x`, `y` place the text box's anchor
(default: the comp centre); long text wraps at `style.maxWidth` and shrinks to fit `maxLines` or `box`.
Fonts bundled with Michelangelo render the same everywhere: **Inter**, **Noto Sans**, **Anton** (display),
**JetBrains Mono**. Another font is an asset (`asset.add fonts/Brand.ttf id=brand-font`) used as
`"font": "brand-font"`.

```sh
mgl new shorts -o text.mgl.json
mgl edit text.mgl.json clip.add id=bg track=V1 len=4s gen='{"type": "gradient", "colors": ["#141e30", "#243b55"]}'
mgl edit text.mgl.json clip.add id=title track=T1 len=3s text="Three tips to focus" style=title y=640
mgl edit text.mgl.json clip.set title style='{"base": "title", "maxWidth": 800, "color": "#ffd400"}'
mgl edit text.mgl.json text.set title text="Three ways to focus"
```

## Styles

`style` is a style id or an inline object. Ids come from the project's `styles` table or the built-ins:
`title`, `subtitle`, `caption`, `karaoke`, `pop`, `boxed`, `lower-third`, `cta`, `label`, `body`
(`mgl docs title` shows one). A style may inherit with `base`; an inline object may too, and overrides
field by field. When a clip's style is an inline object, change one field with a dotted path:
`clip.set title style.color=#ffffff`; to restyle a clip that uses a style id, give an object with `base`.

```sh
mgl edit text.mgl.json style.add brand base=caption color=#00e5ff size=70
mgl edit text.mgl.json style.set brand stroke=null
```

## Animation

Three tools, from simplest to most control:

1. **Presets per unit**: `text.animate <id> in=<preset> out=<preset> by=char|word|line|all stagger=3 len=10`
   (frames). Presets: fade, pop, slide-up, slide-down, slide-left, typewriter, blur-in, bounce, scale-in,
   drop, wave, none. Splitting a clip never restarts its animation (the second half keeps the clock).
2. **Keyframes** on any numeric property: `key.set <id> prop=y at=0 value=700`, `key.set ... at=0.4s value=640 ease=outBack`.
   Times are clip-local. `key.clear <id> prop=y value=640` goes back to a constant.
3. **Hand-written keyframes** on the line: `"scale": [[0, 0.8], [12, 1, "outBack"]]`.

```sh
mgl edit text.mgl.json text.animate title in=pop by=word stagger=4
mgl edit text.mgl.json key.set title prop=y at=0 value=700
mgl edit text.mgl.json key.set title prop=y at=0.4s value=640 ease=outBack
mgl edit text.mgl.json clip.split title at=1.5s
mgl show text.mgl.json
```

## Captions

A captions clip (`"captions": true`) shows its cues; each cue is a line in the `cues` table with `at` and
`len` relative to the clip start and optional per-word start offsets (`words`). The style decides the
look: `caption` (plain), `karaoke` (the spoken word in `highlight`), `maxWords` (pages of N words).

- `captions.import <file.srt|vtt>`: cues from subtitles (file times are comp times; `offset=` shifts them;
  VTT inline timestamps give word timings, `words=true` estimates them otherwise).
- `captions.from-text text="..."` or `file=script.txt`: split a script into cues of ≤ `maxWords` words,
  timed to the speech of a voice clip (`voice=<clip>`, silences skipped) or spread over `at`+`len`.
- `captions.style <id> style=karaoke` or `style='{"highlight": "#00e5ff", "maxWords": 3}'`.
- `captions.shift <id> by=-0.5s` (subtitles running late), `cue.set c3 text="..."`, `cue.split c3 word=3`,
  `cue.merge ids='["c3","c4"]'`, `cue.add clip=subs at=1s len=1.5s text="..."`, `cue.remove c3`.
- `render <file> out.srt` (or `.vtt`) exports the cues.

```sh
mkdir -p media
printf '1\n00:00:00,500 --> 00:00:02,000\nPut your phone away\n\n2\n00:00:02,200 --> 00:00:03,800\nWork in short sprints\n' > media/subs.srt
mgl edit text.mgl.json captions.import media/subs.srt id=subs style=karaoke words=true
mgl edit text.mgl.json clip.set subs y=1300
mgl edit text.mgl.json cue.set c1 text="Put the phone away"
mgl edit text.mgl.json captions.style subs style='{"highlight": "#00e5ff", "maxWords": 3}'
mgl render text.mgl.json out/subs.vtt
mgl show text.mgl.json --at 2.5s
```

Keep captions inside the platform's safe area: `mgl check` reports text crossing it (by measured text
boxes) with a `fix:` (usually a `style.maxWidth` or a `y`). `mgl look` also reports captions that
overlap other visible elements, judged by the rendered pixels.
