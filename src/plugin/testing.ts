/**
 * `michelangelo/testing`: helpers for plugin tests with zero extra dependencies. Tests run with
 * `node --test` (what `mgl plugin test` uses); under vitest, `test` is vitest's.
 *
 *   import { test, assert, loadPlugin, renderEffect, meanColor } from 'michelangelo/testing';
 *   const plugin = await loadPlugin(import.meta.url);
 *   test('tints red', () => { const { dst } = renderEffect(plugin.effects![0]!, { amount: 1 }); ... });
 */
import nodeAssert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MglError } from '../core/errors.js';
import type { ProjectFile } from '../core/schema/index.js';
import type { EffectDef, GeneratorDef, TransitionDef, PluginDef, Surface, CheckContext, AudioLevels } from './api.js';
import type { FilterSpec } from '../render/types.js';
import { createSurface as rawSurface } from './surface.js';
import { registerFonts } from '../render/text.js';

let fontsReady = false;
/** Surfaces for tests and previews: the bundled fonts (Inter, ...) are registered first, as in a render. */
function createSurface(w: number, h: number): Surface {
  if (!fontsReady) { fontsReady = true; try { registerFonts(); } catch { /* fonts are optional for pixel tests */ } }
  return rawSurface(w, h);
}
import { PluginRegistry } from './registry.js';

type TestFn = (name: string, fn: () => unknown | Promise<unknown>) => void;

const underVitest = !!process.env.VITEST;
const runner = (await import(/* @vite-ignore */ underVitest ? 'vitest' : 'node:test')) as { test: TestFn };

/** Define a test (node:test, or vitest's when run by vitest). */
export const test: TestFn = (name, fn) => runner.test(name, async () => { await fn(); });
/** node:assert/strict */
export const assert: typeof nodeAssert = nodeAssert;

export type RGBA = [number, number, number, number];
export type Box = [number, number, number, number];

export interface RenderStats {
  /** wall time of draw (ms) */
  ms: number;
  /** mean straight RGBA of the output */
  mean: RGBA;
  /** fraction of pixels with alpha > 0 */
  coverage: number;
}

const BARS: RGBA[] = [[255, 255, 255, 255], [255, 255, 0, 255], [0, 255, 255, 255], [0, 255, 0, 255], [255, 0, 255, 255], [255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 0, 255]];

/** A test image: 8 colour bars (white, yellow, cyan, green, magenta, red, blue, black) over the top 2/3, a black → white ramp below. */
export function testPattern(width = 320, height = 180): Surface {
  const s = createSurface(width, height);
  const d = s.pixels(), w = s.width, h = s.height, split = Math.round((h * 2) / 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (y < split) d.set(BARS[Math.min(7, Math.floor((x * 8) / w))]!, i);
    else { const v = Math.round((x / Math.max(1, w - 1)) * 255); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  }
  s.commit();
  return s;
}

/** A surface filled with one CSS colour. */
export function solid(width: number, height: number, color: string): Surface {
  const s = createSurface(width, height);
  s.ctx.fillStyle = color;
  s.ctx.fillRect(0, 0, s.width, s.height);
  return s;
}

/** Straight RGBA at (x, y). */
export function pixel(s: Surface, x: number, y: number): RGBA {
  const d = s.pixels(), i = (Math.floor(y) * s.width + Math.floor(x)) * 4;
  return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
}

function region(s: Surface, box?: Box): Box {
  const [x, y, w, h] = box ?? [0, 0, s.width, s.height];
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  return [x0, y0, Math.min(s.width, Math.ceil(x + w)) - x0, Math.min(s.height, Math.ceil(y + h)) - y0];
}

/** Mean straight RGBA over a box [x, y, w, h] (default: the whole surface). */
export function meanColor(s: Surface, box?: Box): RGBA {
  const d = s.pixels(), [x0, y0, w, h] = region(s, box);
  const sum = [0, 0, 0, 0];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * s.width + x) * 4;
    for (let c = 0; c < 4; c++) sum[c]! += d[i + c]!;
  }
  const n = Math.max(1, w * h);
  return sum.map((v) => Math.round((v / n) * 10) / 10) as RGBA;
}

/** Fraction of pixels with alpha > 0 in a box. */
export function coverage(s: Surface, box?: Box): number {
  const d = s.pixels(), [x0, y0, w, h] = region(s, box);
  let n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (d[(y * s.width + x) * 4 + 3]! > 0) n++;
  return n / Math.max(1, w * h);
}

/** Number of distinct values of one channel (0..3 or 'r' | 'g' | 'b' | 'a') among visible pixels in a box. */
export function distinctLevels(s: Surface, channel: 0 | 1 | 2 | 3 | 'r' | 'g' | 'b' | 'a', box?: Box): number {
  const c = typeof channel === 'number' ? channel : 'rgba'.indexOf(channel);
  const d = s.pixels(), [x0, y0, w, h] = region(s, box), seen = new Set<number>();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * s.width + x) * 4;
    if (d[i + 3]! > 0) seen.add(d[i + c]!);
  }
  return seen.size;
}

/** Mean absolute difference per channel (0..255) between two same-sized surfaces. */
export function difference(a: Surface, b: Surface): number {
  assert.equal(a.width, b.width, 'surfaces differ in width');
  assert.equal(a.height, b.height, 'surfaces differ in height');
  const p = a.pixels(), q = b.pixels();
  let sum = 0;
  for (let i = 0; i < p.length; i++) sum += Math.abs(p[i]! - q[i]!);
  return sum / p.length;
}

function stats(dst: Surface, t0: number): RenderStats {
  return { ms: Math.round((performance.now() - t0) * 100) / 100, mean: meanColor(dst), coverage: coverage(dst) };
}

export interface FrameOpts { width?: number; height?: number; frame?: number; fps?: number; seed?: number }

const frameInfo = (o: FrameOpts, w: number, h: number) => {
  const fps = o.fps ?? 30, frame = o.frame ?? 0;
  return { frame, time: frame / fps, fps, seed: o.seed ?? 1, comp: { width: w, height: h } };
};

function parseParams(def: { type: string; params: { parse(v: unknown): unknown } }, params: Record<string, unknown> | undefined): Record<string, unknown> {
  try { return def.params.parse(params ?? {}) as Record<string, unknown>; } catch (e) {
    throw new MglError({ code: 'E_ARG', message: `${def.type}: invalid params ${JSON.stringify(params ?? {})}: ${(e as Error).message}`, fix: 'pass params the schema accepts (every param needs a default so {} works).' });
  }
}

/** Run a layer-stage effect on `src` (default: the test pattern) and return the result. */
export function renderEffect(def: EffectDef, params?: Record<string, unknown>, opts: FrameOpts & { src?: Surface } = {}): { dst: Surface; src: Surface; stats: RenderStats } {
  if (!def.draw) throw new MglError({ code: 'E_ARG', message: `effect "${def.type}" has no draw() (${def.audio && !def.source ? 'an audio effect' : 'source/audio stage only'}).`, fix: 'test it with effectFilters(def, params): it returns the source and audio filters, checked against the allowlist.' });
  const src = opts.src ?? testPattern(opts.width, opts.height);
  const dst = createSurface(src.width, src.height);
  const t0 = performance.now();
  def.draw({ src, dst, params: parseParams(def, params), ...frameInfo(opts, src.width, src.height) });
  return { dst, src, stats: stats(dst, t0) };
}

export interface EffectFilters {
  /** source-stage (video) filters with the params, as the effect returns them */
  source: FilterSpec[];
  /** audio-stage filters (clip sound or bus mix) */
  audio: FilterSpec[];
  /** the ffmpeg filtergraph text of each stage ('' when the stage is absent) */
  sourceGraph: string;
  audioGraph: string;
}

/**
 * The ffmpeg filters a source-stage or audio-stage effect produces for `params` (defaults filled in), checked
 * against the allowlist and escaped exactly as the renderer does. Throws E_FILTER for a disallowed filter or option.
 */
export async function effectFilters(def: EffectDef, params?: Record<string, unknown>): Promise<EffectFilters> {
  if (!def.source && !def.audio) throw new MglError({ code: 'E_ARG', message: `effect "${def.type}" has no source() or audio() stage.`, fix: 'test a layer effect with renderEffect(def, params).' });
  const p = parseParams(def, params);
  const { filtersToString } = await import('../media/filters.js');
  const source = def.source ? def.source(p as never) : [], audio = def.audio ? def.audio(p as never) : [];
  return { source, audio, sourceGraph: filtersToString(source, { stage: 'video' }), audioGraph: filtersToString(audio, { stage: 'audio' }) };
}

/** Draw a transition at `progress` from `from` (default: the test pattern) to `to` (default: solid blue). */
export function renderTransition(def: TransitionDef, progress: number, opts: FrameOpts & { params?: Record<string, unknown>; from?: Surface; to?: Surface } = {}): { dst: Surface; from: Surface; to: Surface; stats: RenderStats } {
  const from = opts.from ?? testPattern(opts.width, opts.height);
  const to = opts.to ?? solid(from.width, from.height, '#1040ff');
  const dst = createSurface(from.width, from.height);
  const t0 = performance.now();
  def.draw({ from, to, dst, progress, params: parseParams(def, opts.params), ...frameInfo(opts, from.width, from.height) });
  return { dst, from, to, stats: stats(dst, t0) };
}

/** Draw a generator at a clip-local frame (size from def.size, else the given / default comp size). */
export function renderGenerator(def: GeneratorDef, params?: Record<string, unknown>, frame = 0, opts: FrameOpts & { audio?: AudioLevels } = {}): { dst: Surface; stats: RenderStats } {
  const p = parseParams(def, params);
  const comp = { width: opts.width ?? 320, height: opts.height ?? 180 };
  const [w, h] = def.size ? def.size(p, comp) : [comp.width, comp.height];
  const dst = createSurface(w, h);
  const t0 = performance.now();
  const audio = opts.audio ?? (def.audioSource ? testLevels(frame) : undefined);
  def.draw({ dst, params: p, ...(audio ? { audio } : {}), ...frameInfo({ ...opts, frame }, comp.width, comp.height) });
  return { dst, stats: stats(dst, t0) };
}

/**
 * Synthetic sound levels for audio-reactive generators: `frames` frames of a 2 Hz pulse (at 30 fps) with a falling
 * spectrum of `bands` bands, positioned at `frame`. Generators with audioSource() get these in renderGenerator by default.
 */
export function testLevels(frame = 0, opts: { frames?: number; bands?: number } = {}): AudioLevels {
  const n = opts.frames ?? 300, bands = opts.bands ?? 16;
  const rms = new Float32Array(n), spectrum = new Float32Array(n * bands);
  for (let f = 0; f < n; f++) {
    rms[f] = 0.5 + 0.4 * Math.sin((f / 30) * Math.PI * 4);
    for (let b = 0; b < bands; b++) spectrum[f * bands + b] = Math.max(0, Math.min(1, rms[f]! * (1 - b / bands) + 0.1 * Math.sin(f * 0.3 + b)));
  }
  return { rms, spectrum, bands, frame: Math.max(0, Math.min(n - 1, frame)) };
}

/** A path named `name` inside a fresh temporary folder. */
export function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'mgl-test-')), name);
}

/** A text file's contents (utf8). */
export function readText(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Write a surface as PNG. */
export async function savePNG(s: Surface, file: string): Promise<void> {
  writeFileSync(file, await s.canvas.encode('png'));
}

/** Import the plugin a test belongs to: pass `import.meta.url` (or the plugin folder). */
export async function loadPlugin(from: string | URL): Promise<PluginDef> {
  let dir = resolve(String(from).startsWith('file:') ? fileURLToPath(from) : String(from));
  while (!existsSync(join(dir, 'package.json'))) {
    if (dirname(dir) === dir) throw new MglError({ code: 'E_PLUGIN_MANIFEST', message: `no package.json above ${String(from)}.`, fix: 'call loadPlugin(import.meta.url) from a file inside the plugin folder.' });
    dir = dirname(dir);
  }
  const { pluginEntry } = await import('./loader.js');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  const mod = (await import(pathToFileURL(pluginEntry(dir, pkg)).href)) as { default?: PluginDef };
  if (!mod.default) throw new MglError({ code: 'E_PLUGIN_INVALID', message: `${dir} has no default export.`, fix: 'end src/index.ts with export default definePlugin({...}).' });
  return mod.default;
}

/** A small project: comp "main" (width × height at fps, `seconds` long) with a visual track V1 and a background clip "bg". */
export function testProject(o: { width?: number; height?: number; fps?: number; seconds?: number; plugins?: Record<string, string> } = {}): ProjectFile {
  const fps = o.fps ?? 30, len = Math.round((o.seconds ?? 2) * fps);
  return {
    michelangelo: 1,
    ...(o.plugins ? { project: { plugins: o.plugins } } : {}),
    comps: [{ id: 'main', size: [o.width ?? 320, o.height ?? 180], fps, length: len }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'bg', track: 'V1', at: 0, len, color: '#202024' }],
  } as ProjectFile;
}

/** A registry of the built-ins plus the given plugin definitions. */
export async function registryWith(plugins: PluginDef[] = []): Promise<PluginRegistry> {
  const { builtinRegistry } = await import('../builtin/index.js');
  const r = builtinRegistry();
  for (const p of plugins) r.add(p, `test:${p.name}`);
  return r;
}

/**
 * Run one command against a project, with the given plugins' commands and catalog available. `services` (API 1.6) adds
 * stand-ins for the SDK's services (readText, speak, probe, ...) so commands that use them can be tested offline.
 */
export async function runCommandOn(project: ProjectFile, cmd: { op: string; [k: string]: unknown }, opts: { plugins?: PluginDef[]; services?: Partial<import('../core/commands/registry.js').CommandServices> } = {}) {
  const core = await import('../core/commands/index.js');
  const known = new Set(core.listCommands().map((c) => c.op));
  for (const p of opts.plugins ?? []) for (const c of p.commands ?? []) if (!known.has(c.op)) { core.defineCommand(c); known.add(c.op); }
  const registry = await registryWith(opts.plugins);
  return core.runCommand(project, cmd, { catalog: registry.catalog(), ...opts.services });
}

/**
 * (API 1.5) A StockContext for testing a stock provider without the network: `routes` maps URL patterns to recorded
 * answers (a string or object is sent as the body with status 200; a number is a status; a function builds a Response).
 * An unmatched URL answers 404 and is listed in `misses`. Every request is recorded in `calls`.
 */
export function testStockContext(o: { routes?: [RegExp, unknown][]; env?: Record<string, string>; cacheDir?: string } = {}): import('./api.js').StockContext & { calls: { url: string; headers: Record<string, string> }[]; misses: string[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [], misses: string[] = [];
  const dir = o.cacheDir ?? mkdtempSync(join(tmpdir(), 'mgl-stock-test-'));
  return {
    calls, misses, cacheDir: dir,
    env: (name) => o.env?.[name],
    async fetch(url, init) {
      calls.push({ url, headers: { ...(init?.headers ?? {}) } });
      const hit = (o.routes ?? []).find(([re]) => re.test(url));
      if (!hit) { misses.push(url); return new Response('not found', { status: 404 }); }
      const v = hit[1];
      if (typeof v === 'function') return (v as (u: string) => Response | Promise<Response>)(url);
      if (typeof v === 'number') return new Response(`status ${v}`, { status: v });
      if (v instanceof Uint8Array) return new Response(v as unknown as BodyInit, { status: 200 });
      return new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: 200, headers: { 'content-type': typeof v === 'string' ? 'text/plain' : 'application/json' } });
    },
  };
}

/** A CheckContext for a project-stage check. */
export function checkContext(project: ProjectFile, opts: { compId?: string; platform?: string } = {}): CheckContext {
  const compId = opts.compId ?? project.project?.main ?? project.comps[0]!.id;
  const comp = project.comps.find((c) => c.id === compId)!;
  return {
    project, compId, platform: opts.platform ?? project.project?.platform ?? 'none',
    safeArea: () => ({ x: Math.round(comp.size[0] * 0.05), y: Math.round(comp.size[1] * 0.05), w: Math.round(comp.size[0] * 0.9), h: Math.round(comp.size[1] * 0.9) }),
  };
}

/**
 * Render one comp frame of a project (a ProjectFile, or a path to a .mgl.json) through the render pipeline.
 * Plugins: `plugins` adds definitions directly; otherwise a project file's own plugins are loaded (trust not required in tests).
 */
export async function renderProject(project: ProjectFile | string, frame = 0, opts: { plugins?: PluginDef[]; baseDir?: string; scale?: number; comp?: string } = {}): Promise<{ width: number; height: number; data: Uint8Array | Buffer }> {
  let pipeline: typeof import('../render/pipeline.js');
  try { pipeline = await import('../render/pipeline.js'); } catch (e) {
    throw new MglError({ code: 'E_RENDER_UNAVAILABLE', message: `the render pipeline could not be loaded: ${(e as Error).message}`, fix: 'reinstall michelangelo (npm install michelangelo); renderEffect / renderGenerator work without it.' });
  }
  let p: ProjectFile, baseDir = opts.baseDir ?? process.cwd();
  if (typeof project === 'string') {
    const { parseProjectText } = await import('../core/load.js');
    const r = parseProjectText(readFileSync(project, 'utf8'), { file: project });
    const bad = r.problems.find((x) => x.severity === 'error' && !x.renderOnly);
    if (bad) throw new MglError(bad);
    p = r.project;
    baseDir = opts.baseDir ?? dirname(resolve(project));
  } else p = project;
  let registry: PluginRegistry;
  if (opts.plugins) registry = await registryWith(opts.plugins);
  else {
    const { loadRegistry } = await import('./loader.js');
    registry = await loadRegistry(p, baseDir, { allowUntrusted: true, strict: true });
  }
  const [still] = await pipeline.renderStills(p, { baseDir, registry, frames: [frame], scale: opts.scale ?? 1, ...(opts.comp ? { comp: opts.comp } : {}) });
  return still!.image;
}

/**
 * (API 1.4) What a speak provider must do for audio.speak and captions.from-speech: write a readable WAV with sound
 * in it, and, if it returns word timings, one per word of the text, in order, inside the audio. Returns the
 * problems found (empty = conforms) and what it measured. Use it in a speak plugin's own tests:
 *   assert.deepEqual((await checkSpeakProvider(plugin.providers![0]!)).problems, []);
 */
export async function checkSpeakProvider(provider: import('./api.js').ProviderDef, opts: { text?: string; voice?: string } = {}): Promise<{ problems: string[]; duration: number; words: number }> {
  const problems: string[] = [];
  if (provider.kind !== 'speak') return { problems: [`provider "${provider.id}" is a ${provider.kind} provider, not speak`], duration: 0, words: 0 };
  const text = opts.text ?? 'Three tips for better sleep. First, keep your room cool and dark.';
  const voices = await provider.voices();
  if (!voices.length) problems.push('voices() lists no voice');
  const out = tempFile(`${provider.id}-check.wav`);
  const r = await provider.speak({ text, out, ...(opts.voice ? { voice: opts.voice } : {}) });
  if (!existsSync(out)) return { problems: [...problems, `speak() wrote nothing at ${out}`], duration: 0, words: 0 };
  const b = readFileSync(out);
  let duration = 0;
  if (b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WAVE') problems.push('the output is not a WAV file (RIFF/WAVE header)');
  else {
    // find the fmt and data chunks
    let rate = 0, bytesPerSec = 0, dataLen = 0, bits = 16, loud = 0;
    for (let o = 12; o + 8 <= b.length;) {
      const id = b.subarray(o, o + 4).toString('latin1'), len = b.readUInt32LE(o + 4);
      if (id === 'fmt ') { rate = b.readUInt32LE(o + 12); bytesPerSec = b.readUInt32LE(o + 16); bits = b.readUInt16LE(o + 22); }
      if (id === 'data') {
        dataLen = Math.min(len, b.length - o - 8);
        if (bits === 16) for (let i = o + 8; i + 1 < o + 8 + dataLen; i += 2) loud = Math.max(loud, Math.abs(b.readInt16LE(i)));
        else loud = 1;
        break;
      }
      o += 8 + len + (len & 1);
    }
    duration = bytesPerSec ? dataLen / bytesPerSec : 0;
    if (!rate || !duration) problems.push('the WAV has no audio data');
    else if (bits === 16 && loud < 300) problems.push('the audio is silent');
    if (rate && rate < 16000) problems.push(`sample rate ${rate} Hz is low for speech (48000 preferred)`);
  }
  const words = r?.words ?? [];
  if (words.length) {
    const textWords = text.split(/\s+/).filter(Boolean);
    if (words.length !== textWords.length) problems.push(`${words.length} word timings for ${textWords.length} words of text (give one per word, or none: Michelangelo then aligns by sound)`);
    else textWords.forEach((w, i) => { if (words[i]!.text !== w) problems.push(`word ${i + 1} is "${words[i]!.text}", the text has "${w}"`); });
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (!(w.start >= 0) || (duration && w.start > duration + 0.05)) problems.push(`word ${i + 1} "${w.text}" starts at ${w.start}, outside the audio (0–${duration.toFixed(2)} s)`);
      if (w.end !== undefined && w.end < w.start) problems.push(`word ${i + 1} "${w.text}" ends before it starts`);
      if (i && w.start < words[i - 1]!.start) problems.push(`word ${i + 1} "${w.text}" starts before word ${i}`);
    }
  }
  return { problems, duration: Math.round(duration * 1000) / 1000, words: words.length };
}

