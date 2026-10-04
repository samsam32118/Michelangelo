/** Burn-in timecode / clock, SMPTE colour bars and a film-style countdown leader. */
import { defineGenerator, z } from '../../../plugin/api.js';
import { color } from '../util.js';

const TC_RE = /^(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{2})$/;
const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** Nominal (integer) frame rate of a timecode: 29.97 → 30, 23.976 → 24. */
export const nominalFps = (fps: number) => Math.max(1, Math.round(fps));
/** Drop-frame applies to 29.97 and 59.94. */
const isDropRate = (fps: number) => Math.abs(fps - 30000 / 1001) < 0.01 || Math.abs(fps - 60000 / 1001) < 0.01;

/** "HH:MM:SS:FF" → frame count at the nominal rate (drop-frame counting when `drop`). */
export function parseTimecode(tc: string, fps: number, drop = false): number {
  const m = TC_RE.exec(tc.trim());
  if (!m) return 0;
  const [h, mi, s, f] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  const nf = nominalFps(fps);
  let total = ((h * 60 + mi) * 60 + s) * nf + f;
  if (drop) { const d = Math.round(nf / 15), mins = h * 60 + mi; total -= d * (mins - Math.floor(mins / 10)); }
  return total;
}

/** A frame count → "HH:MM:SS:FF" (";" before the frames when drop-frame). Wraps at 24 h. */
export function formatTimecode(frames: number, fps: number, drop = false): string {
  const nf = nominalFps(fps);
  let f = Math.max(0, Math.floor(frames));
  if (drop) {
    const d = Math.round(nf / 15), per10 = nf * 600 - d * 9, per1 = nf * 60 - d;
    const tens = Math.floor(f / per10), rem = f % per10;
    f += d * 9 * tens + (rem > d ? d * Math.floor((rem - d) / per1) : 0);
  }
  f %= nf * 86400;
  const ff = f % nf, s = Math.floor(f / nf) % 60, m = Math.floor(f / (nf * 60)) % 60, h = Math.floor(f / (nf * 3600));
  return `${pad(h)}:${pad(m)}:${pad(s)}${drop ? ';' : ':'}${pad(ff)}`;
}

type TcParams = { start: string; format: 'smpte' | 'clock' | 'seconds' | 'frames'; drop: boolean; prefix: string };

/** The text the timecode generator shows at clip frame `frame`. */
export function timecodeText(p: TcParams, frame: number, fps: number): string {
  const drop = p.drop && isDropRate(fps);
  const total = parseTimecode(p.start, fps, drop) + frame;
  let body: string;
  if (p.format === 'smpte') body = formatTimecode(total, fps, drop);
  else {
    // real elapsed time: start (at the nominal rate) + frame / actual rate
    const sec = parseTimecode(p.start, fps, drop) / nominalFps(fps) + frame / fps;
    if (p.format === 'clock') body = `${pad(sec / 3600)}:${pad((sec / 60) % 60)}:${pad(sec % 60)}`;
    else if (p.format === 'seconds') body = `${sec.toFixed(2)}s`;
    else body = String(total);
  }
  return p.prefix + body;
}

export const timecode = defineGenerator({
  type: 'timecode',
  describe: 'Burned-in timecode (HH:MM:SS:FF from `start`, at the comp rate), a clock (HH:MM:SS), seconds or a frame number, on an optional box: review copies, BITC, news clocks.',
  params: z.object({
    start: z.string().regex(TC_RE, 'a timecode like "10:00:00:00"').default('00:00:00:00').describe('timecode of the clip\'s first frame'),
    format: z.enum(['smpte', 'clock', 'seconds', 'frames']).default('smpte'),
    drop: z.boolean().default(false).describe('drop-frame counting at 29.97 / 59.94'),
    prefix: z.string().max(40).default('').describe('text before the time, e.g. "TC "'),
    font: z.string().min(1).default('JetBrains Mono').describe('a font family, or the id of a font asset'),
    weight: z.number().int().min(100).max(900).default(700),
    size: z.number().min(4).max(2000).default(56).describe('font size in px'),
    color: color('#ffffff'),
    bg: color('rgba(0,0,0,0.6)').describe('box colour ("transparent" for none)'),
    padding: z.number().min(0).max(400).default(12).describe('box padding in px'),
  }),
  size(p) {
    const chars = p.prefix.length + (p.format === 'frames' ? 7 : p.format === 'seconds' ? 9 : p.format === 'clock' ? 8 : 11);
    return [Math.ceil(p.size * 0.62 * chars + 2 * p.padding), Math.ceil(p.size * 1.25 + 2 * p.padding)];
  },
  draw({ dst, params: p, frame, fps }) {
    const c = dst.ctx, W = dst.width, H = dst.height, text = timecodeText(p, frame, fps);
    c.save();
    if (p.bg !== 'transparent') { c.fillStyle = p.bg; c.fillRect(0, 0, W, H); }
    c.font = `${p.weight} ${p.size}px "${p.font}"`;
    c.fillStyle = p.color;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const tw = c.measureText(text).width, room = W - 2 * p.padding;
    if (tw > room && room > 0) { c.translate(W / 2, H / 2); c.scale(room / tw, room / tw); c.translate(-W / 2, -H / 2); }
    c.fillText(text, W / 2, H / 2);
    c.restore();
  },
});

/** SMPTE (ECR 1-1978 style) bar colours at a level (0..1 of white). */
function smpteRows(level: number): { top: string[]; mid: string[] } {
  const v = Math.round(255 * level), k = '#000000', rgb = (r: number, g: number, b: number) => `rgb(${r * v},${g * v},${b * v})`;
  return {
    top: [rgb(1, 1, 1), rgb(1, 1, 0), rgb(0, 1, 1), rgb(0, 1, 0), rgb(1, 0, 1), rgb(1, 0, 0), rgb(0, 0, 1)],
    mid: [rgb(0, 0, 1), k, rgb(1, 0, 1), k, rgb(0, 1, 1), k, rgb(1, 1, 1)],
  };
}

export const smpteBars = defineGenerator({
  type: 'smpte-bars',
  describe: 'Colour bars for a head leader: SMPTE (7 bars, castellations, -I/white/+Q and PLUGE) or EBU (8 full-height bars), at 75% or 100% (picture only: tone is an audio asset).',
  params: z.object({
    standard: z.enum(['smpte', 'ebu']).default('smpte'),
    level: z.union([z.literal(75), z.literal(100)]).default(75).describe('bar amplitude in % of white'),
  }),
  draw({ dst, params: p }) {
    const c = dst.ctx, W = dst.width, H = dst.height, lv = p.level / 100;
    const col = (i: number, n: number) => [Math.round((i * W) / n), Math.round(((i + 1) * W) / n) - Math.round((i * W) / n)] as const;
    const rows = smpteRows(lv);
    if (p.standard === 'ebu') {
      const cols = ['rgb(255,255,255)', ...rows.top.slice(1), '#000000'];
      cols.forEach((fill, i) => { const [x, w] = col(i, 8); c.fillStyle = fill; c.fillRect(x, 0, w, H); });
      return;
    }
    const h1 = Math.round(H * 0.67), h2 = Math.round(H * 0.75);
    rows.top.forEach((fill, i) => { const [x, w] = col(i, 7); c.fillStyle = fill; c.fillRect(x, 0, w, h1); });
    rows.mid.forEach((fill, i) => { const [x, w] = col(i, 7); c.fillStyle = fill; c.fillRect(x, h1, w, h2 - h1); });
    // bottom: -I, 100% white, +Q, black, PLUGE (below black is impossible in RGB: 0 / 4% / 8%), black
    const bot: [number, string][] = [[5 / 4, 'rgb(0,33,76)'], [5 / 4, '#ffffff'], [5 / 4, 'rgb(50,0,106)'], [5 / 4, '#000000'], [1 / 3, '#000000'], [1 / 3, 'rgb(10,10,10)'], [1 / 3, 'rgb(20,20,20)'], [1, '#000000']];
    const unit = W / 7;
    let x = 0;
    for (const [wu, fill] of bot) { const w = wu * unit; c.fillStyle = fill; c.fillRect(Math.round(x), h2, Math.round(x + w) - Math.round(x), H - h2); x += w; }
  },
});

export const countdownLeader = defineGenerator({
  type: 'countdown-leader',
  describe: 'Film-style countdown leader: a big number per second from `from` down to 1 with a sweeping hand, circles and crosshair (make the clip `from` seconds long).',
  params: z.object({
    from: z.number().int().min(1).max(99).default(5),
    color: color('#ffffff').describe('numbers and lines'),
    bg: color('#202020'),
    sweep: color('rgba(255,255,255,0.18)').describe('colour of the sweeping hand\'s wedge'),
    font: z.string().min(1).default('Inter'),
  }),
  draw({ dst, params: p, frame, fps }) {
    const c = dst.ctx, W = dst.width, H = dst.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.38;
    c.save();
    c.fillStyle = p.bg;
    c.fillRect(0, 0, W, H);
    const sec = frame / fps, n = p.from - Math.floor(sec);
    if (n >= 1) {
      const k = sec - Math.floor(sec), lw = Math.max(2, Math.round(Math.min(W, H) / 270));
      c.fillStyle = p.sweep;
      c.beginPath();
      c.moveTo(cx, cy);
      c.arc(cx, cy, Math.hypot(W, H), -Math.PI / 2, -Math.PI / 2 + k * 2 * Math.PI);
      c.closePath();
      c.fill();
      c.strokeStyle = p.color;
      c.lineWidth = lw;
      c.beginPath(); c.moveTo(0, cy); c.lineTo(W, cy); c.moveTo(cx, 0); c.lineTo(cx, H); c.stroke();
      for (const rr of [R, R * 0.86]) { c.beginPath(); c.arc(cx, cy, rr, 0, 2 * Math.PI); c.stroke(); }
      c.fillStyle = p.color;
      c.font = `700 ${Math.round(R * 1.2)}px "${p.font}"`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(n), cx, cy + R * 0.04);
    }
    c.restore();
  },
});
