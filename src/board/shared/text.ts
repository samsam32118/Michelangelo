/** Text layout with the context's measureText: word wrap (long words broken), ellipsis. Layouts are cached by font. */
import type { Ctx2D } from './canvas.js';

const CACHE_MAX = 4000;
const cache = new Map<string, string[]>();

/** Lines of `text` that fit `maxW` in the context's current font. Explicit newlines are kept. */
export function wrapText(ctx: Pick<Ctx2D, 'measureText' | 'font'>, text: string, maxW: number): string[] {
  const key = `${ctx.font}\u0000${Math.round(maxW)}\u0000${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out: string[] = [];
  const width = (s: string) => ctx.measureText(s).width;
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (!line || width(next) <= maxW) {
        if (!line && width(w) > maxW && !/^\s+$/.test(w)) { line = breakWord(w, maxW, width, out); continue; }
        line = next;
        continue;
      }
      out.push(line.trimEnd());
      if (/^\s+$/.test(w)) { line = ''; continue; }
      line = width(w) > maxW ? breakWord(w, maxW, width, out) : w;
    }
    out.push(line.trimEnd());
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

/** push full chunks of a too-long word, return the remainder */
function breakWord(w: string, maxW: number, width: (s: string) => number, out: string[]): string {
  let cur = '';
  for (const ch of w) {
    if (cur && width(cur + ch) > maxW) { out.push(cur); cur = ch; } else cur += ch;
  }
  return cur;
}

/** `text` cut with … to fit maxW */
export function ellipsize(ctx: Pick<Ctx2D, 'measureText'>, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1; }
  return lo ? text.slice(0, lo).trimEnd() + '…' : '';
}

export function clearTextCache(): void { cache.clear(); }
