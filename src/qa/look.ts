/**
 * `mgl look`: check work without watching it. Renders a few frames into a contact sheet, runs the project,
 * frame and audio checks, writes a zoomed crop per finding, and summarises the mix as text.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas';
import type { Finding } from '../plugin/api.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { ProjectFile } from '../core/schema/index.js';
import { parseRate, rateToNumber } from '../core/time.js';
import type { AudioAnalysisReport, MediaBackend } from '../media/types.js';
import type { AudioPlan, RGBAFrame } from '../render/types.js';
import { compIdOf, makeContext, missingMedia, problemFindings, projectLayers, projectRegistry, restFrames, runStage, sortFindings, type Layers } from './check.js';

export const SHEET_MAX = 1568;
const LABEL_H = 20, PAD = 6, MAX_FRAMES = 24, CROP_MIN = 512;

type StillsFn = (project: ProjectFile, opts: { baseDir: string; comp?: string; frames: number[]; scale?: number; registry?: PluginRegistry }) =>
  Promise<{ frame: number; image: RGBAFrame; layers: { clipId: string; kind: string; box: [number, number, number, number]; text?: string; fontPx?: number }[] }[]>;
type PlanFn = (project: ProjectFile, compId: string, opts: { baseDir: string }) => AudioPlan;

export interface LookOptions {
  baseDir: string;
  /** the project file (the work dir is .mgl/<basename>/look/ next to it) */
  file: string;
  comp?: string;
  /** comp frames to show (--at); default: n evenly spaced */
  frames?: number[];
  n?: number;
  /** render scale override (default: the tile size) */
  scale?: number;
  /** add the first frame of every clip change (max 24 frames) */
  cuts?: boolean;
  audio?: boolean;
  platform?: string;
  registry?: PluginRegistry;
  /** injected for tests / other backends */
  deps?: { renderStills?: StillsFn; backend?: Pick<MediaBackend, 'renderAudio' | 'analyzeAudio'>; planAudio?: PlanFn };
}

export interface SoundSummary {
  integrated: number;
  truePeak: number;
  lra: number;
  silences: { start: number; end: number }[];
  bpm?: number;
  beats: number;
  duration: number;
}

export interface LookReport {
  sheet: string;
  /** sheet size [w, h] and grid [cols, rows] */
  size: [number, number];
  grid: [number, number];
  crops: { finding: number; path: string }[];
  findings: Finding[];
  sound?: SoundSummary;
  frames: number[];
  /** render scale used */
  scale: number;
  fps: number;
  seconds: number;
  notes: string[];
}

export function lookDir(file: string): string {
  const base = basename(file).replace(/\.mgl\.json$|\.json$/, '');
  return join(dirname(resolve(file)), '.mgl', base, 'look');
}

/** Frames for the sheet: explicit list, else n centred samples; cuts add clip starts. Sorted, unique, ≤ 24. */
export function chooseFrames(project: ProjectFile, compId: string, length: number, o: { frames?: number[]; n?: number; cuts?: boolean }): number[] {
  const L = Math.max(1, length), clamp = (f: number) => Math.min(L - 1, Math.max(0, Math.round(f)));
  const n = Math.max(1, Math.min(MAX_FRAMES, o.n ?? 12));
  const base = o.frames?.length ? o.frames.map(clamp) : Array.from({ length: Math.min(n, L) }, (_, i) => clamp(Math.floor(((i + 0.5) * L) / Math.min(n, L))));
  const set = new Set(base);
  if (o.cuts) {
    const tracks = new Set((project.tracks ?? []).filter((t) => t.comp === compId && !t.audio && !t.hidden).map((t) => t.id));
    for (const c of project.clips ?? []) if (tracks.has(c.track) && c.at > 0 && c.at < L) set.add(c.at);
  }
  const all = [...set].sort((a, b) => a - b);
  if (all.length <= MAX_FRAMES) return all;
  return [...new Set(Array.from({ length: MAX_FRAMES }, (_, i) => all[Math.round((i * (all.length - 1)) / (MAX_FRAMES - 1))]!))];
}

/** The grid (cols × rows) and tile size that make the tiles largest with the sheet's long edge ≤ max. */
export function sheetLayout(count: number, W: number, H: number, max = SHEET_MAX): { cols: number; rows: number; tileW: number; tileH: number; width: number; height: number; scale: number } {
  let best = { cols: 1, rows: count, scale: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const s = Math.min((max - PAD * (cols + 1)) / cols / W, (max - PAD * (rows + 1) - LABEL_H * rows) / rows / H);
    if (s > best.scale + 1e-9) best = { cols, rows, scale: s };
  }
  const tileW = Math.max(2, Math.floor(W * best.scale)), tileH = Math.max(2, Math.floor(H * best.scale));
  return { ...best, tileW, tileH, scale: tileW / W, width: best.cols * tileW + PAD * (best.cols + 1), height: best.rows * (tileH + LABEL_H) + PAD * (best.rows + 1) };
}

function toCanvas(img: RGBAFrame): Canvas {
  const cv = createCanvas(img.width, img.height);
  const data = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.width * img.height * 4);
  cv.getContext('2d').putImageData(new ImageData(data, img.width, img.height), 0, 0);
  return cv;
}

/** A zoomed crop of a finding's box: padded 30%, long edge 512..1568, box outlined in red. */
export function cropFinding(img: RGBAFrame, scale: number, box: [number, number, number, number]): Canvas {
  const px = box.map((v) => v * scale) as [number, number, number, number];
  const pw = Math.max(px[2] * 0.3, 8), ph = Math.max(px[3] * 0.3, 8);
  const x0 = Math.max(0, Math.floor(px[0] - pw)), y0 = Math.max(0, Math.floor(px[1] - ph));
  const x1 = Math.min(img.width, Math.ceil(px[0] + px[2] + pw)), y1 = Math.min(img.height, Math.ceil(px[1] + px[3] + ph));
  const sw = Math.max(1, x1 - x0), sh = Math.max(1, y1 - y0), long = Math.max(sw, sh);
  const z = Math.min(SHEET_MAX, Math.max(CROP_MIN, long)) / long;
  const out = createCanvas(Math.max(1, Math.round(sw * z)), Math.max(1, Math.round(sh * z)));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(toCanvas(img), x0, y0, sw, sh, 0, 0, out.width, out.height);
  const lw = Math.max(2, Math.round(out.width / 256)), r = [(px[0] - x0) * z, (px[1] - y0) * z, px[2] * z, px[3] * z] as const;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = lw + 2;
  ctx.strokeRect(...r);
  ctx.strokeStyle = '#ff2020';
  ctx.lineWidth = lw;
  ctx.strokeRect(...r);
  return out;
}

async function savePng(cv: Canvas, path: string): Promise<void> {
  writeFileSync(path, await cv.encode('png'));
}

function summarise(a: AudioAnalysisReport): SoundSummary {
  const s: SoundSummary = {
    integrated: a.loudness.integrated, truePeak: a.loudness.truePeak, lra: a.loudness.lra,
    silences: a.silences.filter((x) => x.end - x.start > 0.5), beats: a.beats.length, duration: a.duration,
  };
  if (a.bpm !== undefined) s.bpm = a.bpm;
  return s;
}

export async function look(project: ProjectFile, opts: LookOptions): Promise<LookReport> {
  const t0 = performance.now();
  const notes: string[] = [];
  const compId = compIdOf(project, opts.comp);
  const comp = project.comps.find((c) => c.id === compId)!;
  const [W, H] = comp.size, fps = rateToNumber(parseRate(comp.fps));
  const { compLength } = await import('../render/evaluate.js');
  (await import('../render/text.js')).registerFonts();
  const length = compLength(project, compId);
  const dir = lookDir(opts.file);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^qa-\d+\.png$/.test(f)) rmSync(join(dir, f), { force: true });

  let registry = opts.registry, problems = (registry as { problems?: Parameters<typeof problemFindings>[0] } | undefined)?.problems ?? [];
  if (!registry) ({ registry, problems } = await projectRegistry(project, opts.baseDir));

  // project stage first (no pixels): its boxed findings' frames are rendered too, for their crops
  const rest = await projectLayers(project, compId, restFrames(project, compId), { baseDir: opts.baseDir, registry });
  const projectFindings = await runStage(registry, 'project', makeContext(project, compId, opts.platform, { layers: rest }));
  const frames = chooseFrames(project, compId, length, opts);
  const extra = [...new Set(projectFindings.filter((f) => f.box && f.frame !== undefined && !frames.includes(f.frame)).map((f) => f.frame!))].slice(0, 8);
  const layout = sheetLayout(frames.length, W, H);
  const scale = opts.scale ?? layout.scale;

  const stillsFn: StillsFn = opts.deps?.renderStills ?? (await import('../render/pipeline.js')).renderStills;
  const audioJob = opts.audio === false ? Promise.resolve(undefined) : runAudio(project, compId, opts, dir, notes);
  const [stills, audio] = await Promise.all([
    stillsFn(project, { baseDir: opts.baseDir, comp: compId, frames: [...frames, ...extra], scale, registry }),
    audioJob,
  ]);
  const byFrame = new Map(stills.map((s) => [s.frame, s]));

  // contact sheet
  const sheet = createCanvas(layout.width, layout.height);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#16161a';
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.font = '13px "JetBrains Mono", "Inter", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  frames.forEach((f, i) => {
    const s = byFrame.get(f);
    const col = i % layout.cols, row = Math.floor(i / layout.cols);
    const x = PAD + col * (layout.tileW + PAD), y = PAD + row * (layout.tileH + LABEL_H + PAD);
    if (s) ctx.drawImage(toCanvas(s.image), x, y, layout.tileW, layout.tileH);
    ctx.fillStyle = '#e8e8ec';
    ctx.fillText(`${(f / fps).toFixed(2)}s · f${f}`, x + layout.tileW / 2, y + layout.tileH + LABEL_H / 2);
  });
  const sheetPath = join(dir, 'sheet.png');

  // frame stage on the rendered stills, audio stage on the analysis
  const imgs = new Map(stills.map((s) => [s.frame, { width: s.image.width, height: s.image.height, data: s.image.data, scale: s.image.width / W }]));
  const layers: Layers = new Map(stills.map((s) => [s.frame, s.layers]));
  const frameFindings = await runStage(registry, 'frame', makeContext(project, compId, opts.platform, { frames: imgs, layers }));
  const audioFindings = audio ? await runStage(registry, 'audio', makeContext(project, compId, opts.platform, { audio })) : [];
  // overlap-alpha refines caption-overlap on every frame it saw
  const refined = registry.checks.has('overlap-alpha');
  const kept = projectFindings.filter((f) => !(refined && f.rule === 'caption-overlap' && f.frame !== undefined && imgs.has(f.frame)));
  const seen = new Set<string>();
  const findings = sortFindings([...problemFindings(problems), ...missingMedia(project, opts.baseDir), ...kept, ...frameFindings, ...audioFindings])
    .filter((f) => { const k = `${f.rule}|${f.clip ?? ''}|${f.message}`; return !seen.has(k) && !!seen.add(k); });

  // crops come from a sharper render of the frames with boxed findings (enough px for a 512 px crop, at most comp size)
  const boxed = findings.filter((f) => f.box && f.frame !== undefined && byFrame.has(f.frame));
  const want = Math.min(1, Math.max(0, ...boxed.map((f) => CROP_MIN / (1.6 * Math.max(f.box![2], f.box![3], 1)))));
  const cropFrames = [...new Set(boxed.map((f) => f.frame!))].slice(0, 8);
  const sharp = new Map<number, (typeof stills)[number]>();
  if (cropFrames.length && want > scale * 1.25) {
    for (const s of await stillsFn(project, { baseDir: opts.baseDir, comp: compId, frames: cropFrames, scale: want, registry })) sharp.set(s.frame, s);
  }
  const crops: LookReport['crops'] = [];
  const writes: Promise<void>[] = [savePng(sheet, sheetPath)];
  findings.forEach((f, i) => {
    if (!f.box || f.frame === undefined) return;
    const s = sharp.get(f.frame) ?? byFrame.get(f.frame);
    if (!s) return;
    const path = join(dir, `qa-${i + 1}.png`);
    writes.push(savePng(cropFinding(s.image, s.image.width / W, f.box), path));
    crops.push({ finding: i, path });
  });
  await Promise.all(writes);

  const report: LookReport = {
    sheet: sheetPath, size: [layout.width, layout.height], grid: [layout.cols, layout.rows], crops, findings,
    frames, scale, fps, seconds: Math.round((performance.now() - t0) / 100) / 10, notes,
  };
  if (audio) report.sound = summarise(audio);
  return report;
}

async function runAudio(project: ProjectFile, compId: string, opts: LookOptions, dir: string, notes: string[]): Promise<AudioAnalysisReport | undefined> {
  const media = opts.deps?.planAudio && opts.deps.backend ? undefined : await import('../media/index.js');
  const plan = (opts.deps?.planAudio ?? media!.planAudio)(project, compId, { baseDir: opts.baseDir });
  if (!plan.segments.length) { notes.push('no audio in this comp'); return undefined; }
  const backend = opts.deps?.backend ?? media!.getMediaBackend({ baseDir: opts.baseDir });
  const wav = join(dir, 'mix.wav');
  try {
    await backend.renderAudio(plan, wav, { baseDir: opts.baseDir });
    return await backend.analyzeAudio(wav);
  } catch (e) {
    notes.push(`audio not analysed: ${(e as Error).message.split('\n')[0]}`);
    return undefined;
  }
}
