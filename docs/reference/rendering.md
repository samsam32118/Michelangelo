# Rendering

`mgl render <file> [out] [--draft|--final|--hq] [--range a-b] [--still t] [--alpha] [--comp id] [--segments n] [--detach] [--status]`
plus delivery flags: `[--crf n] [--bitrate 8M] [--audio-bitrate 320k] [--pcm 16|24] [--prores proxy|lt|422|hq|4444|4444xq] [--timecode HH:MM:SS:FF] [--color-range tv|pc] [--bus <id>|all]`

The format comes from the extension of `out` (default `out/<name>.mp4` next to the project):

| Extension | Output |
|---|---|
| `.mp4` | H.264 + AAC, yuv420p, BT.709, `+faststart` |
| `.webm` | VP9 + Opus (`--alpha`: with transparency) |
| `.mov` | ProRes 422 HQ, 10-bit, PCM audio (`--prores` picks the profile; `--alpha`: ProRes 4444 with transparency) |
| `.gif` | palette GIF, ≤ 15 fps |
| `.png` | one frame (`--still <time>`, default the start), RGBA: transparent where the comp has no `bg` |
| `.wav` `.mp3` `.m4a` `.opus` `.flac` | the audio mix only (`--bus` for stems) |
| `.srt` `.vtt` | the caption cues |
| `.chapters.txt` `.chapters.vtt` | chapters from the comp's markers that have a `note` (YouTube description lines, WebVTT chapters) |

| Quality | Video |
|---|---|
| `--draft` | half size (long edge ≤ 960), fast encode: for checking timing and sound |
| `--final` (default) | full size, x264 veryfast crf 20, AAC 192k |
| `--hq` | full size, slower encode, better compression |

```sh
mkdir -p media
ffmpeg -v error -f lavfi -i testsrc2=s=640x360:r=30:d=3 -f lavfi -i sine=f=440:d=3 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -y media/clip.mp4
mgl new youtube -o r.mgl.json
mgl edit r.mgl.json clip.add src=media/clip.mp4 id=shot track=V1
mgl render r.mgl.json out/r.mp4 --draft
mgl render r.mgl.json out/frame.png --still 1.5s
mgl render r.mgl.json out/part.gif --draft --range 0.5s-1.5s
mgl render r.mgl.json out/r.mp3
```

## Delivery settings

| Flag | Applies to | Effect |
|---|---|---|
| `--crf n` | `.mp4` (x264 0–51, default 20), `.webm` (VP9 0–63, default 32) | quality; lower = better and bigger |
| `--bitrate 8M` | `.mp4`, `.webm` | target video bitrate (with `--crf`: a cap) |
| `--audio-bitrate 320k` | `.mp4`, `.webm`, `.mp3`, `.m4a`, `.opus` | audio bitrate (default 192k AAC) |
| `--pcm 24` | `.wav`, `.flac`, `.mov` | PCM bit depth (default 16) |
| `--prores proxy` | `.mov` | proxy, lt, 422, hq (default), 4444 (default with `--alpha`), 4444xq |
| `--timecode 10:00:00:00` | `.mov`, `.mp4` | start timecode of the file (`;` before the frames for drop-frame at 29.97/59.94) |
| `--color-range pc` | video | range flag: tv (limited, the default) or pc (full) |
| `--bus dialogue` | `.wav` and other audio | a **stem**: that bus's contribution to the mix (other buses muted, ducking kept); `--bus all` writes one stereo pair per bus in a multichannel `.wav` |

A flag that does not apply to the output is an error naming the ones that do. With a loudness target on master,
stems get the full mix's gain (they are not normalised on their own), so the stems sum to the mix. For a
broadcast-legal picture put a `legalize` effect on an adjustment layer over everything (QA's `luma-range` rule
reports out-of-range frames in `look`); `letterbox` adds a 2.39 or 1.85 matte.

```sh
mgl render r.mgl.json out/r-web.mp4 --range 0-1s --crf 24 --audio-bitrate 128k
mgl render r.mgl.json out/r-master.mov --range 0-1s --prores proxy --pcm 24 --timecode 10:00:00:00
mgl render r.mgl.json out/r-24bit.wav --pcm 24
```

## Chapters

Markers with a `note` are chapters (the note is the title): `mgl edit r.mgl.json marker.add at=0 note="Intro"`,
then `mgl render r.mgl.json out/r.chapters.txt` (lines `0:00 Intro` for a YouTube description) or
`out/r.chapters.vtt`. An "Intro" chapter is added at 0:00 when none starts there, and the result notes
YouTube's rules (at least 3 chapters, each at least 10 s).

## Transparency

`--alpha` writes transparency to `.webm` (VP9) and `.mov` (ProRes 4444). Only what the comp leaves empty is
transparent: a comp with `bg` renders opaque (`mgl check <file> --alpha` warns), so remove `bg` for an overlay.
`look` shows transparent areas over dark grey.

## The estimate and long renders

The **first line** of every render is the estimate, from three sample frames (start, middle, busiest)
and the encoder's measured speed: `est. 24 s (final 1080x1920, 30.0 s, ≈0.8x real time)`. Then it
renders, verifies the file with ffprobe and prints one line:
`wrote out/r.mp4 (30.0 s, 1080x1920, H.264/AAC, 9.8 MB) in 31 s (1.0x real time)`.

Shell tools often stop a command after 2 minutes. When the estimate is over that, render in the
background and poll:

```sh
mgl render r.mgl.json out/bg.mp4 --draft --detach
sleep 8
mgl render r.mgl.json --status
```

`--detach` writes `.mgl/<name>/render.json` (pid, progress, ETA, result); `--status` reads it and says
`running … 45%, eta 30 s`, `done: wrote …` or `failed: …` with the fix. One detached render per project
at a time. Renders over the target speed are split into up to 4 frame ranges rendered in parallel and
joined without re-encoding (`--segments n` forces it; `--segments 1` never splits); audio is mixed once.

## What blocks a render

A file that does not load blocks everything (fix it with `mgl check`). Render-blocking issues (clips that
overlap on a track, a cue's word count not matching its `words`) let you edit but refuse to render, each
with a fix. Plugins the project names must be installed and trusted (`mgl plugin trust <dir>`).
Missing media is reported with the asset line and an `asset.relink` fix.

## Determinism

Same project + same Michelangelo version + same fonts = the same frames. Fonts are bundled; plugin
`draw` functions must be pure functions of params, frame and seed.

## ffmpeg

Michelangelo uses the system `ffmpeg` (≥ 6, with libx264 and aac), or `MGL_FFMPEG`, or a pinned static
build it downloads on `mgl doctor --fetch` into `~/.cache/michelangelo/ffmpeg/`. `mgl doctor` lists which
encoders, decoders and filters are present and what each missing one disables. Headless containers have
no GPU; everything renders on the CPU (Skia for compositing, native ffmpeg for decode and encode).
