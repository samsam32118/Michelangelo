# Text and captions

## Text clips

A text clip is `{"text": "...", "style": ...}` on a visual track. `x`, `y` place the text box's anchor
(default: the comp centre); long text wraps at `style.maxWidth` and shrinks to fit `maxLines` or `box`.
A line break is `\n` in the JSON string; on the command line pass the value as a JSON string
(`text='"Line one\nLine two"'`), since an unquoted `\n` is kept as the two characters. Fonts bundled with
Michelangelo render the same everywhere: **Inter**, **Noto Sans**, **Anton** (display),
**Montserrat** (400/700/800/900: the heavy social-caption look), **Bebas Neue** (tall display caps),
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
`title`, `subtitle`, `caption`, `karaoke`, `pop`, `boxed`, `lower-third`, `cta`, `label`, `body`, and two
social caption looks: `hormozi` (Montserrat Black upper case, heavy outline, 3 words, the spoken word in yellow)
and `word-pop` (one big Bebas Neue word at a time) (`mgl docs styles` lists them; `mgl docs title` shows one). A style may inherit with `base`; an inline object may too, and overrides
field by field. When a clip's style is an inline object, change one field with a dotted path:
`clip.set title style.color=#ffffff`; to restyle a clip that uses a style id, give an object with `base`.

```sh
mgl edit text.mgl.json style.add brand base=caption color=#00e5ff size=70
mgl edit text.mgl.json style.set brand stroke=null
```

## Animation

Four tools, from simplest to most control:

1. **Presets per unit**: `text.animate <id> in=<preset> out=<preset> by=char|word|line|all stagger=3 len=10`
   (frames). Presets: fade, pop, slide-up, slide-down, slide-left, typewriter, blur-in, bounce, scale-in,
   drop, wave, snap (words punch in like hits; best `by=word`), none. Splitting a clip never restarts its animation (the second half keeps the clock).
2. **Keyframes** on any numeric property: `key.set <id> prop=y at=0 value=700`, `key.set ... at=0.4s value=640 ease=outBack`.
   Times are clip-local. `key.clear <id> prop=y value=640` goes back to a constant.
3. **Hand-written keyframes** on the line: `"scale": [[0, 0.8], [12, 1, "outBack"]]`.
4. **Motion presets for any layer** (text, shapes, images, video, generators): `motion.apply <id> in=pop
   out=fade emphasis=pulse@2s loop=float` writes ordinary keyframes relative to the clip's rest values (merged with
   keys you set; applying a phase again replaces it; `motion.clear <id> [phase=]` removes them). `ids=[a,b,c]
   stagger=4` animates several clips in turn; `len=`, `period=` (a loop cycle) and `params=` tune them. Presets:
   in/out `fade`, `pop`, `slide-up|down|left|right`, `zoom`, `focus`, `drop`, `spin`, `whip`; emphasis `pulse`,
   `punch`, `shake`, `wiggle`, `bounce`, `nod`, `flash`, `tada`; loop `float`, `breathe`, `sway`, `spin`, `drift`,
   `ken-burns-in`, `ken-burns-out` (the authoritative list: `mgl docs motion.apply`). Plugins add presets
   (`motionPresets`, plugin API 1.3).

```sh
mgl edit text.mgl.json text.animate title in=pop by=word stagger=4
mgl edit text.mgl.json key.set title prop=y at=0 value=700
mgl edit text.mgl.json key.set title prop=y at=0.4s value=640 ease=outBack
mgl edit text.mgl.json clip.split title at=1.5s
mgl edit text.mgl.json clip.add id=badge at=0.5s len=3s shape='{"type": "ellipse", "size": [160, 160], "fill": "#ffd400"}' y=1100
mgl edit text.mgl.json motion.apply badge in=pop emphasis=pulse@1.5s loop=float out=fade
mgl show text.mgl.json
```

## Captions

A captions clip (`"captions": true`) shows its cues; each cue is a line in the `cues` table with `at` and
`len` relative to the clip start and optional per-word start offsets (`words`). The style decides the
look: `caption` (plain), `karaoke` (the spoken word in `highlight`), `maxWords` (pages of N words).

- `captions.import <file.srt|vtt>`: cues from subtitles (file times are comp times; `offset=` shifts them;
  VTT inline timestamps give word timings, `words=true` estimates them otherwise).
- `captions.from-text text="..."` or `file=script.txt`: split a script into cues of ≤ `maxWords` words. With
  `voice=<clip>` every word of the script is aligned to that clip's sound (a recorded voice-over and its script
  give karaoke captions without any plugin); without it the cues are spread over `at`+`len`.
- `captions.from-speech [clip=<voice clip>]`: word-timed cues from speech: the timings `audio.speak` stored, or
  a transcribe provider plugin (audio.md, "Speech"); with no `clip`, every voice clip on the dialogue bus.
- `captions.style <id> style=karaoke` or `style='{"highlight": "#00e5ff", "maxWords": 3}'`.
- `captions.shift <id> by=-0.5s` (subtitles running late), `cue.set c3 text="..."`, `cue.split c3 word=3`,
  `cue.merge ids='["c3","c4"]'`, `cue.add clip=subs at=1s len=1.5s text="..."`, `cue.remove c3`.
- `render <file> out.srt` (or `.vtt`) exports the cues.
- Keywords: mark words in a cue as `*word*` (or `*several words*`); a style with `emphasisColor` draws them in
  that colour (the spoken word still uses `highlight`). The marks are never shown or exported. `recipe.short`
  marks the script's numbers for you (`hormozi` has a green `emphasisColor`).

```sh
mkdir -p media
printf '1\n00:00:00,500 --> 00:00:02,000\nPut your phone away\n\n2\n00:00:02,200 --> 00:00:03,800\nWork in short sprints\n' > media/subs.srt
mgl edit text.mgl.json captions.import media/subs.srt id=subs style=karaoke words=true
mgl edit text.mgl.json clip.set subs y=1300
mgl edit text.mgl.json cue.set c1 text="Put the phone away"
mgl edit text.mgl.json captions.style subs style='{"highlight": "#00e5ff", "maxWords": 3}'
mgl edit text.mgl.json cue.set c2 text="Work in *short* sprints"
mgl edit text.mgl.json captions.style subs style='{"highlight": "#00e5ff", "emphasisColor": "#4ade80", "maxWords": 3}'
mgl render text.mgl.json out/subs.vtt
mgl show text.mgl.json --at 2.5s
```

### Captions in sync with speech

Both `captions.from-speech` and `captions.from-text voice=` time cues the same way, by rules that read as in
sync to people (`src/core/cue-timing.ts`, `CUE_TIMING`):

| setting | value | why |
|---|---|---|
| `lead` | 0.05 s | a cue appears just before its first word: text after the voice reads as late, a frame or two early reads as in sync |
| `wordLead` | 0.05 s | each karaoke word lights at its onset, by the same margin |
| `tail` | 0.3 s | a cue stays after its last word ends |
| `bridge` | 0.5 s | a shorter gap between two cues is closed (no flicker); a real pause leaves the screen clear |
| `minLen` | 0.7 s | the shortest a cue is shown, when the silence after it allows |
| `maxCps` | 17 | reading speed (characters per second) a cue is stretched towards, when the silence allows |

Word times come from the speak provider (checked against the sound: a word that starts a phrase starts where the
voice does), from a transcribe provider, or from **word alignment** (`src/core/align.ts`): the voice's loudness
every 10 ms is cut into voiced runs at pauses, the words are matched to the runs in order (lengths fit the
syllables, pauses fall at punctuation), and each boundary inside a run moves to the quietest point near it. It
needs no model and works in any language written with spaces. Its settings (`ALIGN_DEFAULTS`):

| setting | value | meaning |
|---|---|---|
| `hop` | 0.01 s | one loudness value per 10 ms |
| `minPause` | 0.08 s | a quieter stretch this long separates two voiced runs |
| `minRun` | 0.03 s | shorter bursts (clicks, breaths) are ignored |
| `snap` | 0.06 s | how far a boundary moves to the quietest point |
| `maxGroup` | 14 | most words or runs matched as one group |

Measured on Kokoro speech (8 two-sentence lines, 5 voices; truth: the model's own word times with phrase starts
moved to the sound): 72 % of words start within 100 ms and 90 % within 210 ms of the truth, phrase starts are
exact; spreading words over the line by their letters (what Michelangelo did before) gets 24 % and 421 ms. A
provider that reports word times, or a transcriber, is more exact inside a phrase; alignment is the fallback that
makes every voice captionable. `silenceDb=` on `captions.from-text` overrides the pause level for a noisy recording.

Keep captions inside the platform's safe area: `mgl check` reports text crossing it (by measured text
boxes) with a `fix:` (usually a `style.maxWidth` or a `y`). `mgl look` also reports captions that
overlap other visible elements, judged by the rendered pixels.
