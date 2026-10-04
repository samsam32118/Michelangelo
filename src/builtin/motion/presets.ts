/**
 * Built-in motion presets for any visual layer (public plugin API only). Each returns keyframes over `len` frames,
 * relative to the layer's rest state: x/y are px offsets, scale and opacity multiply, rotate adds degrees.
 *
 * Conventions every preset keeps (tests/unit/motion-presets.test.ts):
 * - integer, strictly increasing frames from 0 to len;
 * - in presets end at rest, out presets start at rest, emphasis presets start and end at rest;
 * - cycling loops end where they start (rotate may end a whole turn further); "sustained" loops (ken-burns)
 *   do not cycle: the command stretches them once over the free span.
 * Default moves stay small so a layer stays inside the frame and safe area; `offscreen: true` makes slides,
 * drops and whips start (or end) fully off-frame.
 */
import { z, defineMotionPreset, type MotionPresetDef } from '../../plugin/api.js';

type Key = [number, number, string?];
type Keys = Partial<Record<'x' | 'y' | 'scale' | 'rotate' | 'opacity', Key[]>>;
type Args = Parameters<MotionPresetDef['keys']>[0];

const amount = z.number().min(0).max(4).default(1).describe('strength multiplier (1 = default)');
const P = {
  basic: z.object({ amount }),
  slide: z.object({
    amount,
    distance: z.number().min(0).optional().describe('travel in px (default ~12% of the short side; offscreen: fully off-frame)'),
    offscreen: z.boolean().default(false).describe('start (in) or end (out) fully outside the frame'),
  }),
  whip: z.object({
    amount,
    direction: z.enum(['left', 'right']).default('left').describe('direction of travel'),
    offscreen: z.boolean().default(true).describe('start (in) or end (out) fully outside the frame'),
  }),
};

/**
 * Keys from (fraction of len, value, easing) stops: frames are rounded to integers; the first stop is at 0 and the
 * last at len; an in-between stop that would not land strictly between its neighbours (very short len) is dropped.
 */
function at(len: number, stops: [number, number, string?][]): Key[] {
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const out: Key[] = [];
  stops.forEach(([p, v, e], i) => {
    const last = i === stops.length - 1;
    const f = i === 0 ? 0 : last ? len : Math.round(p * len);
    if (!last && i > 0 && (f <= out[out.length - 1]![0] || f >= len)) return;
    out.push(e && !last ? [f, r4(v), e] : [f, r4(v)]);
  });
  return out;
}

/** The easing that traces the same curve backwards in time (out ↔ in; inOut and linear stay). */
export function reverseEase(e: string | undefined): string | undefined {
  if (!e || e === 'linear') return e;
  if (e.startsWith('inOut')) return e;
  if (e.startsWith('out')) return `in${e.slice(3)}`;
  if (e.startsWith('in')) return `out${e.slice(2)}`;
  return e;
}

/** Play keys backwards over len: an in preset becomes the matching out preset. */
export function mirror(keys: Keys, len: number): Keys {
  const out: Keys = {};
  for (const [prop, ks] of Object.entries(keys) as [keyof Keys, Key[]][]) {
    const r: Key[] = [];
    for (let i = ks.length - 1; i >= 0; i--) {
      const k = ks[i]!;
      // the segment ending at k (shaped by the key before it) now starts at k
      const e = i > 0 ? reverseEase(ks[i - 1]![2]) : undefined;
      r.push(e ? [len - k[0], k[1], e] : [len - k[0], k[1]]);
    }
    out[prop] = r;
  }
  return out;
}

const num = (p: Record<string, unknown>, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
const short = (a: Args) => Math.min(a.comp.width, a.comp.height);
/** slide travel: the distance param, fully off-frame, or ~12% of the short side × amount */
function travel(a: Args, axis: 'x' | 'y'): number {
  const p = a.params;
  if (typeof p.distance === 'number') return p.distance;
  if (p.offscreen) return axis === 'x' ? a.comp.width + a.size.w / 2 : a.comp.height + a.size.h / 2;
  return Math.round(short(a) * 0.12 * num(p, 'amount', 1));
}
const fadeIn = (len: number, frac = 0.6): Key[] => at(len, [[0, 0, 'outQuad'], [frac, 1]]);

// ---------------------------------------------------------------------------
// in presets (and their out mirrors)
// ---------------------------------------------------------------------------

interface InSpec { base: string; describe: string; outDescribe: string; params?: z.ZodObject; seconds: number; keys(a: Args): Keys }

const slide = (dir: 'up' | 'down' | 'left' | 'right') => (a: Args): Keys => {
  const axis = dir === 'up' || dir === 'down' ? 'y' : 'x';
  // "up" comes from below (+y) moving up; "left" comes from the right (+x) moving left
  const d = travel(a, axis) * (dir === 'up' || dir === 'left' ? 1 : -1);
  const keys: Keys = { [axis]: at(a.len, [[0, d, a.params.offscreen ? 'outExpo' : 'outCubic'], [1, 0]]) };
  if (!a.params.offscreen) keys.opacity = fadeIn(a.len);
  return keys;
};

const IN: InSpec[] = [
  {
    base: 'fade', seconds: 0.4, describe: 'Fade in from transparent.', outDescribe: 'Fade out to transparent.',
    keys: (a) => ({ opacity: at(a.len, [[0, 0, 'outQuad'], [1, 1]]) }),
  },
  {
    base: 'pop', seconds: 0.45, describe: 'Grow from 30% with a springy overshoot while fading in (the social-video default).', outDescribe: 'Swell slightly, then shrink to 30% while fading out.',
    keys: (a) => ({ scale: at(a.len, [[0, 1 - 0.7 * Math.min(1, num(a.params, 'amount', 1)), 'outBack'], [1, 1]]), opacity: fadeIn(a.len, 0.4) }),
  },
  ...(['up', 'down', 'left', 'right'] as const).map((dir): InSpec => ({
    base: `slide-${dir}`, seconds: 0.5, params: P.slide,
    describe: `Slide ${dir} into place (~12% of the short side, fading in; offscreen=true: from outside the frame).`,
    outDescribe: `Slide ${dir} out of place (~12% of the short side, fading out; offscreen=true: to outside the frame).`,
    // an out slide moving up is an in slide moving down, played backwards
    keys: slide(dir),
  })),
  {
    base: 'zoom', seconds: 0.5, describe: 'Zoom up from 50% size while fading in (smooth, no overshoot).', outDescribe: 'Zoom down to 50% size while fading out.',
    keys: (a) => ({ scale: at(a.len, [[0, 1 - 0.5 * Math.min(1.8, num(a.params, 'amount', 1)), 'outCubic'], [1, 1]]), opacity: fadeIn(a.len, 0.5) }),
  },
  {
    base: 'focus', seconds: 0.6, describe: 'Settle from 115% size while fading in: a soft, blur-in-like reveal (opacity + scale only).', outDescribe: 'Grow to 115% while fading out: a soft dissolve forward.',
    keys: (a) => ({ scale: at(a.len, [[0, 1 + 0.15 * num(a.params, 'amount', 1), 'outQuart'], [1, 1]]), opacity: at(a.len, [[0, 0, 'outSine'], [0.8, 1]]) }),
  },
  {
    base: 'drop', seconds: 0.7, params: P.slide, describe: 'Fall from above and bounce to rest (offscreen=true: from above the frame).', outDescribe: 'Hop up slightly, then fall down and away while fading out (offscreen=true: below the frame).',
    keys: (a) => {
      const d = typeof a.params.distance === 'number' ? a.params.distance : a.params.offscreen ? a.comp.height + a.size.h / 2 : Math.round(short(a) * 0.2 * num(a.params, 'amount', 1));
      return { y: at(a.len, [[0, -d, 'outBounce'], [1, 0]]), ...(a.params.offscreen ? {} : { opacity: fadeIn(a.len, 0.25) }) };
    },
  },
  {
    base: 'spin', seconds: 0.6, describe: 'Spin a half turn while growing from 30% and fading in.', outDescribe: 'Spin a half turn while shrinking to 30% and fading out.',
    keys: (a) => ({
      rotate: at(a.len, [[0, -180 * num(a.params, 'amount', 1), 'outCubic'], [1, 0]]),
      scale: at(a.len, [[0, 0.3, 'outBack'], [1, 1]]),
      opacity: fadeIn(a.len, 0.35),
    }),
  },
  {
    base: 'whip', seconds: 0.4, params: P.whip, describe: 'Whip in fast from the side (direction= of travel, default left: from the right edge), overshoot a touch and settle.', outDescribe: 'Whip out fast to the side (direction= of travel, default left).',
    keys: (a) => {
      const sign = a.params.direction === 'right' ? -1 : 1;
      const d = (a.params.offscreen === false ? Math.round(short(a) * 0.35) : a.comp.width + a.size.w / 2) * sign;
      const over = -Math.round(short(a) * 0.025 * num(a.params, 'amount', 1)) * sign;
      return {
        x: at(a.len, [[0, d, 'outExpo'], [0.6, over, 'inOutSine'], [1, 0]]),
        rotate: at(a.len, [[0, 6 * sign * num(a.params, 'amount', 1), 'outCubic'], [0.6, -1.5 * sign, 'inOutSine'], [1, 0]]),
        ...(a.params.offscreen === false ? { opacity: fadeIn(a.len, 0.3) } : {}),
      };
    },
  },
];

const inPresets = IN.map((s) => defineMotionPreset({
  id: `${s.base}-in`, phase: 'in', describe: s.describe, seconds: s.seconds, params: s.params ?? P.basic, keys: s.keys,
}));

/** out presets: the in preset played backwards; slides/whips/drops leave in their own direction. */
const OUT_SOURCE: Record<string, (a: Args) => Keys> = {
  'slide-up': slide('down'), 'slide-down': slide('up'), 'slide-left': slide('right'), 'slide-right': slide('left'),
  whip: (a) => IN.find((s) => s.base === 'whip')!.keys({ ...a, params: { ...a.params, direction: a.params.direction === 'right' ? 'left' : 'right' } }),
};
const outPresets = IN.map((s) => defineMotionPreset({
  id: `${s.base}-out`, phase: 'out', describe: s.outDescribe, seconds: s.seconds, params: s.params ?? P.basic,
  keys: s.base === 'drop'
    ? (a) => {
      const d = typeof a.params.distance === 'number' ? a.params.distance : a.params.offscreen ? a.comp.height + a.size.h / 2 : Math.round(short(a) * 0.2 * num(a.params, 'amount', 1));
      return {
        y: at(a.len, [[0, 0, 'outQuad'], [0.25, -Math.round(short(a) * 0.03), 'inCubic'], [1, d]]),
        ...(a.params.offscreen ? {} : { opacity: at(a.len, [[0, 1], [0.45, 1, 'inQuad'], [1, 0]]) }),
      };
    }
    : (a) => mirror((OUT_SOURCE[s.base] ?? s.keys)(a), a.len),
}));

// ---------------------------------------------------------------------------
// emphasis: start and end at rest
// ---------------------------------------------------------------------------

/** decaying oscillation stops: n half-swings of ±amp, shrinking to 0 */
function oscillate(n: number, amp: number): [number, number, string?][] {
  const stops: [number, number, string?][] = [[0, 0, 'inOutSine']];
  for (let i = 1; i <= n; i++) stops.push([i / (n + 1), amp * (i % 2 ? 1 : -1) * (1 - (i - 1) / n), 'inOutSine']);
  stops.push([1, 0]);
  return stops;
}

const emphasis: MotionPresetDef[] = [
  defineMotionPreset({
    id: 'pulse', phase: 'emphasis', seconds: 0.5, params: P.basic, describe: 'Swell to 112% and back: a soft beat.',
    keys: (a) => ({ scale: at(a.len, [[0, 1, 'inOutSine'], [0.45, 1 + 0.12 * num(a.params, 'amount', 1), 'inOutSine'], [1, 1]]) }),
  }),
  defineMotionPreset({
    id: 'punch', phase: 'emphasis', seconds: 0.35, params: P.basic, describe: 'Quick scale punch to 120%, settling back with a small rebound.',
    keys: (a) => ({ scale: at(a.len, [[0, 1, 'outCubic'], [0.25, 1 + 0.2 * num(a.params, 'amount', 1), 'outBack'], [1, 1]]) }),
  }),
  defineMotionPreset({
    id: 'shake', phase: 'emphasis', seconds: 0.5, params: P.basic, describe: 'Rattle left-right (±2% of the short side), dying out.',
    keys: (a) => ({ x: at(a.len, oscillate(6, Math.round(short(a) * 0.02 * num(a.params, 'amount', 1)))) }),
  }),
  defineMotionPreset({
    id: 'wiggle', phase: 'emphasis', seconds: 0.6, params: P.basic, describe: 'Rock ±7° side to side, dying out.',
    keys: (a) => ({ rotate: at(a.len, oscillate(5, 7 * num(a.params, 'amount', 1))) }),
  }),
  defineMotionPreset({
    id: 'bounce', phase: 'emphasis', seconds: 0.6, params: P.basic, describe: 'Hop up (5% of the short side) and land, with a small second hop.',
    keys: (a) => {
      const h = Math.round(short(a) * 0.05 * num(a.params, 'amount', 1));
      return {
        y: at(a.len, [[0, 0, 'outQuad'], [0.3, -h, 'inQuad'], [0.6, 0, 'outQuad'], [0.8, -h * 0.3, 'inQuad'], [1, 0]]),
        scale: at(a.len, [[0, 1, 'outQuad'], [0.3, 1.04, 'inQuad'], [0.6, 0.97, 'outQuad'], [1, 1]]),
      };
    },
  }),
  defineMotionPreset({
    id: 'nod', phase: 'emphasis', seconds: 0.6, params: P.basic, describe: 'Two small nods: dip down and tilt forward, then back.',
    keys: (a) => {
      const d = Math.round(short(a) * 0.015 * num(a.params, 'amount', 1));
      return {
        y: at(a.len, [[0, 0, 'inOutSine'], [0.25, d, 'inOutSine'], [0.5, 0, 'inOutSine'], [0.75, d * 0.6, 'inOutSine'], [1, 0]]),
        rotate: at(a.len, [[0, 0, 'inOutSine'], [0.25, 3 * num(a.params, 'amount', 1), 'inOutSine'], [0.5, 0, 'inOutSine'], [0.75, 1.8, 'inOutSine'], [1, 0]]),
      };
    },
  }),
  defineMotionPreset({
    id: 'flash', phase: 'emphasis', seconds: 0.5, params: P.basic, describe: 'Blink twice (opacity dips to 25%) to catch the eye.',
    keys: (a) => {
      const lo = Math.max(0, 1 - 0.75 * num(a.params, 'amount', 1));
      return { opacity: at(a.len, [[0, 1, 'inOutSine'], [0.25, lo, 'inOutSine'], [0.5, 1, 'inOutSine'], [0.75, lo, 'inOutSine'], [1, 1]]) };
    },
  }),
  defineMotionPreset({
    id: 'tada', phase: 'emphasis', seconds: 0.8, params: P.basic, describe: 'Shrink a touch, then grow to 110% while rocking ±4°, and settle (a celebratory accent).',
    keys: (a) => {
      const k = num(a.params, 'amount', 1);
      return {
        scale: at(a.len, [[0, 1, 'outQuad'], [0.15, 1 - 0.08 * k, 'outBack'], [0.35, 1 + 0.1 * k, 'inOutSine'], [0.85, 1 + 0.1 * k, 'inOutSine'], [1, 1]]),
        rotate: at(a.len, [[0, 0], [0.35, 0, 'inOutSine'], [0.45, 4 * k, 'inOutSine'], [0.55, -4 * k, 'inOutSine'], [0.65, 4 * k, 'inOutSine'], [0.75, -4 * k, 'inOutSine'], [0.85, 0, 'inOutSine'], [1, 0]]),
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// loops: one cycle over len (the command repeats it to fill the free span)
// ---------------------------------------------------------------------------

/** one sine cycle 0 → +amp → 0 → −amp → 0 as eased quarter segments (exact sine shape, 5 keys) */
const sine = (len: number, amp: number, phase: 0 | 0.5 = 0): Key[] =>
  at(len, phase === 0
    ? [[0, 0, 'outSine'], [0.25, amp, 'inSine'], [0.5, 0, 'outSine'], [0.75, -amp, 'inSine'], [1, 0]]
    : [[0, 0, 'outSine'], [0.25, -amp, 'inSine'], [0.5, 0, 'outSine'], [0.75, amp, 'inSine'], [1, 0]]);

const loops: MotionPresetDef[] = [
  defineMotionPreset({
    id: 'float', phase: 'loop', seconds: 2.4, params: P.basic, describe: 'Bob gently up and down (1.2% of the short side) — an idle hover.',
    keys: (a) => ({ y: at(a.len, [[0, 0, 'inOutSine'], [0.5, -Math.round(short(a) * 0.012 * num(a.params, 'amount', 1)), 'inOutSine'], [1, 0]]) }),
  }),
  defineMotionPreset({
    id: 'breathe', phase: 'loop', seconds: 3, params: P.basic, describe: 'Slowly swell to 104% and back.',
    keys: (a) => ({ scale: at(a.len, [[0, 1, 'inOutSine'], [0.5, 1 + 0.04 * num(a.params, 'amount', 1), 'inOutSine'], [1, 1]]) }),
  }),
  defineMotionPreset({
    id: 'sway', phase: 'loop', seconds: 3, params: P.basic, describe: 'Rock ±3° like a hanging sign.',
    keys: (a) => ({ rotate: sine(a.len, 3 * num(a.params, 'amount', 1)) }),
  }),
  defineMotionPreset({
    id: 'spin', phase: 'loop', seconds: 4, params: P.basic, describe: 'Turn continuously, one full turn per cycle (badges, stickers, loaders).',
    keys: (a) => ({ rotate: at(a.len, [[0, 0, 'linear'], [1, 360]]) }),
  }),
  defineMotionPreset({
    id: 'drift', phase: 'loop', seconds: 6, params: P.basic, describe: 'Wander slowly in a figure eight (±1.5% of the short side) — subtle life for stills and cards.',
    keys: (a) => {
      const r = Math.round(short(a) * 0.015 * num(a.params, 'amount', 1));
      if (a.len < 4) return { x: sine(a.len, r) };
      const half = Math.floor(a.len / 2);
      // y runs two sine cycles per x cycle
      const y1 = sine(half, Math.round(r / 2), 0.5);
      const y = [...y1, ...sine(a.len - half, Math.round(r / 2), 0.5).slice(1).map(([f, v, e]): Key => (e ? [f + half, v, e] : [f + half, v]))];
      return { x: sine(a.len, r), y };
    },
  }),
  defineMotionPreset({
    id: 'ken-burns-in', phase: 'loop', seconds: 6, params: P.basic, describe: 'Slow push in to 112% across the whole span (sustained, not cycled) — for photos and b-roll.',
    keys: (a) => ({ scale: at(a.len, [[0, 1, 'inOutSine'], [1, 1 + 0.12 * num(a.params, 'amount', 1)]]) }),
  }),
  defineMotionPreset({
    id: 'ken-burns-out', phase: 'loop', seconds: 6, params: P.basic, describe: 'Slow pull out from 112% to rest across the whole span (sustained; never below rest, so cover-fit media keep filling the frame).',
    keys: (a) => ({ scale: at(a.len, [[0, 1 + 0.12 * num(a.params, 'amount', 1), 'inOutSine'], [1, 1]]) }),
  }),
];

/** Every built-in motion preset. */
export const motionPresets: MotionPresetDef[] = [...inPresets, ...outPresets, ...emphasis, ...loops];
export const MOTION_PRESET_IDS: string[] = motionPresets.map((m) => m.id);
