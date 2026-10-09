/**
 * The fidelity ladder through the SDK (BOARD.md §4): stills (cached by project content + request), the look contact
 * sheet, draft and final renders. Every render that was not a cache hit is recorded as a `spend` row.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { fail } from '../../core/errors.js';
import { parseRate, parseTime } from '../../core/time.js';
import { open, type MglProject } from '../../sdk/index.js';
import { renderStills, resolveComp, type Estimate } from '../../render/pipeline.js';
import type { BoardFile, Fidelity, Shape, SpendEntry, StillShape, TimeLike, Who } from '../shared/types.js';
import { BoardSession, resolveBoardPath } from '../model/index.js';
import { boardCacheDir, linkedProject } from './paths.js';

export const THUMB_W = 270;

/** Pixel width of a still at a fidelity, for a comp `compW` wide. */
export const stillWidth = (f: Fidelity | undefined, compW: number): number => (f === 'full' ? compW : f === 'half' ? Math.round(compW / 2) : THUMB_W);

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex');

/** One open project per file, reopened when its bytes change (open() loads plugins: not free). */
const opened = new Map<string, { hash: string; p: MglProject }>();
async function openCached(projectPath: string): Promise<{ hash: string; p: MglProject }> {
  const file = resolve(projectPath);
  if (!existsSync(file)) fail('E_NO_PROJECT', `project ${projectPath} does not exist.`, 'create it (mgl new video.mgl.json), or fix the board\'s "project" path.');
  const hash = sha1(readFileSync(file));
  const hit = opened.get(file);
  if (hit && hit.hash === hash) return hit;
  const entry = { hash, p: await open(file) };
  opened.set(file, entry);
  return entry;
}

export interface StillResult { path: string; ms: number; cached: boolean; frame: number; comp: string; width: number; height: number }

const inflight = new Map<string, Promise<StillResult>>();

/**
 * A still of the project at `t` (any edge time form), `width` px wide, as a PNG in <dir>/.mgl/board/stills.
 * Cache key: project content hash + comp + frame + width. Renders through renderStills at a scale (no ffmpeg needed
 * unless the frame shows media). `cacheDir` defaults to the project's folder's .mgl/board/stills.
 */
export async function renderStill(projectPath: string, o: { t: TimeLike; comp?: string; width?: number; cacheDir?: string }): Promise<StillResult> {
  const t0 = performance.now();
  const { hash, p } = await openCached(projectPath);
  const comp = resolveComp(p.data, o.comp);
  const frame = parseTime(o.t, parseRate(comp.fps), 'still time');
  const [W, H] = comp.size;
  const width = Math.max(16, Math.min(Math.round(o.width ?? THUMB_W), W * 4));
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
}

export interface RenderLevelResult { files: string[]; ms: number; spend: SpendEntry[]; estimate?: Estimate; cached?: number }

/** Climb the ladder: 1 stills, 2 contact sheet (look), 3 draft render, 4 final render. Records spend. */
export async function renderLevel(file: string, o: RenderLevelOptions): Promise<RenderLevelResult> {
  if (![1, 2, 3, 4].includes(o.level)) fail('E_LEVEL', `level ${String(o.level)} is not a render level.`, 'use --level 1 (stills), 2 (sheet), 3 (draft) or 4 (final); level 0 is the board itself.');
  const t0 = performance.now();
  const s = o.session ?? (await BoardSession.open(resolveBoardPath(file).boardPath));
  const by = o.by ?? 'ai';
  const rec = (e: Omit<SpendEntry, 'id' | 'round'>) => (o.record ? o.record(e, by) : recordSpend(s, e, by));
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
    const { p } = await openCached(projectPath);
    let missMs = 0, cached = 0;
    const missed: string[] = [];
    for (const sh of picked) {
      const comp = resolveComp(p.data, sh.comp);
      const r = await renderStill(projectPath, { t: sh.t, ...(sh.comp ? { comp: sh.comp } : {}), width: stillWidth(sh.fidelity, comp.size[0]), cacheDir: join(cache, 'stills') });
      files.push(r.path);
      if (r.cached) cached++; else { missMs += r.ms; missed.push(sh.id); }
    }
    if (missed.length) spend.push(await rec({ level: 1, what: `still ${missed.slice(0, 8).join(',')}${missed.length > 8 ? ` +${missed.length - 8}` : ''}`, ms: missMs }));
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
    spend.push(await rec({ level: 2, what: `sheet ${basename(out)} (${r.frames.length} frames)`, ms }));
    return { files, ms: Math.round(ms), spend };
  }
  const out = nextName(join(cache, 'renders'), o.level === 3 ? 'draft' : 'final', '.mp4');
  let estimate: Estimate | undefined;
  const range = o.range ? parseRange(o.range) : undefined;
  const r0 = performance.now();
  await p.render(out, { quality: o.level === 3 ? 'draft' : 'final', ...(range ? { range } : {}), onEstimate: (e) => { estimate = e as Estimate; o.onEstimate?.(e as Estimate); } });
  const ms = performance.now() - r0;
  files.push(out);
  spend.push(await rec({ level: o.level, what: `${o.level === 3 ? 'draft' : 'final'} ${basename(out)}${o.range ? ` ${o.range}` : ''}`, ms }));
  return { files, ms: Math.round(performance.now() - t0), spend, ...(estimate ? { estimate } : {}) };
}
