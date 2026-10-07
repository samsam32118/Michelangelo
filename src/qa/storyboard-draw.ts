/**
 * Storyboard images (Skia). Level 1: a row of scene tiles (mid frame, or a note card for an idea) with a two-line
 * label, then a thin strip of the six lanes across the full width. Level 2: one scene's three moments and each
 * visual lane alone. Pure drawing: the frames come in rendered.
 */
import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas';
import type { RGBAFrame } from '../render/types.js';
import { LANES, type Lane, type Storyboard, type StoryScene } from './storyboard.js';

export const SHEET_MAX = 1568;
/** At most this many tiles per row; tiles never taller than TILE_MAX_H. */
export const ROW_MAX = 12;
const PAD = 6, LABEL2 = 34, LANE_ROW = 15, HEAD = 16, NAME_W = 76, TILE_MAX_H = 640, STRIP_MIN_W = 960, LABEL_H = 18, TITLE_H = 24;
export const STRIP_H = HEAD + LANES.length * LANE_ROW + 4;

/** One set for the image (dark) and the page (light or dark): mid tones that read on both. */
export const LANE_COLOURS: Record<Lane, string> = { picture: '#4e8cff', graphics: '#b565f0', captions: '#e0a400', voice: '#06b98a', music: '#e8436a', sfx: '#f08a00' };
const BG = '#16161a', FG = '#e8e8ec', DIM = '#8a8a96', WARN = '#ffb020', CHANGED = '#3fa9ff', IDEA = '#ffd166';
const FONT = (px: number, bold = false) => `${bold ? 'bold ' : ''}${px}px "Inter", "JetBrains Mono", sans-serif`;

export type Pic = RGBAFrame | Canvas;
type Ctx = ReturnType<Canvas['getContext']>;

export function toCanvas(img: Pic): Canvas {
  if ('getContext' in img) return img;
  const cv = createCanvas(img.width, img.height);
  const data = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.width * img.height * 4);
  cv.getContext('2d').putImageData(new ImageData(data, img.width, img.height), 0, 0);
  return cv;
}

/** A copy scaled to fit w × h (never enlarged). */
export function fitPic(img: Pic, w: number, h: number): Canvas {
  const src = toCanvas(img), k = Math.min(1, w / src.width, h / src.height);
  if (k >= 1) return src;
  const out = createCanvas(Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/** `data:` URL of a picture fitted to w × h: JPEG, or WebP when it must keep transparency. */
export async function dataUrl(img: Pic, w: number, h: number, alpha = false): Promise<string> {
  const cv = fitPic(img, w, h);
  return alpha ? `data:image/webp;base64,${(await cv.encode('webp', 75)).toString('base64')}` : `data:image/jpeg;base64,${(await cv.encode('jpeg', 72)).toString('base64')}`;
}

const secs = (f: number, fps: number) => (f / fps).toFixed(1);
export const rangeOf = (at: number, len: number, fps: number) => `${secs(at, fps)}–${secs(at + len, fps)}s`;
/** idea, ⚠ (issues), ● (changed): at most two, in that order. */
export const marksOf = (s: StoryScene): ('idea' | 'issue' | 'changed')[] => ([s.idea ? 'idea' : '', s.findings.length ? 'issue' : '', s.changed ? 'changed' : ''].filter(Boolean) as ('idea' | 'issue' | 'changed')[]).slice(0, 2);

/** `s` cut with "…" to fit `w` px in the current font. */
function fit(ctx: Ctx, s: string, w: number): string {
  if (ctx.measureText(s).width <= w) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, m).trimEnd() + '…').width <= w) lo = m; else hi = m - 1; }
  return lo ? s.slice(0, lo).trimEnd() + '…' : '';
}

/** Draw the marks at (x, middle y); returns the width used. Shapes, not glyphs: the bundled fonts lack ⚠ and ●. */
function drawMarks(ctx: Ctx, marks: ReturnType<typeof marksOf>, x: number, y: number, px: number): number {
  let cx = x;
  for (const m of marks) {
    if (m === 'issue') {
      ctx.fillStyle = WARN;
      ctx.beginPath(); ctx.moveTo(cx + px / 2, y - px / 2); ctx.lineTo(cx + px, y + px / 2); ctx.lineTo(cx, y + px / 2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#000'; ctx.fillRect(cx + px / 2 - 0.75, y - px / 6, 1.5, px / 3); ctx.fillRect(cx + px / 2 - 0.75, y + px / 4, 1.5, 1.5);
      cx += px + 4;
    } else if (m === 'changed') {
      ctx.fillStyle = CHANGED;
      ctx.beginPath(); ctx.arc(cx + px / 2, y, px / 2.4, 0, Math.PI * 2); ctx.fill();
      cx += px + 4;
    } else {
      ctx.font = FONT(px - 1, true); ctx.fillStyle = IDEA; ctx.textAlign = 'left';
      ctx.fillText('idea', cx, y); cx += ctx.measureText('idea').width + 5;
    }
  }
  return cx - x;
}

/**
 * The grid of scene tiles (≤ 12 per row, tiles ≤ 640 px tall, long edge ≤ max): the fewest rows whose tiles are at
 * least 60% of the largest possible, so a few scenes read as one row.
 */
export function storyLayout(count: number, W: number, H: number, max = SHEET_MAX): { cols: number; rows: number; tileW: number; tileH: number; width: number; height: number; scale: number } {
  const n = Math.max(1, count);
  const opts: { cols: number; rows: number; scale: number }[] = [];
  for (let rows = Math.ceil(n / ROW_MAX); rows <= n; rows++) {
    const cols = Math.ceil(n / rows);
    if (opts.length && opts[opts.length - 1]!.cols === cols) continue;
    opts.push({ cols, rows: Math.ceil(n / cols), scale: Math.min((max - PAD * (cols + 1)) / cols / W, (max - STRIP_H - PAD * (rows + 2) - LABEL2 * rows) / rows / H, TILE_MAX_H / H) });
  }
  const top = Math.max(...opts.map((o) => o.scale)), best = opts.find((o) => o.scale >= top * 0.6)!;
  const tileW = Math.max(2, Math.floor(W * best.scale)), tileH = Math.max(2, Math.floor(H * best.scale));
  const width = Math.min(max, Math.max(best.cols * tileW + PAD * (best.cols + 1), STRIP_MIN_W));
  return { ...best, tileW, tileH, scale: tileW / W, width, height: best.rows * (tileH + LABEL2) + PAD * (best.rows + 2) + STRIP_H };
}

/** An idea scene: a note card with its words. */
function noteCard(ctx: Ctx, s: StoryScene, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = '#2b2a1f'; ctx.fillRect(x, y, w, h);
  ctx.save(); ctx.strokeStyle = IDEA; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(x + 1, y + 1, w - 2, h - 2); ctx.restore();
  const px = Math.max(10, Math.min(22, Math.round(w / 9)));
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = IDEA; ctx.font = FONT(px, true);
  ctx.fillText(s.pastEnd ? 'idea · not rendered' : 'idea', x + 8, y + 8, w - 16);
  ctx.font = FONT(px); ctx.fillStyle = FG;
  const lines: string[] = [];
  let cur = '';
  for (const word of s.label.split(/\s+/)) { const c = cur ? `${cur} ${word}` : word; if (cur && ctx.measureText(c).width > w - 16) { lines.push(cur); cur = word; } else cur = c; }
  if (cur) lines.push(cur);
  const room = Math.max(1, Math.floor((h - px * 2 - 16) / (px * 1.3)));
  lines.slice(0, room).forEach((l, i) => ctx.fillText(fit(ctx, i === room - 1 && lines.length > room ? l + '…' : l, w - 16), x + 8, y + 16 + px * 1.4 + i * px * 1.3));
  ctx.textBaseline = 'middle';
}

/**
 * The lane strip: lane names at the left, one block per clip (per cue on captions) scaled to time, overlapping tracks
 * in thin rows, transitions as dark wedges, "none" on an empty lane; scene columns tinted alternately with their
 * numbers; point markers as ticks; the end of the video as a line, ideas after it hatched.
 */
export function drawLanes(ctx: Ctx, sb: Storyboard, x: number, y: number, w: number): void {
  // to the end of the last scene: an idea scene past the end of the video still gets its column
  const L = Math.max(1, sb.length, ...sb.scenes.map((s) => s.at + s.len)), tx = x + NAME_W, tw = Math.max(1, w - NAME_W), X = (f: number) => tx + (Math.min(L, Math.max(0, f)) / L) * tw;
  ctx.fillStyle = '#1e1e24'; ctx.fillRect(x, y, w, STRIP_H);
  ctx.textBaseline = 'middle'; ctx.font = FONT(11, true);
  sb.scenes.forEach((s, i) => {
    const a = X(s.at), b = X(s.at + s.len), m = marksOf(s);
    if (i % 2) { ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(a, y, b - a, STRIP_H); }
    if (m.includes('issue')) { ctx.fillStyle = 'rgba(255,176,32,0.25)'; ctx.fillRect(a, y, b - a, HEAD); }
    else if (m.includes('changed')) { ctx.fillStyle = 'rgba(63,169,255,0.25)'; ctx.fillRect(a, y, b - a, HEAD); }
    ctx.fillStyle = 'rgba(232,232,236,0.28)'; ctx.fillRect(Math.round(a), y, 1, STRIP_H);
    if (b - a >= 12) { ctx.fillStyle = FG; ctx.textAlign = 'center'; ctx.fillText(String(s.n), (a + b) / 2, y + HEAD / 2, b - a - 2); }
  });
  if (L > sb.length) {
    const e = X(sb.length);
    ctx.save(); ctx.beginPath(); ctx.rect(e, y + HEAD, tx + tw - e, STRIP_H - HEAD); ctx.clip(); ctx.strokeStyle = 'rgba(255,209,102,0.25)'; ctx.lineWidth = 1;
    for (let k = -STRIP_H; k < tx + tw - e; k += 6) { ctx.beginPath(); ctx.moveTo(e + k, y + STRIP_H); ctx.lineTo(e + k + STRIP_H, y); ctx.stroke(); }
    ctx.restore();
    ctx.fillStyle = FG; ctx.fillRect(Math.round(e), y, 2, STRIP_H);
  }
  for (const p of sb.points) { const px = Math.round(X(p.at)); ctx.fillStyle = WARN; ctx.fillRect(px, y, 1, STRIP_H); ctx.beginPath(); ctx.moveTo(px - 4, y); ctx.lineTo(px + 4, y); ctx.lineTo(px, y + 5); ctx.fill(); }
  LANES.forEach((lane, i) => {
    const ly = y + HEAD + i * LANE_ROW, spans = sb.lanes[lane];
    ctx.fillStyle = spans.length ? LANE_COLOURS[lane] : DIM; ctx.beginPath(); ctx.arc(x + 9, ly + LANE_ROW / 2, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.font = FONT(11); ctx.textAlign = 'left'; ctx.fillStyle = spans.length ? FG : DIM;
    ctx.fillText(lane, x + 17, ly + LANE_ROW / 2, NAME_W - 20);
    if (!spans.length) {
      ctx.fillStyle = DIM; ctx.font = FONT(10); ctx.fillText('none', tx + 4, ly + LANE_ROW / 2);
      ctx.save(); ctx.strokeStyle = 'rgba(138,138,150,0.5)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(tx + 32, ly + LANE_ROW / 2); ctx.lineTo(tx + tw, ly + LANE_ROW / 2); ctx.stroke(); ctx.restore();
      return;
    }
    const rows = Math.max(1, ...spans.map((b) => b.row + 1)), rh = (LANE_ROW - 3) / rows;
    for (const sp of spans) {
      const a = X(sp.at), b = X(sp.at + sp.len), by = ly + 1.5 + sp.row * rh, bw = Math.max(1.5, b - a - 1), bh = Math.max(1, rh - (rows > 1 ? 1 : 0));
      ctx.globalAlpha = sp.faded ? 0.35 : 1; ctx.fillStyle = LANE_COLOURS[lane]; ctx.fillRect(a, by, bw, bh);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      for (const [t, left] of [[sp.tin, true], [sp.tout, false]] as const) {
        if (!t) continue;
        const tw2 = Math.min(bw / 2, (t / L) * tw), ex = left ? a : a + bw;
        ctx.beginPath(); ctx.moveTo(ex, by); ctx.lineTo(ex, by + bh); ctx.lineTo(left ? ex + tw2 : ex - tw2, by + bh); ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  });
}

/** Level 1: the scene tiles (keyed by scene number) and the lane strip, long edge ≤ max. */
export function drawStoryboard(sb: Storyboard, tiles: Map<number, Pic>, o: { max?: number; onTile?: (ctx: Ctx, x: number, y: number, w: number, h: number) => void } = {}): { canvas: Canvas; layout: ReturnType<typeof storyLayout> } {
  const [W, H] = sb.size, lay = storyLayout(sb.scenes.length, W, H, o.max ?? SHEET_MAX);
  const cv = createCanvas(lay.width, lay.height), ctx = cv.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, lay.width, lay.height);
  const x0 = Math.max(PAD, Math.floor((lay.width - (lay.cols * lay.tileW + PAD * (lay.cols - 1))) / 2));
  ctx.textBaseline = 'middle';
  sb.scenes.forEach((s, i) => {
    const col = i % lay.cols, row = Math.floor(i / lay.cols);
    const x = x0 + col * (lay.tileW + PAD), y = PAD + row * (lay.tileH + LABEL2 + PAD), pic = tiles.get(s.n);
    if (s.idea) noteCard(ctx, s, x, y, lay.tileW, lay.tileH);
    else if (pic) ctx.drawImage(toCanvas(pic), x, y, lay.tileW, lay.tileH);
    else { ctx.fillStyle = '#24242b'; ctx.fillRect(x, y, lay.tileW, lay.tileH); }
    if (!s.idea) o.onTile?.(ctx, x, y, lay.tileW, lay.tileH);
    const m = marksOf(s);
    if (m.includes('issue')) { ctx.strokeStyle = WARN; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, lay.tileW - 2, lay.tileH - 2); }
    // label: "3 ⚠ ● 5.8–9.1s" then the words
    const ly = y + lay.tileH + 9;
    ctx.textAlign = 'left'; ctx.font = FONT(12, true); ctx.fillStyle = FG;
    const num = String(s.n);
    ctx.fillText(num, x, ly);
    let cx = x + ctx.measureText(num).width + 5;
    cx += drawMarks(ctx, m, cx, ly, 10);
    ctx.font = FONT(11); ctx.fillStyle = DIM;
    ctx.fillText(fit(ctx, rangeOf(s.at, s.len, sb.fps), x + lay.tileW - cx), cx, ly);
    ctx.font = FONT(11); ctx.fillStyle = FG;
    ctx.fillText(fit(ctx, s.label, lay.tileW), x, ly + 15);
  });
  drawLanes(ctx, sb, PAD, lay.height - STRIP_H - PAD, lay.width - 2 * PAD);
  return { canvas: cv, layout: lay };
}

function checker(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = '#2a2a30'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#34343c';
  for (let j = 0; j * 12 < h; j++) for (let i = j % 2; i * 12 < w; i += 2) ctx.fillRect(x + i * 12, y + j * 12, Math.min(12, w - i * 12), Math.min(12, h - j * 12));
}

export interface SceneShots {
  /** start, middle, end of the composite */
  moments: { label: string; image?: Pic }[];
  /** each visual lane alone at the middle (graphics / captions on transparency) */
  solos: { lane: Lane; image?: Pic; empty?: boolean }[];
}

/** The scale level 2 renders at: three tiles across, two rows, long edge ≤ max, tiles ≤ 640 px tall. */
export function sceneScale(W: number, H: number, max = SHEET_MAX): number {
  return Math.min(1, (max - 4 * PAD) / 3 / W, (max - TITLE_H - 2 * LABEL_H - 3 * PAD) / 2 / H, TILE_MAX_H / H);
}

/** Level 2: a title, the composite at three moments, then each visual lane alone at the middle. */
export function drawScene(sb: Storyboard, s: StoryScene, shots: SceneShots, o: { max?: number } = {}): Canvas {
  const [W, H] = sb.size, k = sceneScale(W, H, o.max ?? SHEET_MAX);
  const tw = Math.max(2, Math.floor(W * k)), th = Math.max(2, Math.floor(H * k));
  const width = Math.max(3 * tw + 4 * PAD, 480), height = TITLE_H + 2 * (th + LABEL_H) + 3 * PAD;
  const cv = createCanvas(width, height), ctx = cv.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = FONT(14, true); ctx.fillStyle = FG;
  const head = `scene ${s.n}`;
  ctx.fillText(head, PAD, TITLE_H / 2 + 2);
  let cx = PAD + ctx.measureText(head).width + 6;
  cx += drawMarks(ctx, marksOf(s), cx, TITLE_H / 2 + 2, 12);
  ctx.font = FONT(13); ctx.fillText(fit(ctx, `"${s.label}" ${rangeOf(s.at, s.len, sb.fps)}`, width - cx - PAD), cx, TITLE_H / 2 + 2);
  const x0 = Math.floor((width - (3 * tw + 2 * PAD)) / 2);
  const cell = (row: number, col: number, label: string, pic: Pic | undefined, alpha: boolean, note?: string) => {
    const x = x0 + col * (tw + PAD), y = TITLE_H + PAD + row * (th + LABEL_H + PAD);
    if (alpha) checker(ctx, x, y, tw, th); else { ctx.fillStyle = '#24242b'; ctx.fillRect(x, y, tw, th); }
    if (pic) ctx.drawImage(toCanvas(pic), x, y, tw, th);
    else if (note) { ctx.font = FONT(12); ctx.fillStyle = DIM; ctx.textAlign = 'center'; ctx.fillText(note, x + tw / 2, y + th / 2, tw - 8); ctx.textAlign = 'left'; }
    ctx.font = FONT(12); ctx.fillStyle = FG;
    ctx.fillText(fit(ctx, label, tw), x, y + th + LABEL_H / 2);
  };
  shots.moments.slice(0, 3).forEach((m, i) => cell(0, i, m.label, m.image, false, s.idea ? 'idea: nothing yet' : '—'));
  shots.solos.slice(0, 3).forEach((m, i) => {
    ctx.fillStyle = LANE_COLOURS[m.lane];
    cell(1, i, `${m.lane} alone`, m.image, m.lane !== 'picture', m.empty ? `no ${m.lane} here` : '—');
  });
  return cv;
}
