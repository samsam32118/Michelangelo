/**
 * `mgl plugin new <kind> <name>`: writes plugins/<name>/ with a manifest, a working example of that kind,
 * a passing node:test test (michelangelo/testing), an eval task and a README.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { PLUGIN_API_VERSION } from './api.js';
import { builtinRegistry } from '../builtin/index.js';
import '../core/commands/index.js';
import { listCommands } from '../core/commands/registry.js';

export const SCAFFOLD_KINDS = ['effect', 'audio-effect', 'transition', 'generator', 'template', 'command', 'check', 'importer', 'exporter'] as const;
export type ScaffoldKind = (typeof SCAFFOLD_KINDS)[number];

interface Parts { src: string; test: string; task: string; checks: string[]; use: string; what: string }

const camel = (n: string) => n.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function parts(kind: ScaffoldKind, n: string): Parts {
  const v = camel(n);
  switch (kind) {
    case 'effect': return {
      what: `a layer effect that tints a layer towards a colour`,
      src: `import { definePlugin, defineEffect, z } from 'michelangelo/plugin';

/** Tints every visible pixel towards \`color\` by \`amount\`. Replace the loop with your effect. */
const ${v} = defineEffect({
  type: '${n}',
  describe: 'Tints the layer towards a colour (amount 0 = off, 1 = solid colour, alpha kept).',
  params: z.object({
    amount: z.number().min(0).max(1).default(0.5),
    color: z.string().default('#ff3300').describe('a CSS colour'),
  }),
  draw({ src, dst, params: p }) {
    // resolve the CSS colour to RGB by painting one pixel
    const one = dst.scratch(1, 1);
    one.ctx.fillStyle = p.color;
    one.ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = one.pixels();
    const s = src.pixels(), d = dst.pixels();
    for (let i = 0; i < s.length; i += 4) {
      d[i] = s[i]! + (r! - s[i]!) * p.amount;
      d[i + 1] = s[i + 1]! + (g! - s[i + 1]!) * p.amount;
      d[i + 2] = s[i + 2]! + (b! - s[i + 2]!) * p.amount;
      d[i + 3] = s[i + 3]!;
    }
    dst.commit();
  },
});

export default definePlugin({ name: '${n}', version: '0.1.0', effects: [${v}] });
`,
      test: `import { test, assert, loadPlugin, renderEffect, meanColor, difference } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const effect = plugin.effects![0]!;

test('amount 0 leaves the layer unchanged', () => {
  const { dst, src } = renderEffect(effect, { amount: 0 });
  assert.ok(difference(dst, src) < 0.5);
});

test('amount 1 paints the colour and keeps alpha', () => {
  const { dst } = renderEffect(effect, { amount: 1, color: '#ff0000' });
  const [r, g, b, a] = meanColor(dst);
  assert.ok(r > 250 && g < 5 && b < 5, \`mean colour \${r},\${g},\${b}\`);
  assert.equal(a, 255);
});
`,
      task: `Apply the \`${n}\` effect to the clip in \`demo.mgl.json\` with \`amount\` 0.8 and \`color\` "#00aaff", and render a still at 1 s to \`out/${n}.png\`.`,
      checks: [`demo.mgl.json names the plugin and the clip has fx ${n} amount=0.8`, `out/${n}.png: the clip area is tinted towards #00aaff`],
      use: `mgl edit demo.mgl.json clip.set <clip> 'fx=[{"type": "${n}", "amount": 0.8}]'`,
    };
    case 'audio-effect': return {
      what: 'an audio effect (a voice clean-up chain: high-pass, de-esser, compressor) for clip sound or a bus mix',
      src: `import { definePlugin, defineEffect, z, type FilterSpec } from 'michelangelo/plugin';

/**
 * An audio effect: only an audio() stage, which returns ffmpeg audio filters (checked against an allowlist and
 * escaped by Michelangelo). Put it on a clip with sound (fx.add <clip> type=${n}) or on a bus (fx.add bus=<id> type=${n}).
 */
const ${v} = defineEffect({
  type: '${n}',
  describe: 'Voice clean-up: removes rumble below lowCut Hz, tames sibilance and evens out the level (amount 0 = off).',
  params: z.object({
    lowCut: z.number().min(20).max(400).default(90).describe('high-pass cutoff in Hz'),
    amount: z.number().min(0).max(1).default(0.6).describe('de-esser and compressor strength'),
  }),
  audio(p) {
    // annotate the list: mixed literal args would otherwise not match FilterSpec
    const chain: FilterSpec[] = [{ filter: 'highpass', args: { f: p.lowCut, poles: 2 } }];
    if (p.amount > 0) {
      chain.push({ filter: 'deesser', args: { i: Math.round(p.amount * 0.6 * 100) / 100 } });
      chain.push({ filter: 'acompressor', args: { threshold: Math.round((0.25 - p.amount * 0.2) * 1000) / 1000, ratio: 1 + p.amount * 4, attack: 10, release: 150 } });
    }
    return chain;
  },
});

export default definePlugin({ name: '${n}', version: '0.1.0', effects: [${v}] });
`,
      test: `import { test, assert, loadPlugin, effectFilters } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const effect = plugin.effects![0]!;

test('is an audio effect (no draw, no source stage)', () => {
  assert.equal(typeof effect.audio, 'function');
  assert.equal(effect.draw, undefined);
});

test('default params give an allowed high-pass + de-esser + compressor chain', async () => {
  const f = await effectFilters(effect, {});
  assert.deepEqual(f.audio.map((x) => x.filter), ['highpass', 'deesser', 'acompressor']);
  assert.match(f.audioGraph, /^highpass=f=90/);
});

test('amount 0 keeps only the high-pass', async () => {
  const f = await effectFilters(effect, { amount: 0, lowCut: 120 });
  assert.equal(f.audioGraph, 'highpass=f=120:poles=2');
});
`,
      task: `Add the \`${n}\` audio effect to the dialogue bus of \`demo.mgl.json\` (create the bus and route the voice track to it if needed), and render the mix to \`out/${n}.wav\`.`,
      checks: [`demo.mgl.json names the plugin and bus "dialogue" has fx ${n}`, `out/${n}.wav: less energy below 80 Hz than the raw voice`],
      use: `mgl edit demo.mgl.json fx.add bus=dialogue type=${n}`,
    };
    case 'transition': return {
      what: 'a transition that wipes from left to right',
      src: `import { definePlugin, defineTransition, z } from 'michelangelo/plugin';

/** A hard-edged wipe: the incoming clip is revealed from one side. Replace with your transition. */
const ${v} = defineTransition({
  type: '${n}',
  describe: 'A wipe that reveals the incoming clip from the left (or right) edge.',
  params: z.object({
    from: z.enum(['left', 'right']).default('left').describe('the edge the reveal starts at'),
  }),
  draw({ from, to, dst, progress, params: p }) {
    const c = dst.ctx, w = dst.width * progress;
    c.drawImage(from.canvas, 0, 0);
    c.save();
    c.beginPath();
    c.rect(p.from === 'left' ? 0 : dst.width - w, 0, w, dst.height);
    c.clip();
    c.clearRect(0, 0, dst.width, dst.height);
    c.drawImage(to.canvas, 0, 0);
    c.restore();
  },
});

export default definePlugin({ name: '${n}', version: '0.1.0', transitions: [${v}] });
`,
      test: `import { test, assert, loadPlugin, renderTransition, difference, meanColor } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const transition = plugin.transitions![0]!;

test('progress 0 is the outgoing clip, 1 the incoming clip', () => {
  const a = renderTransition(transition, 0);
  assert.equal(difference(a.dst, a.from), 0);
  const b = renderTransition(transition, 1);
  assert.equal(difference(b.dst, b.to), 0);
});

test('halfway: the left half is incoming, the right half outgoing', () => {
  const { dst, to, from } = renderTransition(transition, 0.5);
  assert.deepEqual(meanColor(dst, [0, 0, 150, 180]), meanColor(to, [0, 0, 150, 180]));
  assert.deepEqual(meanColor(dst, [170, 0, 150, 180]), meanColor(from, [170, 0, 150, 180]));
});
`,
      task: `Put a 1 s \`${n}\` transition between the two clips of \`demo.mgl.json\` (on the second clip's \`in\`), and render a still at the middle of the transition to \`out/${n}.png\`.`,
      checks: [`demo.mgl.json names the plugin and clip 2 has transition.in type ${n}, len 1 s`, `out/${n}.png: left part shows clip 2, right part clip 1`],
      use: `mgl edit demo.mgl.json clip.set <second clip> 'transition.in={"type": "${n}", "len": "1s"}'`,
    };
    case 'generator': return {
      what: 'a generator that draws expanding rings',
      src: `import { definePlugin, defineGenerator, z } from 'michelangelo/plugin';

/** Rings that expand from the centre and fade; a pure function of (params, time). Replace with yours. */
const ${v} = defineGenerator({
  type: '${n}',
  describe: 'Concentric rings expanding from the centre and fading out, looping every period seconds.',
  params: z.object({
    color: z.string().default('#ffffff'),
    rings: z.number().int().min(1).max(50).default(5),
    width: z.number().min(0.5).max(100).default(6).describe('line width in px'),
    period: z.number().min(0.1).max(60).default(2).describe('seconds for a ring to reach the edge'),
  }),
  draw({ dst, params: p, time }) {
    const c = dst.ctx, cx = dst.width / 2, cy = dst.height / 2, R = Math.hypot(cx, cy);
    c.strokeStyle = p.color;
    c.lineWidth = p.width;
    for (let i = 0; i < p.rings; i++) {
      const t = (time / p.period + i / p.rings) % 1;
      c.globalAlpha = 1 - t;
      c.beginPath();
      c.arc(cx, cy, t * R, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
  },
});

export default definePlugin({ name: '${n}', version: '0.1.0', generators: [${v}] });
`,
      test: `import { test, assert, loadPlugin, renderGenerator, coverage, difference } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const generator = plugin.generators![0]!;

test('draws rings on a transparent layer', () => {
  const { dst } = renderGenerator(generator, {}, 0);
  const cov = coverage(dst);
  assert.ok(cov > 0.02 && cov < 0.9, \`coverage \${cov}\`);
});

test('animates, and the same frame renders the same', () => {
  const a = renderGenerator(generator, {}, 10).dst;
  assert.equal(difference(a, renderGenerator(generator, {}, 10).dst), 0);
  assert.ok(difference(a, renderGenerator(generator, {}, 20).dst) > 0.2);
});
`,
      task: `Add a 3 s \`${n}\` generator clip with 8 rings in "#ffcc00" on top of the video in \`demo.mgl.json\`, and render a still at 1 s to \`out/${n}.png\`.`,
      checks: [`demo.mgl.json names the plugin and has a clip with gen.type ${n}, rings 8`, `out/${n}.png: yellow ring pixels over the video`],
      use: `mgl edit demo.mgl.json clip.add 'gen={"type": "${n}", "rings": 8}' len=3s`,
    };
    case 'template': return {
      what: 'a template that builds a title card',
      src: `import { definePlugin, defineTemplate, z } from 'michelangelo/plugin';

const params = z.object({
  title: z.string().default('Title'),
  bg: z.string().default('#101014'),
  color: z.string().default('#ffffff'),
});

/** A title card: background + centred title. Layers are named by \`track\`; template.apply places them. */
const ${v} = defineTemplate({
  id: '${n}',
  describe: 'A title card: a solid background and a centred title that fades in (3 s).',
  params,
  build({ params: raw, comp, rate, at, len }) {
    const p = params.parse(raw);
    const [W, H] = comp.size;
    const n = len ?? Math.round((3 * rate.num) / rate.den);
    const size = Math.round(Math.min(W, H) / 10);
    return {
      clips: [
        { id: 'bg', track: 'bg', at, len: n, color: p.bg },
        { id: 'title', track: 'title', at, len: n, text: p.title, style: { size, color: p.color, align: 'center', box: [Math.round(W * 0.8), size * 3], maxLines: 2 }, x: Math.round(W / 2), y: Math.round(H / 2), fade: [Math.min(10, Math.floor(n / 4)), 0] },
      ],
      summary: \`title card "\${p.title}"\`,
    };
  },
});

export default definePlugin({ name: '${n}', version: '0.1.0', templates: [${v}] });
`,
      test: `import { test, assert, loadPlugin, testProject, runCommandOn } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);

test('template.apply builds the card on free tracks', async () => {
  const r = await runCommandOn(testProject({ seconds: 5 }), { op: 'template.apply', template: '${n}', at: '0.5s', params: { title: 'Hello' } }, { plugins: [plugin] });
  const made = r.project.clips!.filter((c) => c.tags?.includes('template:${n}'));
  assert.equal(made.length, 2);
  assert.ok(made.some((c) => c.text === 'Hello'));
  assert.ok(made.every((c) => c.at === 15 && c.len === 90));
});
`,
      task: `Add the \`${n}\` template at the start of \`demo.mgl.json\` with the title "Launch day", and render a still at 1 s to \`out/${n}.png\`.`,
      checks: [`demo.mgl.json names the plugin and has clips tagged template:${n} with the text "Launch day"`, `out/${n}.png is not blank and shows light text pixels in the centre`],
      use: `mgl edit demo.mgl.json template.apply ${n} params='{"title": "Launch day"}'`,
    };
    case 'command': return {
      what: `a command, ${n}.title, that adds a title on a new top track`,
      src: `import { definePlugin, z, type CommandDef } from 'michelangelo/plugin';

/** A command definition; the plugin loader registers it when a project names this plugin. */
const command = <S extends z.ZodObject>(def: CommandDef<S>) => def;
const Time = z.union([z.number().int(), z.string()]);

const title = command({
  op: '${n}.title', group: '${n}',
  doc: 'Add a title (text) at a time on a new track above everything in the comp.',
  schema: z.strictObject({ text: z.string().min(1), at: Time.optional(), len: Time.optional(), comp: z.string().optional() }),
  primary: 'text', example: { text: 'Hello', at: '1s', len: '2s' },
  apply(ctx, a) {
    const p = ctx.project;
    const comp = ctx.comp(a.comp ?? p.project?.main ?? p.comps[0]!.id);
    const track = { id: ctx.newId('titles'), comp: comp.id };
    (p.tracks ??= []).push(track);
    const clip = { id: ctx.newId('title'), track: track.id, at: ctx.time(a.at ?? 0, comp, 'at'), len: ctx.time(a.len ?? '2s', comp, 'len'), text: a.text, style: 'title' };
    (p.clips ??= []).push(clip);
    ctx.out.id = clip.id;
    ctx.summary(\`added title "\${clip.id}" on \${track.id} at frame \${clip.at}.\`);
  },
});

export default definePlugin({ name: '${n}', version: '0.1.0', commands: [title] });
`,
      test: `import { test, assert, loadPlugin, testProject, runCommandOn } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);

test('${n}.title adds a text clip on a new track', async () => {
  const r = await runCommandOn(testProject(), { op: '${n}.title', text: 'Hello', at: '1s' }, { plugins: [plugin] });
  const clip = r.project.clips!.find((c) => c.id === r.out.id)!;
  assert.equal(clip.text, 'Hello');
  assert.equal(clip.at, 30);
  assert.equal(clip.len, 60);
  assert.equal(r.project.tracks!.length, 2);
});
`,
      task: `Use the \`${n}.title\` command to add the title "Chapter 1" at 2 s for 3 s in \`demo.mgl.json\`, and render a still at 3 s to \`out/${n}.png\`.`,
      checks: [`demo.mgl.json names the plugin and has a text clip "Chapter 1" at 2 s, 3 s long, on its own track`, `out/${n}.png shows text pixels`],
      use: `mgl edit demo.mgl.json ${n}.title "Chapter 1" at=2s len=3s`,
    };
    case 'check': return {
      what: 'a QA check that flags very short visual clips',
      src: `import { definePlugin, defineCheck, type Finding } from 'michelangelo/plugin';

/** Flags visual clips shorter than half a second (flashes viewers can't read). */
const ${v} = defineCheck({
  id: '${n}',
  describe: 'Warns about visual clips shorter than 0.5 s in the comp.',
  stage: 'project',
  run({ project, compId }) {
    const comp = project.comps.find((c) => c.id === compId)!;
    const [num, den] = String(comp.fps).split('/').map(Number);
    const min = Math.round((0.5 * num!) / (den || 1));
    const tracks = new Set((project.tracks ?? []).filter((t) => t.comp === compId && !t.audio).map((t) => t.id));
    const out: Finding[] = [];
    for (const c of project.clips ?? []) {
      if (!tracks.has(c.track) || c.len >= min) continue;
      out.push({ rule: '${n}', severity: 'warning', clip: c.id, frame: c.at, message: \`clip "\${c.id}" is only \${c.len} frames long (under 0.5 s).\`, fix: \`mgl edit <file> clip.trim \${c.id} len=\${min}\` });
    }
    return out;
  },
});

export default definePlugin({ name: '${n}', version: '0.1.0', checks: [${v}] });
`,
      test: `import { test, assert, loadPlugin, testProject, checkContext } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const check = plugin.checks![0]!;

test('flags a 5-frame clip and nothing else', async () => {
  const p = testProject();
  p.clips!.push({ id: 'flash', track: 'V1', at: 60, len: 5, color: '#ffffff' });
  const findings = await check.run(checkContext(p));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.clip, 'flash');
  assert.match(findings[0]!.fix!, /clip.trim flash/);
});
`,
      task: `Run \`mgl check demo.mgl.json\` with the \`${n}\` plugin enabled, and fix every clip it flags so the check reports nothing.`,
      checks: [`demo.mgl.json names the plugin`, `no visual clip in the main comp is shorter than 0.5 s`, `the number of clips is unchanged`],
      use: 'mgl check demo.mgl.json',
    };
    case 'importer': return {
      what: 'an importer that turns a .cuts list ("start end label" per line, seconds) into markers',
      src: `import { definePlugin, defineImporter } from 'michelangelo/plugin';

/** Reads a cut list: one "start end label" line per range (seconds); "#" starts a comment. */
const ${v} = defineImporter({
  id: '${n}',
  describe: 'Imports a .cuts list (lines "start end label", seconds) as comp markers.',
  extensions: ['.cuts'],
  async import({ text }) {
    const ops: { op: string; [k: string]: unknown }[] = [];
    for (const line of (await text()).split(/\\r?\\n/)) {
      const t = line.replace(/#.*/, '').trim();
      if (!t) continue;
      const [a, b, ...label] = t.split(/\\s+/);
      const start = Number(a), end = Number(b);
      if (!(end > start && start >= 0)) throw new Error(\`bad line "\${line}" (fix: write "start end label" in seconds, end after start)\`);
      ops.push({ op: 'marker.add', at: \`\${start}s\`, len: \`\${end - start}s\`, ...(label.length ? { note: label.join(' ') } : {}) });
    }
    return ops;
  },
});

export default definePlugin({ name: '${n}', version: '0.1.0', importers: [${v}] });
`,
      test: `import { test, assert, loadPlugin, testProject, runCommandOn } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const importer = plugin.importers![0]!;

test('turns each line into a marker', async () => {
  let project = testProject();
  const ops = await importer.import({ file: 'a.cuts', text: async () => '0 0.5 intro\\n# comment\\n1 1.5 hook\\n', project, options: {} });
  assert.equal(ops.length, 2);
  for (const op of ops) project = (await runCommandOn(project, op)).project;
  assert.deepEqual(project.markers!.map((m) => [m.at, m.len, m.note]), [[0, 15, 'intro'], [30, 15, 'hook']]);
});
`,
      task: `Import \`cuts.cuts\` into \`demo.mgl.json\` with the \`${n}\` importer, so each line becomes a marker on the main comp.`,
      checks: [`demo.mgl.json names the plugin`, 'one marker per line of cuts.cuts with matching times (±1 frame) and notes'],
      use: 'mgl import demo.mgl.json cuts.cuts',
    };
    case 'exporter': return {
      what: 'an exporter that writes the clips of a comp as a .cuts list',
      src: `import { writeFile } from 'node:fs/promises';
import { definePlugin, defineExporter } from 'michelangelo/plugin';

/** Writes "start end id" (seconds) for each clip of the comp, in timeline order. */
const ${v} = defineExporter({
  id: '${n}',
  describe: 'Exports the clips of a comp as a .cuts list: one "start end id" line per clip, in seconds.',
  extensions: ['.cuts'],
  async export({ out, project, compId }) {
    const comp = project.comps.find((c) => c.id === compId)!;
    const [num, den] = String(comp.fps).split('/').map(Number);
    const sec = (f: number) => Math.round((f * (den || 1) * 1000) / num!) / 1000;
    const tracks = new Set((project.tracks ?? []).filter((t) => t.comp === compId).map((t) => t.id));
    const lines = (project.clips ?? []).filter((c) => tracks.has(c.track)).sort((a, b) => a.at - b.at)
      .map((c) => \`\${sec(c.at)} \${sec(c.at + c.len)} \${c.id}\`);
    await writeFile(out, lines.join('\\n') + '\\n');
  },
});

export default definePlugin({ name: '${n}', version: '0.1.0', exporters: [${v}] });
`,
      test: `import { test, assert, loadPlugin, testProject, tempFile, readText } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const exporter = plugin.exporters![0]!;

test('writes one line per clip in seconds', async () => {
  const project = testProject();
  project.clips!.push({ id: 'title', track: 'V1', at: 75, len: 15, color: '#ffffff' });
  const out = tempFile('list.cuts');
  await exporter.export({ out, project, compId: 'main', renderFrames: async function* () {}, renderAudio: async () => {} });
  assert.equal(readText(out), '0 2 bg\\n2.5 3 title\\n');
});
`,
      task: `Export the main comp of \`demo.mgl.json\` with the \`${n}\` exporter to \`out/list.cuts\`.`,
      checks: [`demo.mgl.json names the plugin`, 'out/list.cuts has one "start end id" line per clip of the main comp, in order'],
      use: 'mgl render demo.mgl.json out/list.cuts',
    };
  }
}

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Why `name` would clash with a built-in once loaded (the scaffold names its item after the plugin), or undefined. */
export function builtinClash(kind: ScaffoldKind, name: string): string | undefined {
  const r = builtinRegistry();
  if (r.plugins.has(name)) return `"${name}" is the name of a built-in plugin`;
  const maps: Partial<Record<ScaffoldKind, Map<string, unknown>>> = {
    effect: r.effects, 'audio-effect': r.effects, transition: r.transitions, generator: r.generators, template: r.templates, check: r.checks, importer: r.importers, exporter: r.exporters,
  };
  if (maps[kind]?.has(name)) return `a built-in ${kind} is already called "${name}"`;
  if (kind === 'command' && listCommands().some((c) => c.op.split('.')[0] === name || c.group === name)) return `built-in commands already use the "${name}." prefix`;
  return undefined;
}

/** Scaffold plugins/<name>/ under `dir` (a project folder). Returns the plugin folder and the files written. */
export function scaffoldPlugin(kind: ScaffoldKind, name: string, dir: string): { dir: string; files: string[] } {
  if (!(SCAFFOLD_KINDS as readonly string[]).includes(kind)) fail('E_ARG', `"${kind}" is not a plugin kind.`, `use one of: ${SCAFFOLD_KINDS.join(', ')}.`);
  if (!NAME_RE.test(name)) fail('E_ARG', `"${name}" is not a valid plugin name.`, 'use lowercase letters, digits and dashes, starting with a letter (e.g. "film-burn").');
  const clash = builtinClash(kind, name);
  if (clash) fail('E_ARG', `cannot scaffold ${kind} "${name}": ${clash}, so the plugin would not load.`, `choose another name, e.g. "my-${name}" or "${name}-2".`);
  const root = resolve(dir, 'plugins', name);
  if (existsSync(root)) fail('E_EXISTS', `${root} already exists.`, `choose another name, or delete plugins/${name} first.`);
  const p = parts(kind, name);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name, version: '0.1.0', description: `${p.what[0]!.toUpperCase()}${p.what.slice(1)}.`, type: 'module', main: 'src/index.ts',
      michelangelo: { api: `^${PLUGIN_API_VERSION}`, kinds: [kind === 'audio-effect' ? 'effect' : kind] },
      scripts: { test: 'node --test test/*.test.ts' },
      peerDependencies: { michelangelo: '*' },
    }, null, 2) + '\n',
    'src/index.ts': p.src,
    [`test/${name}.test.ts`]: p.test,
    [`evals/${name}-basic/task.md`]: p.task + '\n',
    [`evals/${name}-basic/meta.json`]: JSON.stringify({
      id: `${name}-basic`, tags: ['plugins', kind], timeout_min: 15, expects_weak: false,
      fixtures: ['demo.mgl.json (a 1080x1920 30 fps comp with a testsrc2 clip)'], checks: p.checks,
    }, null, 2) + '\n',
    'README.md': readme(kind, name, p),
  };
  for (const [rel, text] of Object.entries(files)) {
    const f = join(root, rel);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, text);
  }
  return { dir: root, files: Object.keys(files).map((f) => join(root, f)) };
}

function readme(kind: ScaffoldKind, n: string, p: Parts): string {
  return `# ${n}

A Michelangelo ${kind === 'audio-effect' ? 'audio effect' : kind} plugin: ${p.what}. Start from \`src/index.ts\`; it imports only \`michelangelo/plugin\`.

## Develop

\`\`\`sh
mgl plugin test plugins/${n}     # manifest, definition, type-check, tests, .preview.png
\`\`\`

Tests live in \`test/\` and run with \`node --test\` using \`michelangelo/testing\`
(\`renderEffect\`, \`effectFilters\` (source/audio stages), \`renderTransition\`, \`renderGenerator\`, \`runCommandOn\`, \`checkContext\`, \`pixel\`, \`meanColor\`, ...).
Keep \`src/index.ts\` to erasable TypeScript (no enums or namespaces): Node runs it directly.

## Use it in a project

\`\`\`sh
mgl plugin trust plugins/${n}    # plugins next to a project load only once trusted (re-run after edits)
mgl edit demo.mgl.json project.set plugins='{"${n}": "^0.1.0"}'
${p.use}
\`\`\`

Plugins are code that runs on your machine with no sandbox: only trust plugins you have read.

## Eval

\`evals/${n}-basic/\` holds an eval task for this plugin (\`task.md\` + \`meta.json\`), in the same format as Michelangelo's own evals.
`;
}
