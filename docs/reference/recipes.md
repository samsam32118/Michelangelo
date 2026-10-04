# Recipes

Short, tested recipes for tasks agents often attempt. Every block below runs in the docs tests, in order, in
one folder (later recipes reuse media made earlier). Sizes are small so they run fast; use real presets for real
work. `mgl docs <op>` prints every field of a command; `mgl docs <effect|generator|template>` one catalog entry.

## Multicam: sync angles by the audio onset, then cut between them

Two cameras of the same take, synced on the clap. Put the master angle on V1 and the other on a track above;
where the upper angle is cut away, V1 shows through.

```sh
mkdir -p media out
# camA hears the clap (a short 1 kHz beep) at 1.0 s, camB at 1.5 s (it started rolling earlier)
ffmpeg -v error -f lavfi -i testsrc2=s=640x360:r=30:d=6 -f lavfi -i "aevalsrc=if(between(t\,1\,1.1)\,0.8*sin(2*PI*1000*t)\,0.002*sin(2*PI*220*t)):s=48000:d=6" -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -y media/camA.mp4
ffmpeg -v error -f lavfi -i smptehdbars=s=640x360:r=30:d=6.5 -f lavfi -i "aevalsrc=if(between(t\,1.5\,1.6)\,0.8*sin(2*PI*1000*t)\,0.002*sin(2*PI*220*t)):s=48000:d=6.5" -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -y media/camB.mp4
mgl new youtube -o multicam.mgl.json
mgl edit multicam.mgl.json comp.set main size=[640,360]
mgl edit multicam.mgl.json clip.add src=media/camA.mp4 id=camA track=V1
mgl edit multicam.mgl.json track.add id=V2
mgl edit multicam.mgl.json clip.add src=media/camB.mp4 id=camB track=V2 muted=true
```

Find the clap in each file with `p.services.analyzeLevels` (per-frame RMS 0..1 = −60..0 dBFS, plus a spectrum)
and slip the later angle by the difference:

```js
import { open } from 'michelangelo';
const p = await open('multicam.mgl.json');
const rate = { num: 30, den: 1 };
const onset = async (src) => (await p.services.analyzeLevels(src, rate)).rms.findIndex((v) => v > 0.6);
const a = await onset('media/camA.mp4'), b = await onset('media/camB.mp4');
console.log(`clap: camA frame ${a}, camB frame ${b}`);
await p.edit([{ op: 'clip.set', id: 'camB', in: b - a }, { op: 'clip.trim', id: 'camB', len: p.clip('camA').len }]);
```

Angle cuts: split the upper angle and remove the pieces where the master angle should show.

```sh
mgl edit multicam.mgl.json clip.split camB at=2s newId=camB-2
mgl edit multicam.mgl.json clip.split camB-2 at=4s newId=camB-3
mgl edit multicam.mgl.json clip.remove camB-2
mgl show multicam.mgl.json
mgl render multicam.mgl.json out/cut.png --still 3s
```

No onset to sync on? `mgl show media/camB.mp4` gives durations; `audio.cut-silences` and `marker.beats` use the
same analysis. QA's frozen-frame rule only looks at the pixels you can see, so a covered master angle is fine.

## Screencast: punch-in zoom plus a redaction that follows it

`clip.punch-in` writes the zoom keyframes. For a redaction that stays on the secret through the zoom, duplicate
the clip (keyframes and all) onto a track above, pixelate the copy, and mask it in **clip space** (fractions of
the clip box), so the mask moves with the zoom.

```sh
ffmpeg -v error -f lavfi -i testsrc2=s=640x360:r=30:d=6 -vf "drawbox=x=420:y=40:w=180:h=36:color=red@1:t=fill" -c:v libx264 -pix_fmt yuv420p -y media/screen.mp4
mgl new youtube -o tutorial.mgl.json
mgl edit tutorial.mgl.json comp.set main size=[640,360]
mgl edit tutorial.mgl.json clip.add src=media/screen.mp4 id=screen track=V1
mgl edit tutorial.mgl.json clip.punch-in screen box=[360,20,280,158] at=2s len=0.5s hold=2s out=0.5s
mgl edit tutorial.mgl.json track.add id=V2
mgl edit tutorial.mgl.json clip.duplicate screen newId=redact track=V2
mgl edit tutorial.mgl.json fx.add redact type=pixelate size=16
mgl edit tutorial.mgl.json mask.add redact shape=rect space=clip box=[0.64,0.1,0.3,0.12]
mgl render tutorial.mgl.json out/zoomed.png --still 3s
```

Punch in after the redaction exists? Run the same `clip.punch-in` on both clips. A comp-space mask box can also
be keyframed (`box=[[0, [x, y, w, h]], [15, [x2, y2, w2, h2], "inOutCubic"]]`, clip-local frames).

## Chapters from markers

A marker with a `note` is a chapter (the note is the title). Render `.chapters.txt` (YouTube description lines)
or `.chapters.vtt` (WebVTT chapters); the result notes YouTube's rules (first at 0:00, at least 3, each ≥ 10 s).

```sh
mgl edit tutorial.mgl.json marker.add at=0 id=ch1 note="Intro"
mgl edit tutorial.mgl.json marker.add at=2s id=ch2 note="The export button"
mgl edit tutorial.mgl.json marker.add at=4.5s id=ch3 note="Wrap-up"
mgl render tutorial.mgl.json out/tutorial.chapters.txt
mgl render tutorial.mgl.json out/tutorial.chapters.vtt
cat out/tutorial.chapters.txt
```

## Podcast: clean-up chain on the dialogue bus, loudness, audiogram

Audio effects go on a clip with sound (`fx.add <clip> type=...`) or on a bus mix (`fx.add bus=<id> type=...`),
in order: `dehum` → `denoise-audio` → `voice` (high-pass, compression, de-ess) is a good default. The `waveform`
and `spectrum` generators draw an asset's sound.

```sh
ffmpeg -v error -f lavfi -i "aevalsrc=0.5*sin(2*PI*220*t)*gt(sin(2*PI*1.5*t)\,0)+0.05*sin(2*PI*50*t):s=48000:d=5" -y media/episode.wav
mgl new square -o podcast.mgl.json
mgl edit podcast.mgl.json comp.set main size=[540,540]
mgl edit podcast.mgl.json clip.add src=media/episode.wav id=ep track=A1
mgl edit podcast.mgl.json fx.add bus=dialogue type=dehum freq=50
mgl edit podcast.mgl.json fx.add bus=dialogue type=voice
mgl edit podcast.mgl.json audio.normalize lufs=-16
mgl edit podcast.mgl.json clip.add color=#14141c id=bg track=V1 len=5s
mgl edit podcast.mgl.json clip.add gen='{"type": "waveform", "asset": "episode", "color": "#7fdcff"}' id=wave track=T1 len=5s y=380
mgl edit podcast.mgl.json track.add id=T2
mgl edit podcast.mgl.json clip.add text="Episode 12: Hum-free audio" id=title track=T2 len=5s style=subtitle y=150
mgl show podcast.mgl.json
mgl render podcast.mgl.json out/audiogram.png --still 2s
mgl render podcast.mgl.json out/dialogue-stem.wav --bus dialogue --pcm 24
```

`clip.add src=...` names the asset after the file (`episode`); `mgl show <file> --assets` lists asset ids.

## Multi-platform: one layout, several safe zones, several deliverables

`--platform a,b,c` checks every platform at once; a finding for one platform starts with `[tiktok]`. Apply the
strictest fix (the smallest x/y it suggests) and check again.

```sh
ffmpeg -v error -f lavfi -i testsrc2=s=540x960:r=30:d=4 -f lavfi -i sine=f=330:d=4 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -y media/vertical.mp4
mgl new shorts -o promo.mgl.json
mgl edit promo.mgl.json comp.set main size=[540,960]
mgl edit promo.mgl.json clip.add src=media/vertical.mp4 id=shot track=V1
mgl edit promo.mgl.json clip.add text="@michelangelo" id=handle track=T1 len=4s style=label x=470 y=820
mgl check promo.mgl.json --platform tiktok,reels,shorts
mgl edit promo.mgl.json clip.set handle x=311 y=728
mgl check promo.mgl.json --platform tiktok,reels,shorts
```

Deliverables are one render each; delivery flags set the codec details (`mgl docs rendering`):

```sh
mgl render promo.mgl.json out/promo-web.mp4 --range 0-1s --crf 23 --bitrate 6M --audio-bitrate 160k
mgl render promo.mgl.json out/promo-master.mov --range 0-1s --prores proxy --pcm 24 --timecode 01:00:00:00
mgl render promo.mgl.json out/promo-cover.png --still 1s
```

## Split screen

`layout.grid` fits clips into grid cells (cover-cropped with a clip-space mask, or `fit=contain`).

```sh
mgl new youtube -o split.mgl.json
mgl edit split.mgl.json comp.set main size=[640,360] bg=#000000
mgl edit split.mgl.json clip.add src=media/camA.mp4 id=left track=V1
mgl edit split.mgl.json track.add id=V2
mgl edit split.mgl.json clip.add src=media/camB.mp4 id=right track=V2 len=6s muted=true
mgl edit split.mgl.json layout.grid ids='["left","right"]' cols=2 gap=8
mgl render split.mgl.json out/split.png --still 1s
```

## Credits roll

One text clip with line breaks, moving up with linear `y` keys. In `k=v`, a value in double quotes is a JSON
string, so `\n` is a line break. Give the style a `maxWidth` (otherwise text wraps at the frame edge from `x`).
The `qa-ignore:off-frame` tag tells QA the clip leaves the frame on purpose.

```sh
mgl new youtube -o credits.mgl.json
mgl edit credits.mgl.json comp.set main size=[640,360] bg=#000000
mgl edit credits.mgl.json clip.add id=roll track=T1 len=6s text='"DIRECTED BY\nAda Lovelace\n\nMUSIC\nGrace Hopper"' style='{"base": "body", "size": 28, "align": "center", "maxWidth": 560}' tags='["qa-ignore:off-frame"]'
mgl edit credits.mgl.json key.set roll prop=y at=0 value=520 ease=linear
mgl edit credits.mgl.json key.set roll prop=y at=179 value=-160
mgl check credits.mgl.json
```

## Looping animation with transparency

A comp with no `bg` renders transparent with `--alpha` (`.webm` VP9 or `.mov` ProRes 4444). For a seamless loop,
the last key sits at frame `len` with the same pose as frame 0 (here a 5-point star turns 72°). `key.set` notes
that frame 60 is outside the clip: that is the loop point, never shown.

```sh
mgl new square -o loop.mgl.json
mgl edit loop.mgl.json comp.set main size=[320,320] length=2s
mgl edit loop.mgl.json clip.add id=star track=V1 len=2s shape='{"type": "star", "sides": 5, "size": [220, 220], "fill": "#ffcc00"}'
mgl edit loop.mgl.json key.set star prop=rotate at=0 value=0 ease=linear
mgl edit loop.mgl.json key.set star prop=rotate at=60 value=72
mgl edit loop.mgl.json key.set star prop=scale at=0 value=1 ease=inOutSine
mgl edit loop.mgl.json key.set star prop=scale at=30 value=1.15 ease=inOutSine
mgl edit loop.mgl.json key.set star prop=scale at=60 value=1
mgl render loop.mgl.json out/loop.webm --alpha
```

## Review copy: slate, timecode burn-in, watermark

Leader templates (`bars-and-tone`, `slate`, `countdown`) and the `timecode` generator cover review and broadcast
copies; `--timecode` writes the start timecode into the file.

```sh
mgl new youtube -o review.mgl.json
mgl edit review.mgl.json comp.set main size=[640,360]
mgl edit review.mgl.json clip.add src=media/camA.mp4 id=prog track=V1 at=3s
mgl edit review.mgl.json template.apply slate at=0 len=3s params='{"title": "Launch film", "version": "v3"}'
mgl edit review.mgl.json clip.add gen='{"type": "timecode", "start": "10:00:00:00", "size": 24}' id=tc track=T1 at=3s len=6s y=330 tags='["qa-ignore:safe-zone"]'
mgl edit review.mgl.json track.add id=WM
mgl edit review.mgl.json clip.add text="CONFIDENTIAL · DRAFT v3" id=wm track=WM at=0 len=9s style=label opacity=0.35 rotate=-20
mgl show review.mgl.json
mgl render review.mgl.json out/review.png --still 4s
```
