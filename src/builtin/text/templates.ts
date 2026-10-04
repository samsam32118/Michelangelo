/**
 * Built-in templates. Each `build` returns plain entities with short ids and a layer name in `track`
 * ("bg", "title", ...): template.apply prefixes the ids and puts each layer on a free visual track,
 * bottom to top in the order the layers first appear. Everything is laid out from the comp size, and on
 * a vertical comp it stays inside the Shorts / TikTok / Reels safe zone.
 */
import { z, defineTemplate, type TemplateDef, type TemplateOutput } from '../../plugin/api.js';

type Clip = NonNullable<TemplateOutput['clips']>[number];
type Args = Parameters<TemplateDef['build']>[0];

/** Safe areas as fractions of the frame. Vertical: the platform UI (buttons right, caption bottom). */
export const SAFE_ZONES = {
  vertical: { x0: 0.06, x1: 0.83, y0: 0.08, y1: 0.78 },
  other: { x0: 0.05, x1: 0.95, y0: 0.05, y1: 0.95 },
} as const;

export interface Rect { x0: number; y0: number; x1: number; y1: number; w: number; h: number; cx: number; cy: number }

export function safeRect(W: number, H: number): Rect {
  const z0 = H / W > 1.5 ? SAFE_ZONES.vertical : SAFE_ZONES.other;
  const x0 = W * z0.x0, x1 = W * z0.x1, y0 = H * z0.y0, y1 = H * z0.y1;
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** Smallest template text size as a fraction of the frame height (the tiny-text QA check wants ≥ 2.5%). */
export const MIN_TEXT = 0.028;

/** Layout helpers shared by every template. */
function setup(a: Args, defaultSeconds: number) {
  const [W, H] = a.comp.size;
  const f = (sec: number) => Math.round((sec * a.rate.num) / a.rate.den);
  const len = Math.max(f(0.5), a.len ?? f(defaultSeconds));
  const S = safeRect(W, H);
  const u = Math.min(W, H) / 1080;
  const r = (n: number) => Math.round(n);
  /** an animation length that fits the clip: at most a quarter of it */
  const fit = (sec: number, of = len) => Math.max(1, Math.min(f(sec), Math.floor(of / 4)));
  /** a text size of `n` px at 1080, never under MIN_TEXT of the frame height (QA tiny-text flags < 2.5%) */
  const ts = (n: number) => Math.max(r(n * u), Math.ceil(MIN_TEXT * H));
  return { W, H, f, len, S, u, r, ts, fit, at: a.at };
}

/** Keyframes with strictly increasing frames (later duplicates are dropped). */
function keys<V>(...ks: ([number, V] | [number, V, string])[]): never {
  const out: ([number, V] | [number, V, string])[] = [];
  for (const k of ks) if (!out.length || k[0] > out[out.length - 1]![0]) out.push(k);
  return out as never;
}

/** A clip that starts `delay` frames into the template and ends with it. */
function later(at: number, len: number, delay: number): { at: number; len: number } {
  const d = Math.min(delay, Math.floor(len / 3));
  return { at: at + d, len: len - d };
}

const color = z.string().regex(/^(#[0-9a-fA-F]{3,8}|[a-z]+|rgba?\([^)]*\))$/, 'a colour like "#ffcc00"');

const intro = defineTemplate({
  id: 'intro',
  describe: 'Title card: background, accent shapes, a popping title and a subtitle that slides up (4 s).',
  params: z.object({ title: z.string().default('Your title here'), subtitle: z.string().default(''), bg: color.default('#101014'), accent: color.default('#ffd400') }),
  build(a) {
    const p = a.params as { title: string; subtitle: string; bg: string; accent: string };
    const { len, S, u, r, ts, fit, at } = setup(a, 4);
    const size = r(120 * u), boxH = r(size * 1.15 * 2);
    const titleY = r(S.cy - 40 * u);
    const anim = fit(0.5);
    const clips: Clip[] = [
      { id: 'bg', track: 'bg', at, len, color: p.bg },
      { id: 'bar', track: 'bar', at, len, shape: { type: 'rect', size: [r(S.w * 0.5), r(12 * u)], radius: r(6 * u), fill: p.accent }, x: r(S.cx), y: r(titleY - boxH / 2 - 30 * u), scale: keys([0, [0, 1], 'outCubic'], [anim, [1, 1]]) },
      // the dot keeps growing and the title slowly pushes in, so the card keeps moving after its entrance
      { id: 'dot', track: 'dot', at, len, shape: { type: 'ellipse', size: [r(160 * u), r(160 * u)], fill: p.accent }, opacity: 0.25, x: r(S.x1 - 100 * u), y: r(S.y0 + 100 * u), scale: keys([0, 0, 'outBack'], [anim, 1], [len - 1, 1.4]) },
      { id: 'title', track: 'title', at, len, text: p.title, style: { base: 'title', size, box: [r(S.w * 0.9), boxH], maxLines: 2 }, x: r(S.cx), y: titleY, scale: keys([0, 1], [len - 1, 1.08]), animate: { in: 'pop', out: 'fade', by: 'word' } },
    ];
    if (p.subtitle) {
      const sub = ts(56), subH = r(sub * 1.3 * 2);
      clips.push({ id: 'subtitle', track: 'subtitle', ...later(at, len, fit(0.4)), text: p.subtitle, style: { base: 'subtitle', size: sub, box: [r(S.w * 0.85), subH], maxLines: 2 }, x: r(S.cx), y: r(titleY + boxH / 2 + 30 * u + subH / 2), animate: { in: 'slide-up', out: 'fade', by: 'all' } });
    }
    return { clips, summary: `intro "${p.title}"` };
  },
});

const lowerThird = defineTemplate({
  id: 'lower-third',
  describe: 'Name and role on a dark plate with an accent bar, bottom left; wipes in and out (5 s).',
  params: z.object({ name: z.string().default('Jane Doe'), role: z.string().default(''), accent: color.default('#ffd400'), plate: color.default('#000000b3') }),
  build(a) {
    const p = a.params as { name: string; role: string; accent: string; plate: string };
    const { len, S, u, r, ts, fit, at } = setup(a, 5);
    // text sizes keep a readable minimum on tall frames; the plate grows with them so nothing shrinks to fit
    const ns = Math.max(ts(52), p.role ? Math.ceil(ts(36) * 1.3) : 0), rs = ts(36), lh = 1.2;
    const pw = r(Math.min(S.w * 0.8, 900 * u));
    // a long name wraps to two lines (estimated width ≈ 0.55 em per character) instead of shrinking below QA size
    const nameLines = p.name.length * ns * 0.55 > pw - r(48 * u) ? 2 : 1;
    const nh = Math.ceil(ns * lh * 1.05 * nameLines), rh = Math.ceil(rs * lh * 1.05), gap = r(4 * u), pad = r(18 * u);
    const ph = Math.max(r((p.role ? 150 : 100) * u), 2 * pad + nh + (p.role ? gap + rh : 0)), bw = r(12 * u);
    const left = r(S.x0 + 20 * u), py = r(S.y1 - ph / 2 - 30 * u);
    const a1 = fit(0.3), a2 = fit(0.5), end = len - 1;
    const wipe = keys<[number, number]>([0, [0, 1], 'outCubic'], [a2, [1, 1]], [end - a2, [1, 1], 'inCubic'], [end, [0, 1]]);
    const textW = pw - r(48 * u), tx = left + bw + r(24 * u);
    const nameY = p.role ? r(py - (gap + rh) / 2) : py, roleY = r(py + (gap + nh) / 2);
    const clips: Clip[] = [
      { id: 'bar', track: 'bar', at, len, shape: { type: 'rect', size: [bw, ph], fill: p.accent }, anchor: [0, 0.5], x: left, y: py, scale: keys<[number, number]>([0, [1, 0], 'outCubic'], [a1, [1, 1]], [end - a1, [1, 1], 'inCubic'], [end, [1, 0]]) },
      { id: 'plate', track: 'plate', at, len, shape: { type: 'rect', size: [pw, ph], fill: p.plate }, anchor: [0, 0.5], x: left + bw, y: py, scale: wipe },
      { id: 'name', track: 'name', ...later(at, len, a1), text: p.name, style: { base: 'lower-third', size: ns, lineHeight: lh, box: [textW, nh], maxLines: nameLines }, anchor: [0, 0.5], x: tx, y: nameY, animate: { in: 'slide-left', out: 'fade', by: 'all' } },
    ];
    if (p.role) clips.push({ id: 'role', track: 'role', ...later(at, len, fit(0.45)), text: p.role, style: { base: 'body', size: rs, lineHeight: lh, color: '#dddddd', align: 'left', box: [textW, rh], maxLines: 1 }, anchor: [0, 0.5], x: tx, y: roleY, animate: { in: 'slide-left', out: 'fade', by: 'all' } });
    return { clips, summary: `lower third "${p.name}"` };
  },
});

const cta = defineTemplate({
  id: 'cta',
  describe: 'Call-to-action button (rounded rect + label) that pops in and bounces, inside the safe zone (3 s).',
  params: z.object({ label: z.string().default('Subscribe'), color: color.default('#ff0033'), textColor: color.default('#ffffff'), y: z.number().min(0).max(1).default(0.8).describe('vertical position inside the safe area, 0 = top, 1 = bottom') }),
  build(a) {
    const p = a.params as { label: string; color: string; textColor: string; y: number };
    const { len, S, u, r, fit, f, at } = setup(a, 3);
    const bw = r(Math.min(S.w * 0.7, 560 * u)), bh = r(130 * u);
    const x = r(S.cx), y = r(Math.min(S.y1 - bh * 0.6, Math.max(S.y0 + bh * 0.6, S.y0 + S.h * p.y)));
    const pop = fit(0.25), b0 = Math.min(f(1.2), Math.floor(len / 2));
    const scale = keys<number>([0, 0.6, 'outQuad'], [pop, 1.08, 'inOutQuad'], [pop * 2, 1], [b0, 1, 'outQuad'], [b0 + fit(0.12), 1.08, 'inQuad'], [b0 + 2 * fit(0.12), 1]);
    const clips: Clip[] = [
      { id: 'button', track: 'button', at, len, shape: { type: 'rect', size: [bw, bh], radius: r(bh / 2), fill: p.color }, x, y, scale, opacity: keys<number>([0, 0], [Math.max(1, Math.floor(pop / 2)), 1]) },
      { id: 'label', track: 'label', at, len, text: p.label, style: { base: 'cta', size: r(56 * u), color: p.textColor, box: [bw - r(60 * u), bh - r(30 * u)], maxLines: 1 }, x, y, scale, animate: { in: 'pop', by: 'all', len: pop * 2 } },
    ];
    return { clips, summary: `CTA "${p.label}"` };
  },
});

const title = defineTemplate({
  id: 'title',
  describe: 'A big centred title that pops in word by word and fades out (3 s).',
  params: z.object({ text: z.string().default('Big title'), color: color.default('#ffffff') }),
  build(a) {
    const p = a.params as { text: string; color: string };
    const { len, S, u, r, at } = setup(a, 3);
    const size = r(140 * u);
    return { clips: [{ id: 'title', track: 'title', at, len, text: p.text, style: { base: 'title', size, color: p.color, box: [r(S.w * 0.92), r(Math.min(S.h * 0.8, size * 1.1 * 3))], maxLines: 3 }, x: r(S.cx), y: r(S.cy), animate: { in: 'pop', out: 'fade', by: 'word' } }], summary: `title "${p.text}"` };
  },
});

const endCard = defineTemplate({
  id: 'end-card',
  describe: 'End screen: background, title, two video placeholders and a subtitle (5 s).',
  params: z.object({ title: z.string().default('Thanks for watching'), subtitle: z.string().default('Subscribe for more'), bg: color.default('#101014'), accent: color.default('#ffd400') }),
  build(a) {
    const p = a.params as { title: string; subtitle: string; bg: string; accent: string };
    const { W, H, len, S, u, r, ts, fit, at } = setup(a, 5);
    const gap = r(30 * u);
    const tSize = r(88 * u), tH = r(tSize * 1.1 * 2), sSize = ts(52), sH = r(sSize * 1.3 * 2);
    const stacked = H > W;
    const avail = S.h - tH - sH - 4 * gap;
    let tw = stacked ? S.w * 0.8 : (S.w - 2 * gap) / 2 * 0.9;
    let th = (tw * 9) / 16;
    const blockH = stacked ? 2 * th + gap : th;
    if (blockH > avail) { const k = avail / blockH; tw *= k; th *= k; }
    tw = r(tw); th = r(th);
    const titleY = r(S.y0 + gap + tH / 2);
    const midTop = S.y0 + gap + tH + gap, midH = S.y1 - gap - sH - gap - midTop;
    const midY = midTop + midH / 2;
    const pos: [number, number][] = stacked ? [[S.cx, midY - (th + gap) / 2], [S.cx, midY + (th + gap) / 2]] : [[S.cx - (tw + gap) / 2, midY], [S.cx + (tw + gap) / 2, midY]];
    const grow = fit(0.4);
    const clips: Clip[] = [
      { id: 'bg', track: 'bg', at, len, color: p.bg },
      ...pos.map(([x, y], i): Clip => ({ id: `video${i + 1}`, track: `video${i + 1}`, ...later(at, len, fit(0.2) * i), shape: { type: 'rect', size: [tw, th], radius: r(16 * u), fill: '#ffffff1f', stroke: p.accent, strokeWidth: r(4 * u) }, x: r(x), y: r(y), scale: keys<number>([0, 0.8, 'outBack'], [grow, 1]), opacity: keys<number>([0, 0], [grow, 1]) })),
      { id: 'title', track: 'title', at, len, text: p.title, style: { base: 'title', size: tSize, box: [r(S.w * 0.9), tH], maxLines: 2 }, x: r(S.cx), y: titleY, animate: { in: 'slide-down', by: 'word' } },
    ];
    if (p.subtitle) clips.push({ id: 'subtitle', track: 'subtitle', ...later(at, len, fit(0.5)), text: p.subtitle, style: { base: 'subtitle', size: sSize, color: p.accent, box: [r(S.w * 0.9), sH], maxLines: 2 }, x: r(S.cx), y: r(S.y1 - gap - sH / 2), animate: { in: 'fade', by: 'all' } });
    return { clips, summary: `end card "${p.title}"` };
  },
});

const progressBar = defineTemplate({
  id: 'progress-bar',
  describe: 'A bar that fills from left to right over the comp length (or len), at the top or bottom of the safe area.',
  params: z.object({ color: color.default('#ffd400'), trackColor: color.default('#ffffff33'), position: z.enum(['top', 'bottom']).default('bottom'), thickness: z.number().positive().default(12) }),
  build(a) {
    const p = a.params as { color: string; trackColor: string; position: 'top' | 'bottom'; thickness: number };
    const comp = a.comp;
    const length = typeof comp.length === 'number' ? comp.length : lastClipEnd(a);
    const { len, S, u, r, at } = setup({ ...a, len: a.len ?? (length > a.at ? length - a.at : undefined) }, 10);
    const x = Math.ceil(S.x0), h = Math.max(2, r(p.thickness * u)), w = Math.floor(S.x1) - x;
    const y = p.position === 'top' ? r(S.y0 + 20 * u + h / 2) : r(S.y1 - 20 * u - h / 2);
    const clips: Clip[] = [
      { id: 'track', track: 'track', at, len, shape: { type: 'rect', size: [w, h], radius: r(h / 2), fill: p.trackColor }, anchor: [0, 0.5], x, y },
      { id: 'fill', track: 'fill', at, len, shape: { type: 'rect', size: [w, h], radius: r(h / 2), fill: p.color }, anchor: [0, 0.5], x, y, scale: keys<[number, number]>([0, [0, 1]], [Math.max(1, len - 1), [1, 1]]) },
    ];
    return { clips, summary: `progress bar over ${len} frames` };
  },
});

function lastClipEnd(a: Args): number {
  const tracks = new Set((a.project.tracks ?? []).filter((t) => t.comp === a.comp.id).map((t) => t.id));
  return (a.project.clips ?? []).filter((c) => tracks.has(c.track)).reduce((m, c) => Math.max(m, c.at + c.len), 0);
}

const quote = defineTemplate({
  id: 'quote',
  describe: 'A quotation with a large accent quote mark and the author underneath (5 s).',
  params: z.object({ quote: z.string().default('Simplicity is the ultimate sophistication.'), author: z.string().default(''), accent: color.default('#ffd400') }),
  build(a) {
    const p = a.params as { quote: string; author: string; accent: string };
    const { len, S, u, r, ts, fit, at } = setup(a, 5);
    const size = ts(60), qH = r(Math.min(S.h * 0.5, size * 1.35 * 5)), qY = r(S.cy);
    const mark = r(200 * u);
    const clips: Clip[] = [
      { id: 'mark', track: 'mark', at, len, text: '“', style: { base: 'title', size: mark, color: p.accent, strokeWidth: 0, box: [mark, r(mark * 1.2)], maxLines: 1 }, x: r(S.cx), y: r(qY - qH / 2 - 20 * u - mark * 0.6), animate: { in: 'scale-in', by: 'all' } },
      { id: 'quote', track: 'quote', ...later(at, len, fit(0.3)), text: p.quote, style: { base: 'body', size, italic: true, box: [r(S.w * 0.88), qH], maxLines: 5 }, x: r(S.cx), y: qY, animate: { in: 'fade', out: 'fade', by: 'word', stagger: 2 } },
    ];
    const aSize = ts(40), aH = Math.ceil(aSize * 1.4);
    if (p.author) clips.push({ id: 'author', track: 'author', ...later(at, len, fit(0.8)), text: `— ${p.author}`, style: { base: 'subtitle', size: aSize, color: p.accent, box: [r(S.w * 0.8), aH], maxLines: 1 }, x: r(S.cx), y: r(qY + qH / 2 + 20 * u + aH / 2), animate: { in: 'slide-up', by: 'all' } });
    return { clips, summary: 'quote' };
  },
});

const listicleItem = defineTemplate({
  id: 'listicle-item',
  describe: 'A numbered list item: a number in an accent circle and the item text (3 s).',
  params: z.object({ number: z.number().int().default(1), text: z.string().default('List item'), accent: color.default('#ffd400'), numberColor: color.default('#111111') }),
  build(a) {
    const p = a.params as { number: number; text: string; accent: string; numberColor: string };
    const { len, S, u, r, fit, at } = setup(a, 3);
    const d = r(Math.min(140 * u, S.w * 0.2)), gap = r(30 * u);
    const left = S.cx - S.w * 0.45, y = r(S.cy);
    const tw = r(S.w * 0.9 - d - gap), size = r(72 * u);
    const pop = fit(0.3);
    const clips: Clip[] = [
      { id: 'circle', track: 'circle', at, len, shape: { type: 'ellipse', size: [d, d], fill: p.accent }, x: r(left + d / 2), y, scale: keys<number>([0, 0, 'outBack'], [pop, 1]) },
      { id: 'number', track: 'number', at, len, text: String(p.number), style: { base: 'title', size: r(d * 0.6), color: p.numberColor, strokeWidth: 0, box: [d, d], maxLines: 1 }, x: r(left + d / 2), y, animate: { in: 'pop', by: 'all' } },
      { id: 'text', track: 'text', ...later(at, len, fit(0.2)), text: p.text, style: { base: 'title', size, align: 'left', box: [tw, r(Math.min(S.h * 0.5, size * 1.1 * 2))], maxLines: 2 }, anchor: [0, 0.5], x: r(left + d + gap), y, animate: { in: 'slide-left', out: 'fade', by: 'word' } },
    ];
    return { clips, summary: `list item ${p.number}` };
  },
});

const barsAndTone = defineTemplate({
  id: 'bars-and-tone',
  describe: 'Head-leader colour bars (SMPTE or EBU, from the smpte-bars generator) with an optional ident line (10 s). Picture only: add the 1 kHz tone as an audio asset (e.g. ffmpeg -f lavfi -i sine=f=1000:d=10 tone.wav) on an audio track.',
  params: z.object({ ident: z.string().default('').describe('optional ident text over the bars, e.g. the programme title'), standard: z.enum(['smpte', 'ebu']).default('smpte'), level: z.union([z.literal(75), z.literal(100)]).default(75) }),
  build(a) {
    const p = a.params as { ident: string; standard: 'smpte' | 'ebu'; level: 75 | 100 };
    const { len, S, u, r, ts, at } = setup(a, 10);
    const clips: Clip[] = [{ id: 'bars', track: 'bars', at, len, gen: { type: 'smpte-bars', standard: p.standard, level: p.level } }];
    if (p.ident) {
      const size = ts(44), h = Math.ceil(size * 1.6);
      clips.push({ id: 'ident', track: 'ident', at, len, text: p.ident, style: { base: 'label', size, box: [r(S.w * 0.9), h], maxLines: 1 }, x: r(S.cx), y: r(S.y0 + 20 * u + h / 2) });
    }
    return { clips, summary: `${p.standard.toUpperCase()} bars${p.ident ? ` "${p.ident}"` : ''} (picture only; add tone as an audio asset)` };
  },
});

const slate = defineTemplate({
  id: 'slate',
  describe: 'Programme slate: title, then version, date and duration lines on a dark card (5 s). Empty fields are left out.',
  params: z.object({
    title: z.string().default('Untitled'), version: z.string().default('v1'), date: z.string().default(''), duration: z.string().default(''),
    client: z.string().default(''), bg: color.default('#111111'), accent: color.default('#ffd400'),
  }),
  build(a) {
    const p = a.params as { title: string; version: string; date: string; duration: string; client: string; bg: string; accent: string };
    const { len, S, u, r, ts, at } = setup(a, 5);
    const lines = ([['Client', p.client], ['Version', p.version], ['Date', p.date], ['Duration', p.duration]] as const).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    const tSize = ts(96), tH = r(tSize * 1.1 * 2), dSize = ts(48), dH = Math.ceil(dSize * 1.35 * Math.max(1, lines.length));
    const gap = r(40 * u), total = tH + gap + (lines.length ? dH : 0), top = S.cy - total / 2;
    const x0 = r(S.x0 + S.w * 0.06), w = r(S.w * 0.88);
    const clips: Clip[] = [
      { id: 'bg', track: 'bg', at, len, color: p.bg },
      { id: 'rule', track: 'rule', at, len, shape: { type: 'rect', size: [w, Math.max(2, r(6 * u))], fill: p.accent }, anchor: [0, 0.5], x: x0, y: r(top + tH + gap / 2) },
      { id: 'title', track: 'title', at, len, text: p.title, style: { base: 'title', size: tSize, strokeWidth: 0, align: 'left', box: [w, tH], maxLines: 2 }, anchor: [0, 0.5], x: x0, y: r(top + tH / 2) },
    ];
    if (lines.length) clips.push({ id: 'details', track: 'details', at, len, text: lines.join('\n'), style: { base: 'body', size: dSize, align: 'left', color: '#dddddd', lineHeight: 1.3, box: [w, dH], maxLines: lines.length }, anchor: [0, 0.5], x: x0, y: r(top + tH + gap + dH / 2) });
    return { clips, summary: `slate "${p.title}"` };
  },
});

const countdown = defineTemplate({
  id: 'countdown',
  describe: 'Countdown leader: a number per second from `from` down to 1 with a sweeping hand (countdown-leader generator); the clip is `from` seconds long unless len is given.',
  params: z.object({ from: z.number().int().min(1).max(99).default(5), color: color.default('#ffffff'), bg: color.default('#202020') }),
  build(a) {
    const p = a.params as { from: number; color: string; bg: string };
    const { len, at } = setup(a, p.from);
    return { clips: [{ id: 'leader', track: 'leader', at, len, gen: { type: 'countdown-leader', from: p.from, color: p.color, bg: p.bg } }], summary: `countdown from ${p.from}` };
  },
});

export const templates: TemplateDef[] = [intro, lowerThird, cta, title, endCard, progressBar, quote, listicleItem, barsAndTone, slate, countdown];
