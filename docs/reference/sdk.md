# The SDK

`import { open, create } from 'michelangelo'` gives the same project session the CLI uses. The object
model is thin on purpose: `p.data` is the plain validated project (read it, never mutate it), and every
change is `p.edit(command)` with the same commands as `mgl edit` (`mgl docs commands`).
Use it when edits are computed from data: a CSV of variants, a list of beats, a 200-clip timeline.

**Install.** `import ... from 'michelangelo'` resolves only where the package is installed: in the script's
folder (or a parent) run `npm install michelangelo` (or `npm install <path or .tgz of the package>`). A global
install gives you `mgl` but Node does not resolve global packages for `import`; then run `npm link michelangelo`
in the script's folder (or import the package's `dist/sdk/index.js` by its full path). `mgl --version` prints
the version and the plugin API.

```js
import { create } from 'michelangelo';

const p = await create('sdk.mgl.json', { preset: 'shorts', name: 'Focus tips' });
await p.edit({ op: 'clip.add', id: 'bg', track: 'V1', len: '4s', gen: { type: 'gradient', colors: ['#0f2027', '#2c5364'] } });
const r = await p.edit([
  { op: 'clip.add', id: 'title', track: 'T1', at: 0, len: '2s', text: 'Three tips to focus', style: 'title' },
  { op: 'text.animate', id: 'title', in: 'pop', by: 'word' },
]);
console.log(r.summary.join('\n'));
for (const c of r.changes) console.log(`L${c.line} ${c.kind} ${c.id}`);
```

- `create(file, { preset, fps, name, platform, force })` writes a new file from a preset (shorts, tiktok,
  reels, vertical, youtube, landscape, square, portrait, 4k: the same as `mgl new`) and refuses to overwrite unless `force`.
- `open(file)` loads and validates (throws `MglError` with the line and fix), loads the project's plugins
  and attaches the media services commands need (probing, audio analysis, file reads).
- `p.edit(cmd | cmd[], { dryRun?, save? })` applies commands atomically (a list is all or nothing, and one
  undo step) and saves; it returns `{ summary, notes, changes: [{ kind, table, id, line, text }], out, issues }`.
  `p.dryRun(cmd)` (or `{ dryRun: true }`) returns the same without changing anything.
- `p.undo(n)`, `p.redo(n)`, `p.historyStatus()`: the same history as `mgl edit <file> undo`.
- Queries: `p.clip(id)`, `p.clips({ track, comp })`, `p.mainComp()`, `p.line(table, id)`, `p.text()`
  (the formatted file), `p.issues` (render-blocking issues), `p.problems` (warnings).
- Verbs: `await p.check({ platforms? })`, `await p.look({ frames: 12, at: ['1s'], cuts: true, platforms? })`,
  `await p.render('out/x.mp4', { quality: 'draft' | 'final' | 'hq', range: ['1s', '3s'], still: '1s' })`.
  `platforms: ['tiktok', 'reels']` checks every platform's safe zones at once (a platform-specific finding has
  `platform` and its message starts with `[tiktok]`). `alpha: true` (the render will use `alpha`) enables the
  alpha-with-bg rule; `displayFile` sets how fixes name the project file (default: the file relative to the cwd).
- `render` options also take the delivery settings of `mgl render`: `crf`, `bitrate`, `audioBitrate`,
  `pcmDepth` (16 | 24), `prores` (proxy, lt, 422, hq, 4444, 4444xq), `timecode` ("10:00:00:00"),
  `colorRange` ('tv' | 'pc'), and `bus` (a stem: one bus, or 'all').
- **`p.render()` renders `p.data` as it is in memory**, including edits made with `{ save: false }`: render
  variants, stems or a muted-music version without touching the file.
- `p.services`: `probe(src)` (duration, size, fps, codec), `analyzeAudio(src)` (silences, beats, tempo),
  `analyzeLevels(src, rate)` (per-frame RMS 0..1 and a spectrum: onsets for syncing angles, see recipes.md),
  `measureText(text, style)` (the laid-out width and height of a text before you animate it), `readText(path)`.
  Paths are relative to the project folder.
- `p.save({ force })` refuses if the file changed on disk since it was opened (a hand edit); open it again.

## Errors

Every failure is an `MglError` with `code`, `message`, `fix`, and `line` when it is in the file
(`errors.md` lists the codes). `e.exitCode` is 1 for input problems and 2 for the environment.

```js
import { open, MglError } from 'michelangelo';

const p = await open('sdk.mgl.json');
try {
  await p.edit({ op: 'clip.add', id: 'oops', track: 'V9', text: 'x' });
} catch (e) {
  if (!(e instanceof MglError)) throw e;
  console.log(e.code, '|', e.message, '| fix:', e.fix);
}
const plan = await p.dryRun({ op: 'clip.move', id: 'title', at: '1s' });
console.log('dry run would change', plan.changes.map((c) => c.id).join(', '));
```

## Variants from data

```js
import { writeFileSync } from 'node:fs';
import { open } from 'michelangelo';

writeFileSync('variants.csv', 'id,headline,color\nred,Sale ends today,#ff3b30\nblue,New colours in,#0a84ff\n');
const rows = (await import('node:fs')).readFileSync('variants.csv', 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
for (const [id, headline, color] of rows) {
  const p = await open('sdk.mgl.json');
  await p.edit([
    { op: 'text.set', id: 'title', text: headline },
    { op: 'clip.set', id: 'title', style: { base: 'title', color } },
  ], { save: false });
  writeFileSync(`variant-${id}.mgl.json`, p.text());
  console.log(`variant-${id}.mgl.json`);
}
```

Render each variant with `mgl render variant-red.mgl.json --draft` or `(await open(f)).render(out)`.
Renders are CPU-bound: run them one after another, or in the background with `mgl render --detach`.

## Check, look and render from a script

```js
import { open } from 'michelangelo';

const p = await open('sdk.mgl.json');
const report = await p.check();
console.log('check:', report.errors, 'errors,', report.findings.length, 'findings');
const r = await p.render('out/sdk.png', { still: '1s' });
console.log(`wrote ${r.out} ${r.width}x${r.height}`);
const box = p.services.measureText('Three tips to focus', { size: 96, maxWidth: 900 });
console.log(`title box ${Math.round(box.width)}x${Math.round(box.height)} px`);
const multi = await p.check({ platforms: ['tiktok', 'reels'] });
console.log('tiktok + reels findings:', multi.findings.length);
```
