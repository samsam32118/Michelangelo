import { definePlugin, defineEffect, defineGenerator, z, type FilterSpec } from 'michelangelo/plugin';

/**
 * An audio effect (plugin API 1.1): only an audio() stage. It narrows the sound to a phone line's band and adds
 * a little grit. Works on a clip with sound or on a bus: fx.add bus=dialogue type=telephone.
 */
const telephone = defineEffect({
  type: 'telephone',
  describe: 'Audio: a telephone / radio voice (band-limited to low..high Hz, with optional grit 0..1).',
  params: z.object({
    low: z.number().min(100).max(1000).default(300).describe('lowest frequency kept, Hz'),
    high: z.number().min(1500).max(8000).default(3400).describe('highest frequency kept, Hz'),
    grit: z.number().min(0).max(1).default(0.3).describe('bit-crush amount (0 = clean)'),
  }),
  audio(p) {
    const chain: FilterSpec[] = [
      { filter: 'highpass', args: { f: p.low, poles: 2 } },
      { filter: 'lowpass', args: { f: p.high, poles: 2 } },
    ];
    if (p.grit > 0) chain.push({ filter: 'acrusher', args: { bits: Math.round(16 - p.grit * 10), mix: Math.round(p.grit * 100) / 100, mode: 'log' } });
    chain.push({ filter: 'volume', args: { volume: '3dB' } });
    return chain;
  },
});

/**
 * An audio-reactive generator (plugin API 1.1): audioSource() names the asset whose sound it shows, and draw()
 * gets `audio` with per-frame RMS levels (0..1) and a spectrum. A vertical meter with a peak-hold tick.
 */
const levelMeter = defineGenerator({
  type: 'level-meter',
  describe: 'A vertical level meter (green → yellow → red) showing the loudness of an asset\'s sound, with a peak-hold tick.',
  params: z.object({
    asset: z.string().default('').describe('id of the audio (or video) asset whose sound to show'),
    width: z.number().min(4).max(400).default(40).describe('meter width in px'),
    height: z.number().min(20).max(4000).default(300).describe('meter height in px'),
    hold: z.number().int().min(1).max(120).default(15).describe('frames the peak tick holds'),
  }),
  size: (p) => [p.width, p.height],
  audioSource: (p) => p.asset || undefined,
  draw({ dst, params: p, audio }) {
    const c = dst.ctx, W = dst.width, H = dst.height;
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.fillRect(0, 0, W, H);
    if (!audio) return;
    const level = audio.rms[audio.frame] ?? 0;
    let peak = 0;
    for (let f = Math.max(0, audio.frame - p.hold); f <= audio.frame; f++) peak = Math.max(peak, audio.rms[f] ?? 0);
    const g = c.createLinearGradient(0, H, 0, 0);
    g.addColorStop(0, '#2ecc71');
    g.addColorStop(0.7, '#f1c40f');
    g.addColorStop(1, '#e74c3c');
    c.fillStyle = g;
    c.fillRect(2, H - level * H, W - 4, level * H);
    c.fillStyle = '#ffffff';
    c.fillRect(2, Math.min(H - 2, H - peak * H), W - 4, 2);
  },
});

export default definePlugin({ name: 'on-air', version: '1.0.0', effects: [telephone], generators: [levelMeter] });
