# flite-voice

A text-to-speech **provider** (plugin API 1.3) for `audio.speak`, built on the flite engine inside ffmpeg (the
`flite` lavfi source). Zero downloads, offline, deterministic (the same text gives the same bytes). English voices:
`slt` (female, default), `kal` (male, 8 kHz, thin), `rms` (male), `awb` (Scottish male). It sounds robotic but clear:
good for drafts, tests, evals and script-only briefs where any voice beats none.

- Speaks phrase by phrase (split at `, . ! ? ; :`), trims each phrase's silence and inserts its own pauses, so the
  **word timings** it returns follow the real phrase lengths; inside a phrase the voiced span is shared by syllables.
  `captions.from-speech` uses them for karaoke captions.
- 48 kHz mono WAV, peak at −3 dBFS; `speed` 0.5–2 (ffmpeg `atempo`).
- Needs an ffmpeg built with `--enable-libflite` (`mgl doctor` lists the `flite` filter); `$MGL_FFMPEG` picks one.
- Also defines `flite-voice.voices` (lists the voices; plugins need an item of a kind the manifest knows).

## Use it (trusted loading)

Plugins are code that runs on your machine with no sandbox, so a project loads one only when you name it **and**
trust it. Trust is a hash of every file in the folder: re-run `mgl plugin trust` after any change.

```sh
cp -r <michelangelo repo>/examples/plugins/flite-voice plugins/flite-voice
mgl plugin test plugins/flite-voice            # manifest, definition, type-check, tests
mgl plugin trust plugins/flite-voice           # after reading src/index.ts
mgl edit video.mgl.json project.set plugins='{"flite-voice": "^1.0.0"}'
mgl doctor video.mgl.json                      # providers of video.mgl.json: speak flite
mgl edit video.mgl.json audio.speak text="Three tips for better sleep." voice=slt id=line1
mgl edit video.mgl.json audio.speak text="Keep your room cool and dark." id=line2
mgl edit video.mgl.json captions.from-speech style=karaoke maxWords=3
```

`audio.speak` writes `media/generated/vo-<hash>.wav` (reused when text, voice and speed repeat) with the word timings
in `vo-<hash>.wav.json`, and puts each line on the dialogue bus after the previous one.

## Files

- `src/index.ts`: the provider (`defineProvider({ kind: 'speak', ... })`); Node built-ins are imported lazily.
- `test/flite-voice.test.ts`: phrase splitting, WAV header, determinism, word timings, speed, voice errors.
