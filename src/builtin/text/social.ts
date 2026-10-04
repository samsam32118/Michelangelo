/**
 * Social templates (Shorts / TikTok / Reels first, and laid out for 16:9 and 1:1 too): a scroll-stopping hook title
 * and a follow / subscribe outro card. Same conventions as templates.ts: plain entities with short ids, layers named
 * by `track`, everything laid out from the comp size inside the platform safe zone, text never under MIN_TEXT.
 * Fonts: the bundled Montserrat (400/700/800/900) and Bebas Neue.
 */
import { z, defineTemplate, type TemplateDef } from '../../plugin/api.js';
import { setup, keys, later, color, type Clip } from './templates.js';

const HEAVY = { font: 'Montserrat', weight: 900, uppercase: true } as const;

/**
 * Estimated width in px of upper-case Montserrat Black (900; 800 is ~5% wider) at `size`, from per-glyph widths in em
 * (measured: within ±4% on common words), plus letter spacing. Templates cannot measure text, so plates and line
 * counts use this; the renderer still shrinks text that would not fit its box.
 */
export function capsWidth(text: string, size: number, opts: { weight?: number; letterSpacing?: number } = {}): number {
  let em = 0;
  const chars = [...text.toUpperCase()];
  for (const ch of chars) em += ch === ' ' ? 0.27 : /[I1!.,':;|]/.test(ch) ? 0.35 : /[MW]/.test(ch) ? 0.95 : /[JTLFESP]/.test(ch) ? 0.64 : 0.74;
  return em * size * 1.03 * (opts.weight === 800 ? 1.05 : 1) + chars.length * (opts.letterSpacing ?? 0);
}

/** Lines a heavy upper-case text wraps to in `w` px at `size` (greedy, word widths from capsWidth), capped at `max`. */
export function estimateLines(text: string, w: number, size: number, max: number): number {
  let lines = 1, cur = '';
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const cand = cur ? `${cur} ${word}` : word;
    if (cur && capsWidth(cand, size) > w) { lines++; cur = word; } else cur = cand;
  }
  return Math.min(max, lines);
}

const hookTitle = defineTemplate({
  id: 'hook-title',
  describe: 'Scroll-stopping hook for the first seconds of a Short: an optional kicker pill, a heavy upper-case line that snaps in word by word and a tilted highlight sticker line in the accent colour, over a soft dark scrim (3 s). '
    + 'e.g. template.apply hook-title params=\'{"kicker": "Productivity", "text": "Stop doing this", "highlight": "every morning"}\'',
  params: z.object({
    text: z.string().default('Stop scrolling if you'),
    highlight: z.string().default('want more focus').describe('second line on an accent sticker ("" for none)'),
    kicker: z.string().default('').describe('small label above the hook, e.g. "Part 1" or "3 tips"'),
    accent: color.default('#ffe01b'),
    accentText: color.default('#111111').describe('text colour on the accent sticker'),
    position: z.enum(['top', 'center']).default('top').describe('top: upper third (leaves the middle for the subject); center: middle of the safe area'),
    scrim: z.boolean().default(true).describe('a soft dark gradient behind the text so it reads over busy footage'),
  }),
  build(a) {
    const p = a.params as { text: string; highlight: string; kicker: string; accent: string; accentText: string; position: 'top' | 'center'; scrim: boolean };
    const { W, H, len, S, u, r, ts, fit, f, at } = setup(a, 3);
    const vertical = H > W;
    const boxW = r(Math.min(S.w * 0.96, 1300 * u));
    const size = r((vertical ? 112 : 120) * u), lh = 1.04;
    const words = p.text.trim().split(/\s+/).filter(Boolean).length;
    const lines = estimateLines(p.text, boxW, size, 3);
    const mainH = Math.ceil(size * lh * lines);
    const hSize = r(size * 0.82), hPad = r(22 * u), hLine = Math.ceil(hSize * 1.1), hH = p.highlight ? hLine + 2 * hPad : 0;
    const kSize = ts(44), kH = p.kicker ? Math.ceil(kSize * 1.2 + 2 * r(12 * u)) : 0;
    const gap = r(28 * u);
    // the sticker is tilted 2.5°: its box grows by w·sin(2.5°); both lines also push in to 1.04
    const hTextW = Math.ceil(Math.min(boxW * 0.92 - 60 * u, capsWidth(p.highlight, hSize, { letterSpacing: -1 })));
    const hW = hTextW + 60 * u;
    const hGap = p.highlight ? gap + Math.ceil(hW * 0.0436 / 2 + 0.02 * (mainH + hH)) : 0;
    const total = (kH ? kH + gap : 0) + mainH + (hH ? hGap + hH : 0);
    const top = p.position === 'top' ? Math.round(S.y0 + (vertical ? S.h * 0.06 : S.h * 0.08)) : Math.round(S.cy - total / 2);
    const stagger = Math.max(1, Math.min(f(0.1), Math.floor(len / 4 / Math.max(1, words))));
    const snap = fit(0.3);
    const settle = keys<number>([0, 1], [len - 1, 1.04]);
    // everything fades out together at the end (a per-word out animation would strip the line word by word)
    const outFade = (n: number) => keys<number>([Math.max(0, n - 1 - fit(0.2)), 1], [n - 1, 0]);
    const clips: Clip[] = [];
    if (p.scrim) {
      // a full-frame gradient (evenly spaced stops): top: dark at the top edge, clear below the block; center: a band
      const clear = '#00000000';
      if (p.position === 'top') {
        const frac = Math.min(1, (top + total + 160 * u) / H);
        const m = Math.max(3, Math.min(12, Math.round(2 / frac) + 1));
        clips.push({ id: 'scrim', track: 'scrim', at, len, gen: { type: 'gradient', angle: 90, colors: ['#000000b3', '#00000059', ...Array<string>(m - 2).fill(clear)] }, opacity: keys<number>([0, 0], [fit(0.25), 1]) });
      } else clips.push({ id: 'scrim', track: 'scrim', at, len, gen: { type: 'gradient', angle: 90, colors: [clear, '#00000080', clear] }, opacity: keys<number>([0, 0], [fit(0.25), 1]) });
    }
    let y = top;
    if (p.kicker) {
      const kw = Math.ceil(Math.min(boxW * 0.8, capsWidth(p.kicker, kSize, { weight: 800, letterSpacing: 3 }))), kh = Math.ceil(kSize * 1.2);
      clips.push({ id: 'kicker', track: 'kicker', at, len, text: p.kicker, style: { font: 'Montserrat', weight: 800, uppercase: true, size: kSize, color: p.accentText, bg: p.accent, bgPadding: [r(22 * u), r((kH - kh) / 2)], bgRadius: r(kH / 2), letterSpacing: 3, box: [kw, kh], maxLines: 1, align: 'center' }, x: r(S.cx), y: r(y + kH / 2), opacity: outFade(len), animate: { in: 'slide-down', by: 'all', len: snap } });
      y += kH + gap;
    }
    clips.push({ id: 'text', track: 'text', at, len, text: p.text, style: { ...HEAVY, size, color: '#ffffff', stroke: '#000000', strokeWidth: r(7 * u), shadow: '#000000b3', shadowBlur: r(18 * u), shadowOffset: [0, r(6 * u)], lineHeight: lh, letterSpacing: -1, box: [boxW, mainH], maxLines: lines, align: 'center' }, x: r(S.cx), y: r(y + mainH / 2), scale: settle, opacity: outFade(len), animate: { in: 'snap', by: 'word', stagger, len: snap } });
    y += mainH;
    if (p.highlight) {
      const delay = Math.min(Math.floor(len / 3), words * stagger + fit(0.15));
      const span = later(at, len, delay);
      clips.push({ id: 'highlight', track: 'highlight', ...span, text: p.highlight, style: { ...HEAVY, size: hSize, color: p.accentText, bg: p.accent, bgPadding: [r(30 * u), hPad], bgRadius: r(18 * u), shadow: '#00000080', shadowBlur: r(24 * u), shadowOffset: [0, r(8 * u)], lineHeight: 1.1, letterSpacing: -1, box: [hTextW, hLine], maxLines: 1, align: 'center' }, x: r(S.cx), y: r(y + hGap + hH / 2), rotate: -2.5, scale: keys<number>([0, 1], [span.len - 1, 1.04]), opacity: outFade(span.len), animate: { in: 'snap', by: 'all', len: snap } });
    }
    return { clips, summary: `hook title "${p.text}${p.highlight ? ` / ${p.highlight}` : ''}"` };
  },
});

const PLATFORM = {
  youtube: { label: 'Subscribe', done: 'Subscribed', color: '#ff0033' },
  tiktok: { label: 'Follow', done: 'Following', color: '#fe2c55' },
  instagram: { label: 'Follow', done: 'Following', color: '#0095f6' },
} as const;

/** A mouse pointer outline (tip at 0,0), 1 unit ≈ 1 px at 1080. */
const POINTER: [number, number][] = [[0, 0], [0, 70], [17, 54], [30, 82], [43, 76], [30, 49], [52, 49]];

const followOutro = defineTemplate({
  id: 'follow-outro',
  describe: 'Outro card: animated gradient background, avatar ring with your initial, @handle, a headline and a Subscribe / Follow button that a pointer clicks (it turns into Subscribed / Following with a ripple) (5 s). '
    + 'platform sets the label and colour (youtube, tiktok, instagram). e.g. template.apply follow-outro params=\'{"handle": "@studio.mia", "title": "Follow for daily tips", "platform": "tiktok"}\'',
  params: z.object({
    handle: z.string().default('@yourchannel'),
    title: z.string().default('Want more like this?'),
    platform: z.enum(['youtube', 'tiktok', 'instagram']).default('youtube'),
    label: z.string().default('').describe('button text (default: Subscribe on youtube, Follow elsewhere)'),
    doneLabel: z.string().default('').describe('button text after the click (default: Subscribed / Following)'),
    accent: color.optional().describe('button colour (default: the platform colour)'),
    bg: z.array(color).min(2).max(4).default(['#14102e', '#3a1d6e', '#0b0a1a']).describe('background gradient colours'),
    click: z.boolean().default(true).describe('animate a pointer clicking the button'),
  }),
  build(a) {
    const p = a.params as { handle: string; title: string; platform: keyof typeof PLATFORM; label: string; doneLabel: string; accent?: string; bg: string[]; click: boolean };
    const pf = PLATFORM[p.platform];
    const accent = p.accent || pf.color, label = p.label || pf.label, done = p.doneLabel || pf.done;
    const { W, len, S, u, r, ts, f, at } = setup(a, 5);
    /** a moment of the 5 s choreography: real seconds on long cards, compressed on short ones */
    const tt = (sec: number) => Math.min(f(sec), Math.round((sec / 5) * len));
    const d = r(Math.min(250 * u, S.h * 0.2)), ring = Math.max(4, r(10 * u));
    const hs = ts(52), hH = Math.ceil(hs * 1.3);
    const tSize = r(88 * u), tH = Math.ceil(tSize * 1.08 * 2);
    const bw = r(Math.min(S.w * 0.8, 640 * u)), bh = r(140 * u);
    const g1 = r(34 * u), g2 = r(26 * u), g3 = r(56 * u);
    const total = d + g1 + hH + g2 + tH + g3 + bh;
    const top = Math.round(S.cy - total / 2);
    const cx = r(S.cx);
    const avY = r(top + d / 2), hY = r(top + d + g1 + hH / 2), tY = r(top + d + g1 + hH + g2 + tH / 2), bY = r(top + total - bh / 2);
    const glow = Math.floor(Math.min(S.w, S.h));
    const initial = ([...p.handle.replace(/^@/, '').trim()][0] ?? 'M').toUpperCase();
    const pop = Math.max(2, tt(0.4)), btnIn = tt(0.9), click = tt(2.3), press = Math.max(1, tt(0.1));
    const clips: Clip[] = [
      { id: 'bg', track: 'bg', at, len, gen: { type: 'gradient', colors: p.bg, angle: 120, animate: 12 } },
      // a soft accent glow behind the card that breathes (only for #rrggbb accents, which take an alpha suffix);
      // it fades out before its edge, so keeping it inside the safe area hides nothing
      ...(/^#[0-9a-f]{6}$/i.test(accent) ? [{ id: 'glow', track: 'glow', at, len, shape: { type: 'ellipse', size: [glow, glow], fill: '#000000', gradient: { type: 'radial', stops: [[0, `${accent}66`], [0.55, `${accent}26`], [1, `${accent}00`]] } }, x: cx, y: r(S.cy), scale: keys<number>([0, 0.7, 'outCubic'], [pop * 2, 0.95], [len - 1, 1]) } as Clip] : []),
      { id: 'avatar', track: 'avatar', at, len, shape: { type: 'ellipse', size: [d, d], fill: '#ffffff', stroke: accent, strokeWidth: ring }, x: cx, y: avY, scale: keys<number>([0, 0, 'outBack'], [pop, 1]) },
      { id: 'initial', track: 'initial', at, len, text: initial, style: { ...HEAVY, size: r(d * 0.5), color: '#14102e', box: [r(d * 0.66), r(d * 0.66)], maxLines: 1 }, x: cx, y: avY, scale: keys<number>([0, 0, 'outBack'], [pop, 1]) },
      { id: 'handle', track: 'handle', ...later(at, len, tt(0.25)), text: p.handle, style: { font: 'Montserrat', weight: 700, size: hs, color: '#ffffffd9', box: [r(S.w * 0.9), hH], maxLines: 1, align: 'center' }, x: cx, y: hY, animate: { in: 'slide-up', by: 'all' } },
      { id: 'title', track: 'title', ...later(at, len, tt(0.45)), text: p.title, style: { ...HEAVY, size: tSize, color: '#ffffff', shadow: '#00000099', shadowBlur: r(16 * u), shadowOffset: [0, r(5 * u)], lineHeight: 1.08, letterSpacing: -1, box: [r(S.w * 0.94), tH], maxLines: 2, align: 'center' }, x: cx, y: tY, animate: { in: 'snap', by: 'word', stagger: Math.max(1, tt(0.08)) } },
    ];
    // the button: pops in, (pointer) presses at `click`, then swaps to the done state
    // track order is the order layers first appear: buttons, then the ripple (on the button, under its text), labels, pointer
    const labels: Clip[] = [];
    const btn = (id: string, fill: string, text: string, from: number, to: number, enter: boolean): void => {
      const span = { at: at + from, len: to - from };
      const scale = enter
        ? keys<number>([0, 0.5, 'outBack'], [pop, 1], ...(p.click && click - from > pop ? [[click - from - press, 1, 'inQuad'], [click - from, 0.9, 'outQuad']] as [number, number, string][] : []))
        : keys<number>([0, 0.9, 'outBack'], [press * 2, 1]);
      clips.push({ id, track: 'button', ...span, shape: { type: 'rect', size: [bw, bh], radius: r(bh / 2), fill, ...(enter ? {} : { stroke: '#ffffff59', strokeWidth: Math.max(2, r(4 * u)) }) }, x: cx, y: bY, scale });
      labels.push({ id: `${id}-label`, track: 'label', ...span, text: text, style: { ...HEAVY, weight: 800, size: r(54 * u), color: '#ffffff', letterSpacing: 2, box: [bw - r(70 * u), bh - r(36 * u)], maxLines: 1, align: 'center' }, x: cx, y: bY, scale });
    };
    const swap = p.click && click + press < len - 1 ? click + 1 : len;
    btn('button', accent, label, Math.min(btnIn, len - 2), swap, true);
    if (swap < len) btn('done', '#2a2a35', done, swap, len, false);
    let pointer: Clip | undefined;
    if (p.click && swap < len) {
      const k = u * 1.25;
      const enter = Math.max(btnIn + pop, click - tt(0.8));
      // the tip lands near the button's lower edge, below the label's box, so the pointer never covers the text
      const tip: [number, number] = [r(cx + bw * 0.28), r(bY + bh / 2 - 14 * u)];
      const lenP = len - enter;
      const leave = Math.min(lenP - 1, click - enter + tt(0.7));
      // the pointer swings in on an arc about a pivot below-right of it (anchor outside its box), so its rest position
      // is plain numbers: the tip lands at `tip`, presses (scale 0.85) and fades out
      const pw = Math.ceil(52 * k), ph = Math.ceil(82 * k), ax = 8, ay = 5, arrive = click - enter - press;
      pointer = { id: 'pointer', track: 'pointer', at: at + enter, len: lenP, shape: { type: 'polygon', size: [pw, ph], points: POINTER.map(([x, y]) => [r(x * k), r(y * k)] as [number, number]), fill: '#ffffff', stroke: '#111111', strokeWidth: Math.max(2, r(4 * u)), lineJoin: 'round' },
        anchor: [ax, ay], x: tip[0] + Math.round(ax * pw), y: tip[1] + Math.round(ay * ph),
        rotate: keys<number>([0, -14, 'inOutCubic'], [arrive, 0]),
        scale: keys<number>([0, 1], [arrive, 1, 'outQuad'], [click - enter, 0.97, 'outQuad'], [click - enter + press, 1]),
        opacity: keys<number>([0, 0], [Math.max(1, tt(0.15)), 1], [Math.max(tt(0.15) + 1, leave - tt(0.2)), 1], [Math.max(tt(0.15) + 2, leave), 0]) };
      const rippleLen = Math.max(2, Math.min(len - click, tt(0.5)));
      clips.push({ id: 'ripple', track: 'ripple', at: at + click, len: rippleLen, shape: { type: 'ellipse', size: [r(bh * 1.4), r(bh * 1.4)], fill: 'none', stroke: '#ffffff', strokeWidth: Math.max(2, r(6 * u)) }, x: tip[0], y: tip[1], scale: keys<number>([0, 0.2, 'outCubic'], [rippleLen - 1, 1.3]), opacity: keys<number>([0, 0.9], [rippleLen - 1, 0]) });
    }
    clips.push(...labels, ...(pointer ? [pointer] : []));
    return { clips, summary: `follow outro "${p.handle}" (${label} → ${done})` };
  },
});

export { hookTitle, followOutro };
export const socialTemplates: TemplateDef[] = [hookTitle, followOutro];
