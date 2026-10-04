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
import { framesToSeconds, parseRate, parseSpeed, type Rate } from '../core/time.js';
import { interpolate } from './keyframes.js';
import { chapterList, formatChaptersVtt, formatChaptersYouTube } from './chapters.js';
import { builtinRegistry } from '../builtin/index.js';
import type { PluginRegistry } from '../plugin/registry.js';
import { getMediaBackend, planAudio } from '../media/index.js';
import { run } from '../media/proc.js';
import type { DeliveryOptions, EncodeOptions, MediaBackend, MediaInfo, RenderAudioOptions } from '../media/types.js';
import type { AudioLevelsData } from '../media/levels.js';
import { checkDelivery } from '../media/encode.js';
import { filtersToString } from '../media/filters.js';
import { compLength, evaluate, fitBox, layerBoxes, type EvaluateOptions, type LayerBox } from './evaluate.js';
import { MediaFrames, mediaRequests, pool } from './frames.js';
import { scaling } from './matrix.js';
import { skiaRenderer } from './skia/index.js';
import type { AudioPlan, DisplayList, DisplayNode, MediaSource, Renderer, RenderSession, RGBAFrame } from './types.js';

export type Quality = 'draft' | 'final' | 'hq';
export type OutputKind = 'video' | 'still' | 'audio' | 'subtitles' | 'chapters' | 'exporter';

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
  /**
   * audio outputs: render one bus's contribution to master (others muted; ducking kept), or 'all' = one stereo pair per
   * bus feeding master in a multichannel WAV. With a master loudness target the stems get the full mix's gain (they
   * are not normalised on their own), so they sum to the mix.
   */
  bus?: string;
  /** video: constant rate factor (mp4 x264 0–51, webm VP9 0–63) */
  crf?: number;
  /** video bitrate, e.g. "8M" (mp4/webm) */
  bitrate?: string;
  /** audio bitrate for aac/opus/mp3, e.g. "320k" */
  audioBitrate?: string;
  /** PCM bit depth for .wav, .flac and mov audio */
  pcmDepth?: 16 | 24;
  /** ProRes profile for .mov: proxy, lt, 422, hq (default), 4444 (default with alpha), 4444xq */
  prores?: DeliveryOptions['prores'];
  /** start timecode written to .mov/.mp4, "HH:MM:SS:FF" (e.g. "10:00:00:00") */
  timecode?: string;
  /** colour range flag of the video: tv (limited, default) or pc (full) */
  colorRange?: 'tv' | 'pc';
}

const DELIVERY_KEYS = ['crf', 'bitrate', 'audioBitrate', 'pcmDepth', 'prores', 'timecode', 'colorRange'] as const;
/** The delivery settings of render options (undefined when none are set). */
export function deliveryOf(o: Partial<Record<(typeof DELIVERY_KEYS)[number], unknown>>): DeliveryOptions | undefined {
  const d: Record<string, unknown> = {};
  for (const k of DELIVERY_KEYS) if (o[k] !== undefined) d[k] = o[k];
  return Object.keys(d).length ? (d as DeliveryOptions) : undefined;
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
  if (/\.chapters\.(txt|vtt)$/i.test(out)) return 'chapters';
  if (VIDEO_EXT[ext]) return 'video';
  if (ext === '.png') return 'still';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext === '.srt' || ext === '.vtt') return 'subtitles';
  if (registry && [...registry.exporters.values()].some((e) => e.extensions.map((x) => x.toLowerCase().replace(/^\.?/, '.')).includes(ext))) return 'exporter';
  return fail('E_FORMAT', `cannot render to "${ext || out}".`, 'use .mp4, .webm, .mov, .gif, .png, .wav, .mp3, .m4a, .srt, .vtt, .chapters.txt or .chapters.vtt (or install a plugin exporter for that extension).');
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
  /** sound levels of the assets audio-reactive generators follow, by `${assetId}@${rate}` */
  levels: Map<string, AudioLevelsData>;
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
  const prep: Prep = { project, comp, rate: parseRate(comp.fps), W: comp.size[0], H: comp.size[1], length, baseDir: o.baseDir, registry, backend, renderer: o.renderer ?? skiaRenderer, info, fontAssets, notes: [], levels: new Map() };
  if (probeMedia) await loadLevels(prep);
  return prep;
}

export const levelsKey = (assetId: string, rate: Rate) => `${assetId}@${rate.num}/${rate.den}`;

/**
 * Audio-reactive generators (GeneratorDef.audioSource → an asset id): measure that asset's per-frame RMS and spectrum
 * at the rate of the comp the clip is in, once per render (the backend caches it).
 */
async function loadLevels(prep: Prep): Promise<void> {
  const { project, registry } = prep;
  const trackComp = new Map((project.tracks ?? []).map((t) => [t.id, t.comp]));
  const comps = new Map(project.comps.map((c) => [c.id, c]));
  const assets = new Map((project.assets ?? []).map((a) => [a.id, a]));
  const want = new Map<string, { asset: Asset; rate: Rate; clip: string }>();
  for (const c of project.clips ?? []) {
    if (!c.gen || c.hidden) continue;
    const def = registry.generators.get(c.gen.type);
    if (!def?.audioSource) continue;
    const { type: _t, ...raw } = c.gen;
    const vals = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, interpolate(v as never, 0)]));
    const parsed = def.params.safeParse(vals);
    if (!parsed.success) continue; // evaluate reports the parameter error with its fix
    const id = def.audioSource(parsed.data as never);
    if (!id) continue;
    const asset = assets.get(id);
    if (!asset) fail('E_REF', `clip "${c.id}": generator "${c.gen.type}" follows the sound of asset "${id}", which does not exist.`, `add it (mgl edit <file> asset.add src=<file> id=${id}) or point the generator at an existing audio asset.`);
    const comp = comps.get(trackComp.get(c.track) ?? '') ?? prep.comp;
    const rate = parseRate(comp.fps);
    want.set(levelsKey(id, rate), { asset, rate, clip: c.id });
  }
  if (!want.size) return;
  if (!prep.backend.analyzeLevels) fail('E_NATIVE', 'this media backend cannot measure sound levels (needed by an audio-reactive generator).', 'use the default native-ffmpeg backend.');
  await pool([...want], 4, async ([key, w]) => { prep.levels.set(key, await prep.backend.analyzeLevels!(assetPath(w.asset, prep.baseDir), w.rate)); });
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
  prep.renderer.open({ width, height, registry: prep.registry, fontAssets: prep.fontAssets, ...(prep.levels.size ? { audioLevels: (assetId: string, rate: Rate) => prep.levels.get(levelsKey(assetId, rate)) } : {}) });

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

/**
 * Encoder throughput (frames/s) at 1080x1920, measured on the 4-vCPU reference machine, RGBA piped in (the scale to
 * YUV included). ProRes (prores_ks HQ 4:2:2 10-bit) was re-measured 2026-10-04 at ≈3.5× slower than x264 veryfast on
 * the same frames (it was 45, which made ProRes estimates ≈1.7× low); 4444 with alpha is slower again (ALPHA_FACTOR).
 */
const ENCODE_FPS_1080x1920: Record<string, number> = {
  'mp4:draft': 220, 'mp4:final': 65, 'mp4:hq': 22,
  'webm:draft': 40, 'webm:final': 15, 'webm:hq': 8,
  'mov:draft': 19, 'mov:final': 19, 'mov:hq': 19,
  'gif:draft': 150, 'gif:final': 150, 'gif:hq': 150,
  'png:draft': 25, 'png:final': 25, 'png:hq': 25,
};
const REF_PIXELS = 1080 * 1920;
/** sequential decode + RGBA conversion per 1080p frame (ms), by codec; scaled by source pixels (short renders only) */
const DECODE_MS_1080P: Record<string, number> = { h264: 12, hevc: 16, vp9: 16, av1: 20, prores: 14 };

/** throughput factor of alpha encodes (ProRes 4444 + 16-bit alpha, VP9 yuva420p) */
const ALPHA_FACTOR: Partial<Record<EncodeOptions['format'], number>> = { mov: 0.8, webm: 0.85 };
/** ProRes throughput by profile relative to HQ (lighter profiles encode faster) */
const PRORES_FACTOR: Record<string, number> = { proxy: 1.6, lt: 1.3, '422': 1.1, hq: 1, '4444': 0.8, '4444xq': 0.7 };

export function encodeFps(format: EncodeOptions['format'], quality: Quality, width: number, height: number, o: { alpha?: boolean; prores?: string } = {}): number {
  let base = ENCODE_FPS_1080x1920[`${format}:${quality}`] ?? 60;
  if (format === 'mov' && o.prores) base *= PRORES_FACTOR[o.prores] ?? 1;
  else if (o.alpha) base *= ALPHA_FACTOR[format] ?? 1;
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

async function estimateWith(prep: Prep, o: { range: [number, number]; quality: Quality; format: EncodeOptions['format']; width: number; height: number; segments?: number; alpha?: boolean; prores?: string }): Promise<Estimate> {
  const [a, b] = o.range;
  const frames = b - a;
  const duration = framesToSeconds(frames, prep.rate);
  const session = await openSession(prep, o.width, o.height);
  const provider = new MediaFrames({ backend: prep.backend, baseDir: prep.baseDir, mode: 'random' });
  let perFrameMs = 0, decodeMs = 0, machine = 1;
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
      // frames on the passthrough path are not composited: only the decoded frame is handed on
      if (passthroughSource(prep, l, o.width, o.height)) { times.push(PASSTHROUGH_MS); continue; }
      const t0 = performance.now();
      await session.drawFrame(l, provider);
      times.push(performance.now() - t0);
    }
    perFrameMs = times.reduce((s, t) => s + t, 0) / times.length;
    ({ ms: decodeMs, speed: machine } = await measureDecode(prep, mediaRequests(lists[lists.length - 1]!.nodes, root), frames));
  } finally {
    await provider.close();
    await session.close();
  }
  const fps = encodeFps(o.format, o.quality, o.width, o.height, { ...(o.alpha ? { alpha: true } : {}), ...(o.prores ? { prores: o.prores } : {}) });
  // the encoder table is for the reference machine; a measured decode slower or faster than its reference scales it too
  const encodeMs = (1000 / fps) * machine;
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
/** frames evaluated and requested from the decoders ahead of the one being drawn */
const LOOKAHEAD = 2;
/** main-thread cost of a passthrough frame (evaluate + handing the buffer on), ms */
const PASSTHROUGH_MS = 1;
const WORKER_START_SEC = 1.5;
/** wall-time targets (× real time) per quality: over target, long renders split into worker processes */
const TARGET_RT: Record<Quality, number> = { draft: 1, final: 3, hq: 3 };

/**
 * Sequential decode time per frame (ms) of the video layers of a frame, measured: each source is opened at the
 * size it is drawn and read for a few frames, all at once (they run side by side during the render too).
 * Short renders use a codec/pixel-count constant instead.
 */
async function measureDecode(prep: Prep, reqs: { src: MediaSource; size: { w: number; h: number } }[], frames: number): Promise<{ ms: number; speed: number }> {
  const videos = [...new Map(reqs.filter((r) => r.src.kind === 'video').map((r) => [r.src.assetId + JSON.stringify(r.src.filters), r])).values()];
  if (!videos.length) return { ms: 0, speed: 1 };
  const guess = (r: (typeof videos)[number]) => {
    const i = prep.info.get(r.src.assetId);
    return (DECODE_MS_1080P[i?.videoCodec ?? 'h264'] ?? 8) * (((i?.width ?? 1920) * (i?.height ?? 1080)) / (1920 * 1080));
  };
  const guessed = videos.reduce((s, r) => s + guess(r), 0);
  if (frames < 120) return { ms: guessed, speed: 1 };
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
    const ms = top + CONTENTION * (per.reduce((s, x) => s + x, 0) - top);
    // this machine (and its load) against the reference: the slowest source's measured vs reference decode time
    const worst = videos[per.indexOf(top)]!;
    const speed = Math.min(MACHINE_MAX, Math.max(MACHINE_MIN, top / Math.max(1, guess(worst))));
    return { ms, speed };
  } catch {
    return { ms: guessed, speed: 1 };
  } finally { await fr.close(); }
}
const DECODE_SAMPLE = 8;
/** bounds of the machine factor applied to the encoder table (a decode sample is noisy) */
const MACHINE_MIN = 0.75, MACHINE_MAX = 2.5;

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
export async function estimate(project: ProjectFile, opts: PipelineOptions & { quality?: Quality; range?: [number, number]; format?: EncodeOptions['format']; out?: string; segments?: number; alpha?: boolean; prores?: DeliveryOptions['prores'] }): Promise<Estimate> {
  const prep = await prepare(project, opts);
  const quality = opts.quality ?? 'final';
  const format = opts.format ?? (opts.out ? VIDEO_EXT[extname(opts.out).toLowerCase()] : undefined) ?? 'mp4';
  const { width, height } = outputSize(prep.W, prep.H, quality);
  return estimateWith(prep, { range: checkRange(prep, opts.range), quality, format, width, height, segments: opts.segments, ...(opts.alpha ? { alpha: true } : {}), ...(opts.prores ? { prores: opts.prores } : {}) });
}

// ------------------------------------------------------------------------------------------- frames

/** Render [a, b) in order into `sink`, decoding the next frame while the current one is drawn. */
/**
 * Composite a straight-alpha frame over opaque black, in place: outputs without an alpha channel (mp4, gif,
 * non-alpha mov/webm) would otherwise drop the alpha and show translucent pixels at full strength.
 * The comp's bg (when set) is already drawn into the frame; black is the default bg.
 */
export function flattenAlpha(f: RGBAFrame): RGBAFrame {
  const d = f.data;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i]!;
    if (a === 255) continue;
    if (a === 0) { d[i - 3] = 0; d[i - 2] = 0; d[i - 1] = 0; }
    else { d[i - 3] = Math.round((d[i - 3]! * a) / 255); d[i - 2] = Math.round((d[i - 2]! * a) / 255); d[i - 1] = Math.round((d[i - 1]! * a) / 255); }
    d[i] = 255;
  }
  return f;
}

async function renderRange(prep: Prep, o: { range: [number, number]; width: number; height: number; onFrame?(done: number): void; opaque?: boolean; /** frames that took the passthrough path */ stats?(passthrough: number): void }, write: (f: RGBAFrame) => Promise<void>): Promise<void> {
  const session = await openSession(prep, o.width, o.height);
  const frames = new MediaFrames({ backend: prep.backend, baseDir: prep.baseDir, mode: 'sequential' });
  const root = scaling(o.width / prep.W, o.height / prep.H);
  const eo = evalOptions(prep, session);
  const [a, b] = o.range;
  const prefetch = (l: DisplayList) => { for (const r of mediaRequests(l.nodes, root)) frames.get(r.src, r.size).catch(() => {}); };
  let passthrough = 0;
  try {
    // decodes run LOOKAHEAD frames ahead of drawing, so the decoders work while frames are drawn and encoded
    const ahead: DisplayList[] = [];
    let nextEval = a;
    const fill = () => { while (nextEval < b && ahead.length <= LOOKAHEAD) { const l = evaluate(prep.project, prep.comp.id, nextEval++, eo); prefetch(l); ahead.push(l); } };
    let pending: Promise<void> = Promise.resolve();
    for (let f = a; f < b; f++) {
      fill();
      const list = ahead.shift()!;
      const direct = passthroughSource(prep, list, o.width, o.height);
      let img: RGBAFrame | null = null;
      if (direct) {
        // one opaque full-frame media layer: the decoded frame is the output frame (no compositing, no readback)
        const f = await frames.get(direct.src, direct.size);
        if (f.width === o.width && f.height === o.height && f.data.byteLength === o.width * o.height * 4) { img = f; passthrough++; }
      }
      if (!img) {
        img = await session.drawFrame(list, frames);
        if (o.opaque) flattenAlpha(img);
      }
      await pending;
      pending = write(img);
      o.onFrame?.(f - a + 1);
    }
    await pending;
    o.stats?.(passthrough);
  } finally {
    await frames.close();
    await session.close();
  }
}

/** pixel formats that can carry alpha (their decoded frames may be translucent) */
const ALPHA_PIX = /^(yuva|rgba|argb|abgr|bgra|gbrap|ya|pal8|rgb32|bgr32)/;

/**
 * The fast path of a frame: when its display list is exactly one opaque media layer drawn 1:1 over the whole output
 * (identity placement, no effects, masks, matte, crop, blend or opacity, a source without alpha and of the output's
 * aspect), returns the decode request whose frame is the output frame; otherwise null.
 */
export function passthroughSource(prep: Pick<Prep, 'W' | 'H' | 'info'>, list: DisplayList, width: number, height: number): { src: MediaSource; size: { w: number; h: number } } | null {
  if (list.nodes.length !== 1) return null;
  const n = list.nodes[0]!;
  if (n.type !== 'layer' || n.source.type !== 'media' || n.opacity !== 1 || n.blend !== 'normal' || n.fx.length || n.masks.length || n.matte) return null;
  const src = n.source;
  if (src.crop || !src.size) return null;
  const info = prep.info.get(src.assetId);
  if (!info?.pixFmt || ALPHA_PIX.test(info.pixFmt)) return null;
  const m = n.matrix, sx = width / prep.W, sy = height / prep.H;
  const tol = 0.5;
  if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9 || m[0] <= 0 || m[3] <= 0) return null;
  if (Math.abs(m[4] * sx) > tol || Math.abs(m[5] * sy) > tol) return null;
  if (Math.abs(m[0] * n.box.w * sx - width) > tol || Math.abs(m[3] * n.box.h * sy - height) > tol) return null;
  // the drawn image must fill the box exactly (fill, or a source of the box's aspect)
  if (src.fit !== 'fill') {
    const d = fitBox(src.size.w, src.size.h, n.box.w, n.box.h, src.fit);
    if (Math.abs(d.w - n.box.w) * m[0] * sx > tol || Math.abs(d.h - n.box.h) * m[3] * sy > tol) return null;
  }
  const req = mediaRequests(list.nodes, scaling(sx, sy))[0];
  return req ? { src, size: req.size } : null;
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
  const ext = extname(out).toLowerCase();
  const delivery = deliveryOf(opts);
  if (opts.bus !== undefined && kind !== 'audio') fail('E_ARG', `bus applies to audio outputs (stems), not ${kind === 'video' ? 'video' : ext}.`, `render the stem to a .wav: mgl render <file> stem.wav --bus ${opts.bus}.`);
  if (opts.bus === 'all' && ext !== '.wav') fail('E_ARG', `stems of every bus ("all") are written as one multichannel WAV, not ${ext}.`, 'render to a .wav, or name one bus.');
  if (delivery && (kind === 'audio' || kind === 'still' || kind === 'subtitles' || kind === 'chapters')) {
    const audioOnly = kind === 'audio' && Object.keys(delivery).every((k) => k === 'audioBitrate' || k === 'pcmDepth');
    if (!audioOnly) fail('E_ARG', `${Object.keys(delivery).join(', ')} ${Object.keys(delivery).length > 1 ? 'are' : 'is'} not used by ${ext} outputs.`, kind === 'audio' ? 'audio outputs take audioBitrate (mp3, m4a, opus) and pcmDepth (wav, flac).' : 'drop the delivery settings for this output.');
    checkDelivery(delivery, 'mp4', { num: 30, den: 1 });
  }
  const prep = await prepare(project, { ...opts, registry }, kind !== 'subtitles' && kind !== 'chapters');
  const quality = opts.quality ?? 'final';
  const range = kind === 'subtitles' || kind === 'chapters' ? (opts.range ?? [0, Math.max(1, prep.length)]) : checkRange(prep, opts.range);
  const base = { notes: prep.notes, segments: 1 };
  let res: Omit<RenderResult, 'wallSec' | 'realtimeFactor' | 'bytes' | 'probe' | 'codec' | 'audioCodec' | 'width' | 'height'> & { width?: number; height?: number };
  switch (kind) {
    case 'subtitles': {
      const n = await writeSubtitles(prep, out, range);
      res = { out, seconds: framesToSeconds(range[1] - range[0], prep.rate), frames: 0, ...base };
      prep.notes.push(`${n} cues`);
      break;
    }
    case 'chapters': {
      const ch = chapterList(prep.project, prep.comp.id, range);
      prep.notes.push(...ch.notes);
      await writeFile(out, ext === '.vtt' ? formatChaptersVtt(ch.chapters, framesToSeconds(range[1] - range[0], prep.rate)) : formatChaptersYouTube(ch.chapters));
      prep.notes.push(`${ch.chapters.length} chapters`);
      res = { out, seconds: framesToSeconds(range[1] - range[0], prep.rate), frames: 0, ...base };
      break;
    }
    case 'audio': {
      const audioOpts: RenderAudioOptions = { ...(opts.bus !== undefined ? { bus: opts.bus } : {}), ...(opts.pcmDepth ? { pcmDepth: opts.pcmDepth } : {}) };
      await renderAudioFile(prep, range, out, audioOpts, opts.audioBitrate);
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
      const format = VIDEO_EXT[ext]!;
      if (opts.alpha && format !== 'webm' && format !== 'mov') fail('E_ALPHA', `${format} cannot carry an alpha channel.`, 'render to .mov (ProRes 4444) or .webm (VP9) for alpha.');
      checkDelivery(delivery, format, prep.rate, !!opts.alpha);
      if (opts.alpha && prep.comp.bg && isOpaqueColor(prep.comp.bg)) {
        prep.notes.push(`warning: comp "${prep.comp.id}" has an opaque bg (${prep.comp.bg}), so the alpha channel is fully opaque; for a transparent background remove it: mgl edit <file> comp.set ${prep.comp.id} bg=null`);
      }
      const plan = planFor(prep, range); // audio-stage effect errors stop the render before any frame is drawn
      const { width, height } = outputSize(prep.W, prep.H, quality);
      const est = await estimateWith(prep, { range, quality, format, width, height, segments: opts.segments, alpha: !!opts.alpha, ...(delivery?.prores ? { prores: delivery.prores } : {}) });
      opts.onEstimate?.(est);
      const segs = Math.min(est.segments, Math.max(1, Math.floor((range[1] - range[0]) / 2)));
      const job: VideoJob = { range, quality, format, width, height, alpha: !!opts.alpha, onProgress: opts.onProgress, plan, ...(delivery ? { delivery } : {}) };
      if (segs > 1) await renderSegmented(prep, out, { ...job, segments: segs });
      else await renderVideo(prep, out, job);
      if (delivery?.timecode) prep.notes.push(`start timecode ${delivery.timecode}`);
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
  const probe = kind === 'subtitles' || kind === 'chapters' || kind === 'exporter' ? undefined : await verify(prep.backend, out, kind, res);
  const v = probe?.streams.find((s) => s.type === 'video');
  const au = probe?.streams.find((s) => s.type === 'audio');
  const result: RenderResult = {
    ...res,
    width: v?.width ?? res.width ?? 0,
    height: v?.height ?? res.height ?? 0,
    codec: v?.codec ?? au?.codec ?? (ext === '.srt' ? 'subrip' : ext === '.vtt' ? (kind === 'chapters' ? 'webvtt-chapters' : 'webvtt') : kind === 'chapters' ? 'chapters' : ext.slice(1)),
    bytes,
    wallSec,
    realtimeFactor: res.seconds > 0 ? wallSec / res.seconds : 0,
  };
  if (au && v) result.audioCodec = au.codec;
  if (probe) result.probe = probe;
  return result;
}

/** Is a CSS colour fully opaque? (#rgb/#rrggbb, named colours; #rgba/#rrggbbaa, rgba()/hsla() and "transparent" can be translucent) */
export function isOpaqueColor(c: string): boolean {
  const s = c.trim().toLowerCase();
  if (s === 'transparent') return false;
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 4) return h[3] === 'f';
    if (h.length === 8) return h.slice(6) === 'ff';
    return true;
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  if (fn) {
    const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return true;
    const a = parts[3]!;
    const v = a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a);
    return !(v < 1);
  }
  return true;
}

interface VideoJob { range: [number, number]; quality: Quality; format: EncodeOptions['format']; width: number; height: number; alpha: boolean; onProgress?: RenderOptions['onProgress']; delivery?: DeliveryOptions; plan?: AudioPlan }

/** The comp's audio plan for `range`, with audio-stage effects resolved through the registry; their filters are checked against the allowlist now. */
function planFor(prep: Prep, range: [number, number]): AudioPlan {
  const plan = planAudio(prep.project, prep.comp.id, { baseDir: prep.baseDir, range, hasAudio: (id) => prep.info.get(id)?.hasAudio ?? true, duration: (id) => prep.info.get(id)?.duration, registry: prep.registry });
  for (const s of plan.segments) if (s.filters?.length) filtersToString(s.filters, { stage: 'audio', baseDir: prep.baseDir });
  for (const b of plan.buses) if (b.filters?.length) filtersToString(b.filters, { stage: 'audio', baseDir: prep.baseDir });
  return plan;
}

/** Mix the comp's audio for `range` to a WAV; null when nothing in the range makes sound. */
async function mixAudio(prep: Prep, range: [number, number], wav: string, force = false, o: RenderAudioOptions = {}, plan?: AudioPlan): Promise<string | null> {
  plan ??= planFor(prep, range);
  if (!plan.segments.length && !force) return null;
  const r = await prep.backend.renderAudio(plan, wav, { baseDir: prep.baseDir, ...o });
  if (r && r.notes.length) prep.notes.push(...r.notes);
  return wav;
}

async function renderAudioFile(prep: Prep, range: [number, number], out: string, o: RenderAudioOptions = {}, audioBitrate?: string): Promise<void> {
  const ext = extname(out).toLowerCase();
  if (ext === '.wav') { await mixAudio(prep, range, out, true, o); return; }
  if (audioBitrate && (ext === '.flac' || ext === '.wav')) fail('E_ARG', `audioBitrate does not apply to lossless ${ext}.`, 'use pcmDepth for .wav/.flac, or render to .mp3/.m4a/.opus.');
  if (o.pcmDepth && ext !== '.flac') fail('E_ARG', `pcmDepth applies to .wav and .flac, not ${ext}.`, 'use audioBitrate for lossy formats.');
  const dir = await mkdtemp(join(tmpdir(), 'mgl-render-'));
  try {
    const wav = (await mixAudio(prep, range, join(dir, 'mix.wav'), true, { ...o, ...(o.pcmDepth ? { pcmDepth: o.pcmDepth } : {}) }))!;
    await prep.backend.transcodeAudio(wav, out, { ...(audioBitrate ? { bitrate: audioBitrate } : {}), ...(o.pcmDepth ? { pcmDepth: o.pcmDepth } : {}) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Encoder settings of a video job; the timecode is written when the final file is assembled (muxed), not per segment. */
function encodeDelivery(d: DeliveryOptions | undefined): DeliveryOptions | undefined {
  if (!d) return undefined;
  const { timecode: _tc, audioBitrate: _ab, pcmDepth: _pd, ...rest } = d;
  return Object.keys(rest).length ? rest : undefined;
}

async function renderVideo(prep: Prep, out: string, j: VideoJob): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mgl-render-'));
  try {
    // the audio mix runs while frames render; it is muxed at the end without re-encoding the video
    const audio = j.format === 'gif' ? Promise.resolve(null) : mixAudio(prep, j.range, join(dir, 'mix.wav'), false, {}, j.plan);
    audio.catch(() => {});
    const tmp = join(dir, `video${extname(out)}`);
    const enc: EncodeOptions = { out: tmp, width: j.width, height: j.height, rate: prep.rate, format: j.format, quality: j.quality };
    if (j.alpha) enc.alpha = true;
    const ed = encodeDelivery(j.delivery);
    if (ed) enc.delivery = ed;
    const sink = await prep.backend.encode(enc);
    const progress = progressReporter(j.range[1] - j.range[0], j.onProgress);
    try {
      await renderRange(prep, { range: j.range, width: j.width, height: j.height, onFrame: progress, opaque: !j.alpha }, (f) => sink.write(f));
      await sink.finish();
    } catch (e) { await sink.abort().catch(() => {}); throw e; }
    const wav = await audio;
    await finishVideo(prep.backend, tmp, wav, out, j);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Assemble the output: mux the audio (if any) and write the start timecode, without re-encoding the video. */
async function finishVideo(backend: MediaBackend, video: string, wav: string | null, out: string, j: Pick<VideoJob, 'format' | 'quality' | 'delivery'>): Promise<void> {
  if (wav || j.delivery?.timecode) await muxAudio(backend, video, wav, out, j.format, j.quality, j.delivery);
  else await moveFile(video, out);
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
  /** segment mode: encoder delivery settings; detached mode: all delivery settings */
  delivery?: DeliveryOptions;
  /** detached mode: audio stems */
  bus?: string;
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
    const ed = encodeDelivery(j.delivery);
    const workers = ranges.map(async (r, i) => {
      const job: WorkerJob = { mode: 'segment', project: projectFile, baseDir: prep.baseDir, out: parts[i]!, comp: prep.comp.id, quality: j.quality, range: r, alpha: j.alpha, width: j.width, height: j.height, format: j.format, ...(ed ? { delivery: ed } : {}) };
      const jf = join(dir, `job-${i}.json`);
      await writeFile(jf, JSON.stringify(job));
      await runWorker(jf, (n) => { done[i] = n; progress(done.reduce((s, x) => s + x, 0)); });
    });
    const [audio] = await Promise.all([mixAudio(prep, j.range, join(dir, 'mix.wav'), false, {}, j.plan), Promise.all(workers)]);
    const joined = join(dir, `joined${ext}`);
    await prep.backend.concat(parts, joined);
    await finishVideo(prep.backend, joined, audio, out, j);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Render one segment (worker side): exact frames [a, b), video only; the encoder starts it with an IDR. */
export async function renderSegment(project: ProjectFile, job: WorkerJob, onFrame?: (n: number) => void): Promise<void> {
  const prep = await prepare(project, { baseDir: job.baseDir, comp: job.comp });
  const enc: EncodeOptions = { out: job.out, width: job.width!, height: job.height!, rate: prep.rate, format: job.format!, quality: job.quality ?? 'final' };
  if (job.alpha) enc.alpha = true;
  if (job.delivery) enc.delivery = job.delivery;
  const sink = await prep.backend.encode(enc);
  try {
    await renderRange(prep, { range: job.range!, width: job.width!, height: job.height!, onFrame, opaque: !job.alpha }, (f) => sink.write(f));
    await sink.finish();
  } catch (e) { await sink.abort().catch(() => {}); throw e; }
}

/** Mux `wav` (or no audio) into `video` without re-encoding it; writes the start timecode when one is set. */
async function muxAudio(backend: MediaBackend, video: string, wav: string | null, out: string, format: EncodeOptions['format'], quality: Quality, d: DeliveryOptions = {}): Promise<void> {
  const ff = await backend.info();
  const codec = !wav ? [] : format === 'webm' ? ['-c:a', 'libopus', '-b:a', d.audioBitrate ?? '128k'] : format === 'mov' ? ['-c:a', d.pcmDepth === 24 ? 'pcm_s24le' : 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', d.audioBitrate ?? (quality === 'draft' ? '96k' : '192k'), '-ar', '48000'];
  const extra = format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : [];
  const tc = d.timecode && (format === 'mp4' || format === 'mov') ? ['-timecode', d.timecode] : [];
  await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', video, ...(wav ? ['-i', wav] : []), '-map', '0:v:0', ...(wav ? ['-map', '1:a:0'] : []), '-c:v', 'copy', ...codec, ...tc, ...extra, out], { what: `${wav ? 'muxing audio into' : 'writing'} ${out}` });
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

/**
 * Caption cues of the comp at absolute times (cue.at is local to its captions clip), clipped to the clip and range.
 * Captions inside nested comps are included at the times they show in the render (DESIGN §16 #5 time map:
 * the clip's in, speed and rate ratio, windowed to the comp clip, repeated with loop).
 */
export function subtitleCues(project: ProjectFile, compId: string, range?: [number, number]): { start: number; end: number; text: string; speaker?: string }[] {
  const comp = resolveComp(project, compId);
  const rate = parseRate(comp.fps);
  const comps = new Map(project.comps.map((c) => [c.id, c]));
  const cuesByClip = new Map<string, NonNullable<ProjectFile['cues']>>();
  for (const q of project.cues ?? []) { const l = cuesByClip.get(q.clip) ?? []; l.push(q); cuesByClip.set(q.clip, l); }
  const [r0, r1] = range ?? [0, Number.POSITIVE_INFINITY];
  const out: { s: number; e: number; text: string; speaker?: string }[] = [];
  /** visit a comp whose frame f shows at top frame a + f × m, for f in [w0, w1) */
  const visit = (id: string, a: number, m: number, w0: number, w1: number, depth: number) => {
    if (depth > 16) return;
    const cr = parseRate(comps.get(id)!.fps);
    const tracks = new Set((project.tracks ?? []).filter((t) => t.comp === id && !t.hidden && !t.audio).map((t) => t.id));
    for (const c of project.clips ?? []) {
      if (!tracks.has(c.track) || c.hidden) continue;
      if (c.captions) {
        for (const q of cuesByClip.get(c.id) ?? []) {
          const s = Math.max(c.at + q.at, c.at, w0), e = Math.min(c.at + q.at + q.len, c.at + c.len, w1);
          if (!(e > s)) continue;
          const ts = Math.max(a + s * m, r0), te = Math.min(a + e * m, r1);
          if (te > ts) out.push({ s: ts - (range ? r0 : 0), e: te - (range ? r0 : 0), text: q.text, ...(q.speaker ? { speaker: q.speaker } : {}) });
        }
        continue;
      }
      if (c.comp === undefined || !comps.has(c.comp)) continue;
      const child = comps.get(c.comp)!;
      const sp = parseSpeed(c.speed ?? 1);
      if (!(sp.num > 0)) continue;
      const chr = parseRate(child.fps);
      // parent frame = at + (cf − in) × R
      const R = (cr.num * chr.den * sp.den) / (cr.den * chr.num * sp.num);
      const inF = c.in ?? 0;
      const pv0 = Math.max(c.at, w0), pv1 = Math.min(c.at + c.len, w1);
      if (!(pv1 > pv0)) continue;
      const cv0 = inF + (pv0 - c.at) / R, cv1 = inF + (pv1 - c.at) / R;
      const ca = a + (c.at - inF * R) * m, cm = R * m;
      const L = compLength(project, child.id);
      if (L <= 0) continue;
      if (!c.loop) { visit(child.id, ca, cm, Math.max(cv0, 0), Math.min(cv1, L), depth + 1); continue; }
      for (let k = Math.floor(cv0 / L); k * L < cv1; k++) visit(child.id, ca + k * L * cm, cm, Math.max(cv0 - k * L, 0), Math.min(cv1 - k * L, L), depth + 1);
    }
  };
  visit(comp.id, 0, 1, 0, Number.POSITIVE_INFINITY, 0);
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
  if (!cues.length) fail('E_NO_CUES', `comp "${prep.comp.id}" has no caption cues to export.`, 'add captions first: mgl edit <project> captions.import file=<srt> (or captions.from-text text="...", or cue.add).');
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
  const d = deliveryOf(opts);
  if (d) job.delivery = d;
  if (opts.bus !== undefined) job.bus = opts.bus;
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
    if (job.delivery) Object.assign(o, job.delivery);
    if (job.bus !== undefined) o.bus = job.bus;
    const result = await render(project, job.out, o);
    writeStatus(sf, { ...s, status: 'done', progress: 1, etaSec: 0, result });
  } catch (e) {
    const err = e instanceof MglError ? e.toJSON() : { code: 'E_RENDER', message: (e as Error).message ?? String(e), fix: 'run the render again without --detach to see the full error.' };
    writeStatus(sf, { ...s, status: 'failed', error: { code: err.code, message: err.message, fix: err.fix } });
    throw e;
  }
}
