/**
 * `mgl look`: check work without watching it. Renders a few frames, runs the project, frame and audio checks,
 * writes a zoomed crop per finding, and summarises the mix as text. By default the sheet is the storyboard (scene
 * tiles + lane strip) with storyboard.html next to it; --at / -n / --cuts give the plain contact sheet; --scene n
 * draws one scene's moments and each visual lane alone.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import type { Finding } from '../plugin/api.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { ProjectFile } from '../core/schema/index.js';
import { fail } from '../core/errors.js';
import { entityEquals } from '../core/commands/registry.js';
import { parseRate, rateToNumber } from '../core/time.js';
import type { AudioAnalysisReport, MediaBackend } from '../media/types.js';
import type { AudioPlan, RGBAFrame } from '../render/types.js';
import { uiZones, type Rect } from './safezones.js';
import { assignFindings, diffStoryboard, readPrevious, sceneDetail, sceneFrames, sceneMoments, laneOf, writeSnapshot, type HistoryLike, type Lane, type Storyboard, type StoryScene } from './storyboard.js';
import { dataUrl, drawScene, drawStoryboard, marksOf, sceneScale, SHEET_MAX, storyLayout, toCanvas, type Pic } from './storyboard-draw.js';
import { pageData, storyboardPage, type SceneImages } from './storyboard-page.js';
import { compIdOf, makeContext, mergePlatforms, missingMedia, platformsOf, probeAssets, problemFindings, projectLayers, projectRegistry, qaExtras, restFrames, runStage, sampleFrames, sortFindings, withFile, type Layers, type PlatformFinding, type ProbeFn } from './check.js';

export { SHEET_MAX };
const LABEL_H = 20, PAD = 6, MAX_FRAMES = 24, CROP_MIN = 512;
/** Scenes (⚠ or ●) whose moments and layers a default look renders for the page; the rest show their middle frame. */
const FOCUS_MAX = 4;

type StillsFn = (project: ProjectFile, opts: { baseDir: string; comp?: string; frames: number[]; scale?: number; registry?: PluginRegistry }) =>
  Promise<{ frame: number; image: RGBAFrame; layers: { clipId: string; kind: string; box: [number, number, number, number]; text?: string; fontPx?: number }[] }[]>;
type PlanFn = (project: ProjectFile, compId: string, opts: { baseDir: string; duration?: (assetId: string, src: string) => number | undefined }) => AudioPlan;

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
  /** check against several platforms at once (findings that differ per platform carry `platform`) */
  platforms?: string[];
  /** the render will use --alpha (enables alpha-with-bg) */
  alpha?: boolean;
  /** outline each platform's interface panels (header, buttons, caption panel) on the sheet and crops; never rendered */
  safe?: boolean;
  /** how fixes name the project file (default: `file` relative to the cwd when below it, else as given) */
  displayFile?: string;
  registry?: PluginRegistry;
  /** one scene (number or id): its three moments and each visual lane alone (scene-<n>.png) and its level-2 text */
  scene?: number | string;
  /** false: the plain contact sheet even without frames / n / cuts, no page, no storyboard snapshot */
  storyboard?: boolean;
  /** the project's edit history: changes no recorded command made read "(by hand)" */
  history?: HistoryLike[];
  /** 1-based line of a clip in the project file (the page's level 3, the scene text) */
  lineOf?: (clipId: string) => number | undefined;
  /** injected for tests / other backends (a backend with `probe` gives clip-past-source and source-end aware frozen checks) */
  deps?: { renderStills?: StillsFn; backend?: Pick<MediaBackend, 'renderAudio' | 'analyzeAudio'> & Partial<Pick<MediaBackend, 'probe'>>; planAudio?: PlanFn };
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
  findings: PlatformFinding[];
  sound?: SoundSummary;
  frames: number[];
  /** render scale used */
  scale: number;
  fps: number;
  seconds: number;
  notes: string[];
  /** the storyboard (default look and --scene; additive) */
  storyboard?: StoryboardSummary;
}

export interface StoryboardSummary {
  /** storyboard.html (absent for --scene) */
  page?: string;
  scenes: { n: number; id: string; label: string; at: number; len: number; marks: string[]; changes: string[]; issues: number; /** the first issue */ issue?: string; /** a scene marker's note (the label) */ note?: boolean }[];
  /** changes outside any scene (comps, buses, point markers) */
  notes: string[];
  /** when the previous storyboard (the one ● compares against) was made */
  since?: string;
  /** --scene: the scene shown and its level-2 text */
  scene?: number;
  detail?: string[];
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

/** Outline colours of each platform's interface with --safe. */
export const SAFE_COLOURS: Record<string, string> = { tiktok: '#25f4ee', reels: '#ff4fd8', shorts: '#ffd400' };

export interface SafeZone { platform: string; name: string; rect: Rect }

/** The interface panels `look --safe` outlines: the look's platforms, or all three vertical ones when none is set on a 9:16 comp. */
export function safeOverlays(platforms: string[], W: number, H: number): SafeZone[] {
  const list = platforms.flatMap((p) => (p === 'none' ? (H > W ? ['tiktok', 'reels', 'shorts'] : []) : [p]));
  return [...new Set(list)].flatMap((p) => uiZones(p, W, H).map((z) => ({ platform: p, name: z.name, rect: z.rect })));
}

/** Draw zone outlines (comp px) mapped by comp px × k + (ox, oy), with a light tint so a crop wholly inside a panel still shows it. */
function drawZones(ctx: ReturnType<Canvas['getContext']>, zones: SafeZone[], ox: number, oy: number, k: number): void {
  const lw = Math.max(1, Math.round(k * 4));
  ctx.save();
  ctx.lineWidth = lw;
  ctx.setLineDash([lw * 3, lw * 2]);
  zones.forEach((z, i) => {
    const off = (i % 3) * lw; // the three platforms' panels overlap: stagger them so each stays visible
    const x = ox + z.rect.x * k + off, y = oy + z.rect.y * k + off, w = z.rect.w * k - 2 * off, h = z.rect.h * k - 2 * off;
    const colour = SAFE_COLOURS[z.platform] ?? '#ffffff';
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colour;
    ctx.strokeRect(x, y, w, h);
  });
  ctx.restore();
}

/** The crop with a legend strip below it naming the panels the crop region touches (labels never cover the picture). */
function withLegend(crop: Canvas, names: { platform: string; name: string }[]): Canvas {
  if (!names.length) return crop;
  const fontPx = 18, lineH = fontPx + 6;
  const out = createCanvas(crop.width, crop.height + names.length * lineH + 8);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#16161a';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(crop, 0, 0);
  ctx.font = `${fontPx}px "JetBrains Mono", "Inter", sans-serif`;
  ctx.textBaseline = 'top';
  names.forEach((n, i) => {
    ctx.fillStyle = SAFE_COLOURS[n.platform] ?? '#ffffff';
    ctx.fillText(`under: ${n.platform} ${n.name}`, 8, crop.height + 4 + i * lineH, out.width - 16);
  });
  return out;
}

/** A zoomed crop of a finding's box: padded 30%, long edge 512..1568, box outlined in red (and interface panels with --safe). */
export function cropFinding(img: RGBAFrame, scale: number, box: [number, number, number, number], zones: SafeZone[] = []): Canvas {
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
  if (!zones.length) return out;
  drawZones(ctx, zones, -x0 * z, -y0 * z, scale * z);
  // the panels the finding's box itself is under (comp px)
  const under = zones.filter((q) => Math.min(box[0] + box[2], q.rect.x + q.rect.w) - Math.max(box[0], q.rect.x) > 0 && Math.min(box[1] + box[3], q.rect.y + q.rect.h) - Math.max(box[1], q.rect.y) > 0);
  return withLegend(out, under);
}

const colourName = (p: string) => ({ tiktok: 'cyan', reels: 'magenta', shorts: 'yellow' } as Record<string, string>)[p] ?? 'white';

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

type Still = Awaited<ReturnType<StillsFn>>[number];
type Stage = Pick<LookOptions, 'baseDir' | 'registry' | 'deps' | 'alpha' | 'platform' | 'platforms'>;
const VISUAL: Lane[] = ['picture', 'graphics', 'captions'];
/** Page images: tiles ≤ 360 px tall (≤ 640 wide), so the page stays small and look fast. */
export const pageScale = (W: number, H: number) => Math.min(1, 360 / H, 640 / W);

/** The project stage (no pixels) and what the later stages need: registry, media facts, platforms, extras. */
async function projectStage(project: ProjectFile, compId: string, opts: Stage) {
  let registry = opts.registry, problems = (registry as { problems?: Parameters<typeof problemFindings>[0] } | undefined)?.problems ?? [];
  if (!registry) ({ registry, problems } = await projectRegistry(project, opts.baseDir));
  // media facts (sizes, durations) for exact boxes, clip-past-source and source-end aware frozen checks
  const probeFn: ProbeFn | undefined = opts.deps ? opts.deps.backend?.probe?.bind(opts.deps.backend) : await realProbe(opts.baseDir);
  const facts = await probeAssets(project, opts.baseDir, probeFn);
  const platforms = platformsOf(project, opts);
  // its boxed findings' frames are rendered too, for their crops
  const lo = { baseDir: opts.baseDir, registry, media: facts };
  const rest = await projectLayers(project, compId, restFrames(project, compId), lo);
  const sampled = await projectLayers(project, compId, sampleFrames(project, compId).filter((f) => !rest.has(f)), lo);
  for (const [f, ls] of rest) sampled.set(f, ls);
  const extras = qaExtras(facts, opts.alpha, sampled, !!probeFn);
  const projectRuns: [string, Finding[]][] = [];
  for (const pf of platforms) projectRuns.push([pf, await runStage(registry, 'project', makeContext(project, compId, pf, { layers: rest, ...extras }))]);
  return { registry, problems, probeFn, platforms, extras, projectFindings: mergePlatforms(projectRuns) };
}

/** Sorted, one per rule + clip + message, with <file> filled in. */
function finishFindings(list: PlatformFinding[], file: string): PlatformFinding[] {
  const seen = new Set<string>();
  const out = sortFindings(list).filter((f) => { const k = `${f.rule}|${f.clip ?? ''}|${f.message}`; return !seen.has(k) && !!seen.add(k); });
  withFile(out, file);
  return out;
}

/** Start + 2, middle, end − 2 of a scene (inside it), or none past the end of the comp. */
export function momentFrames(sb: Storyboard, s: StoryScene): [number, number, number] | undefined {
  const m = sceneMoments(sb, s);
  return m && [Math.min(m.start + 2, m.middle), m.middle, Math.max(m.end - 2, m.middle)];
}

/** A copy of the project with only one lane's clips visible on the comp's visual tracks (no comp bg above the picture). */
export function soloProject(p: ProjectFile, compId: string, lane: Lane): ProjectFile {
  const visual = new Set((p.tracks ?? []).filter((t) => t.comp === compId && !t.audio).map((t) => t.id));
  return {
    ...p,
    comps: lane === 'picture' ? p.comps : p.comps.map((c) => { if (c.id !== compId) return c; const { bg: _bg, ...rest } = c; return rest; }),
    clips: (p.clips ?? []).map((c) => (visual.has(c.track) && laneOf(p, c) !== lane ? { ...c, hidden: true } : c)),
  };
}

interface Shots { comp: Map<number, Pic>; solos: Map<Lane, Map<number, Pic>> }

/** The scenes' moments (minus `skip`, rendered elsewhere) and each visual lane alone at the middle. */
async function sceneShots(project: ProjectFile, compId: string, sb: Storyboard, scenes: StoryScene[], scale: number, stills: StillsFn, base: { baseDir: string; registry: PluginRegistry }, skip = new Set<number>()): Promise<Shots> {
  const comp = [...new Set(scenes.flatMap((s) => momentFrames(sb, s) ?? []))].filter((f) => !skip.has(f));
  const has = (s: StoryScene, l: Lane) => s.items.some((i) => i.lane === l && !i.faded);
  const lanes = VISUAL.filter((l) => scenes.some((s) => has(s, l)));
  const mids = (l: Lane) => [...new Set(scenes.filter((s) => has(s, l)).map((s) => momentFrames(sb, s)?.[1]).filter((f): f is number => f !== undefined))];
  const run = (p: ProjectFile, frames: number[]): Promise<Still[]> => (frames.length ? stills(p, { baseDir: base.baseDir, comp: compId, frames, scale, registry: base.registry }) : Promise.resolve([]));
  // one after another: parallel stills sessions contend (measured ≈ 2x slower than in turn)
  const c = await run(project, comp), ss: Still[][] = [];
  for (const l of lanes) ss.push(await run(soloProject(project, compId, l), mids(l)));
  return { comp: new Map(c.map((x) => [x.frame, x.image])), solos: new Map(lanes.map((l, i) => [l, new Map(ss[i]!.map((x) => [x.frame, x.image]))])) };
}

const secs = (f: number, fps: number) => `${(f / fps).toFixed(2)}s`;

/** The images of one scene for level 2 (labels, pictures; a solo is empty when the scene has nothing on that lane). */
function sceneShotsOf(sb: Storyboard, s: StoryScene, shots: Shots, more = new Map<number, Pic>()) {
  const m = momentFrames(sb, s), pic = (f: number) => shots.comp.get(f) ?? more.get(f);
  return {
    moments: (['start', 'middle', 'end'] as const).map((w, i) => ({ label: m ? `${w} ${secs(m[i]!, sb.fps)}` : w, ...(m && pic(m[i]!) ? { image: pic(m[i]!)! } : {}) })),
    solos: VISUAL.map((lane) => { const img = m && shots.solos.get(lane)?.get(m[1]); return { lane, ...(img ? { image: img } : {}), ...(!s.items.some((i) => i.lane === lane && !i.faded) ? { empty: true } : {}) }; }),
  };
}

/** The page's images of every scene, as data: URLs at page size (JPEG; WebP for the transparent lanes). */
async function pageImages(sb: Storyboard, shots: Shots, more: Map<number, Pic>): Promise<Map<number, SceneImages>> {
  const [W, H] = sb.size, k = pageScale(W, H), w = Math.max(2, Math.round(W * k)), h = Math.max(2, Math.round(H * k));
  const out = new Map<number, SceneImages>();
  await Promise.all(sb.scenes.map(async (s) => {
    const sh = sceneShotsOf(sb, s, shots, more);
    const url = (p: Pic | undefined, alpha = false) => (p ? dataUrl(p, w, h, alpha) : Promise.resolve(undefined));
    const moments = await Promise.all(sh.moments.map(async (m) => { const src = await url(m.image); return { label: m.label, ...(src ? { src } : {}) }; }));
    const solos = await Promise.all(sh.solos.map(async (x) => { const src = await url(x.image, x.lane !== 'picture'); return { lane: x.lane, ...(src ? { src } : {}) }; }));
    out.set(s.n, { ...(!s.idea && moments[1]?.src ? { tile: moments[1].src } : {}), moments, solos });
  }));
  return out;
}

/** Line number and text of a clip in the project file (lineOf when given, else the line holding its id and a track). */
function lineTexts(file: string, lineOf?: (clipId: string) => number | undefined): (clipId: string) => { line: number; text: string } | undefined {
  let lines: string[] = [];
  try { if (existsSync(file)) lines = readFileSync(file, 'utf8').split('\n'); } catch { /* no file: the page shows the clip's JSON */ }
  return (id) => {
    let n = lineOf?.(id);
    if (n === undefined) { const i = lines.findIndex((l) => /"track"\s*:/.test(l) && new RegExp(`"id"\\s*:\\s*${JSON.stringify(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(l)); if (i >= 0) n = i + 1; }
    const text = n !== undefined ? lines[n - 1] : undefined;
    return n !== undefined && text ? { line: n, text } : undefined;
  };
}

function summary(sb: Storyboard, since?: string, page?: string): StoryboardSummary {
  return {
    ...(page ? { page } : {}),
    scenes: sb.scenes.map((s) => ({ n: s.n, id: s.id, label: s.label, at: s.at, len: s.len, marks: marksOf(s), changes: s.changes, issues: s.findings.length, ...(s.findings[0] ? { issue: s.findings[0].message } : {}), ...(s.note ? { note: true } : {}) })),
    notes: sb.notes, ...(since ? { since } : {}),
  };
}

/** Write the storyboard page and the snapshot the next storyboard compares against (with the findings, for `show`'s ⚠). */
async function writePage(sb: Storyboard, project: ProjectFile, shots: Shots, more: Map<number, Pic>, o: { html: string; file: string; display: string; since?: string; findings: Finding[]; lineOf?: (clipId: string) => number | undefined }): Promise<void> {
  const images = await pageImages(sb, shots, more);
  writeFileSync(o.html, storyboardPage(pageData(sb, project, { file: o.display, images, lineOf: lineTexts(o.file, o.lineOf), ...(o.since ? { since: o.since } : {}) })));
  writeSnapshot(o.file, project, new Date(), { comp: sb.comp, findings: o.findings });
}

function pickScene(sb: Storyboard, want: number | string, file: string): StoryScene {
  const w = String(want).trim();
  const s = /^\d+$/.test(w) ? sb.scenes.find((x) => x.n === Number(w)) : sb.scenes.find((x) => x.id === w) ?? sb.scenes.find((x) => x.id.toLowerCase() === w.toLowerCase());
  if (!s) fail('E_ARG', `no scene "${w}" (${sb.scenes.length ? `scenes 1–${sb.scenes.length}` : 'this comp has no scenes yet'}).`, `list them: mgl show ${file} --scenes`);
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
  const page = join(dir, 'storyboard.html');

  const { registry, problems, probeFn, platforms, extras, projectFindings } = await projectStage(project, compId, opts);
  const display = opts.displayFile ?? displayName(opts.file);
  const zones = opts.safe ? safeOverlays(platforms, W, H) : [];
  if (opts.safe) notes.push(zones.length
    ? `--safe: interface panels outlined on the sheet and crops (${[...new Set(zones.map((z) => z.platform))].map((p) => `${p} ${colourName(p)}`).join(', ')}); outlines are never rendered`
    : `--safe: no interface panels for ${platforms.join(', ')} on a ${W}x${H} comp (they exist for tiktok, reels and shorts on vertical comps)`);
  const stillsFn: StillsFn = opts.deps?.renderStills ?? (await import('../render/pipeline.js')).renderStills;
  const base = { baseDir: opts.baseDir, registry };

  // the storyboard: by default (no --at / -n / --cuts) and for --scene; ● against the previous storyboard
  const mode = opts.scene !== undefined ? 'scene' : opts.storyboard !== false && !opts.frames?.length && opts.n === undefined && !opts.cuts ? 'board' : 'sheet';
  if (mode === 'sheet') rmSync(page, { force: true }); // the plain sheet replaces sheet.png: a page from an earlier look would no longer match it
  const prev = mode === 'sheet' ? undefined : readPrevious(opts.file);
  const sb = mode === 'sheet' ? undefined : diffStoryboard(prev?.project, project, compId, opts.history, prev?.at);

  if (sb && mode === 'scene') {
    // level 2 of one scene: fast (no frame or audio checks; project-stage findings only)
    const sc = pickScene(sb, opts.scene!, display);
    const k = sceneScale(W, H);
    const shots = await sceneShots(project, compId, sb, [sc], k, stillsFn, base);
    const findings = finishFindings([...problemFindings(problems), ...missingMedia(project, opts.baseDir), ...projectFindings], display);
    assignFindings(sb, findings);
    const cv = drawScene(sb, sc, sceneShotsOf(sb, sc, shots));
    const path = join(dir, `scene-${sc.n}.png`);
    await savePng(cv, path);
    return {
      sheet: path, size: [cv.width, cv.height], grid: [3, 2], crops: [], findings: sc.findings as PlatformFinding[], frames: momentFrames(sb, sc) ?? [], scale: k, fps,
      seconds: Math.round((performance.now() - t0) / 100) / 10, notes,
      storyboard: { ...summary(sb, prev?.at), scene: sc.n, detail: sceneDetail(sb, sc.n, sb.rate, opts.lineOf) },
    };
  }

  const frames = chooseFrames(project, compId, length, opts);
  const extra = [...new Set(projectFindings.filter((f) => f.box && f.frame !== undefined && !frames.includes(f.frame)).map((f) => f.frame!))].slice(0, 8);
  const qaFrames = [...frames, ...extra];
  // the QA frames render at the old contact sheet's tile scale (QA unchanged); the scene middles join the same call
  const layout = sheetLayout(frames.length, W, H);
  const scale = opts.scale ?? layout.scale;
  const mids = sb ? sceneFrames(sb).filter((f) => !qaFrames.includes(f)) : [];

  const audioJob = opts.audio === false ? Promise.resolve(undefined) : runAudio(project, compId, opts, dir, notes);
  const stills = await stillsFn(project, { baseDir: opts.baseDir, comp: compId, frames: [...qaFrames, ...mids], scale, registry });
  const byFrame = new Map(stills.map((s) => [s.frame, s]));

  // frame stage on the rendered QA frames (while the mix renders), then the audio stage on the analysis
  const qa = stills.filter((s) => qaFrames.includes(s.frame));
  const imgs = new Map(qa.map((s) => [s.frame, { width: s.image.width, height: s.image.height, data: s.image.data, scale: s.image.width / W }]));
  const layers: Layers = new Map(qa.map((s) => [s.frame, s.layers]));
  const frameRuns: [string, Finding[]][] = [], audioRuns: [string, Finding[]][] = [];
  for (const pf of platforms) frameRuns.push([pf, await runStage(registry, 'frame', makeContext(project, compId, pf, { frames: imgs, layers, ...extras }))]);
  const frameFindings = mergePlatforms(frameRuns);
  // the page's level 2 costs frames: only the scenes worth digging into (⚠ or ●) get their moments and each layer alone
  let shots: Shots | undefined;
  if (sb) {
    assignFindings(sb, [...projectFindings, ...frameFindings]);
    const focus = sb.scenes.filter((s) => !s.idea && (s.changed || s.findings.length)).slice(0, FOCUS_MAX);
    shots = focus.length ? await sceneShots(project, compId, sb, focus, pageScale(W, H), stillsFn, base, new Set(sceneFrames(sb))) : { comp: new Map(), solos: new Map() };
  }
  const audio = await audioJob;
  if (audio) for (const pf of platforms) audioRuns.push([pf, await runStage(registry, 'audio', makeContext(project, compId, pf, { audio, ...extras }))]);
  const audioFindings = audio ? mergePlatforms(audioRuns) : [];
  // overlap-alpha refines caption-overlap on every frame it saw
  const refined = registry.checks.has('overlap-alpha');
  const kept = projectFindings.filter((f) => !(refined && f.rule === 'caption-overlap' && f.frame !== undefined && imgs.has(f.frame)));
  const findings = finishFindings([...problemFindings(problems), ...missingMedia(project, opts.baseDir), ...kept, ...frameFindings, ...audioFindings], display);

  // the sheet: the storyboard (scene tiles + lane strip), or the contact sheet with --at / -n / --cuts
  let sheet: Canvas, size: [number, number], grid: [number, number];
  if (sb) {
    assignFindings(sb, findings);
    const tiles = new Map<number, Pic>();
    for (const s of sb.scenes) { const m = sceneMoments(sb, s), st = m && byFrame.get(m.middle); if (st) tiles.set(s.n, st.image); }
    const d = drawStoryboard(sb, tiles, zones.length ? { onTile: (ctx, x, y, w) => drawZones(ctx, zones, x, y, w / W) } : {});
    sheet = d.canvas; size = [d.layout.width, d.layout.height]; grid = [d.layout.cols, d.layout.rows];
  } else {
    sheet = createCanvas(layout.width, layout.height);
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
      if (zones.length) drawZones(ctx, zones, x, y, layout.tileW / W);
      ctx.fillStyle = '#e8e8ec';
      ctx.fillText(`${(f / fps).toFixed(2)}s · f${f}`, x + layout.tileW / 2, y + layout.tileH + LABEL_H / 2);
    });
    size = [layout.width, layout.height]; grid = [layout.cols, layout.rows];
  }
  const sheetPath = join(dir, 'sheet.png');

  // crops come from a sharper render of the frames with boxed findings (enough px for a 512 px crop, at most comp size)
  const boxed = findings.filter((f) => f.box && f.frame !== undefined && byFrame.has(f.frame));
  const want = Math.min(1, Math.max(0, ...boxed.map((f) => CROP_MIN / (1.6 * Math.max(f.box![2], f.box![3], 1)))));
  const cropFrames = [...new Set(boxed.map((f) => f.frame!))].slice(0, 8);
  const sharp = new Map<number, Still>();
  if (cropFrames.length && want > scale * 1.25) {
    for (const s of await stillsFn(project, { baseDir: opts.baseDir, comp: compId, frames: cropFrames, scale: want, registry })) sharp.set(s.frame, s);
  }
  const crops: LookReport['crops'] = [];
  const writes: Promise<void>[] = [savePng(sheet, sheetPath)];
  if (sb && shots) writes.push(writePage(sb, project, shots, new Map(stills.map((s) => [s.frame, s.image])), { html: page, file: opts.file, display, findings, ...(prev ? { since: prev.at } : {}), ...(opts.lineOf ? { lineOf: opts.lineOf } : {}) }));
  findings.forEach((f, i) => {
    if (!f.box || f.frame === undefined) return;
    const s = sharp.get(f.frame) ?? byFrame.get(f.frame);
    if (!s) return;
    const path = join(dir, `qa-${i + 1}.png`);
    writes.push(savePng(cropFinding(s.image, s.image.width / W, f.box, zones), path));
    crops.push({ finding: i, path });
  });
  await Promise.all(writes);

  const report: LookReport = {
    sheet: sheetPath, size, grid, crops, findings,
    frames, scale, fps, seconds: Math.round((performance.now() - t0) / 100) / 10, notes,
  };
  if (audio) report.sound = summarise(audio);
  if (sb) report.storyboard = summary(sb, prev?.at, page);
  return report;
}

export interface StoryboardFiles { png: string; html: string; size: [number, number]; seconds: number; storyboard: StoryboardSummary }

/**
 * The storyboard alone (what `render` writes next to a video): the image and the page, ⚠ from the project-stage
 * checks (no pixels), ● against the previous storyboard; then this one becomes the previous.
 */
export async function writeStoryboard(project: ProjectFile, o: Stage & { file: string; comp?: string; png?: string; html?: string; displayFile?: string; history?: HistoryLike[]; lineOf?: (clipId: string) => number | undefined }): Promise<StoryboardFiles> {
  const t0 = performance.now();
  const compId = compIdOf(project, o.comp);
  const [W, H] = project.comps.find((c) => c.id === compId)!.size;
  (await import('../render/text.js')).registerFonts();
  const { registry, problems, projectFindings } = await projectStage(project, compId, o);
  const display = o.displayFile ?? displayName(o.file);
  const prev = readPrevious(o.file);
  const sb = diffStoryboard(prev?.project, project, compId, o.history, prev?.at);
  // the last look's frame and sound findings still hold when the project has not changed since (render follows a look)
  const kept = prev?.findings && prev.comp === compId && entityEquals(prev.project, project) ? (prev.findings as PlatformFinding[]) : [];
  const findings = finishFindings([...problemFindings(problems), ...missingMedia(project, o.baseDir), ...projectFindings, ...kept], display);
  assignFindings(sb, findings);
  const stillsFn: StillsFn = o.deps?.renderStills ?? (await import('../render/pipeline.js')).renderStills;
  const k = Math.min(1, Math.max(storyLayout(sb.scenes.length, W, H).scale, pageScale(W, H)));
  const shots = await sceneShots(project, compId, sb, sb.scenes, k, stillsFn, { baseDir: o.baseDir, registry });
  const tiles = new Map<number, Pic>();
  for (const s of sb.scenes) { const m = sceneMoments(sb, s), img = m && shots.comp.get(m.middle); if (img) tiles.set(s.n, img); }
  const d = drawStoryboard(sb, tiles);
  const dir = lookDir(o.file), png = o.png ?? join(dir, 'storyboard.png'), html = o.html ?? join(dir, 'storyboard.html');
  mkdirSync(dirname(resolve(png)), { recursive: true });
  mkdirSync(dirname(resolve(html)), { recursive: true });
  await Promise.all([savePng(d.canvas, png), writePage(sb, project, shots, new Map(), { html, file: o.file, display, findings, ...(prev ? { since: prev.at } : {}), ...(o.lineOf ? { lineOf: o.lineOf } : {}) })]);
  return { png, html, size: [d.layout.width, d.layout.height], seconds: Math.round((performance.now() - t0) / 100) / 10, storyboard: summary(sb, prev?.at, html) };
}

/** How a fix names the project file: relative to the cwd when it is below it, else as given. */
export function displayName(file: string, cwd = process.cwd()): string {
  const r = relative(cwd, resolve(file));
  return r && !r.startsWith('..') && !isAbsolute(r) ? r : file;
}

async function realProbe(baseDir: string): Promise<ProbeFn | undefined> {
  try {
    const media = await import('../media/index.js');
    const b = media.getMediaBackend({ baseDir });
    return (p: string) => b.probe(p);
  } catch { return undefined; }
}

export interface LookEstimate {
  /** predicted wall time (s) */
  seconds: number;
  /** frames the sheet will render */
  frames: number;
  /** seconds of sound to analyse (0 with audio off) */
  audioSeconds: number;
  /** true when the look may take over 2 minutes: print `note` first */
  slow: boolean;
  /** "est. 140 s (look: 12 frames + sound analysis of 600 s)" */
  note: string;
}

/** Predict how long `look` takes (cheap for typical projects; measures a draft frame for long or video-heavy comps). */
export async function estimateLook(project: ProjectFile, opts: { baseDir: string; registry?: PluginRegistry; comp?: string; frames?: number[]; n?: number; cuts?: boolean; audio?: boolean }): Promise<LookEstimate> {
  const compId = compIdOf(project, opts.comp);
  const comp = project.comps.find((c) => c.id === compId)!;
  const rate = parseRate(comp.fps);
  const { compLength } = await import('../render/evaluate.js');
  const length = compLength(project, compId);
  const seconds = (length * rate.den) / rate.num;
  const tracks = new Set((project.tracks ?? []).filter((t) => t.comp === compId).map((t) => t.id));
  const videos = (project.clips ?? []).filter((c) => tracks.has(c.track) && c.asset !== undefined).length;
  const n = opts.frames?.length ?? (opts.cuts ? MAX_FRAMES : Math.min(MAX_FRAMES, opts.n ?? 12));
  const audioSeconds = opts.audio === false ? 0 : seconds;
  let est: number;
  if (seconds < 300 && videos < 8) est = 1 + n * 0.3 + audioSeconds * 0.02; // a look of a typical project takes seconds
  else {
    const pipeline = await import('../render/pipeline.js');
    const registry = opts.registry ?? (await projectRegistry(project, opts.baseDir)).registry;
    const e = await pipeline.estimate(project, { baseDir: opts.baseDir, registry, comp: compId, quality: 'draft', range: [0, Math.min(length, 3)] });
    est = (n * (e.perFrameMs + e.decodeMs * 4)) / 1000 + audioSeconds * 0.05;
  }
  const s = Math.max(1, Math.round(est));
  return { seconds: s, frames: n, audioSeconds, slow: est > 120, note: `est. ${s} s (look: ${n} frames${audioSeconds ? ` + sound analysis of ${Math.round(audioSeconds)} s` : ''})` };
}

async function runAudio(project: ProjectFile, compId: string, opts: LookOptions, dir: string, notes: string[]): Promise<AudioAnalysisReport | undefined> {
  const media = opts.deps?.planAudio && opts.deps.backend ? undefined : await import('../media/index.js');
  const backend = opts.deps?.backend ?? media!.getMediaBackend({ baseDir: opts.baseDir });
  // looped clips repeat their sound with the source's period, so probe those assets' durations (as render does)
  const durations = new Map<string, number>();
  const probeFn = (backend as Partial<Pick<MediaBackend, 'probe'>>).probe;
  if (probeFn) {
    const looped = new Set((project.clips ?? []).filter((c) => c.loop && c.asset !== undefined).map((c) => c.asset!));
    await Promise.all((project.assets ?? []).filter((a) => looped.has(a.id)).map(async (a) => {
      try {
        const d = (await probeFn(isAbsolute(a.src) ? a.src : resolve(opts.baseDir, a.src))).duration;
        if (typeof d === 'number' && d > 0) durations.set(a.id, d);
      } catch { /* missing media is reported elsewhere */ }
    }));
  }
  const plan = (opts.deps?.planAudio ?? media!.planAudio)(project, compId, { baseDir: opts.baseDir, duration: (id) => durations.get(id), ...(opts.registry ? { registry: opts.registry } : {}) });
  if (!plan.segments.length) { notes.push('no audio in this comp'); return undefined; }
  const wav = join(dir, 'mix.wav');
  try {
    await backend.renderAudio(plan, wav, { baseDir: opts.baseDir });
    return await backend.analyzeAudio(wav);
  } catch (e) {
    notes.push(`audio not analysed: ${(e as Error).message.split('\n')[0]}`);
    return undefined;
  }
}
