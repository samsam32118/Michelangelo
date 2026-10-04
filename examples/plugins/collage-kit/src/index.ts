/**
 * collage-kit: the hand-cut paper collage look.
 *  - effect    paper-boil    stop-motion jitter: the layer is re-registered every `step` frames (shot "on threes")
 *  - effect    ink-flat      fills the layer's shape with one flat ink colour (silhouette fills)
 *  - generator paper-field   flat colour field with paper mottle, dust and hairs that change every `step` frames
 *  - template  cutout        a sticker asset that is slapped down in stepped frames, with shadow and boil
 *  - template  tape-label    a paper strip with text, held by two bits of tape
 *  - template  paper-number  a huge number/word printed on a torn paper scrap
 */
import { definePlugin, defineEffect, defineGenerator, defineTemplate, z, type TemplateOutput } from 'michelangelo/plugin';

type Clip = NonNullable<TemplateOutput['clips']>[number];
/** a keyframe: [frame, value] or [frame, value, 'hold'] (stepped, like a pose held for a few frames) */
type Key = [number, number] | [number, number, 'hold'];
type Value = number | Key[];
const hold = (frame: number, value: number): Key => [frame, value, 'hold'];
const key = (frame: number, value: number): Key => [frame, value];

function random(...ns: number[]): () => number {
  let a = 0x2545f491;
  for (const n of ns) a = Math.imul(a ^ (n | 0), 0x9e3779b1) ^ (a >>> 15);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const boil = defineEffect({
  type: 'paper-boil',
  describe: 'Stop-motion jitter: every `step` frames the layer lands a few px and a fraction of a degree off, like paper re-placed by hand.',
  params: z.object({
    step: z.number().int().min(1).max(30).default(3).describe('frames each pose is held'),
    shift: z.number().min(0).max(60).default(3).describe('max offset in px'),
    tilt: z.number().min(0).max(10).default(0.5).describe('max rotation in degrees'),
    seed: z.number().int().default(1),
  }),
  margin: (p) => Math.ceil(p.shift + 8),
  draw({ src, dst, params: p, frame, seed }) {
    const r = random(seed, p.seed, Math.floor(frame / p.step));
    const dx = (r() * 2 - 1) * p.shift, dy = (r() * 2 - 1) * p.shift, rot = ((r() * 2 - 1) * p.tilt * Math.PI) / 180;
    const c = dst.ctx, w = dst.width, h = dst.height;
    c.save();
    c.translate(w / 2 + dx, h / 2 + dy);
    c.rotate(rot);
    c.drawImage(src.canvas, -w / 2, -h / 2);
    c.restore();
  },
});

const inkFlat = defineEffect({
  type: 'ink-flat',
  describe: 'Fills the layer shape with one flat ink colour (amount 1 = solid silhouette), keeping the alpha.',
  params: z.object({ color: z.string().default('#ff5a1f'), amount: z.number().min(0).max(1).default(1) }),
  draw({ src, dst, params: p }) {
    const c = dst.ctx;
    c.drawImage(src.canvas, 0, 0);
    c.save();
    c.globalCompositeOperation = 'source-atop';
    c.globalAlpha = p.amount;
    c.fillStyle = p.color;
    c.fillRect(0, 0, dst.width, dst.height);
    c.restore();
  },
});

const field = defineGenerator({
  type: 'paper-field',
  describe: 'A flat colour field with paper mottle, a soft vignette, and dust specks and hairs that change every `step` frames.',
  params: z.object({
    color: z.string().default('#1f3fe0'),
    dust: z.number().int().min(0).max(400).default(55),
    step: z.number().int().min(1).max(30).default(3),
    mottle: z.number().min(0).max(1).default(0.35),
    seed: z.number().int().default(1),
  }),
  draw({ dst, params: p, frame, seed }) {
    const c = dst.ctx, W = dst.width, H = dst.height;
    c.fillStyle = p.color;
    c.fillRect(0, 0, W, H);
    // mottle: big soft blotches, fixed per seed (the paper itself does not change)
    const m = random(seed, p.seed, 7);
    for (let i = 0; i < 26; i++) {
      const x = m() * W, y = m() * H, rad = (0.15 + m() * 0.35) * W;
      const g = c.createRadialGradient(x, y, 0, x, y, rad);
      const dark = m() < 0.5;
      g.addColorStop(0, dark ? `rgba(0,0,30,${0.10 * p.mottle})` : `rgba(255,255,255,${0.07 * p.mottle})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }
    const v = c.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,20,0.28)');
    c.fillStyle = v;
    c.fillRect(0, 0, W, H);
    // dust and hairs: re-rolled every step
    const r = random(seed, p.seed, Math.floor(frame / p.step) + 100);
    for (let i = 0; i < p.dust; i++) {
      const x = r() * W, y = r() * H, s = 0.6 + r() * 2.2;
      c.fillStyle = r() < 0.6 ? `rgba(255,255,255,${0.25 + r() * 0.5})` : `rgba(0,0,20,${0.3 + r() * 0.4})`;
      c.beginPath();
      c.ellipse(x, y, s, s * (0.5 + r()), r() * 3, 0, Math.PI * 2);
      c.fill();
    }
    for (let i = 0; i < Math.round(p.dust / 14); i++) {
      const x = r() * W, y = r() * H, a = r() * Math.PI * 2, l = 20 + r() * 70;
      c.strokeStyle = `rgba(0,0,20,${0.35 + r() * 0.3})`;
      c.lineWidth = 1 + r();
      c.beginPath();
      c.moveTo(x, y);
      c.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (r() - 0.5) * 30, y + Math.sin(a) * l * 0.5 + (r() - 0.5) * 30, x + Math.cos(a) * l, y + Math.sin(a) * l);
      c.stroke();
    }
  },
});


const dotGrid = defineGenerator({
  type: 'dot-grid',
  describe: 'A grid of paper squares revealed row by row with a few lit ones ("3 in every 1,000"): proportion you can see.',
  params: z.object({
    cols: z.number().int().min(1).max(100).default(40), rows: z.number().int().min(1).max(100).default(25),
    lit: z.number().int().min(0).default(3), cell: z.number().default(19), gap: z.number().default(4),
    x: z.number().default(540), y: z.number().default(1090),
    color: z.string().default('#3a3d47'), litColor: z.string().default('#ff5a1f'),
    reveal: z.number().int().default(14).describe('frames to reveal all rows'), seed: z.number().int().default(4),
  }),
  draw({ dst, params: p, frame, seed }) {
    const c = dst.ctx, pitch = p.cell + p.gap;
    const x0 = p.x - (p.cols * pitch - p.gap) / 2, y0 = p.y - (p.rows * pitch - p.gap) / 2;
    const r = random(seed, p.seed);
    const lit = new Set<number>();
    while (lit.size < Math.min(p.lit, p.cols * p.rows)) lit.add(Math.floor(r() * p.cols * p.rows));
    const shown = Math.min(p.rows, Math.ceil(((Math.floor(frame / 2) * 2 + 2) / p.reveal) * p.rows));
    const j = random(seed, p.seed, Math.floor(frame / 3));
    const dx = (j() - 0.5) * 3, dy = (j() - 0.5) * 3;
    for (let row = 0; row < shown; row++) for (let col = 0; col < p.cols; col++) {
      const on = lit.has(row * p.cols + col);
      const grow = on && frame > p.reveal ? 9 + 3 * Math.sin(frame / 2) : 0;
      c.fillStyle = on && frame > p.reveal - 4 ? p.litColor : p.color;
      c.fillRect(x0 + col * pitch + dx - grow, y0 + row * pitch + dy - grow, p.cell + grow * 2, p.cell + grow * 2);
    }
  },
});

const cutoutParams = z.object({
  asset: z.string().default('sticker').describe('id of a sticker image asset (transparent PNG)'),
  x: z.number().default(540), y: z.number().default(960),
  scale: z.number().default(1), rotate: z.number().default(0),
  from: z.enum(['left', 'right', 'top', 'bottom', 'pop', 'none']).default('bottom'),
  exit: z.enum(['left', 'right', 'top', 'bottom', 'none']).default('none'),
  boil: z.number().min(0).max(20).default(3), seed: z.number().int().default(1),
  shadow: z.boolean().default(true),
});

/** stepped ("on twos") slide: a few held poses overshooting slightly, like paper pushed in by hand */

const cutout = defineTemplate({
  id: 'cutout',
  describe: 'A paper sticker slapped onto the frame in stepped stop-motion poses (from a side or popped), with drop shadow and boil.',
  params: cutoutParams,
  build({ params: raw, comp, at, len: given, rate }) {
    const p = cutoutParams.parse(raw);
    const [W, H] = comp.size;
    const len = given ?? Math.round((3 * rate.num) / rate.den);
    const far = { left: [-W * 0.9, 0], right: [W * 0.9, 0], top: [0, -H * 0.8], bottom: [0, H * 0.8], pop: [0, 0], none: [0, 0] } as const;
    const [fx, fy] = far[p.from];
    const poses = [1, 0.42, 0.1, -0.035, 0];           // fraction of the travel left, one pose per 2 frames
    const slide = (rest: number, d: number): Key[] => poses.map((f, i) => hold(i * 2, Math.round(rest + d * f)));
    let x: Value = p.x, y: Value = p.y, scale: Value = p.scale, rotate: Value = p.rotate;
    if (p.from !== 'none' && p.from !== 'pop') {
      if (fx) x = slide(p.x, fx);
      if (fy) y = slide(p.y, fy);
      rotate = [hold(0, p.rotate - 7), hold(2, p.rotate + 4), hold(4, p.rotate - 2), hold(6, p.rotate + 1), key(8, p.rotate)];
    } else if (p.from === 'pop') {
      scale = [hold(0, p.scale * 0.2), hold(2, p.scale * 1.12), hold(4, p.scale * 0.96), key(6, p.scale)];
      rotate = [hold(0, p.rotate - 9), hold(2, p.rotate + 5), hold(4, p.rotate - 2), key(6, p.rotate)];
    }
    if (p.exit !== 'none') {
      const [ex, ey] = far[p.exit];
      const out = [0, 0.06, 0.4, 1.1];
      const leave = (cur: Value, rest: number, d: number): Key[] => {
        const base: Key[] = Array.isArray(cur) ? cur.map((k) => hold(k[0], k[1])) : [hold(0, rest)];
        const start = len - out.length * 2;
        out.forEach((f, i) => base.push(hold(start + i * 2, Math.round(rest + d * f))));
        return base;
      };
      if (ex) x = leave(x, p.x, ex);
      if (ey) y = leave(y, p.y, ey);
    }
    const clip: Clip = {
      id: 'sticker', track: 'sticker', at, len, asset: p.asset, fit: 'none', x, y, scale, rotate,
      fx: [
        ...(p.shadow ? [{ type: 'shadow', x: 10, y: 14, blur: 10, opacity: 0.35 }] : []),
        ...(p.boil > 0 ? [{ type: 'paper-boil', shift: p.boil, tilt: 0.45, seed: p.seed }] : []),
      ],
    };
    return { clips: [clip], summary: `cutout ${p.asset} from ${p.from}` };
  },
});

const labelParams = z.object({
  text: z.string().min(1).default('ONE STUDY\u2019S ESTIMATE'),
  x: z.number().default(540), y: z.number().default(300), rotate: z.number().default(-3),
  size: z.number().default(44), paper: z.string().default('#f4f1e6'), ink: z.string().default('#111111'),
  tape: z.string().default('#ffd84a'), font: z.string().default('JetBrains Mono'), weight: z.number().default(700),
  width: z.number().optional(), seed: z.number().int().default(3),
});

const tapeLabel = defineTemplate({
  id: 'tape-label',
  describe: 'A strip of paper with typewriter text, stuck down with two pieces of tape; pops on in stepped poses.',
  params: labelParams,
  build({ params: raw, at, len: given, rate }) {
    const p = labelParams.parse(raw);
    const len = given ?? Math.round((3 * rate.num) / rate.den);
    const lines = p.text.split('\n');
    const longest = Math.max(...lines.map((l) => l.length));
    const w = Math.round(p.width ?? longest * p.size * 0.62 + 70), h = Math.round(lines.length * p.size * 1.25 + 36);
    const pop: Key[] = [hold(0, 0.3), hold(2, 1.1), hold(4, 0.97), key(6, 1)];
    const boilFx = { type: 'paper-boil', shift: 2, tilt: 0.3, seed: p.seed };
    const rad = (p.rotate * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const off = (dx: number, dy: number) => ({ x: Math.round(p.x + dx * cos - dy * sin), y: Math.round(p.y + dx * sin + dy * cos) });
    const clips: Clip[] = [
      { id: 'paper', track: 'paper', at, len, shape: { type: 'rect', size: [w, h], fill: p.paper }, x: p.x, y: p.y, rotate: p.rotate, scale: pop, fx: [{ type: 'shadow', x: 6, y: 8, blur: 8, opacity: 0.3 }, boilFx] },
      { id: 'text', track: 'text', at, len, text: p.text, style: { font: p.font, size: p.size, weight: p.weight, color: p.ink, align: 'center', lineHeight: 1.2, maxWidth: w - 30 }, x: p.x, y: p.y, rotate: p.rotate, scale: pop, fx: [boilFx], tags: ['qa-ignore:text-overlap'] },
      { id: 'tape-a', track: 'tape-a', at: at + 3, len: len - 3, shape: { type: 'rect', size: [96, 34], fill: p.tape }, ...off(-w / 2 + 8, -h / 2 + 4), rotate: p.rotate - 38, opacity: 0.82, fx: [boilFx] },
      { id: 'tape-b', track: 'tape-b', at: at + 5, len: len - 5, shape: { type: 'rect', size: [96, 34], fill: p.tape }, ...off(w / 2 - 8, h / 2 - 4), rotate: p.rotate - 32, opacity: 0.82, fx: [boilFx] },
    ];
    return { clips, summary: `tape label "${lines[0]}"` };
  },
});

const numberParams = z.object({
  text: z.string().min(1).default('74%'),
  x: z.number().default(540), y: z.number().default(700), rotate: z.number().default(-4),
  size: z.number().default(420), paper: z.string().default('#f4f1e6'), ink: z.string().default('#111111'),
  font: z.string().default('Anton'), from: z.enum(['top', 'pop', 'none']).default('top'), seed: z.number().int().default(5),
  pad: z.number().default(60),
  width: z.number().optional().describe('measured text width in px (else estimated)'),
});

/** a torn-paper outline: a rectangle whose edges wander */
function tornPath(w: number, h: number, seed: number): string {
  const r = random(seed, 99);
  const pts: [number, number][] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const t = i / n, j = 9;
      pts.push([x0 + (x1 - x0) * t + (r() - 0.5) * j * 2, y0 + (y1 - y0) * t + (r() - 0.5) * j * 2]);
    }
  };
  const m = 12;
  edge(m, m, w - m, m, Math.round(w / 34)); edge(w - m, m, w - m, h - m, Math.round(h / 34));
  edge(w - m, h - m, m, h - m, Math.round(w / 34)); edge(m, h - m, m, m, Math.round(h / 34));
  return 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L') + ' Z';
}

const paperNumber = defineTemplate({
  id: 'paper-number',
  describe: 'A huge number or word printed on a torn scrap of paper that drops in (stepped) and boils.',
  params: numberParams,
  build({ params: raw, comp, at, len: given, rate }) {
    const p = numberParams.parse(raw);
    const len = given ?? Math.round((3 * rate.num) / rate.den);
    const w = Math.round((p.width ?? p.text.length * p.size * 0.66) + p.pad * 2), h = Math.round(p.size * 1.12 + p.pad);
    const boilFx = { type: 'paper-boil', shift: 3, tilt: 0.4, seed: p.seed };
    const H = comp.size[1];
    const drop: { y: Value; scale?: Value } = p.from === 'top'
      ? { y: [hold(0, p.y - H * 0.7), hold(2, p.y - H * 0.25), hold(4, p.y + 26), hold(6, p.y - 8), key(8, p.y)] }
      : p.from === 'pop' ? { y: p.y, scale: [hold(0, 0.3), hold(2, 1.14), hold(4, 0.96), key(6, 1)] } : { y: p.y };
    const clips: Clip[] = [
      { id: 'scrap', track: 'scrap', at, len, shape: { type: 'path', size: [w, h], d: tornPath(w, h, p.seed), fill: p.paper }, x: p.x, rotate: p.rotate, ...drop, fx: [{ type: 'shadow', x: 10, y: 14, blur: 10, opacity: 0.35 }, boilFx] },
      { id: 'ink', track: 'ink', at, len, text: p.text, style: { font: p.font, size: p.size, color: p.ink, align: 'center', lineHeight: 1, maxWidth: 4000 }, x: p.x, rotate: p.rotate, ...drop, fx: [boilFx], tags: ['qa-ignore:text-overlap'] },
    ];
    return { clips, summary: `paper number "${p.text}"` };
  },
});

export default definePlugin({ name: 'collage-kit', version: '1.0.0', effects: [boil, inkFlat], generators: [field, dotGrid], templates: [cutout, tapeLabel, paperNumber] });
