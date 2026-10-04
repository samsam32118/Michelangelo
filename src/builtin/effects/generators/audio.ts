/** Audio-reactive generators (plugin API 1.1): a waveform and a spectrum that follow an asset's sound (audiograms). */
import { defineGenerator, z, type AudioLevels, type Canvas2D } from '../../../plugin/api.js';
import { clamp01, color } from '../util.js';

const common = {
  asset: z.string().min(1).describe('id of the audio (or video) asset whose sound to show'),
  color: color('#ffffff'),
  smoothing: z.number().min(0).max(1).default(0.5).describe('0 = jumpy, 1 = smooth (averages neighbouring frames)'),
  gain: z.number().min(0.1).max(10).default(1).describe('scales the levels before drawing'),
  gap: z.number().min(0).max(0.9).default(0.3).describe('space between bars as a fraction of each bar slot'),
  width: z.number().min(0).max(8192).default(0).describe('layer width in px (0 = 80% of the comp width)'),
  height: z.number().min(0).max(8192).default(0).describe('layer height in px (0 = 15% of the comp height)'),
};

function boxSize(p: { width: number; height: number }, comp: { width: number; height: number }): [number, number] {
  return [Math.max(4, Math.round(p.width || comp.width * 0.8)), Math.max(4, Math.round(p.height || comp.height * 0.15))];
}

/** smoothing 0..1 → averaging radius in frames */
const radius = (smoothing: number) => Math.round(smoothing * 4);

/** RMS level (0..1) at source frame f, averaged over ±r frames; 0 outside the sound. */
export function rmsAt(a: AudioLevels | undefined, f: number, r: number): number {
  if (!a || !a.rms.length) return 0;
  let s = 0, n = 0;
  for (let i = Math.round(f) - r; i <= Math.round(f) + r; i++) { n++; if (i >= 0 && i < a.rms.length) s += a.rms[i]!; }
  return n ? s / n : 0;
}

/**
 * `n` values (0..1) of the source's spectrum at frame f (resampled from its bands, low → high), averaged over ±r
 * frames. All zeros without sound.
 */
export function spectrumAt(a: AudioLevels | undefined, f: number, r: number, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  if (!a || !a.bands || !a.spectrum.length) return out;
  const frames = Math.floor(a.spectrum.length / a.bands), B = a.bands;
  const row = new Array<number>(B).fill(0);
  let cnt = 0;
  for (let i = Math.round(f) - r; i <= Math.round(f) + r; i++) {
    cnt++;
    if (i < 0 || i >= frames) continue;
    for (let b = 0; b < B; b++) row[b]! += a.spectrum[i * B + b]!;
  }
  for (let b = 0; b < B; b++) row[b] = row[b]! / Math.max(1, cnt);
  for (let j = 0; j < n; j++) {
    const x = Math.min(B - 1, Math.max(0, ((j + 0.5) / n) * B - 0.5)), i0 = Math.floor(x), i1 = Math.min(B - 1, i0 + 1), t = x - i0;
    out[j] = row[i0]! * (1 - t) + row[i1]! * t;
  }
  return out;
}

function drawBars(ctx: Canvas2D, W: number, H: number, vals: number[], o: { mirror: boolean; gap: number; color: string }) {
  const n = vals.length, slot = W / n, bw = Math.max(1, slot * (1 - o.gap)), minH = Math.max(2, Math.round(H * 0.03));
  ctx.fillStyle = o.color;
  for (let i = 0; i < n; i++) {
    const h = Math.max(minH, vals[i]! * H), x = i * slot + (slot - bw) / 2;
    ctx.fillRect(x, o.mirror ? (H - h) / 2 : H - h, bw, h);
  }
}

export const waveform = defineGenerator({
  type: 'waveform',
  describe: 'Audiogram waveform: the loudness of an asset\'s sound around the current moment, as bars, mirrored bars or a line for podcast videos (gen.asset names the sound).',
  params: z.object({
    ...common,
    style: z.enum(['bars', 'mirror', 'line']).default('mirror').describe('bars grow up from the bottom, mirror from the middle, line is an envelope'),
    bars: z.number().int().min(4).max(512).default(48).describe('number of bars (or line points)'),
    window: z.number().min(0.2).max(60).default(3).describe('seconds of sound shown across the width, centred on now'),
    thickness: z.number().min(1).max(100).default(4).describe('line width in px (style line)'),
  }),
  size: boxSize,
  audioSource: (p) => p.asset,
  draw({ dst, params: p, audio, fps, frame }) {
    const W = dst.width, H = dst.height, n = p.bars, r = radius(p.smoothing);
    const now = audio ? audio.frame : frame, span = Math.max(1, p.window * fps), f0 = now - span / 2;
    const vals = Array.from({ length: n }, (_, i) => {
      const a = f0 + (i * span) / n, b = f0 + ((i + 1) * span) / n;
      let s = 0, k = 0;
      for (let f = Math.floor(a); f < Math.max(Math.floor(a) + 1, Math.floor(b)); f++) { s += rmsAt(audio, f, r); k++; }
      return clamp01((s / Math.max(1, k)) * p.gain);
    });
    const c = dst.ctx;
    if (p.style !== 'line') return drawBars(c, W, H, vals, { mirror: p.style === 'mirror', gap: p.gap, color: p.color });
    const t = Math.min(p.thickness, H / 2);
    c.save();
    c.strokeStyle = p.color;
    c.lineWidth = t;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.beginPath();
    vals.forEach((v, i) => {
      const x = t / 2 + ((W - t) * i) / Math.max(1, n - 1), y = H - t / 2 - v * (H - t);
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    });
    c.stroke();
    c.restore();
  },
});

export const spectrum = defineGenerator({
  type: 'spectrum',
  describe: 'Audio spectrum: bars for low → high frequencies of an asset\'s sound at the current frame for music visualisers (gen.asset names the sound).',
  params: z.object({
    ...common,
    bands: z.number().int().min(4).max(256).default(32).describe('number of bars'),
    style: z.enum(['bars', 'mirror']).default('bars'),
  }),
  size: boxSize,
  audioSource: (p) => p.asset,
  draw({ dst, params: p, audio, frame }) {
    const vals = spectrumAt(audio, audio ? audio.frame : frame, radius(p.smoothing), p.bands).map((v) => clamp01(v * p.gain));
    drawBars(dst.ctx, dst.width, dst.height, vals, { mirror: p.style === 'mirror', gap: p.gap, color: p.color });
  },
});
