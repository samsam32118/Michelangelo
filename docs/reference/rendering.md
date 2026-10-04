# Rendering

`mgl render <file> [out] [--draft|--final|--hq] [--range a-b] [--still t] [--alpha] [--comp id] [--segments n] [--detach] [--status]`

The format comes from the extension of `out` (default `out/<name>.mp4` next to the project):

| Extension | Output |
|---|---|
| `.mp4` | H.264 + AAC, yuv420p, BT.709, `+faststart` |
| `.webm` | VP9 + Opus (`--alpha`: with transparency) |
| `.mov` | ProRes 422 (`--alpha`: ProRes 4444 with transparency) |
| `.gif` | palette GIF, ≤ 15 fps |
| `.png` | one frame (`--still <time>`, default the start) |
| `.wav` `.mp3` `.m4a` `.opus` `.flac` | the audio mix only |
| `.srt` `.vtt` | the caption cues |

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
