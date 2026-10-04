/**
 * The render pipeline: project → frames → files.
 *
 *   evaluate(comp, frame) → DisplayList → RenderSession.drawFrame → RGBA → FrameSink (ffmpeg)
 *   planAudio → renderAudio (one WAV) → muxed
 *
 * Exports: renderStills (look), render (by output extension), estimate, renderDetached / renderStatus.
 * Long renders split into contiguous frame ranges rendered by worker processes (pipeline-worker.ts) and
 * joined without re-encoding.
 */
import { loadRegistry } from '../plugin/loader.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile, rename, copyFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, MglError } from '../core/errors.js';
import { parseProjectText } from '../core/load.js';
import type { Asset, Comp, ProjectFile } from '../core/schema/index.js';
import { framesToSeconds, parseRate, type Rate } from '../core/time.js';
import { builtinRegistry } from '../builtin/index.js';
import type { PluginRegistry } from '../plugin/registry.js';
import { getMediaBackend, planAudio } from '../media/index.js';
import { run } from '../media/proc.js';
import type { EncodeOptions, MediaBackend, MediaInfo } from '../media/types.js';
import { compLength, evaluate, layerBoxes, type EvaluateOptions, type LayerBox } from './evaluate.js';
import { MediaFrames, mediaRequests, pool } from './frames.js';
import { scaling } from './matrix.js';
import { skiaRenderer } from './skia/index.js';
import type { DisplayList, DisplayNode, MediaSource, Renderer, RenderSession, RGBAFrame } from './types.js';

export type Quality = 'draft' | 'final' | 'hq';
export type OutputKind = 'video' | 'still' | 'audio' | 'subtitles' | 'exporter';

export interface PipelineOptions {
  /** directory relative asset paths resolve against (the project file's directory) */
  baseDir: string;
  comp?: string;
  registry?: PluginRegistry;
  /** a media backend (default: native ffmpeg) */
  backend?: MediaBackend;
  /** a renderer (default: Skia) */
  renderer?: Renderer;
}

export interface Estimate {
  /** predicted wall time (s) */
  seconds: number;
  frames: number;
  /** measured composite time per frame (ms) at the output size */
  perFrameMs: number;
  /** encoder throughput assumed for the preset at the output size */
  encodeFps: number;
  /** predicted wall time / media duration */
  realtimeFactor: number;
  /** the printable line: est. 24 s (final 1080x1920, 30.0 s, ≈0.8x real time) */
  note: string;
  width: number;
  height: number;
  quality: Quality;
  /** media duration (s) */
  duration: number;
  /** estimated decode time per frame (ms, all video layers of the busiest frame) */
  decodeMs: number;
  /** worker processes the render would use */
  segments: number;
}

export interface RenderOptions extends PipelineOptions {
  quality?: Quality;
  /** [start, end) in comp frames */
  range?: [number, number];
  alpha?: boolean;
  /** .png output: the frame to write (default: range start) */
  still?: number;
  onEstimate?(e: Estimate): void;
  onProgress?(p: { frame: number; total: number; fps: number; etaSec: number }): void;
  /** worker processes: 1 = never split, n > 1 = split into n ranges; default: split when the estimate is over 3× real time */
  segments?: number;
}

export interface ProbeReport { duration: number; streams: { type: string; codec: string; width?: number; height?: number; frames?: number; sampleRate?: number }[]; format: string }

export interface RenderResult {
  out: string;
  /** media duration (s) */
  seconds: number;
  frames: number;
  width: number;
  height: number;
  codec: string;
  audioCodec?: string;
  bytes: number;
  wallSec: number;
  /** wall time / media duration */
  realtimeFactor: number;
  segments: number;
  estimate?: Estimate;
  /** ffprobe of the written file */
  probe?: ProbeReport;
  notes: string[];
}

export interface StillLayer { clipId: string; kind: string; box: [number, number, number, number]; text?: string; fontPx?: number }
export interface Still { frame: number; image: RGBAFrame; layers: StillLayer[] }

// ------------------------------------------------------------------------------------------- preparation

const VIDEO_EXT: Record<string, EncodeOptions['format']> = { '.mp4': 'mp4', '.webm': 'webm', '.mov': 'mov', '.gif': 'gif' };
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.opus', '.ogg', '.flac']);
const FONT_EXT = new Set(['.ttf', '.otf', '.woff', '.woff2', '.ttc']);
const NON_MEDIA = new Set(['font', 'lut', 'subtitles', 'data']);

export function outputKind(out: string, registry?: PluginRegistry): OutputKind {
  const ext = extname(out).toLowerCase();
  if (VIDEO_EXT[ext]) return 'video';
  if (ext === '.png') return 'still';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext === '.srt' || ext === '.vtt') return 'subtitles';
  if (registry && [...registry.exporters.values()].some((e) => e.extensions.map((x) => x.toLowerCase().replace(/^\.?/, '.')).includes(ext))) return 'exporter';
  return fail('E_FORMAT', `cannot render to "${ext || out}".`, 'use .mp4, .webm, .mov, .gif, .png, .wav, .mp3, .m4a, .srt or .vtt (or install a plugin exporter for that extension).');
}

/** The comp to render: the given id, else project.main, else "main", else the first comp. */
export function resolveComp(p: ProjectFile, id?: string): Comp {
  const want = id ?? p.project?.main;
  if (want) {
    const c = p.comps.find((x) => x.id === want);
    if (!c) fail('E_REF', `comp "${want}" does not exist.`, `use one of ${p.comps.map((x) => x.id).join(', ')}.`);
    return c;
  }
  return p.comps.find((x) => x.id === 'main') ?? p.comps[0]!;
}

/** The project's plugin registry (built-ins + the plugins it names); untrusted or broken plugins stop the render with their fix. */
export async function loadProjectRegistry(project: ProjectFile, baseDir: string): Promise<PluginRegistry> {
  return loadRegistry(project, baseDir, { strict: true });
}

interface Prep {
  project: ProjectFile;
  comp: Comp;
  rate: Rate;
  W: number;
  H: number;
  length: number;
  baseDir: string;
  registry: PluginRegistry;
  backend: MediaBackend;
  renderer: Renderer;
  info: Map<string, MediaInfo>;
  fontAssets: { id: string; path: string }[];
  notes: string[];
}

const assetPath = (a: Asset, baseDir: string) => (isAbsolute(a.src) ? a.src : resolve(baseDir, a.src));

async function prepare(project: ProjectFile, o: PipelineOptions, probeMedia = true): Promise<Prep> {
  const comp = resolveComp(project, o.comp);
  const backend = o.backend ?? getMediaBackend({ baseDir: o.baseDir });
  const registry = o.registry ?? await loadProjectRegistry(project, o.baseDir);
  const info = new Map<string, MediaInfo>();
  const fontAssets: { id: string; path: string }[] = [];
  const media: Asset[] = [];
  for (const a of project.assets ?? []) {
    if (a.kind === 'font' || (!a.kind && FONT_EXT.has(extname(a.src).toLowerCase()))) fontAssets.push({ id: a.id, path: assetPath(a, o.baseDir) });
    else if (!NON_MEDIA.has(a.kind ?? '')) media.push(a);
  }
  if (probeMedia) {
    const used = new Set((project.clips ?? []).map((c) => c.asset).filter(Boolean));
    await pool(media.filter((a) => used.has(a.id)), 8, async (a) => { info.set(a.id, await backend.probe(assetPath(a, o.baseDir))); });
  }
  const length = compLength(project, comp.id);
  return { project, comp, rate: parseRate(comp.fps), W: comp.size[0], H: comp.size[1], length, baseDir: o.baseDir, registry, backend, renderer: o.renderer ?? skiaRenderer, info, fontAssets, notes: [] };
}

function evalOptions(prep: Prep, session: RenderSession): EvaluateOptions {
  const kinds = new Map((prep.project.assets ?? []).map((a) => [a.id, a.kind]));
  return {
    layouter: session.layouter,
    registry: prep.registry,
    assetKind: (id) => {
      const k = kinds.get(id) ?? prep.info.get(id)?.kind;
      return k === 'image' || k === 'audio' ? k : 'video';
    },
    media: (id) => {
      const i = prep.info.get(id);
      return i ? { ...(i.width ? { width: i.width } : {}), ...(i.height ? { height: i.height } : {}), duration: i.duration } : undefined;
    },
  };
}

const openSession = (prep: Prep, width: number, height: number) =>
  prep.renderer.open({ width, height, registry: prep.registry, fontAssets: prep.fontAssets });

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Output size: draft = half size with the long edge ≤ 960 (even dims); final/hq = comp size. */
export function outputSize(W: number, H: number, quality: Quality): { width: number; height: number } {
  if (quality !== 'draft') return { width: W, height: H };
  const s = Math.min(0.5, 960 / Math.max(W, H));
  return { width: even(W * s), height: even(H * s) };
}

function checkRange(prep: Prep, range?: [number, number]): [number, number] {
  const r: [number, number] = range ?? [0, prep.length];
  if (prep.length <= 0 && !range) fail('E_EMPTY', `comp "${prep.comp.id}" is empty (length 0).`, 'add clips, or give the comp a "length".');
  if (!(Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] > r[0])) {
    fail('E_RANGE', `range [${r[0]}, ${r[1]}) is not a valid frame range.`, `give whole frames with start < end, e.g. [0, ${prep.length}].`);
  }
  return r;
}

// ------------------------------------------------------------------------------------------- stills

/** Render single frames (look): at `scale` of the comp size, decodes for all frames in parallel. */
export async function renderStills(project: ProjectFile, opts: PipelineOptions & { frames: number[]; scale?: number }): Promise<Still[]> {
  const prep = await prepare(project, opts);
  const scale = opts.scale ?? 1;
  if (!(scale > 0 && scale <= 4)) fail('E_SCALE', `scale ${scale} is out of range.`, 'use a scale between 0.05 and 4 (0.5 = half size).');
  const w = Math.max(2, Math.round(prep.W * scale)), h = Math.max(2, Math.round(prep.H * scale));
  const session = await openSession(prep, w, h);
  const frames = new MediaFrames({ backend: prep.backend, baseDir: prep.baseDir, mode: 'random' });
  try {
    const eo = evalOptions(prep, session);
    const lists = opts.frames.map((f) => evaluate(project, prep.comp.id, f, eo));
    const root = scaling(w / prep.W, h / prep.H);
    const reqs = lists.flatMap((l) => mediaRequests(l.nodes, root));
    await pool(reqs, Math.max(2, cpus().length), (r) => frames.prefetch(r.src, r.size));
    const out: Still[] = [];
    for (const list of lists) {
      const image = await session.drawFrame(list, frames);
      out.push({ frame: list.frame, image, layers: layerBoxes(list.nodes, { layouter: session.layouter }).map(roundBox) });
    }
    return out;
  } finally {
    await frames.close();
    await session.close();
  }
}

const roundBox = (b: LayerBox): StillLayer => ({ ...b, box: b.box.map((v) => Math.round(v * 10) / 10) as StillLayer['box'] });

// ------------------------------------------------------------------------------------------- estimate

/** Encoder throughput (frames/s) at 1080x1920, measured on the 4-vCPU reference machine. */
const ENCODE_FPS_1080x1920: Record<string, number> = {
  'mp4:draft': 220, 'mp4:final': 65, 'mp4:hq': 22,
  'webm:draft': 45, 'webm:final': 18, 'webm:hq': 9,
  'mov:draft': 45, 'mov:final': 45, 'mov:hq': 45,
  'gif:draft': 150, 'gif:final': 150, 'gif:hq': 150,
  'png:draft': 25, 'png:final': 25, 'png:hq': 25,
};
const REF_PIXELS = 1080 * 1920;
/** sequential decode + RGBA conversion per 1080p frame (ms), by codec; scaled by source pixels (short renders only) */
const DECODE_MS_1080P: Record<string, number> = { h264: 12, hevc: 16, vp9: 16, av1: 20, prores: 14 };

export function encodeFps(format: EncodeOptions['format'], quality: Quality, width: number, height: number): number {
  const base = ENCODE_FPS_1080x1920[`${format}:${quality}`] ?? 60;
  return base * (REF_PIXELS / Math.max(1, width * height));
}

function countLayers(nodes: DisplayNode[]): number {
  let n = 0;
  for (const x of nodes) {
    if (x.type === 'transition') n += 1 + countLayers(x.from) + countLayers(x.to);
    else {
      n += 1 + x.fx.length + (x.matte ? 1 : 0);
      if (x.type === 'layer' && x.source.type === 'comp' && x.source.list) n += countLayers(x.source.list.nodes);
      if (x.type === 'layer' && x.source.type === 'media' && x.source.kind === 'video') n += 2;
    }
  }
  return n;
}

export function formatEstimate(e: Pick<Estimate, 'seconds' | 'quality' | 'width' | 'height' | 'duration' | 'realtimeFactor'>): string {
  const s = e.seconds < 10 ? e.seconds.toFixed(1) : String(Math.round(e.seconds));
  return `est. ${s} s (${e.quality} ${e.width}x${e.height}, ${e.duration.toFixed(1)} s, ≈${e.realtimeFactor.toFixed(1)}x real time)`;
}

async function estimateWith(prep: Prep, o: { range: [number, number]; quality: Quality; format: EncodeOptions['format']; width: number; height: number; segments?: number }): Promise<Estimate> {
  const [a, b] = o.range;
  const frames = b - a;
  const duration = framesToSeconds(frames, prep.rate);
  const session = await openSession(prep, o.width, o.height);
  const provider = new MediaFrames({ backend: prep.backend, baseDir: prep.baseDir, mode: 'random' });
  let perFrameMs = 0, decodeMs = 0;
  try {
    const eo = evalOptions(prep, session);
    // busiest frame by layer count, over up to 40 evenly spaced frames
    const probes = Array.from(new Set(Array.from({ length: Math.min(40, frames) }, (_, i) => a + Math.floor((i * frames) / Math.min(40, frames)))));
    let busiest = a, most = -1;
    for (const f of probes) {
      const n = countLayers(evaluate(prep.project, prep.comp.id, f, eo).nodes);
      if (n > most) { most = n; busiest = f; }
    }
    const samples = [...new Set([a, a + Math.floor(frames / 2), busiest])];
    const root = scaling(o.width / prep.W, o.height / prep.H);
    const lists: DisplayList[] = samples.map((f) => evaluate(prep.project, prep.comp.id, f, eo));
    await pool(lists.flatMap((l) => mediaRequests(l.nodes, root)), Math.max(2, cpus().length), (r) => provider.prefetch(r.src, r.size));
    await session.drawFrame(lists[0]!, provider); // warm-up (font and shader caches)
    const times: number[] = [];
    for (const l of lists) {
      const t0 = performance.now();
      await session.drawFrame(l, provider);
      times.push(performance.now() - t0);
    }
    perFrameMs = times.reduce((s, t) => s + t, 0) / times.length;
    decodeMs = await measureDecode(prep, mediaRequests(lists[lists.length - 1]!.nodes, root), frames);
  } finally {
    await provider.close();
    await session.close();
  }
  const fps = encodeFps(o.format, o.quality, o.width, o.height);
  const encodeMs = 1000 / fps;
  // compositing (this process), decoding and encoding (ffmpeg processes) overlap; on shared cores they contend
  const parts = [perFrameMs, decodeMs, encodeMs];
  const top = Math.max(...parts);
  const frameMs = top + CONTENTION * (parts.reduce((s, x) => s + x, 0) - top);
  // CPU per frame: the decoders' scale + RGBA conversion and x264 use more than one core each
  const cpuMs = perFrameMs + 2.5 * decodeMs + 2 * encodeMs;
  const setup = 0.5 + duration * 0.02; // processes, probes, the audio mix
  const timeWith = (n: number) => n === 1 ? setup + (frames * frameMs) / 1000
    : setup + WORKER_START_SEC * (1 + 0.15 * n) + (frames * Math.max(frameMs / n, cpuMs / (cpus().length * 0.75))) / 1000;
  const segs = chooseSegments(o.segments, timeWith, duration, o.format, o.quality);
  const seconds = timeWith(segs);
  const e: Estimate = { seconds, frames, perFrameMs, encodeFps: fps, realtimeFactor: duration > 0 ? seconds / duration : 0, note: '', width: o.width, height: o.height, quality: o.quality, duration, decodeMs, segments: segs };
  e.note = formatEstimate(e);
  return e;
}

const CONTENTION = 0.6;
const WORKER_START_SEC = 1.5;
/** wall-time targets (× real time) per quality: over target, long renders split into worker processes */
const TARGET_RT: Record<Quality, number> = { draft: 1, final: 3, hq: 3 };

/**
 * Sequential decode time per frame (ms) of the video layers of a frame, measured: each source is opened at the
 * size it is drawn and read for a few frames, all at once (they run side by side during the render too).
 * Short renders use a codec/pixel-count constant instead.
 */
async function measureDecode(prep: Prep, reqs: { src: MediaSource; size: { w: number; h: number } }[], frames: number): Promise<number> {
  const videos = [...new Map(reqs.filter((r) => r.src.kind === 'video').map((r) => [r.src.assetId + JSON.stringify(r.src.filters), r])).values()];
  if (!videos.length) return 0;
  const guess = (r: (typeof videos)[number]) => {
    const i = prep.info.get(r.src.assetId);
    return (DECODE_MS_1080P[i?.videoCodec ?? 'h264'] ?? 8) * (((i?.width ?? 1920) * (i?.height ?? 1080)) / (1920 * 1080));
  };
  if (frames < 120) return videos.reduce((s, r) => s + guess(r), 0);
  const fr = new MediaFrames({ backend: prep.backend, baseDir: prep.baseDir });
  try {
    const per = await Promise.all(videos.map(async (r) => {
      const at = (k: number) => ({ ...r.src, sourceFrame: r.src.sourceFrame + k });
      await fr.get(at(0), r.size);
      const t0 = performance.now();
      for (let k = 1; k <= DECODE_SAMPLE; k++) await fr.get(at(k), r.size);
      return (performance.now() - t0) / DECODE_SAMPLE;
    }));
    // separate processes: the slowest source paces the render, the others add contention
    const top = Math.max(...per);
    return top + CONTENTION * (per.reduce((s, x) => s + x, 0) - top);
  } catch {
    return videos.reduce((s, r) => s + guess(r), 0);
  } finally { await fr.close(); }
}
const DECODE_SAMPLE = 8;

/**
 * Worker processes for a render: 1 unless asked, or unless the single-process estimate is over the quality's target
 * and the render is longer than 10 s; then the smallest count that is clearly faster (CPU-bound renders gain little).
 */
function chooseSegments(requested: number | undefined, timeWith: (n: number) => number, duration: number, format: EncodeOptions['format'], quality: Quality): number {
  if (format === 'gif' || format === 'png' || format === 'apng') return 1;
  if (requested !== undefined) return Math.max(1, Math.floor(requested));
  if (!(timeWith(1) > TARGET_RT[quality] * duration && duration > 10)) return 1;
  let best = 1;
  for (let n = 2; n <= Math.min(4, cpus().length); n++) if (timeWith(n) < 0.9 * timeWith(best)) best = n;
  return best;
}

/** Predict a render's wall time by drawing 3 sample frames (start, middle, busiest) plus the preset's encode rate. */
export async function estimate(project: ProjectFile, opts: PipelineOptions & { quality?: Quality; range?: [number, number]; format?: EncodeOptions['format']; out?: string; segments?: number }): Promise<Estimate> {
  const prep = await prepare(project, opts);
  const quality = opts.quality ?? 'final';
  const format = opts.format ?? (opts.out ? VIDEO_EXT[extname(opts.out).toLowerCase()] : undefined) ?? 'mp4';
  const { width, height } = outputSize(prep.W, prep.H, quality);
  return estimateWith(prep, { range: checkRange(prep, opts.range), quality, format, width, height, segments: opts.segments });
}

// ------------------------------------------------------------------------------------------- frames

/** Render [a, b) in order into `sink`, decoding the next frame while the current one is drawn. */
async function renderRange(prep: Prep, o: { range: [number, number]; width: number; height: number; onFrame?(done: number): void }, write: (f: RGBAFrame) => Promise<void>): Promise<void> {
  const session = await openSession(prep, o.width, o.height);
  const frames = new MediaFrames({ backend: prep.backend, baseDir: prep.baseDir, mode: 'sequential' });
  const root = scaling(o.width / prep.W, o.height / prep.H);
  const eo = evalOptions(prep, session);
  const [a, b] = o.range;
  const prefetch = (l: DisplayList) => { for (const r of mediaRequests(l.nodes, root)) frames.get(r.src, r.size).catch(() => {}); };
  try {
    let list = evaluate(prep.project, prep.comp.id, a, eo);
    prefetch(list);
    let pending: Promise<void> = Promise.resolve();
    for (let f = a; f < b; f++) {
      const next = f + 1 < b ? evaluate(prep.project, prep.comp.id, f + 1, eo) : null;
      if (next) prefetch(next);
      const img = await session.drawFrame(list, frames);
      await pending;
      pending = write(img);
      o.onFrame?.(f - a + 1);
      if (next) list = next;
    }
    await pending;
  } finally {
    await frames.close();
    await session.close();
  }
}

function progressReporter(total: number, cb?: RenderOptions['onProgress']) {
  const t0 = performance.now();
  let last = 0;
  return (done: number) => {
    if (!cb) return;
    const now = performance.now();
    if (done < total && now - last < 250) return;
    last = now;
    const fps = done / Math.max(1e-3, (now - t0) / 1000);
    cb({ frame: done, total, fps, etaSec: (total - done) / Math.max(1e-3, fps) });
  };
}

// ------------------------------------------------------------------------------------------- render

/** Render a comp to a file; the format comes from the extension of `out`. */
export async function render(project: ProjectFile, out: string, opts: RenderOptions): Promise<RenderResult> {
  const t0 = performance.now();
  out = resolve(out);
  mkdirSync(dirname(out), { recursive: true });
  const registry = opts.registry ?? await loadProjectRegistry(project, opts.baseDir);
  const kind = outputKind(out, registry);
  const prep = await prepare(project, { ...opts, registry }, kind !== 'subtitles');
  const quality = opts.quality ?? 'final';
  const range = kind === 'subtitles' ? (opts.range ?? [0, Math.max(1, prep.length)]) : checkRange(prep, opts.range);
  const base = { notes: prep.notes, segments: 1 };
  let res: Omit<RenderResult, 'wallSec' | 'realtimeFactor' | 'bytes' | 'probe' | 'codec' | 'audioCodec' | 'width' | 'height'> & { width?: number; height?: number };
  switch (kind) {
    case 'subtitles': {
      const n = await writeSubtitles(prep, out, range);
      res = { out, seconds: framesToSeconds(range[1] - range[0], prep.rate), frames: 0, ...base };
      prep.notes.push(`${n} cues`);
      break;
    }
    case 'audio': {
      await renderAudioFile(prep, range, out);
      res = { out, seconds: framesToSeconds(range[1] - range[0], prep.rate), frames: 0, ...base };
      break;
    }
    case 'still': {
      const f = opts.still ?? range[0];
      const { width, height } = outputSize(prep.W, prep.H, quality);
      const sink = await prep.backend.encode({ out, width, height, rate: prep.rate, format: 'png', quality });
      try { await renderRange(prep, { range: [f, f + 1], width, height }, (img) => sink.write(img)); await sink.finish(); } catch (e) { await sink.abort().catch(() => {}); throw e; }
      res = { out, seconds: 0, frames: 1, width, height, ...base };
      break;
    }
    case 'video': {
      const format = VIDEO_EXT[extname(out).toLowerCase()]!;
      if (opts.alpha && format !== 'webm' && format !== 'mov') fail('E_ALPHA', `${format} cannot carry an alpha channel.`, 'render to .mov (ProRes 4444) or .webm (VP9) for alpha.');
      const { width, height } = outputSize(prep.W, prep.H, quality);
      const est = await estimateWith(prep, { range, quality, format, width, height, segments: opts.segments });
      opts.onEstimate?.(est);
      const segs = Math.min(est.segments, Math.max(1, Math.floor((range[1] - range[0]) / 2)));
      if (segs > 1) await renderSegmented(prep, out, { range, quality, format, width, height, alpha: !!opts.alpha, segments: segs, onProgress: opts.onProgress });
      else await renderVideo(prep, out, { range, quality, format, width, height, alpha: !!opts.alpha, onProgress: opts.onProgress });
      res = { out, seconds: framesToSeconds(range[1] - range[0], prep.rate), frames: range[1] - range[0], width, height, ...base, segments: segs, estimate: est };
      break;
    }
    case 'exporter': {
      await runExporter(prep, out, range);
      res = { out, seconds: framesToSeconds(range[1] - range[0], prep.rate), frames: range[1] - range[0], ...base };
      break;
    }
  }
  const wallSec = (performance.now() - t0) / 1000;
  const bytes = (await stat(out)).size;
  const probe = kind === 'subtitles' || kind === 'exporter' ? undefined : await verify(prep.backend, out, kind, res);
  const v = probe?.streams.find((s) => s.type === 'video');
  const au = probe?.streams.find((s) => s.type === 'audio');
  const result: RenderResult = {
    ...res,
    width: v?.width ?? res.width ?? 0,
    height: v?.height ?? res.height ?? 0,
    codec: v?.codec ?? au?.codec ?? (extname(out).toLowerCase() === '.srt' ? 'subrip' : extname(out).toLowerCase() === '.vtt' ? 'webvtt' : extname(out).slice(1)),
    bytes,
    wallSec,
    realtimeFactor: res.seconds > 0 ? wallSec / res.seconds : 0,
  };
  if (au && v) result.audioCodec = au.codec;
  if (probe) result.probe = probe;
  return result;
}

interface VideoJob { range: [number, number]; quality: Quality; format: EncodeOptions['format']; width: number; height: number; alpha: boolean; onProgress?: RenderOptions['onProgress'] }

/** Mix the comp's audio for `range` to a WAV; null when nothing in the range makes sound. */
async function mixAudio(prep: Prep, range: [number, number], wav: string, force = false): Promise<string | null> {
  const plan = planAudio(prep.project, prep.comp.id, { baseDir: prep.baseDir, range, hasAudio: (id) => prep.info.get(id)?.hasAudio ?? true });
  if (!plan.segments.length && !force) return null;
  await prep.backend.renderAudio(plan, wav, { baseDir: prep.baseDir });
  return wav;
}

async function renderAudioFile(prep: Prep, range: [number, number], out: string): Promise<void> {
  if (extname(out).toLowerCase() === '.wav') { await mixAudio(prep, range, out, true); return; }
  const dir = await mkdtemp(join(tmpdir(), 'mgl-render-'));
  try {
    const wav = (await mixAudio(prep, range, join(dir, 'mix.wav'), true))!;
    await prep.backend.transcodeAudio(wav, out);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function renderVideo(prep: Prep, out: string, j: VideoJob): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mgl-render-'));
  try {
    // the audio mix runs while frames render; it is muxed at the end without re-encoding the video
    const audio = j.format === 'gif' ? Promise.resolve(null) : mixAudio(prep, j.range, join(dir, 'mix.wav'));
    audio.catch(() => {});
    const tmp = join(dir, `video${extname(out)}`);
    const enc: EncodeOptions = { out: tmp, width: j.width, height: j.height, rate: prep.rate, format: j.format, quality: j.quality };
    if (j.alpha) enc.alpha = true;
    const sink = await prep.backend.encode(enc);
    const progress = progressReporter(j.range[1] - j.range[0], j.onProgress);
    try {
      await renderRange(prep, { range: j.range, width: j.width, height: j.height, onFrame: progress }, (f) => sink.write(f));
      await sink.finish();
    } catch (e) { await sink.abort().catch(() => {}); throw e; }
    const wav = await audio;
    if (wav) await muxAudio(prep.backend, tmp, wav, out, j.format, j.quality);
    else await moveFile(tmp, out);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function moveFile(from: string, to: string) {
  try { await rename(from, to); } catch { await copyFile(from, to); }
}

// ------------------------------------------------------------------------------------------- segments

/** Split [a, b) into n contiguous ranges of near-equal length. */
export function splitRange([a, b]: [number, number], n: number): [number, number][] {
  const len = b - a, out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const s = a + Math.floor((i * len) / n), e = a + Math.floor(((i + 1) * len) / n);
    if (e > s) out.push([s, e]);
  }
  return out;
}

/** A job for pipeline-worker.ts (JSON). */
export interface WorkerJob {
  mode: 'segment' | 'detached';
  /** segment: the project as canonical JSON (a file path); detached: the project file */
  project: string;
  baseDir: string;
  out: string;
  comp?: string;
  quality?: Quality;
  range?: [number, number];
  alpha?: boolean;
  segments?: number;
  /** segment mode: output size and format */
  width?: number;
  height?: number;
  format?: EncodeOptions['format'];
  /** detached mode: the status file */
  status?: string;
}

const HERE = fileURLToPath(import.meta.url);
const FROM_SOURCE = HERE.endsWith('.ts');
const PACKAGE_ROOT = resolve(dirname(HERE), '..', '..');

/** node + args that run the worker entry (TypeScript sources run through tsx). */
export function workerCommand(job: string): { cmd: string; args: string[]; cwd: string } {
  const entry = join(dirname(HERE), FROM_SOURCE ? 'pipeline-worker.ts' : 'pipeline-worker.js');
  return { cmd: process.execPath, args: [...(FROM_SOURCE ? ['--import', 'tsx'] : []), entry, job], cwd: PACKAGE_ROOT };
}

/** Run one worker; resolve on exit 0, reject with its error (an MglError JSON on its last stderr line) otherwise. */
function runWorker(jobFile: string, onFrames: (n: number) => void): Promise<void> {
  const { cmd, args, cwd } = workerCommand(jobFile);
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '';
    p.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^frames (\d+)$/.exec(line.trim());
        if (m) onFrames(Number(m[1]));
      }
    });
    p.stderr!.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-20_000); });
    p.on('error', (e) => rej(new MglError({ code: 'E_NATIVE', message: `the render worker could not start: ${e.message}.`, fix: 'render with segments: 1 (one process).' })));
    p.on('close', (code) => {
      if (code === 0) return res();
      const last = err.trim().split('\n').pop() ?? '';
      try { const j = JSON.parse(last); if (j.code) return rej(new MglError(j)); } catch { /* not JSON */ }
      rej(new MglError({ code: 'E_RENDER', message: `a render worker failed (exit ${code}): ${err.trim().split('\n').slice(-3).join(' | ') || 'no output'}.`, fix: 'retry with segments: 1 to render in one process and see the full error.' }));
    });
  });
}

async function renderSegmented(prep: Prep, out: string, j: VideoJob & { segments: number }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mgl-segments-'));
  try {
    const projectFile = join(dir, 'project.json');
    await writeFile(projectFile, JSON.stringify(prep.project));
    const ranges = splitRange(j.range, j.segments);
    const ext = extname(out).toLowerCase();
    const done = ranges.map(() => 0);
    const progress = progressReporter(j.range[1] - j.range[0], j.onProgress);
    const parts = ranges.map((_, i) => join(dir, `seg-${i}${ext}`));
    const workers = ranges.map(async (r, i) => {
      const job: WorkerJob = { mode: 'segment', project: projectFile, baseDir: prep.baseDir, out: parts[i]!, comp: prep.comp.id, quality: j.quality, range: r, alpha: j.alpha, width: j.width, height: j.height, format: j.format };
      const jf = join(dir, `job-${i}.json`);
      await writeFile(jf, JSON.stringify(job));
      await runWorker(jf, (n) => { done[i] = n; progress(done.reduce((s, x) => s + x, 0)); });
    });
    const [audio] = await Promise.all([mixAudio(prep, j.range, join(dir, 'mix.wav')), Promise.all(workers)]);
    const joined = join(dir, `joined${ext}`);
    await prep.backend.concat(parts, joined);
    if (audio) await muxAudio(prep.backend, joined, audio, out, j.format, j.quality);
    else await moveFile(joined, out);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Render one segment (worker side): exact frames [a, b), video only; the encoder starts it with an IDR. */
export async function renderSegment(project: ProjectFile, job: WorkerJob, onFrame?: (n: number) => void): Promise<void> {
  const prep = await prepare(project, { baseDir: job.baseDir, comp: job.comp });
  const enc: EncodeOptions = { out: job.out, width: job.width!, height: job.height!, rate: prep.rate, format: job.format!, quality: job.quality ?? 'final' };
  if (job.alpha) enc.alpha = true;
  const sink = await prep.backend.encode(enc);
  try {
    await renderRange(prep, { range: job.range!, width: job.width!, height: job.height!, onFrame }, (f) => sink.write(f));
    await sink.finish();
  } catch (e) { await sink.abort().catch(() => {}); throw e; }
}

async function muxAudio(backend: MediaBackend, video: string, wav: string, out: string, format: EncodeOptions['format'], quality: Quality): Promise<void> {
  const ff = await backend.info();
  const codec = format === 'webm' ? ['-c:a', 'libopus', '-b:a', '128k'] : format === 'mov' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', quality === 'draft' ? '96k' : '192k', '-ar', '48000'];
  const extra = format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : [];
  await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', video, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...codec, ...extra, out], { what: `muxing audio into ${out}` });
}

// ------------------------------------------------------------------------------------------- verify

export async function probeOutput(backend: MediaBackend, file: string): Promise<ProbeReport> {
  const ff = await backend.info();
  const r = await run(ff.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { what: `checking ${file}` });
  const j = JSON.parse(r.stdout.toString()) as { streams?: Record<string, string | number | undefined>[]; format?: Record<string, string | number | undefined> };
  const num = (v: unknown) => (v === undefined || v === 'N/A' ? undefined : Number(v));
  return {
    duration: num(j.format?.duration) ?? 0,
    format: String(j.format?.format_name ?? ''),
    streams: (j.streams ?? []).map((s) => {
      const o: ProbeReport['streams'][number] = { type: String(s.codec_type), codec: String(s.codec_name) };
      if (s.width !== undefined) o.width = Number(s.width);
      if (s.height !== undefined) o.height = Number(s.height);
      const nf = num(s.nb_frames);
      if (nf !== undefined) o.frames = nf;
      if (s.sample_rate !== undefined) o.sampleRate = Number(s.sample_rate);
      return o;
    }),
  };
}

async function verify(backend: MediaBackend, out: string, kind: OutputKind, res: { seconds: number }): Promise<ProbeReport> {
  const p = await probeOutput(backend, out);
  const need = kind === 'audio' ? 'audio' : 'video';
  if (!p.streams.some((s) => s.type === need)) fail('E_RENDER_VERIFY', `${out} was written but has no ${need} stream.`, 'render again; if it repeats, run mgl doctor to check the ffmpeg build.');
  if ((kind === 'video' || kind === 'audio') && extname(out).toLowerCase() !== '.gif' && res.seconds > 0.5 && Math.abs(p.duration - res.seconds) > Math.max(0.25, res.seconds * 0.05)) {
    fail('E_RENDER_VERIFY', `${out} is ${p.duration.toFixed(2)} s long; expected ${res.seconds.toFixed(2)} s.`, 'render again with segments: 1; if it repeats, report it with the project file.');
  }
  return p;
}

// ------------------------------------------------------------------------------------------- subtitles

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function stamp(sec: number, sep: ',' | '.'): string {
  const ms = Math.round(sec * 1000);
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}

/** Caption cues of the comp at absolute times (cue.at is local to its captions clip), clipped to the clip and range. */
export function subtitleCues(project: ProjectFile, compId: string, range?: [number, number]): { start: number; end: number; text: string; speaker?: string }[] {
  const comp = resolveComp(project, compId);
  const rate = parseRate(comp.fps);
  const tracks = new Set((project.tracks ?? []).filter((t) => t.comp === comp.id && !t.hidden).map((t) => t.id));
  const clips = new Map((project.clips ?? []).filter((c) => c.captions && tracks.has(c.track) && !c.hidden).map((c) => [c.id, c]));
  const [r0, r1] = range ?? [0, Number.POSITIVE_INFINITY];
  const out: { s: number; e: number; text: string; speaker?: string }[] = [];
  for (const q of project.cues ?? []) {
    const c = clips.get(q.clip);
    if (!c) continue;
    const s = Math.max(c.at + q.at, c.at, r0), e = Math.min(c.at + q.at + q.len, c.at + c.len, r1);
    if (e > s) out.push({ s: s - (range ? r0 : 0), e: e - (range ? r0 : 0), text: q.text, ...(q.speaker ? { speaker: q.speaker } : {}) });
  }
  out.sort((x, y) => x.s - y.s);
  return out.map((x) => ({ start: framesToSeconds(x.s, rate), end: framesToSeconds(x.e, rate), text: x.text, ...(x.speaker ? { speaker: x.speaker } : {}) }));
}

export function formatSubtitles(cues: { start: number; end: number; text: string }[], format: 'srt' | 'vtt'): string {
  const sep = format === 'srt' ? ',' : '.';
  const body = cues.map((c, i) => `${format === 'srt' ? `${i + 1}\n` : ''}${stamp(c.start, sep)} --> ${stamp(c.end, sep)}\n${c.text}\n`).join('\n');
  return format === 'vtt' ? `WEBVTT\n\n${body}` : body;
}

async function writeSubtitles(prep: Prep, out: string, range: [number, number]): Promise<number> {
  const cues = subtitleCues(prep.project, prep.comp.id, range);
  if (!cues.length) fail('E_NO_CUES', `comp "${prep.comp.id}" has no caption cues to export.`, 'add captions first: mgl edit <project> captions.import file=<srt> (or captions.add).');
  await writeFile(out, formatSubtitles(cues, extname(out).toLowerCase() === '.vtt' ? 'vtt' : 'srt'));
  return cues.length;
}

// ------------------------------------------------------------------------------------------- exporters

async function runExporter(prep: Prep, out: string, range: [number, number]): Promise<void> {
  const ext = extname(out).toLowerCase();
  const ex = [...prep.registry.exporters.values()].find((e) => e.extensions.map((x) => x.toLowerCase().replace(/^\.?/, '.')).includes(ext))!;
  await ex.export({
    out,
    project: prep.project,
    compId: prep.comp.id,
    renderFrames: async function* (o = {}) {
      const s = o.scale ?? 1;
      const width = Math.max(2, Math.round(prep.W * s)), height = Math.max(2, Math.round(prep.H * s));
      const queue: RGBAFrame[] = [];
      let frame = range[0];
      // render in chunks so the exporter can consume frames as they come
      for (let a = range[0]; a < range[1]; a += 30) {
        await renderRange(prep, { range: [a, Math.min(range[1], a + 30)], width, height }, async (f) => { queue.push(f); });
        while (queue.length) { const f = queue.shift()!; yield { frame: frame++, width: f.width, height: f.height, data: f.data }; }
      }
    },
    renderAudio: async (file: string) => { await mixAudio(prep, range, file, true); },
  });
  if (!existsSync(out)) fail('E_EXPORT', `exporter "${ex.id}" did not write ${out}.`, `check the plugin that provides "${ex.id}".`);
}

// ------------------------------------------------------------------------------------------- detached renders

export interface RenderStatus {
  pid: number;
  out: string;
  startedAt: string;
  status: 'running' | 'done' | 'failed';
  /** 0..1 */
  progress: number;
  etaSec?: number;
  result?: RenderResult;
  error?: { code: string; message: string; fix: string };
  updatedAt?: string;
}

/** .mgl/<project-basename>/render.json */
export function statusFile(projectFile: string): string {
  const base = basename(projectFile).replace(/\.mgl\.json$|\.json$/, '');
  return join(dirname(resolve(projectFile)), '.mgl', base, 'render.json');
}

export function writeStatus(file: string, s: RenderStatus): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  renameSync(tmp, file);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Start a render in a detached process; it keeps running after this process exits. Poll with renderStatus. */
export async function renderDetached(projectFile: string, out: string, opts: Omit<RenderOptions, 'baseDir' | 'registry' | 'backend' | 'renderer' | 'onEstimate' | 'onProgress'> & { baseDir?: string } = {}): Promise<RenderStatus & { statusFile: string }> {
  const file = resolve(projectFile);
  if (!existsSync(file)) fail('E_NO_FILE', `${projectFile} does not exist.`, `create it with: mgl new shorts -o ${projectFile}`);
  const sf = statusFile(file);
  const prev = existsSync(sf) ? readStatus(sf) : null;
  if (prev?.status === 'running' && alive(prev.pid)) fail('E_BUSY', `a render of ${basename(file)} is already running (pid ${prev.pid}, ${Math.round(prev.progress * 100)}%).`, 'wait for it (mgl render --status) or stop it with kill ' + prev.pid + '.');
  const job: WorkerJob = { mode: 'detached', project: file, baseDir: opts.baseDir ?? dirname(file), out: resolve(out), status: sf };
  if (opts.comp) job.comp = opts.comp;
  if (opts.quality) job.quality = opts.quality;
  if (opts.range) job.range = opts.range;
  if (opts.alpha) job.alpha = true;
  if (opts.segments) job.segments = opts.segments;
  mkdirSync(dirname(sf), { recursive: true });
  const jobFile = join(dirname(sf), 'render-job.json');
  writeFileSync(jobFile, JSON.stringify(job));
  const { cmd, args, cwd } = workerCommand(jobFile);
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  const s: RenderStatus = { pid: child.pid!, out: job.out, startedAt: new Date().toISOString(), status: 'running', progress: 0 };
  writeStatus(sf, s);
  return { ...s, statusFile: sf };
}

function readStatus(file: string): RenderStatus | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as RenderStatus; } catch { return null; }
}

/** The state of the last detached render of a project. */
export function renderStatus(projectFile: string): RenderStatus {
  const sf = statusFile(projectFile);
  const s = readStatus(sf);
  if (!s) return fail('E_NO_RENDER', `no detached render of ${basename(projectFile)} was found (${sf}).`, `start one with: mgl render ${projectFile} out.mp4 --detach`);
  if (s.status === 'running' && !alive(s.pid)) {
    return { ...s, status: 'failed', error: { code: 'E_RENDER', message: `the render process (pid ${s.pid}) exited without finishing.`, fix: 'run the render again without --detach to see the error.' } };
  }
  return s;
}

/** Worker side of renderDetached: run the render and keep the status file current. */
export async function runDetached(job: WorkerJob): Promise<void> {
  const sf = job.status!;
  const s: RenderStatus = { pid: process.pid, out: job.out, startedAt: readStatus(sf)?.startedAt ?? new Date().toISOString(), status: 'running', progress: 0 };
  writeStatus(sf, s);
  let lastWrite = 0;
  try {
    const text = readFileSync(job.project, 'utf8');
    const { project } = parseProjectText(text, { file: job.project });
    const o: RenderOptions = {
      baseDir: job.baseDir,
      onEstimate: (e) => { s.etaSec = e.seconds; writeStatus(sf, s); },
      onProgress: (p) => {
        s.progress = p.total ? p.frame / p.total : 0;
        s.etaSec = p.etaSec;
        const now = Date.now();
        if (now - lastWrite > 1000) { lastWrite = now; writeStatus(sf, s); }
      },
    };
    if (job.comp) o.comp = job.comp;
    if (job.quality) o.quality = job.quality;
    if (job.range) o.range = job.range;
    if (job.alpha) o.alpha = true;
    if (job.segments) o.segments = job.segments;
    const result = await render(project, job.out, o);
    writeStatus(sf, { ...s, status: 'done', progress: 1, etaSec: 0, result });
  } catch (e) {
    const err = e instanceof MglError ? e.toJSON() : { code: 'E_RENDER', message: (e as Error).message ?? String(e), fix: 'run the render again without --detach to see the full error.' };
    writeStatus(sf, { ...s, status: 'failed', error: { code: err.code, message: err.message, fix: err.fix } });
    throw e;
  }
}
