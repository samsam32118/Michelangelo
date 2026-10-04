/** Text layout with Skia metrics (the same fonts the renderer draws with), and font registration. */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import type { ResolvedTextStyle, TextLayout, TextLayouter } from './types.js';

/** The bundled fonts directory (<package>/fonts), from src/render or dist/render. */
export const BUNDLED_FONTS_DIR = fileURLToPath(new URL('../../fonts', import.meta.url));

const registered = new Set<string>();
const FONT_EXT = new Set(['.ttf', '.otf', '.woff', '.woff2', '.ttc']);

/** Register every font file in the given directories (once per file). Returns the number newly registered. */
export function registerFonts(dirs: string[] = [BUNDLED_FONTS_DIR]): number {
  let n = 0;
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (!FONT_EXT.has(extname(f).toLowerCase()) || registered.has(p)) continue;
      if (GlobalFonts.registerFromPath(p)) { registered.add(p); n++; }
    }
  }
  return n;
}

/** Register a project font asset; its family name is the asset id. */
export function registerFontAsset(path: string, family: string): boolean {
  const key = `${path}\u0000${family}`;
  if (registered.has(key)) return true;
  const ok = !!GlobalFonts.registerFromPath(path, family);
  if (ok) registered.add(key);
  return ok;
}

export function weightOf(w: ResolvedTextStyle['weight']): number {
  return w === 'bold' ? 700 : w === 'normal' ? 400 : Math.round(Number(w) || 400);
}

/** Configure a context's font for a style at a size (variable fonts get their weight axis set). */
export function applyFont(ctx: SKRSContext2D, st: ResolvedTextStyle, size: number): void {
  const w = weightOf(st.weight);
  ctx.font = `${st.italic ? 'italic ' : ''}${w} ${size}px "${st.font}"`;
  (ctx as { fontVariationSettings?: string }).fontVariationSettings = `"wght" ${w}`;
  ctx.letterSpacing = `${(st.letterSpacing ?? 0) * (size / st.size)}px`;
}

export function displayText(text: string, st: ResolvedTextStyle): string {
  return st.uppercase ? text.toUpperCase() : text;
}

const MIN_SIZE = 6;

export function createTextLayouter(): TextLayouter {
  registerFonts();
  const ctx = createCanvas(4, 4).getContext('2d');
  const cache = new Map<string, TextLayout>();

  const wrap = (paras: string[][], maxW: number, measure: (s: string) => number): string[] => {
    const lines: string[] = [];
    for (const words of paras) {
      if (!words.length) { lines.push(''); continue; }
      let cur = '';
      for (const w of words) {
        const cand = cur ? `${cur} ${w}` : w;
        if (cur && measure(cand) > maxW) { lines.push(cur); cur = w; } else cur = cand;
      }
      lines.push(cur);
    }
    return lines;
  };

  const layoutAt = (text: string, st: ResolvedTextStyle, size: number) => {
    applyFont(ctx, st, size);
    const measure = (s: string) => ctx.measureText(s).width;
    const maxW = st.box?.[0] ?? st.maxWidth ?? Infinity;
    const paras = text.split('\n').map((p) => p.split(/[ \t]+/).filter(Boolean));
    const lines = wrap(paras, maxW, measure);
    const widths = lines.map(measure);
    const lh = size * st.lineHeight;
    const fits = (!st.maxLines || lines.length <= st.maxLines)
      && (!Number.isFinite(maxW) || Math.max(0, ...widths) <= maxW + 0.5)
      && (!st.box || lines.length * lh <= st.box[1] + 0.5);
    return { lines, widths, lh, fits, measure };
  };

  const layout = (raw: string, st: ResolvedTextStyle): TextLayout => {
    const text = displayText(raw, st);
    let size = st.size;
    let r = layoutAt(text, st, size);
    while (!r.fits && size > MIN_SIZE) {
      size = Math.max(MIN_SIZE, Math.floor(size * 0.94 * 10) / 10);
      r = layoutAt(text, st, size);
    }
    const m = ctx.measureText('Hg');
    const asc = m.fontBoundingBoxAscent || size * 0.8, desc = m.fontBoundingBoxDescent || size * 0.2;
    const contentW = Math.ceil(Math.max(1, ...r.widths));
    const w = st.box?.[0] ?? contentW;
    const textH = r.lines.length * r.lh;
    const h = st.box?.[1] ?? Math.ceil(textH);
    const top = st.box ? (st.box[1] - textH) / 2 : 0;
    const out: TextLayout = { w, h, lines: [], words: [], size };
    const space = r.measure(' ');
    r.lines.forEach((line, i) => {
      const lw = r.widths[i]!;
      const x = st.align === 'left' ? 0 : st.align === 'right' ? w - lw : (w - lw) / 2;
      const y = top + i * r.lh;
      const baseline = y + (r.lh - (asc + desc)) / 2 + asc;
      out.lines.push({ text: line, x, y, w: lw, baseline });
      let wx = x;
      for (const word of line.split(' ').filter(Boolean)) {
        const ww = r.measure(word);
        out.words.push({ text: word, x: wx, y, w: ww, h: r.lh, line: i });
        wx += ww + space;
      }
    });
    return out;
  };

  return {
    layout(text, st) {
      const key = text + '\u0000' + JSON.stringify(st);
      let l = cache.get(key);
      if (!l) {
        l = layout(text, st);
        if (cache.size > 2000) cache.clear();
        cache.set(key, l);
      }
      return l;
    },
  };
}
