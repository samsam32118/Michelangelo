/**
 * The board as a PNG, drawn by Skia with the same draw code the page uses (src/board/shared/shapes.ts), so an agent
 * can look at the board without a browser. Stills are rendered (cached) and captioned with timecode + visible clips.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { fail } from '../../core/errors.js';
import { parseRate, parseTime } from '../../core/time.js';
import { registerFonts } from '../../render/text.js';
import type { Ctx2D, DrawEnv } from '../shared/canvas.js';
import type { BoardFile, Outline, Shape, StillShape, Who } from '../shared/types.js';
import { drawBoard, shapeBounds } from '../shared/shapes.js';
import { BoardSession, clipsAt, loadBoard, projectOutline, resolveBoardPath } from '../model/index.js';
import { boardCacheDir, IMAGE_EXT, linkedProject, safeJoin } from './paths.js';
import { recordSpend, renderStill, stillWidth } from './render.js';

export const SNAPSHOT_MAX = 1568;
const PAD = 40;
export const LIGHT_BG = '#ffffff';

type Box = { x: number; y: number; w: number; h: number };
const union = (bs: Box[]): Box | undefined => {
  if (!bs.length) return undefined;
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  return { x: x0, y: y0, w: Math.max(...bs.map((b) => b.x + b.w)) - x0, h: Math.max(...bs.map((b) => b.y + b.h)) - y0 };
};

/** m:ss.ff of a frame at fps */
export function timecode(frame: number, fps: number): string {
  const s = frame / (fps || 30);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** frame of a still's time in the outline's comp (undefined if it does not parse) */
export function stillFrame(o: Outline, sh: StillShape): { comp: string; frame: number; fps: number } | undefined {
  const comp = o.comps.find((c) => c.id === (sh.comp ?? o.main)) ?? o.comps[0];
  if (!comp) return undefined;
  try { return { comp: comp.id, frame: parseTime(sh.t, parseRate(comp.fps), 'still time'), fps: comp.fps }; } catch { return undefined; }
}

export interface SnapshotOptions { out?: string; frame?: string; ids?: string[]; by?: Who }
export interface SnapshotResult { path: string; width: number; height: number; ms: number; warnings?: string[] }

export async function snapshotBoard(file: string, o: SnapshotOptions = {}): Promise<SnapshotResult> {
  const t0 = performance.now();
  const { boardPath, projectPath: given } = resolveBoardPath(file);
  const board: BoardFile = await loadBoard(boardPath);
  const shapes: Shape[] = board.shapes ?? [];
  const byId = new Map(shapes.map((s) => [s.id, s] as const));
  const lookup = (id: string): Shape | undefined => byId.get(id);
  const bounds = (s: Shape): Box => shapeBounds(s, lookup);
  const pick = (id: string): Shape => byId.get(id) ?? fail('E_BOARD_ID', `"${id}" is not a shape on the board.`, `use a shape id (${shapes.map((s) => s.id).slice(0, 6).join(', ') || 'the board is empty'}).`);
  let region: Box | undefined;
  if (o.frame) {
    const f = pick(o.frame);
    if (f.type !== 'frame') fail('E_BOARD_ID', `"${o.frame}" is a ${f.type}, not a frame.`, `use a frame id (${shapes.filter((s) => s.type === 'frame').map((s) => s.id).slice(0, 6).join(', ') || 'none yet'}), or --ids to snapshot shapes.`);
    region = bounds(f);
  } else if (o.ids?.length) region = union(o.ids.map((id) => bounds(pick(id))));
  else region = union(shapes.map(bounds));
  region ??= { x: 0, y: 0, w: 800, h: 500 };
  const r = { x: region.x - PAD, y: region.y - PAD, w: region.w + 2 * PAD, h: region.h + 2 * PAD };
  const scale = Math.min(2, SNAPSHOT_MAX / Math.max(r.w, r.h));
  const width = Math.max(1, Math.min(SNAPSHOT_MAX, Math.round(r.w * scale))), height = Math.max(1, Math.min(SNAPSHOT_MAX, Math.round(r.h * scale)));
  const inRegion = (s: Shape) => { const b = bounds(s); return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y; };

  // images: stills through the still cache, image shapes from files under the board's folder
  const warnings: string[] = [];
  const images = new Map<string, unknown>();
  const captions = new Map<string, string>();
  const projectPath = linkedProject(boardPath, board.project, given);
  let outline: Outline | null = null;
  if (projectPath) { try { outline = await projectOutline(projectPath); } catch (e) { warnings.push(`project: ${(e as Error).message}`); } }
  let missMs = 0;
  const missed: string[] = [];
  for (const s of shapes.filter(inRegion)) {
    try {
      if (s.type === 'still' && projectPath && outline) {
        const at = stillFrame(outline, s);
        if (at) captions.set(s.id, `${timecode(at.frame, at.fps)}  ${clipsAt(outline, at.comp, at.frame).join(', ')}`.trim());
        const compW = outline.comps.find((c) => c.id === at?.comp)?.size[0] ?? 1080;
        const st = await renderStill(projectPath, { t: s.t, ...(s.comp ? { comp: s.comp } : {}), width: stillWidth(s.fidelity, compW), cacheDir: join(boardCacheDir(boardPath), 'stills') });
        if (!st.cached) { missMs += st.ms; missed.push(s.id); }
        images.set(s.id, await loadImage(st.path));
      } else if (s.type === 'image') {
        const abs = safeJoin(dirname(boardPath), s.src);
        if (!abs || !IMAGE_EXT.has(abs.slice(abs.lastIndexOf('.')).toLowerCase())) { warnings.push(`${s.id}: ${s.src} is not an image under the board's folder`); continue; }
        images.set(s.id, await loadImage(abs));
      }
    } catch (e) { warnings.push(`${s.id}: ${(e as Error).message}`); }
  }
  if (missed.length) {
    try { const sess = await BoardSession.open(boardPath); await recordSpend(sess, { level: 1, what: `still ${missed.slice(0, 8).join(',')} (snapshot)`, ms: missMs }, o.by ?? 'ai'); } catch (e) { warnings.push(`spend: ${(e as Error).message}`); }
  }

  registerFonts();
  const cv = createCanvas(width, height);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = LIGHT_BG;
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(scale, 0, 0, scale, -r.x * scale, -r.y * scale);
  const env: DrawEnv = {
    zoom: scale,
    theme: 'light',
    image: (id) => images.get(id),
    bounds: (id) => { const s = byId.get(id); return s ? bounds(s) : undefined; },
    stillCaption: (id) => captions.get(id),
  };
  drawBoard(ctx as unknown as Ctx2D, shapes.filter(inRegion), env);
  const out = resolve(o.out ?? join(boardCacheDir(boardPath), 'snapshot.png'));
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, await cv.encode('png'));
  renameSync(tmp, out);
  return { path: out, width, height, ms: Math.round(performance.now() - t0), ...(warnings.length ? { warnings } : {}) };
}
