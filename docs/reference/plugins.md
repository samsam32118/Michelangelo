# Plugins

A plugin adds **effects** (source, layer and/or audio stage), **transitions**, **generators** (clip kinds that
draw), **templates**, **commands**, **QA checks**, **importers**, **exporters**, text **styles** and text
**animations**. The built-ins use exactly the same API (`michelangelo/plugin`), so anything they do a
plugin can do.

## The loop

```sh
mgl new shorts -o demo.mgl.json
mgl edit demo.mgl.json clip.add id=bg track=V1 len=2s gen='{"type": "gradient"}'
mgl plugin new effect film-tint
mgl plugin test plugins/film-tint
mgl plugin trust plugins/film-tint
mgl edit demo.mgl.json project.set plugins='{"film-tint": "^0.1.0"}'
mgl edit demo.mgl.json fx.add bg type=film-tint amount=0.4
mgl plugin list demo.mgl.json
mgl render demo.mgl.json out/tint.png --still 1s
mgl plugin new audio-effect voice-chain
mgl plugin test plugins/voice-chain
```

1. `mgl plugin new <kind> <name>` scaffolds `plugins/<name>/` next to the project (kinds: effect,
   audio-effect, transition, generator, template, command, check, importer, exporter) with a working example,
   a passing test, an eval task and a README.
2. Edit `plugins/<name>/src/index.ts`. Keep to erasable TypeScript (no enums, namespaces or parameter
   properties): Node runs it directly.
3. `mgl plugin test plugins/<name>` checks the manifest, loads the definition in a child process, checks the
   ffmpeg filters of source/audio-stage effects against the allowlist, writes `.preview.png` for drawing
   effects, transitions and generators (look at it; the bundled fonts are registered, as in a render),
   type-checks when `tsc` is available, and runs `test/*.test.ts` with `node --test`. Exit 1 until everything
   passes.
4. Name it in the project: `project.set plugins='{"<name>": "^0.1.0"}'` (or `mgl.config.json`).
5. `mgl plugin trust plugins/<name>`: plugins found next to a project load only after you trust them; the
   trust store keeps the plugin's name and a hash of its files, so **trust again after every edit**.
   Untrusted plugins let `show`, `check` and `edit` work and refuse `render` / `look` with the fix.

## Layout

```text
plugins/film-tint/
  package.json        "type": "module", "main": "src/index.ts", "michelangelo": {"api": "^1.2.0", "kinds": ["effect"]}
  src/index.ts        export default definePlugin({ name: 'film-tint', effects: [...] })
  test/film-tint.test.ts   uses michelangelo/testing
  evals/film-tint-basic/   task.md + meta.json
  README.md
```

## The API (`michelangelo/plugin`, semver 1.x, minor versions only add)

```text
definePlugin({ name, version?, effects?, transitions?, generators?, templates?, commands?, checks?, importers?, exporters?, styles?, textAnimations? })
defineEffect({ type, describe, params: z.object({...}), draw?({ src, dst, params, frame, time, fps, seed, comp }), source?(params) → FilterSpec[], audio?(params) → FilterSpec[], margin?(params) })
defineTransition({ type, describe, params, draw({ from, to, dst, progress, params, ... }) })
defineGenerator({ type, describe, params, size?(params, comp), draw({ dst, params, frame, time, fps, seed, comp, audio? }), audioSource?(params) → asset id })
defineTemplate({ id, describe, params, build({ params, comp, rate, at, len, prefix, project }) → { clips, tracks?, comps?, styles?, cues?, summary? } })
defineCommand({ op: '<plugin>.<verb>', group, doc, schema, primary?, example, apply(ctx, payload) })
defineCheck({ id, describe, stage: 'project' | 'frame' | 'audio', run(ctx) → [{ rule, severity, message, clip?, frame?, box?, fix? }] })
defineImporter({ id, describe, extensions, import({ file, text, project, options }) → commands })
defineExporter({ id, describe, extensions, export({ out, project, compId, renderFrames, renderAudio }) })
```

- A `Surface` (`src`, `dst`, `from`, `to`) has `ctx` (a CanvasRenderingContext2D-compatible context),
  `pixels()` (RGBA, call `commit()` after changing them), `scratch(w?, h?)`, `clear()`, `width`, `height`.
- **Parameters are zod schemas**; numeric and colour parameters are animatable with keyframes for free.
- `draw` must be a pure function of (params, frame, seed): use `seed` for randomness.
- Source-stage effects return structured ffmpeg filters (`{ filter: 'hue', args: { s: 0 } }`); the core
  escapes them and refuses filters that read files or run commands. `source()` filters are video only: they
  never touch the sound.
- **Audio effects** (API 1.1) implement `audio(params)` and return ffmpeg audio filters (`highpass`, `equalizer`,
  `afftdn`, `acompressor`, `deesser`, `alimiter`, ... from an allowlist; nothing that reads files or changes the
  length). An effect with only `audio` goes on a clip with sound (`fx.add <clip> type=x`) or a bus mix
  (`fx.add bus=dialogue type=x`); adding it to a silent clip is an error. Annotate the list you build
  (`const chain: FilterSpec[] = [...]`) so mixed argument types type-check. Scaffold one with
  `mgl plugin new audio-effect <name>`.
- A `FilterSpec` may carry an optional `latency` (output delay in samples at 48 kHz) for a filter that delays its
  output; the mixer compensates it so the sound stays in sync. Known lookahead filters are compensated without it.
  The field is an additive change (API 1.x).
- **Audio-reactive generators** (API 1.1) return an asset id from `audioSource(params)`; `draw` then gets
  `audio: { rms, spectrum, bands, frame }` (per-frame RMS 0..1 and `bands` spectrum values per frame of that
  asset; read `rms[audio.frame]`). The built-in `waveform` and `spectrum` generators work this way.
- `frame` and `time` are clip-local; `fps`, `seed` and `comp` (the comp size) are passed to every draw. Text
  drawn with `ctx.font = '700 64px Inter'` uses the bundled fonts (Inter, Noto Sans, Anton, JetBrains Mono).
- Commands are named `<plugin>.<verb>`, have a zod schema, a doc sentence and an example, and change the
  project only through `ctx` (so they are undoable and dry-runnable).

## Testing helpers (`michelangelo/testing`)

`renderEffect(def, params, opts)`, `effectFilters(def, params)` (source/audio stages: the filters and the
escaped filtergraph, checked against the allowlist), `renderTransition(def, progress, opts)`,
`renderGenerator(def, params, frame, { audio? })` (audio-reactive generators get `testLevels()` by default),
`runCommandOn(project, cmd)`, `checkContext(project)`, `testProject()`, `renderProject(project, frame)`,
`pixel(surface, x, y)`, `meanColor`, `coverage`, `difference`, `distinctLevels`, `savePNG`, `loadPlugin(import.meta.url)`,
plus `test` and `assert` (node:test).

## Loading rules and safety

- Only plugins the project (or `mgl.config.json` next to it) names are loaded: never anything found just
  by being in the folder. Resolution: `./plugins/<name>/` next to the project, then `node_modules/<name>`.
- **Every plugin loads only once trusted**, from `./plugins/` or `node_modules/` alike (a cloned repo can ship
  both, so being listed in package.json is not trust): `mgl plugin trust node_modules/<name>` after reading it.
  The hash covers every file of the plugin folder (also `out/` or `dist/`, and symlink targets, which must stay
  inside the folder) except `node_modules/`, `.git/` and `.mgl/`; an entry inside those, or outside the folder,
  is refused.
- Plugin code imports `michelangelo/plugin` and `michelangelo/testing`; they resolve to the Michelangelo that
  is running (global install, npx or a project dependency), so a plugin folder needs no `node_modules`.
- The manifest's `api` range must include this Michelangelo's plugin API (1.2.0; `mgl --version` prints it), and the version must
  satisfy the project's range; otherwise the plugin is refused with the reason and a fix.
- **Plugins are code that runs on your machine with no sandbox.** Read a plugin before trusting it.
- `mgl plugin list [file]` shows what is loaded, versions and sources, and every plugin problem.
