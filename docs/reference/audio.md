# Audio

Audio clips live on audio tracks (`"audio": true`); each audio track sends to a **bus**. The buses
`dialogue`, `music`, `sfx` and `master` exist without an entry; add a line to `buses` only to change one
(`gain`, `muted`, `duck`, `loudness`, `to`, `fx`). Video clips play their own sound into their track's bus
unless `"muted": true` (`clip.detach-audio` moves it to its own linked clip). A track with no `bus` (the
preset's video track V1) sends straight to `master`, so a dialogue bus setting does not reach it until you run
`track.set V1 bus=dialogue` (or detach the audio onto A1). The whole mix is rendered once at
48 kHz, sample-exact to the frame.

```sh
mkdir -p media
ffmpeg -v error -f lavfi -i "sine=f=300:d=1.5" -f lavfi -i "anullsrc=r=48000:cl=mono:d=1" -f lavfi -i "sine=f=500:d=1.5" -filter_complex "[0][1][2]concat=n=3:v=0:a=1" -y media/vo.wav
ffmpeg -v error -f lavfi -i "sine=f=200:d=6" -y media/bed.mp3
mgl new youtube -o mix.mgl.json
mgl edit mix.mgl.json clip.add src=media/vo.wav id=voice track=A1
mgl edit mix.mgl.json clip.add src=media/bed.mp3 id=music-bed track=A2
mgl edit mix.mgl.json clip.add color=#202020 track=V1 len=6s
```

## Levels and fades

- `audio.gain <clip> db=-6` sets a constant; with `at=` it sets a keyframe (clip-local; `abs=true` for
  comp time), so `gain` can ride over time: `"gain": [[0, -20], [30, -6]]`.
- `audio.fade <clip> in=0.5s out=1s` (also fades the opacity of a visual clip); `0` removes a fade.
- `bus.set music gain=-8`, `track.set A2 muted=true`.

```sh
mgl edit mix.mgl.json audio.gain music-bed db=-4
mgl edit mix.mgl.json audio.fade music-bed in=0.5s out=1s
```

## Audio effects (per clip or per bus)

Effects with an audio stage process sound: `highpass`, `lowpass`, `eq`, `dehum`, `denoise-audio`, `compressor`,
`limiter`, `gate`, `deesser`, `reverb`, and `voice` (one-step dialogue clean-up: high-pass, compression,
de-ess). Put them on a clip with sound (`fx.add <clip> type=...`) or on a bus mix (`fx.add bus=<id> type=...`,
stored as the bus line's `fx`), in order; `fx.set` / `fx.remove` / `fx.move` take `bus=` too. Audio-only effects
on a silent clip and picture effects on an audio clip or a bus are errors. Picture effects with a source stage
(`denoise`, `sharpen`, `color`, `lut`) never touch the sound. `mgl docs effects` lists their parameters.

```sh
mgl edit mix.mgl.json fx.add bus=dialogue type=highpass freq=90
mgl edit mix.mgl.json fx.add voice type=deesser
mgl show mix.mgl.json
```

## Ducking

`audio.duck bus=music by=dialogue db=9` lowers the music bus by 9 dB while the dialogue bus has signal
(sidechain compression; `attack`/`release` in ms). It is stored on the bus line:
`{"id": "music", "duck": {"by": "dialogue", "db": 9}}`.

```sh
mgl edit mix.mgl.json audio.duck bus=music by=dialogue db=9
```

## Loudness

`audio.normalize` sets the target of the master bus, applied when rendering: `lufs` (default from the
platform: −14 for shorts, tiktok, reels, youtube; −16 otherwise) and a true-peak ceiling (`peak`, default
−1 dBTP). Only master's `loudness` is applied (on another bus it is ignored). The whole mix is measured on
every render, partial ranges included; a stem (`render --bus`) gets the full mix's gain instead of its own
normalisation, so stems still sum to the mix.

```sh
mgl edit mix.mgl.json audio.normalize lufs=-14
```

## Processing order

Each clip's sound is processed in this order: trim and speed (`in`, `len`, `speed`), then `gain`, then the clip's
`fx` in list order, then the fades. The `fx` run as one chain over the whole clip (not per segment), and their
delay (for example a limiter's lookahead) is compensated, so the clip stays in sync. Gain comes before the
effects, so a `limiter` or `compressor` at the end of a clip's `fx` sees the boosted signal and its ceiling holds.

Each bus then mixes its tracks and processes the sum in this order: the bus's own `fx` in list order, then the
`duck`, then the bus `gain` and mute. A compressor on a ducked bus works on the signal before the duck, so it does
not shrink the duck depth and the bus keeps the requested `db`. Buses route to `master`, where the mix gets master's `fx`, `gain` and finally the
`loudness` normalisation (target and true-peak ceiling).

## Cutting silences

`audio.cut-silences <clip>` analyses the clip's audio, finds silences longer than `min` (default 0.6 s)
under `db` (default −40 dB), and ripple-removes them keeping `pad` (default 0.15 s) on each side. Linked clips (a video and
its detached audio) are cut together. It is undoable like every command.

```sh
mgl edit mix.mgl.json audio.cut-silences voice min=0.5s pad=0.1s
mgl show mix.mgl.json
```

## Cutting to the beat

`marker.beats <clip>` finds the beats in an audio (or video with sound) clip's used range and adds comp
markers `beat1`, `beat2`, … (`prefix` changes the name; `every=2` keeps every second beat; `max` caps the
count and `min` is the fewest allowed, else `E_NO_BEATS`). Running it again replaces them.
`clip.sequence` then places clips back to back, or cut on those markers (`on=markers`) or straight on a
clip's beats (`on=beats clip=<id>`): for example `mgl edit v.mgl.json marker.beats bed every=2`, then
`mgl edit v.mgl.json clip.sequence srcs='["a.mp4","b.mp4","c.mp4"]' on=markers fit=cover`.
`mgl docs marker.beats` and `mgl docs clip.sequence` list every field.

## Stems

`mgl render <file> out/dialogue.wav --bus dialogue` renders one bus's contribution to the mix (other buses
muted, ducking kept); `--bus all` writes one stereo pair per bus into a multichannel WAV (the result names the
channel map); `--pcm 24` for 24-bit.

## Seeing the sound: audiograms

The `waveform` (bars, mirrored bars or a line, around the current moment) and `spectrum` (low → high bars)
generators draw the sound of an asset: `clip.add gen='{"type": "waveform", "asset": "vo-wav", "color": "#7fdcff"}' len=10s`.
See recipes.md for a podcast audiogram.

## Hearing it as text

You cannot listen, so `mgl look` reports the mix: integrated loudness (LUFS), true peak, loudness range,
silences with times, onsets and tempo, and QA findings (clipping, loudness off target, music louder than
the voice). Render only the audio to check it on its own: `.wav`, `.mp3`, `.m4a`, `.opus`, `.flac`.

```sh
mgl look mix.mgl.json -n 4
mgl render mix.mgl.json out/mix.wav
```
