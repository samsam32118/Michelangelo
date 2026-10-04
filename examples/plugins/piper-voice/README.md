# piper-voice

A text-to-speech **provider** (plugin API 1.3) for `audio.speak`, built on [Piper](https://github.com/rhasspy/piper),
an offline neural engine: natural-sounding voices in many languages, a few times faster than real time on a CPU,
no network once the files are on disk. Use it when `flite-voice` is too robotic for the final video.

- **Nothing is bundled or downloaded by the plugin** (the core never downloads models). You put the Piper binary
  and the voice models in a folder once (below) and point `$PIPER_HOME` at it.
- A voice is a model file name without `.onnx` (`en_US-ryan-high`). `voices()` and `piper-voice.voices` list what is
  in `$PIPER_HOME`; the default voice is `$PIPER_VOICE`, else the first by name.
- 48 kHz mono WAV with the leading and trailing silence trimmed; `speed` 0.5–2 (Piper's `length_scale`).
- **Word timings are estimated**, because Piper returns none: the voiced span is shared out by syllables, with extra
  time after punctuation. They are good enough for 2–4 word caption pages (`captions.from-speech maxWords=3`);
  for word-by-word karaoke use a `transcribe` provider instead.
- Needs ffmpeg for resampling (`$MGL_FFMPEG`, else `ffmpeg` on PATH).

## Get Piper and a voice (once)

```text
$PIPER_HOME/                      default: ./piper under the folder mgl runs in
  piper/piper                     the binary: unpack a release from https://github.com/rhasspy/piper/releases
  en_US-ryan-high.onnx            a voice: https://huggingface.co/rhasspy/piper-voices
  en_US-ryan-high.onnx.json       its config (same folder, same name + .json)
```

`$PIPER_BIN` overrides the binary path; with neither, `piper` on PATH is used.

Licences are yours to check: the Piper release is MIT but ships espeak-ng data (GPL-3.0) for phonemes, and every
voice has its own licence in its model card (some are non-commercial). This plugin only runs the program you
installed; it contains none of it.

## Use it (trusted loading)

Plugins are code that runs on your machine with no sandbox, so a project loads one only when you name it **and**
trust it. Trust is a hash of every file in the folder: re-run `mgl plugin trust` after any change.

```sh
cp -r <michelangelo repo>/examples/plugins/piper-voice plugins/piper-voice
mgl plugin test plugins/piper-voice            # manifest, definition, type-check, tests (no Piper needed)
mgl plugin trust plugins/piper-voice           # after reading src/index.ts
export PIPER_HOME=~/piper
mgl edit video.mgl.json project.set plugins='{"piper-voice": "^1.0.0"}'
mgl doctor video.mgl.json                      # providers of video.mgl.json: speak piper
mgl edit video.mgl.json piper-voice.voices     # what is in $PIPER_HOME
mgl edit video.mgl.json audio.speak text="Three tips for better sleep." voice=en_US-ryan-high id=line1
mgl edit video.mgl.json captions.from-speech style=karaoke maxWords=3
```

`mgl new shorts --script script.txt --voice default` speaks a whole script with it when the plugin is named in
`mgl.config.json`.

## Develop

The tests replace the Piper binary with a small shell script that writes a tone, so they run anywhere ffmpeg does
(not on Windows): they cover voice discovery, the resample-and-trim step, speed, the timing estimate and the
error messages, not Piper's own output.
