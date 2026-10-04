---
name: michelangelo
description: Edit videos and make motion graphics from the terminal with Michelangelo (mgl). Use when asked to cut, caption, title, animate, mix, check or render a video, or to write a video effect plugin. Projects are small line-oriented JSON files (*.mgl.json); mgl edits, inspects, checks (contact sheets, sound reports) and renders them.
---

# Michelangelo (mgl)

A project is one `*.mgl.json` file: valid JSON, one entity per line, readable ids. You change it with
commands (`mgl edit`), by editing a line yourself, or from a Node script (the SDK). You check your work
with `mgl look` (a contact sheet image plus QA and a sound report) because you cannot watch video.
Every command prints ≤ 40 lines (`--all` lifts the cap; `mgl docs <topic>` guides print whole); add `--json`
for one machine-readable object.

## Fastest: a finished Short in one call

From a script (text file), `mgl new shorts --script` builds a complete, QA-clean 9:16 Short: moving backgrounds
(or your `--media` b-roll), a hook title, word-highlighted captions, progress bar, CTA, transitions, a generated
music bed ducked under the voice, SFX on the cuts and platform loudness. Then look, and render.

```sh
printf 'Most people waste their mornings. Here are three habits that changed mine. Try them for a week.\n' > script.txt
mgl new shorts --script script.txt --style viral -o short.mgl.json
mgl look short.mgl.json -n 6 --fix
```

Options: `--vo vo.wav` (captions follow the voice) or `--voice default|<id>` (speaks the script with a speak
plugin, e.g. flite-voice, named in mgl.config.json), `--media a.mp4,b.jpg`, `--style viral|bold|clean`,
`--music bed.mp3|none`, `--cta "Follow for more"|none`. Numbers in the script become emphasised caption
keywords; mark your own as `*word*`. `look --fix` (and `check --fix`) applies verified QA fixes in one undo step. Every clip stays editable (`mgl edit ... undo` reverts
it all). Start here for any Short; build by hand (below) only for other shapes. `mgl docs recipes`.

## The loop

```sh
mkdir -p media
ffmpeg -v error -f lavfi -i testsrc2=s=1280x720:r=30:d=6 -f lavfi -i sine=f=330:d=6 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -y media/clip.mp4
mgl new shorts -o demo.mgl.json
mgl edit demo.mgl.json clip.add src=media/clip.mp4 id=shot track=V1 fit=cover
mgl edit demo.mgl.json clip.add text="Three tips to focus" id=title track=T1 len=2.5s style=title
mgl show demo.mgl.json
mgl check demo.mgl.json
mgl look demo.mgl.json
```

1. `mgl new` creates the file (presets: shorts, tiktok, reels, vertical, youtube, landscape, square, portrait, 4k).
2. `mgl show` prints the outline: comp, then one line per clip (track, id, kind, start–end, what it shows).
   **Run `mgl show` before reading a big project file**, and `mgl show <file> --clip <id>` for one clip.
3. Change it (below), then `mgl check` (file problems + QA that needs no pixels).
4. `mgl look` writes `.mgl/<name>/look/sheet.png`. **Open sheet.png with your image viewer and read it
   before saying the video is done**, and fix every QA finding (each comes with a ready `fix:` command).
5. Render: `mgl render demo.mgl.json out/demo.mp4 --draft` for checking, `--final` (default) to deliver.
   Delivery flags (`--crf`, `--bitrate`, `--prores hq`, `--pcm 24`, `--timecode 10:00:00:00`), stems
   (`out/vo.wav --bus dialogue`) and chapters (`out/x.chapters.txt` from markers with a `note`): `mgl docs rendering`.

```sh
mgl render demo.mgl.json out/demo.mp4 --draft
```

The first line of `render` is always the estimate (`est. 24 s (...)`). **If it says more than 2 minutes,
render in the background** so your shell does not time out: `mgl render demo.mgl.json out/final.mp4 --detach`,
then poll `mgl render demo.mgl.json --status` until it says `done`.

## Three ways to change a project

| Do it with | When |
|---|---|
| Edit the line yourself | One value: `"y": 420` → `"y": 380`, a colour, a text, a style field. Lines are unique (`"id"` first), so an exact-string edit works. |
| `mgl edit <file> <op> ...` | Anything structural or touching several lines: add/split/trim/ripple/slip/roll clips, captions, transitions, templates, keyframes. Undoable (`mgl edit <file> undo`). |
| An SDK script (`import { open } from 'michelangelo'`) | Many edits computed from data (a CSV, a beat list, 10 variants). `p.edit([...])` is atomic. |

**Re-read the file after `mgl edit`** before editing it by hand: commands re-sort lines and change line
numbers (`edit` prints the changed lines as `L12 ~ {...}`). Hand edits are re-validated on every load; a
broken file names the line and the fix (`mgl check` lists every problem).

`mgl edit` syntax: `mgl edit <file> <op> [bare word] [key=value ...]`. The bare word fills the op's main field
(usually the clip id; `mgl docs <op>` marks it `(bare word)`, and some ops such as `track.add` have none: use `id=`). Values are JSON when they parse (`2`, `true`, `null`, `[1,2]`, `{"a":1}`), else text;
quote text with spaces for the shell. Dotted keys set nested fields (`fx.blur.radius=8`). Also:
`mgl edit <file> '{"op": "clip.split", "id": "a", "at": "2s"}'`, `--batch edits.jsonl` (atomic),
`--dry-run` (prints the changes, writes nothing), `undo [n]`, `redo [n]`, `history`.

## Time

Inside the file times are integer **frames** at the comp's fps. Anywhere you write a time (CLI, SDK, or
by hand in the file) you may use: `75` (frames), `"2.5s"`, `"1:02.5"` (m:ss.s), `"00:01:02:15"`
(timecode). Seconds off a frame boundary are rounded and the result says so. Keyframe and cue times are
**local**: 0 = the clip's first frame.

## The file in brief

```json
{"michelangelo": 1,
"project": {"name": "Focus tips", "platform": "shorts"},
"assets": [
{"id": "clip", "src": "media/clip.mp4"}
],
"comps": [
{"id": "main", "size": [1080, 1920], "fps": 30}
],
"tracks": [
{"id": "V1", "comp": "main"},
{"id": "T1", "comp": "main"},
{"id": "A1", "comp": "main", "audio": true, "bus": "dialogue"}
],
"clips": [
{"id": "shot", "track": "V1", "at": 0, "len": 180, "asset": "clip", "fit": "cover"},
{"id": "title", "track": "T1", "at": 0, "len": 75, "text": "Three tips to focus", "style": "title", "y": 420, "scale": [[0, 0.8], [12, 1, "outBack"]]}
]
}
```

Tables, not nesting: tracks point to a comp, clips to a track, cues to a captions clip. Track order is
the stacking order (later = on top). A clip shows exactly one thing: `asset`, `text`, `shape`, `color`,
`comp` (nested), `captions`, `adjustment` or `gen` (generator). Common clip fields: `x`, `y` (comp px,
default the centre), `scale`, `rotate`, `opacity` (a number or keyframes `[[frame, value, easing?], ...]`),
`fit`, `blend`, `fx` (effects), `masks`, `transition`, `animate`, `style`, `gain`, `fade`, `speed`, `in`.
Defaults are omitted (`fit`: video cover, images contain = scaled to the frame; `fit=none` keeps pixel size).
Unknown keys are errors with a did-you-mean. Full reference: `mgl docs format`.

## The 12 commands you will use most

```sh
mgl edit demo.mgl.json clip.set title y=380 style='{"base": "title", "color": "#ffcc00"}'
mgl edit demo.mgl.json text.animate title in=pop by=word
mgl edit demo.mgl.json key.set title prop=opacity at=0 value=0
mgl edit demo.mgl.json key.set title prop=opacity at=0.5s value=1 ease=outCubic
mgl edit demo.mgl.json clip.split shot at=3s
mgl edit demo.mgl.json transition.set shot-2 type=crossfade len=0.5s
mgl edit demo.mgl.json clip.trim shot-2 end=5.5s
mgl edit demo.mgl.json fx.add shot type=color saturation=1.3
mgl edit demo.mgl.json captions.from-text text="Put your phone in another room. Work in short sprints." at=2.5s len=3s style=karaoke
mgl edit demo.mgl.json template.apply lower-third at=0.5s params='{"name": "Ada Lovelace", "role": "Engineer"}'
mgl edit demo.mgl.json audio.normalize lufs=-14
mgl edit demo.mgl.json clip.ripple-delete shot-2
```

Also: `asset.add`, `clip.add`, `clip.move`, `clip.slip`, `clip.roll`, `clip.slide`, `clip.speed`,
`clip.freeze`, `captions.import file=subs.srt`, `audio.duck bus=music by=dialogue db=9`,
`audio.cut-silences <clip>`, `marker.beats <clip>` and `clip.sequence srcs=[...] on=markers` (cut to the beat),
`comp.reframe main preset=youtube to=wide`, `mask.add`, `style.add`, `clip.duplicate`, `clip.punch-in <clip>
box=[x,y,w,h]` (zoom to a region), `layout.grid ids=[...]` (split screens), `fx.add bus=dialogue type=voice`
(audio effects on a bus or a clip with sound).
Motion and sound in one call each: `motion.apply <clip> in=pop emphasis=pulse@1s loop=float out=fade` (presets
for any layer), `audio.music mood=upbeat len=30s`, `audio.sfx type=whoosh at=2s`, `audio.auto-sfx` (SFX on every
cut, transition and entrance); all generated offline. Speech needs a provider plugin: `audio.speak text="..."`
then `captions.from-speech` (word-timed captions; `mgl docs audio`). Real images, footage, music and sound effects
with a stock plugin (open-media): `media.search kind=image|video|music|sfx query=...`, `media.fetch id=... at=...`,
then `media.credits card=true` (licences checked, sounds described as text; `mgl docs media`).
`mgl docs commands` lists all of them; `mgl docs <op>` prints one with its fields and an example.

## Look and QA

`mgl look <file> [--at 1s,2.5s] [-n 12] [--cuts]` renders frames into one sheet (long edge ≤ 1568 px),
runs QA (safe zones per platform, text overlapping other elements, tiny or cut-off text, black or frozen
stretches, gaps, clipping or off-target loudness, music over voice) and reports the sound as text
(LUFS, true peak, silences, tempo). Each finding has a crop image, the file line and a `fix:` command.
`mgl check` runs the checks that need no pixels. Both exit 0 with findings; `--strict` exits 1 on errors;
`--fix` applies the findings' fix commands for you and re-checks.
A 9:16 comp is checked against the TikTok, Reels and Shorts interfaces by default (`ui-overlap`: captions, text and
stickers under buttons or caption panels); `look --safe` outlines those panels on the sheet.
`--platforms tiktok,reels,shorts` checks several platforms' safe zones at once. Tag a clip `qa-ignore:<rule>`
(e.g. `tags='["qa-ignore:safe-zone"]'` on a burned-in timecode) when a finding is intended.

## Exit codes and errors

| Exit | Meaning |
|---|---|
| 0 | ok (warnings may be printed) |
| 1 | the input is wrong: file, command, arguments, media. The message names the line and the fix |
| 2 | the environment is wrong: no ffmpeg, no disk, network. Run `mgl doctor` |

Errors print `error E_CODE: message` and `fix: ...`; do what the fix says. With `--json`:
`{"ok": false, "error": {"code", "message", "fix", "line"}}`. Codes: `mgl docs errors`.
No ffmpeg? `mgl doctor --fetch` downloads a pinned build.

## Plugins (effects, transitions, generators, templates, commands, checks, motion presets, AI providers)

```sh
mgl plugin new effect posterize
mgl plugin test plugins/posterize
mgl plugin trust plugins/posterize
mgl edit demo.mgl.json project.set plugins='{"posterize": "^0.1.0"}'
mgl edit demo.mgl.json fx.add shot type=posterize
```

Edit `plugins/<name>/src/index.ts` (it imports only `michelangelo/plugin`), run `mgl plugin test` until it
passes (it also writes `.preview.png`: look at it), name it in the project with `project.set plugins=...`,
and `mgl plugin trust` it (plugins next to a project load only once trusted; trust again after every
edit). Plugins are code on your machine with no sandbox. Guide: `mgl docs plugins`.

## SDK

Scripts need the package installed where they run (`npm install michelangelo`, or `npm link michelangelo`
after a global install); `mgl --version` prints the version.

```js
import { open } from 'michelangelo';
const p = await open('demo.mgl.json');
await p.edit({ op: 'clip.set', id: 'title', y: 400 });
console.log(p.clips({ track: 'T1' }).map((c) => c.id).join(' '));
```

`p.data` is the plain project (read it, never mutate it); every change is `p.edit(command)` and is saved.
Also `create(file, {preset})`, `p.dryRun(cmd)`, `p.undo()`, `p.look()`,
`p.render(out, { quality: 'draft' })` (renders unsaved `{ save: false }` edits too), `p.check()`,
`p.services.analyzeLevels` / `measureText`. Guide: `mgl docs sdk`.

## More

**Recipes** (multicam sync, screencast zoom + redaction, podcast audiogram, chapters, multi-platform delivery,
split screen, credits, loops with alpha, review copies): `mgl docs recipes`.
`mgl docs <topic>`: recipes, format, commands, editing (trim/split/ripple/slip/slide/roll/speed/freeze/punch-in),
text-and-captions, audio, effects, templates, rendering, look-and-qa, plugins, sdk, errors.
`mgl doctor` reports ffmpeg, fonts, cores, disk and gaps with fixes.
