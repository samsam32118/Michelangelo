/**
 * The fidelity ladder through the SDK (BOARD.md §4): stills (cached by project content + request), the look contact
 * sheet, draft and final renders. Every render that was not a cache hit is recorded as a `spend` row.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { fail } from '../../core/errors.js';
import { parseRate, parseTime } from '../../core/time.js';
import { open, type MglProject } from '../../sdk/index.js';
import { estimate as estimateRender, renderStills, resolveComp, type Estimate } from '../../render/pipeline.js';
import { compLength } from '../../render/evaluate.js';
import type { BoardFile, Fidelity, Shape, SpendEntry, StillShape, TimeLike, Who } from '../shared/types.js';
import { BoardSession, resolveBoardPath } from '../model/index.js';
import { boardCacheDir, linkedProject } from './paths.js';

export const THUMB_W = 270;

/** Pixel width of a still at a fidelity, for a comp `compW` wide. */
export const stillWidth = (f: Fidelity | undefined, compW: number): number => (f === 'full' ? compW : f === 'half' ? Math.round(compW / 2) : THUMB_W);

/** m:ss.ff of a frame at fps */
export function timecode(frame: number, fps: number): string {
  const s = frame / (fps || 30);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex');

/** Size and mtime of every local media file the project references: a replaced image must not hit the old cache. */
function mediaPrint(p: MglProject): string {
  const assets = ((p.data as { assets?: { src?: string }[] }).assets ?? []);
  return assets.map((a) => {
    const src = a.src ?? '';
    if (!src || /^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return src; // urls: fetched (and cached) by the media layer
    try { const st = statSync(resolve(p.dir, src)); return `${src}:${st.size}:${Math.round(st.mtimeMs)}`; } catch { return `${src}:missing`; }
  }).join('|');
}

/**
 * One open project per file, reopened when its bytes or its media change (open() loads plugins: not free). `hash`
 * covers the project file and its media: the still cache key.
 */
const opened = new Map<string, { file: string; media: string; hash: string; p: MglProject }>();
async function openCached(projectPath: string): Promise<{ hash: string; p: MglProject }> {
  const file = resolve(projectPath);
  if (!existsSync(file)) fail('E_NO_PROJECT', `project ${projectPath} does not exist.`, 'create it (mgl new video.mgl.json), or fix the board\'s "project" path.');
  const fileHash = sha1(readFileSync(file));
  const hit = opened.get(file);
  if (hit && hit.file === fileHash && hit.media === mediaPrint(hit.p)) return hit;
  const p = await open(file);
  const media = mediaPrint(p);
  const entry = { file: fileHash, media, hash: media ? sha1(Buffer.from(fileHash + '\n' + media)) : fileHash, p };
  opened.set(file, entry);
  return entry;
}

export interface StillResult { path: string; ms: number; cached: boolean; frame: number; comp: string; width: number; height: number }

const inflight = new Map<string, Promise<StillResult>>();

/**
 * A still of the project at `t` (any edge time form), `width` px wide, as a PNG in <dir>/.mgl/board/stills.
 * Cache key: project content hash (file and the media it references) + comp + frame + width. Renders through renderStills at a scale (no ffmpeg needed
 * unless the frame shows media). `cacheDir` defaults to the project's folder's .mgl/board/stills.
 */
export async function renderStill(projectPath: string, o: { t: TimeLike; comp?: string; width?: number; cacheDir?: string }): Promise<StillResult> {
  const t0 = performance.now();
  const { hash, p } = await openCached(projectPath);
  const comp = resolveComp(p.data, o.comp);
  const frame = parseTime(o.t, parseRate(comp.fps), 'still time');
  const [W, H] = comp.size;
  const width = Math.max(16, Math.min(Math.round(o.width ?? THUMB_W), W)); // never more pixels than the comp has
  const height = Math.max(2, Math.round((H * width) / W));
  const dir = o.cacheDir ?? join(boardCacheDir(projectPath), 'stills');
  const path = join(dir, `${hash.slice(0, 12)}-${comp.id}-${frame}-${width}.png`);
  const done = (cached: boolean): StillResult => ({ path, ms: Math.round(performance.now() - t0), cached, frame, comp: comp.id, width, height });
  if (existsSync(path)) return done(true);
  const running = inflight.get(path);
  if (running) return { ...(await running), cached: true };
  const job = (async () => {
    const [still] = await renderStills(p.data, { baseDir: p.dir, registry: p.registry, comp: comp.id, frames: [frame], scale: width / W });
    const img = still!.image;
    const cv = createCanvas(img.width, img.height);
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.width * img.height * 4), img.width, img.height), 0, 0);
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, await cv.encode('png'));
    renameSync(tmp, path);
    return done(false);
  })();
  inflight.set(path, job);
  try { return await job; } finally { inflight.delete(path); }
}

/** The latest round that is not dropped: the round spend is charged to. */
export function currentRound(b: BoardFile): string | undefined {
  return [...(b.rounds ?? [])].reverse().find((r) => r.status !== 'dropped')?.id;
}

/** Append a spend row through the session; returns it with its id. */
export async function recordSpend(s: BoardSession, e: Omit<SpendEntry, 'id' | 'round'>, by: Who): Promise<SpendEntry> {
  const round = currentRound(s.board);
  const op = { op: 'spend.add' as const, level: e.level, what: e.what, ms: Math.round(e.ms), ...(round ? { round } : {}) };
  const r = await s.apply([op], by);
  return { id: r.created[0] ?? '', level: e.level, what: e.what, ms: op.ms, ...(round ? { round } : {}) };
}

/** "1s-3s", "0:01-0:03.5", "30-90" → [a, b] (times are never negative, so the first "-" splits). */
export function parseRange(range: string): [string | number, string | number] {
  const i = range.indexOf('-');
  const a = range.slice(0, i).trim(), b = range.slice(i + 1).trim();
  if (i <= 0 || !a || !b) fail('E_RANGE', `"${range}" is not a range.`, 'write start-end, e.g. --range 2s-6s or --range 60-180 (frames).');
  const num = (x: string) => (/^\d+$/.test(x) ? Number(x) : x);
  return [num(a), num(b)];
}

/** next free <prefix>-<n><ext> in dir */
function nextName(dir: string, prefix: string, ext: string): string {
  mkdirSync(dir, { recursive: true });
  const re = new RegExp(`^${prefix}-(\\d+)\\${ext}$`);
  const n = Math.max(0, ...readdirSync(dir).map((f) => Number(re.exec(f)?.[1] ?? 0))) + 1;
  return join(dir, `${prefix}-${n}${ext}`);
}

export interface RenderLevelOptions {
  level: 1 | 2 | 3 | 4;
  /** still shape ids: level 1 renders them, level 2 puts their times on the sheet */
  ids?: string[];
  /** level 3/4: "a-b" in any edge time form */
  range?: string;
  onEstimate?(e: Estimate): void;
  /** who asked (spend rows); default ai */
  by?: Who;
  /** the server's open session (default: open one on the board file) */
  session?: BoardSession;
  /** how spend rows are written (the server serialises them with its other writes); default recordSpend on the session */
  record?(e: Omit<SpendEntry, 'id' | 'round'>, by: Who): Promise<SpendEntry>;
  /** how the result shape (sheet image, render poster) is added; default a shape.add on the session. Returns its id */
  addShape?(shape: Record<string, unknown>, by: Who): Promise<string>;
}

/** L2: the sheet's QA summary; L3/L4: where the person can watch it. */
export interface RenderLevelResult { files: string[]; ms: number; spend: SpendEntry[]; estimate?: Estimate; cached?: number; shape?: string; summary?: { findings: number; errors: number; lufs?: number; frames: number } }

/** Width and height of a PNG from its header (0, 0 when it is not one). */
function pngSize(file: string): [number, number] {
  try { const b = readFileSync(file); return b.length > 24 && b.readUInt32BE(12) === 0x49484452 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : [0, 0]; } catch { return [0, 0]; }
}

/** An image shape for a rendered file, on the board (the person sees every rung that was paid for). */
function resultShape(boardPath: string, png: string, label: string, round: string | undefined, kind: string, width = 360): Record<string, unknown> {
  const [w, h] = pngSize(png);
  const src = relative(dirname(resolve(boardPath)), png).split(/[\\/]/).join('/');
  return { type: 'image', src, w: width, h: w && h ? Math.round((width * h) / w) : Math.round(width * 0.75), label, tags: [kind, ...(round ? [round] : [])] };
}

/** A variant still's project (BOARD.md: options pictured as sibling projects), absolute; refused outside the board folder. */
export function variantProject(boardPath: string, rel: string): string {
  const dir = dirname(resolve(boardPath));
  const abs = resolve(dir, rel);
  const d = relative(dir, abs);
  if (!rel.endsWith('.mgl.json') || !d || d.startsWith('..') || resolve(d) === d) fail('E_VARIANT', `variant "${rel}" is not a .mgl.json inside the board's folder.`, 'make the variant next to the board: mgl new shorts ... -o calm.mgl.json, then still.add 1s project=calm.mgl.json');
  if (!existsSync(abs)) fail('E_VARIANT', `variant project ${rel} does not exist.`, `create it next to the board (e.g. copy the project and change it: mgl edit ${rel} ...).`);
  return abs;
}

export interface LevelEstimate { level: number; seconds: number; note: string; stills?: number; cached?: number }

/** What a render at `level` would cost, without rendering (render --dry-run): 3/4 use the render estimator. */
export async function estimateLevel(file: string, o: { level: 1 | 2 | 3 | 4; ids?: string[]; range?: string; session?: BoardSession }): Promise<LevelEstimate> {
  const s = o.session ?? (await BoardSession.open(resolveBoardPath(file).boardPath));
  const projectPath = linkedProject(s.boardPath, s.board.project, s.projectPath);
  if (!projectPath) fail('E_NO_PROJECT', `board ${basename(s.boardPath)} has no linked project.`, 'open the board through its project (mgl board serve video.mgl.json), which links it.');
  const { hash, p } = await openCached(projectPath);
  if (o.level === 1) {
    const stills = (s.board.shapes ?? []).filter((x): x is StillShape => x.type === 'still' && (!o.ids?.length || o.ids.includes(x.id)));
    const dir = join(boardCacheDir(s.boardPath), 'stills');
    let cached = 0;
    for (const sh of stills) {
      if (sh.project) continue;
      try {
        const comp = resolveComp(p.data, sh.comp);
        const frame = parseTime(sh.t, parseRate(comp.fps), 'still time');
        if (existsSync(join(dir, `${hash.slice(0, 12)}-${comp.id}-${frame}-${Math.min(stillWidth(sh.fidelity, comp.size[0]), comp.size[0])}.png`))) cached++;
      } catch { /* counted as a miss */ }
    }
    const seconds = (stills.length - cached) * 0.3;
    return { level: 1, seconds, stills: stills.length, cached, note: `est. ≈${seconds.toFixed(1)} s (frames: ${stills.length} still${stills.length === 1 ? '' : 's'}, ${cached} cached, ≈0.05-0.5 s each)` };
  }
  if (o.level === 2) return { level: 2, seconds: 6, note: 'est. ≈2-10 s (sheet: a contact sheet, QA findings and a sound report)' };
  const comp = resolveComp(p.data);
  const rate = parseRate(comp.fps);
  const range = o.range ? parseRange(o.range) : undefined;
  const e = await estimateRender(p.data, { baseDir: p.dir, registry: p.registry, comp: comp.id, quality: o.level === 3 ? 'draft' : 'final', ...(range ? { range: [parseTime(range[0], rate, 'range start'), parseTime(range[1], rate, 'range end')] as [number, number] } : {}) });
  return { level: o.level, seconds: e.seconds, note: e.note };
}

/** Climb the ladder: 1 stills, 2 contact sheet (look), 3 draft render, 4 final render. Records spend. */
export async function renderLevel(file: string, o: RenderLevelOptions): Promise<RenderLevelResult> {
  if (![1, 2, 3, 4].includes(o.level)) fail('E_LEVEL', `level ${String(o.level)} is not a render level.`, 'use --level 1 (stills), 2 (sheet), 3 (draft) or 4 (final); level 0 is the board itself.');
  const t0 = performance.now();
  const s = o.session ?? (await BoardSession.open(resolveBoardPath(file).boardPath));
  const by = o.by ?? 'ai';
  const rec = (e: Omit<SpendEntry, 'id' | 'round'>) => (o.record ? o.record(e, by) : recordSpend(s, e, by));
  const add = async (shape: Record<string, unknown>): Promise<string> => (o.addShape ? o.addShape(shape, by) : (await s.apply([{ op: 'shape.add', shape: shape as never }], by)).created[0] ?? '');
  const projectPath = linkedProject(s.boardPath, s.board.project, s.projectPath);
  if (!projectPath) fail('E_NO_PROJECT', `board ${basename(s.boardPath)} has no linked project.`, 'open the board through its project (mgl board serve video.mgl.json), which links it.');
  const cache = boardCacheDir(s.boardPath);
  const all: Shape[] = s.board.shapes ?? [];
  const stills = all.filter((x): x is StillShape => x.type === 'still');
  const picked = o.ids?.length ? o.ids.map((id) => {
    const sh = all.find((x) => x.id === id);
    if (!sh || sh.type !== 'still') fail('E_BOARD_ID', `"${id}" is not a still on the board.`, `use the id of a still shape (${stills.map((x) => x.id).slice(0, 6).join(', ') || 'none yet: mgl board edit <file> still.add t=2s'}).`);
    return sh as StillShape;
  }) : stills;
  const spend: SpendEntry[] = [];
  const files: string[] = [];
  if (o.level === 1) {
    if (!picked.length) fail('E_NO_STILLS', 'the board has no stills to render.', 'add one: mgl board edit <file> still.add t=2s (or storyboard.make every=3s).');
    let missMs = 0, cached = 0;
    const missed: string[] = [];
    for (const sh of picked) {
      const proj = sh.project ? variantProject(s.boardPath, sh.project) : projectPath;
      const { p } = await openCached(proj);
      const comp = resolveComp(p.data, sh.comp);
      const r = await renderStill(proj, { t: sh.t, ...(sh.comp ? { comp: sh.comp } : {}), width: stillWidth(sh.fidelity, comp.size[0]), cacheDir: join(cache, 'stills') });
      files.push(r.path);
      if (r.cached) cached++; else { missMs += r.ms; missed.push(sh.id); }
    }
    const variants = [...new Set(picked.filter((x) => x.project && missed.includes(x.id)).map((x) => x.project!))];
    if (missed.length) spend.push(await rec({ level: 1, what: `still ${missed.slice(0, 8).join(',')}${missed.length > 8 ? ` +${missed.length - 8}` : ''}${variants.length ? ` (variant ${variants.slice(0, 3).join(', ')})` : ''}`, ms: missMs }));
    return { files, ms: Math.round(performance.now() - t0), spend, cached };
  }
  const { p } = await openCached(projectPath);
  if (o.level === 2) {
    const at = o.ids?.length ? picked.map((x) => x.t) : undefined;
    const r = await p.look({ ...(at ? { at } : {}), cuts: !at });
    const out = nextName(join(cache, 'sheets'), 'sheet', '.png');
    copyFileSync(r.sheet, out);
    const json = out.replace(/\.png$/, '.json');
    writeFileSync(json, JSON.stringify({ frames: r.frames, findings: r.findings, ...(r.sound ? { sound: r.sound } : {}) }) + '\n');
    files.push(out, json);
    const ms = performance.now() - t0;
    const sp = await rec({ level: 2, what: `sheet ${basename(out)} (${r.frames.length} frames)`, ms });
    spend.push(sp);
    const summary = { findings: r.findings.length, errors: r.findings.filter((f) => f.severity === 'error').length, frames: r.frames.length, ...(r.sound ? { lufs: r.sound.integrated } : {}) };
    const qa = `QA ${summary.findings} finding${summary.findings === 1 ? '' : 's'}${r.sound ? ` · ${Math.round(r.sound.integrated)} LUFS` : ''}`;
    const shape = await add(resultShape(s.boardPath, out, `${basename(out, '.png')} · L2 sheet · ${qa}${sp.round ? ` · ${sp.round}` : ''}`, sp.round, 'sheet', 480));
    return { files, ms: Math.round(ms), spend, shape, summary };
  }
  const out = nextName(join(cache, 'renders'), o.level === 3 ? 'draft' : 'final', '.mp4');
  let estimate: Estimate | undefined;
  const range = o.range ? parseRange(o.range) : undefined;
  const r0 = performance.now();
  await p.render(out, { quality: o.level === 3 ? 'draft' : 'final', ...(range ? { range } : {}), onEstimate: (e) => { estimate = e as Estimate; o.onEstimate?.(e as Estimate); } });
  const ms = performance.now() - r0;
  files.push(out);
  const sp = await rec({ level: o.level, what: `${o.level === 3 ? 'draft' : 'final'} ${basename(out)}${o.range ? ` ${o.range}` : ''}`, ms });
  spend.push(sp);
  // a poster still (the middle of what was rendered) on the board, linked to the file: the person sees what was spent
  let shape: string | undefined;
  try {
    const comp = resolveComp(p.data);
    const rate = parseRate(comp.fps);
    const [a, b] = range ? [parseTime(range[0], rate, 'range start'), parseTime(range[1], rate, 'range end')] : [0, Math.max(1, compLength(p.data, comp.id))];
    const st = await renderStill(projectPath, { t: Math.floor((a + b) / 2), width: Math.round(comp.size[0] / 4), cacheDir: join(cache, 'stills') });
    const poster = out.replace(/\.mp4$/, '.png');
    copyFileSync(st.path, poster);
    files.push(poster);
    const url = '/files/renders/' + basename(out);
    shape = await add(resultShape(s.boardPath, poster, `${basename(out)} · L${o.level} ${o.level === 3 ? 'draft' : 'final'} · ${url}${sp.round ? ` · ${sp.round}` : ''}`, sp.round, 'render', 300));
  } catch { /* the render itself succeeded; the poster is a convenience */ }
  return { files, ms: Math.round(performance.now() - t0), spend, ...(estimate ? { estimate } : {}), ...(shape ? { shape } : {}) };
}
