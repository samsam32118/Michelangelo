# on-air

Two audio examples for plugin API 1.1:

- **telephone** (audio effect): `audio(params)` returns ffmpeg audio filters (high-pass, low-pass, a bit-crusher,
  make-up gain). Add it to a clip with sound or to a bus: `mgl edit demo.mgl.json fx.add bus=dialogue type=telephone`.
- **level-meter** (audio-reactive generator): `audioSource(params)` names the asset, and `draw` gets
  `audio.rms[audio.frame]`: `mgl edit demo.mgl.json clip.add gen='{"type": "level-meter", "asset": "vo"}' len=5s x=1000`.

```sh
mgl plugin test plugins/on-air
mgl plugin trust plugins/on-air
mgl edit demo.mgl.json project.set plugins='{"on-air": "^1.0.0"}'
```

Tests use `effectFilters` (audio filters checked against the allowlist) and `renderGenerator` with `testLevels`.
