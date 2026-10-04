# look and check: verifying work you cannot watch

## mgl look

`mgl look <file> [--at 1s,2.5s] [-n 12] [--cuts] [--comp id] [--no-audio] [--strict] [--platforms a,b] [--safe] [--alpha]`

`--safe` outlines the TikTok (cyan), Reels (magenta) and Shorts (yellow) interface panels (header, action buttons,
caption panel) on the contact sheet and the crops, and names the panels under each crop. The outlines are drawn on the
QA images only; they never reach a render.

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

Rules (each finding names its rule): `text-outside-safe`, `ui-overlap` (on a 9:16 comp, a caption cue, text or
sticker under the TikTok, Reels or Shorts interface: header, action buttons or caption panel. With no
`project.platform` it checks all three at once, so a vertical video is covered by default; with one platform set, only
that one. Each finding names the platforms and panels and by how many px; the fix moves the clip, or scales a sticker
down, into the area clear of all of them. Error for text, warning for stickers: an image, generator, shape or nested
comp layer under 40 % of the frame and narrower than 90 % of its width and height, or any clip tagged `sticker`), `text-cut-off`, `tiny-text`, `caption-overlap`,
`overlap-alpha`, `layer-hidden` (a layer fully covered by an opaque one above it), `media-off-frame`, `gaps`,
`trailing-black`, `clip-past-end`, `clip-past-source` (a media clip longer than its source: the last frame holds
or the sound stops; uses probed durations), `keyframes-outside`, `alpha-with-bg`, `music-over-voice`, `caption-timing`
(a cue on screen under 0.3 s or faster than 35 characters/s, or captions blinking off for under 0.5 s between two
cues; the fix stretches the cue); in `look`
also `black-frames`, `frozen` (only pixels you can see), `luma-range` (picture outside 16–235: use `legalize`),
`clipping`, `loudness`, `long-silence`. Retention and legibility rules: `static-visuals` (in a 9:16 comp nothing big
moves for over 2.5 s: no video, keyframed motion, cut or animated generator; fix: a slow `clip.punch-in` on the
dominant layer, or a drift for a still generator background), `edge-gap` (a picture meant to fill the frame is
zoomed out or moved so the background shows; fix: the smallest scale that fills it) and, in `look`, `low-contrast`
(rendered text against the pixels behind it under WCAG 3:1 with no outline, plate or shadow; fix: a contrasting
stroke, or a translucent plate for small text). Plugins add rules.

## Fixing automatically: --fix

`mgl check <file> --fix` and `mgl look <file> --fix` apply the findings' `fix:` commands for you, verified: each
fix is dry-run, applied to a scratch copy, and QA runs again; a fix is kept only if its finding disappears and no
new error or warning appears. Rounds repeat until no fix helps (at most 10), then everything kept is written as
**one edit: one undo step** (`mgl edit <file> undo` reverts the whole run). Errors and warnings are fixed; info
findings and fixes that need a value you choose (`<path ...>`) are left to you. `look --fix` judges on rendered
frames, so it also fixes `low-contrast`, `overlap-alpha` and the sound (`loudness`, `clipping`); `check --fix` is
the fast pass. `--dry-run` shows what would be applied. The summary is at most 10 lines; `--json` has every
applied and rejected fix with its reason, and the remaining findings. From a script: `fixCheck(p)` / `fixLook(p)`
in the QA module do the same.

```text
$ mgl check still.mgl.json --fix
fix: applied 1 fix in 1 round; findings 1 → 0 (one undo step: mgl edit still.mgl.json undo)
  ok   static-visuals sky: clip.punch-in sky 'box=[49,87.5,982,1745]' at=0 len=120 ease=inOutSine
remaining: none, QA is clean
```

A still picture in a Short is the typical case. `check` names it and prints the fix that `--fix` would apply:

```sh
ffmpeg -v error -f lavfi -i color=c=0xdfeaf5:s=1080x1920 -frames:v 1 -y media/sky.png
mgl new shorts -o still.mgl.json
mgl edit still.mgl.json clip.add src=media/sky.png id=sky track=V1 len=4s fit=cover
mgl check still.mgl.json | grep "nothing moves"
mgl edit still.mgl.json clip.punch-in sky 'box=[49,87.5,982,1745]' at=0 len=120 ease=inOutSine
mgl check still.mgl.json
```

Tag a clip `qa-ignore:static` (or `qa-ignore:contrast`, `qa-ignore:gap`) when the stillness, the colours or the
inset are intended.

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
burned-in timecode outside the safe zone, leader black. Short aliases: `safe-zone` (both safe-zone rules), `ui` (`ui-overlap`), `cut-off`, `off-frame`,
`overlap`, `covered`, `black`, `silence`, `frozen`, `levels`. Tags are a list: `clip.set tc tags='["qa-ignore:safe-zone"]'`.

A tag covers its own clip and the timeline under it:

- findings about the tagged clip itself are skipped for any matching tag, `qa-ignore:all` included;
- timeline findings (`black-frames`, `trailing-black`, `gaps`, `long-silence`, `luma-range`) at a frame where
  the tagged clip plays are skipped when the tag names the rule or an alias (`qa-ignore:black`);
- project-scoped findings with no clip or frame, such as `clipping` and `loudness` on the whole mix, are only
  silenced by a tag that names the rule (`qa-ignore:loudness`) on any clip of the comp, never by
  `qa-ignore:all`, so an `all` on a credits clip cannot hide clipping in the mix. There is no project-level
  ignore list.

Watermarks: a clip tagged `role:watermark` (or `watermark`), a layer at opacity 0.35 or less, or one with a
non-normal blend counts as a see-through overlay, and the overlap rules (`caption-overlap`, `overlap-alpha`)
skip it: text over or under it stays readable.

`gaps` also flags a main track that ends before the overlays above it (captions, titles, lower thirds that run
on over an empty frame): extend the last main clip or trim the overlays.

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
