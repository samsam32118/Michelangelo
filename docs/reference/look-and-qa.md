# look and check: verifying work you cannot watch

## mgl look

`mgl look <file> [--at 1s,2.5s] [-n 12] [--cuts] [--comp id] [--no-audio] [--strict] [--platforms a,b] [--alpha]`

`--alpha` says the delivery will be rendered with transparency (enables the `alpha-with-bg` rule).

1. Picks frames: `-n` evenly spaced (default 12), or `--at` times, plus the first frame of every cut with
   `--cuts` (at most 24 frames).
2. Renders them at reduced size into one **contact sheet**, each tile labelled with its time and frame,
   long edge ≤ 1568 px: `.mgl/<name>/look/sheet.png`. **Open it with your image viewer.**
3. Runs **QA checks** on the rendered frames and the project: platform safe zones, text overlapping another
   visible element (by rendered alpha), text too small or cut off by the frame, black or frozen stretches,
   gaps on the main track, missing media, plugin problems, and on the audio: clipping (true peak over
   −1 dBTP), loudness off target, music louder than the voice. Plugins add checks.
4. Each finding is one line: what and where (clip, time), a crop image `.mgl/<name>/look/qa-<n>.png`
   with the offending boxes outlined, the project line, and a ready **`fix:`** command.
5. Reports the **sound as text**: integrated LUFS, true peak, loudness range, silences with times,
   onsets and an estimated tempo.

```sh
mkdir -p media
ffmpeg -v error -f lavfi -i testsrc2=s=1280x720:r=30:d=4 -f lavfi -i sine=f=330:d=4 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -y media/clip.mp4
mgl new shorts -o qa.mgl.json
mgl edit qa.mgl.json clip.add src=media/clip.mp4 id=shot track=V1 fit=cover
mgl edit qa.mgl.json clip.add id=title track=T1 len=3s text="A title that is much too wide for a vertical video" style=title y=300
mgl look qa.mgl.json -n 6
```

A typical result:

```text
wrote .mgl/qa/look/sheet.png (6 frames 0.33–3.67, 1104x1568) in 1.2 s
QA 2 issues
  1 warn text "A title that is..." (title) crosses the top of the shorts-safe area at 0.10s   .mgl/qa/look/qa-1.png   line 15   fix: mgl edit qa.mgl.json clip.set title y=480
  2 warn mix is -21.3 LUFS, 7.3 LU under the -14 LUFS target   fix: mgl edit qa.mgl.json audio.normalize lufs=-14
sound -21.3 LUFS, peak -18.1 dBTP, LRA 0.0 · no silences
```

Run the fix commands (or edit the lines), then `look` again until there are no findings you cannot
explain. `--json` returns every finding with its box, frame and fix; `issues` is the count. A finding's `box`
([x, y, w, h] in comp px) is also a way to measure a laid-out text block; from a script,
`p.services.measureText(text, style)` gives the width and height directly (sdk.md).

## mgl check

`mgl check <file> [--strict] [--platforms a,b] [--alpha]` validates the file and runs the QA that needs no pixels (text boxes are
measured with the same fonts the renderer uses): every load error and warning with its line and fix,
render-blocking issues (overlaps, cue word counts), safe zones, missing media, plugin problems. It is
fast; run it after every few edits.

```sh
mgl check qa.mgl.json
mgl check qa.mgl.json --json > check.json
node -e "const r = require('./check.json'); console.log('issues:', r.issues)"
```

Rules (each finding names its rule): `text-outside-safe`, `text-cut-off`, `tiny-text`, `caption-overlap`,
`overlap-alpha`, `layer-hidden` (a layer fully covered by an opaque one above it), `media-off-frame`, `gaps`,
`trailing-black`, `clip-past-end`, `clip-past-source` (a media clip longer than its source: the last frame holds
or the sound stops; uses probed durations), `keyframes-outside`, `alpha-with-bg`, `music-over-voice`; in `look`
also `black-frames`, `frozen` (only pixels you can see), `luma-range` (picture outside 16–235: use `legalize`),
`clipping`, `loudness`, `long-silence`. Plugins add rules.

## Several platforms at once

`--platforms tiktok,reels,shorts` (`--platform` also works; or `p.check({ platforms })`) runs the checks once per platform and merges the
findings: a finding all platforms share is printed once; a platform-specific one starts with `[tiktok]` and has
`platform` in `--json`. Apply the strictest fix and check again. It does not change `project.platform`, which
still sets the default loudness target.

```sh
mgl check qa.mgl.json --platform tiktok,reels,shorts
```

## Telling QA what is intentional

Tag a clip `qa-ignore:<rule>` (or `qa-ignore:all`) and that rule skips it: credits that roll off the frame,
burned-in timecode outside the safe zone, leader black. Short aliases: `safe-zone`, `cut-off`, `off-frame`,
`overlap`, `covered`, `black`, `silence`, `frozen`, `levels`. Tags are a list: `clip.set tc tags='["qa-ignore:safe-zone"]'`.

```sh
mgl edit qa.mgl.json clip.set title tags='["qa-ignore:safe-zone"]'
mgl check qa.mgl.json
```

## Exit codes

`look` and `check` exit 0 when they ran, even with findings, so you can read them. With `--strict` they
exit 1 if any finding is an error (use it in scripts and CI). `check` exits 1 when the file does not
load. Like every verb, exit 2 means the environment is the problem (`mgl doctor`).

## Safe zones

Platforms cover parts of a vertical video with their UI. The project's `platform` (`project.set
platform=<name>`, set by `mgl new <preset>`; names: `mgl docs project.set`) chooses the zone; text should stay
inside it. The margins (left, top, right, bottom, as fractions of the frame): shorts 5/8/12/20 %,
tiktok 5/9/14/21 %, reels 5/10/13/20 %, youtube and none 5 % all round (title safe).
