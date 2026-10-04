# kokoro-voice

A text-to-speech **provider** (plugin API 1.4) for `audio.speak` with
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), a small neural voice model with Apache-2.0 weights, run on
the CPU through [kokoro-js](https://www.npmjs.com/package/kokoro-js) (ONNX). It sounds natural; use it for finished
voice-overs, and `flite-voice` for zero-download drafts.

- **28 English voices**, US and UK, best first: `af_heart` (default), `af_bella`, `af_nicole`, `bf_emma`,
  `am_fenrir`, `am_michael`, `am_puck` ... (`kokoro-voice.voices` lists them all with grades from the model card).
- **Word timings from the model.** The "timestamped" ONNX export reports how long it spends on each phoneme, so each
  word starts and ends where the model put it. Text words are matched to the spoken (phoneme) words, including
  numbers, money, dates and abbreviations (`$5.99` is six spoken words and one caption word). Michelangelo then moves
  each phrase's first word to where the sound starts (the model marks it 10–120 ms late). If a match fails, the
  provider returns no timings and Michelangelo aligns the text to the sound instead, so captions still line up.
- 24 kHz mono WAV, peak at −3 dBFS. `speed` 0.5–2 is the model's own speaking rate, not a time stretch.
- Long text is spoken in chunks of whole sentences (the model reads at most ~500 phonemes at a time).
- Deterministic: the same text, voice and speed give the same audio, so `audio.speak` reuses its file.

The default is the highest quality there is: voice `af_heart` (the only grade-A voice) and the full-precision `fp32`
model. On a 4-vCPU cloud container it loads in under 1 s from the cache and speaks at about 0.3× real time (a 6.5 s
line in 1.9 s); the quantised `q8` model is a quarter of the download but slower on CPU here.

## Install (once per project)

```sh
cp -r <michelangelo repo>/examples/plugins/kokoro-voice plugins/kokoro-voice
(cd plugins/kokoro-voice && npm install)       # kokoro-js and the ONNX runtime (~700 MB on disk)
mgl plugin test plugins/kokoro-voice            # manifest, definition, type-check, tests (no model needed)
mgl plugin trust plugins/kokoro-voice           # after reading src/index.ts; again after any change
mgl edit video.mgl.json project.set plugins='{"kokoro-voice": "^1.0.0"}'
mgl doctor video.mgl.json                       # providers of video.mgl.json: speak kokoro
```

The model weights are **never in this repository or the plugin folder**: the first `audio.speak` downloads them from
huggingface.co (~330 MB, `fp32`) into `~/.cache/michelangelo/kokoro`; later runs are offline. `MGL_KOKORO_TEST=1 mgl plugin test plugins/kokoro-voice`
also runs one real synthesis.

## Use it

```sh
mgl edit video.mgl.json audio.speak text="Three tips for better sleep. First, keep your room cool and dark." id=line1
mgl edit video.mgl.json audio.speak text="Second, put your phone in another room." voice=am_michael id=line2
mgl edit video.mgl.json captions.from-speech style=karaoke maxWords=3
```

`audio.speak` writes `media/generated/vo-<hash>.wav` with the word timings in `vo-<hash>.wav.json`, and puts each line
on the dialogue bus after the previous one. `captions.from-speech` turns the timings into cues that appear just before
each phrase is heard and break where a person would ("First," | "keep your room" | "cool and dark.").

## Settings (environment variables)

| variable | default | |
|---|---|---|
| `MGL_KOKORO_DTYPE` | `fp32` | model precision: `fp32` (full quality, ~330 MB), `q8` (~90 MB), `fp16`, `q4`, `q4f16` |
| `MGL_KOKORO_MODEL` | `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` | a Hugging Face model id; without per-phoneme durations, Michelangelo aligns by sound |
| `MGL_KOKORO_CACHE` | `~/.cache/michelangelo/kokoro` | where the model is kept |
| `MGL_KOKORO_OFFLINE` | unset | `1`: never download (the model must be in the cache) |

## Licences

The Kokoro weights and kokoro-js are Apache-2.0. kokoro-js turns text into phonemes with the `phonemizer` package,
which compiles **eSpeak NG (GPL-3.0)** to WebAssembly. That is one reason this voice is a plugin you install
yourself: nothing of it is inside the Michelangelo package, and Michelangelo's own code stays FSL-1.1-ALv2 with no
GPL dependency. Check that the licences fit your use before you ship audio made with it.

## Files

- `src/index.ts`: the provider (`defineProvider({ kind: 'speak', ... })`), the phoneme-to-word matching
  (`phonemeWords`, `matchWords`), chunking and the WAV writer. Node built-ins and kokoro-js are imported lazily, so
  loading the plugin costs nothing until it speaks.
- `test/kokoro-voice.test.ts`: word matching against recorded model output (numbers, money, fused words), chunking,
  the WAV header, voices; one real synthesis with `MGL_KOKORO_TEST=1`.
