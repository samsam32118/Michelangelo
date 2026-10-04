import { join } from 'node:path';
import * as L from '../_lib/index.mjs';

const BG = '#101828';

export async function grade(dir) {
  const g = L.grader();
  const out = join(dir, 'out/audiogram.mp4');
  const p = await L.probe(out);
  const fps = p?.video?.fps || 30;
  await g.checkAsync('out/audiogram.mp4: 1080x1080, H.264 + AAC, 12 s +/- 0.2; audio not silent and aligned with clip.wav (+/- 2 frames)', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const fmt = p.video?.width === 1080 && p.video.height === 1080 && p.video.codec === 'h264' && p.audio?.codec === 'aac' && Math.abs(p.duration - 12) <= 0.2;
    const [xo, xr] = await Promise.all([L.pcm(out), L.pcm(join(dir, 'clip.wav'))]);
    const lufs = await L.loudness(out);
    const lag = xo && xr ? L.envelopeLag(xo, xr, 48000, 0.5) : { lag: NaN, r: 0 };
    const ok = fmt && lufs !== null && lufs > -40 && Math.abs(lag.lag) <= 2 / fps + 0.004 && lag.r >= 0.8;
    return { pass: ok, detail: `${p.video?.width}x${p.video?.height} ${p.video?.codec}/${p.audio?.codec ?? 'no audio'} ${L.round(p.duration, 2)} s; ${L.round(lufs, 1)} LUFS; lag ${L.round(lag.lag * 1000, 0)} ms r=${L.round(lag.r, 2)}` };
  });

  const at = async (t) => (p ? L.frameAt(out, t) : null);
  const [f1, f2, f25, f5, f8, f9, f11] = await Promise.all([1, 2, 2.5, 5, 8, 9, 11].map(at));
  const sq = (f) => f && f.width === 1080 && f.height === 1080;
  const bgOk = (f) => sq(f) && L.deltaE(L.lab(...L.avgRGB(f, [16, 1056, 25, 1065])), L.lab(...L.hexRGB(BG))) < 5;
  g.check('background at (20, 1060) within delta E 5 of #101828 at 1 s and 9 s; frames not one colour', bgOk(f1) && bgOk(f9) && [f1, f9].every((f) => L.colourSpread(f).std > 3),
    [f1, f9].map((f) => (sq(f) ? `rgb(${L.avgRGB(f, [16, 1056, 25, 1065])}) std ${L.round(L.colourSpread(f).std, 1)}` : 'no 1080x1080 frame')).join('; '));

  // Ink = pixels far (dE > 20) from the background colour; edges = text strokes.
  const ink = (f, region) => L.maskCount(L.colorMask(f, BG, 20).map((v) => 1 - v), 1080, region) / ((region[2] - region[0]) * (region[3] - region[1]));
  const top = [0, 0, 1080, 270];
  const titleAt = (f) => (sq(f) ? { ink: ink(f, top), edges: L.edgeDensity(f, top, 100) } : null);
  const t1 = titleAt(f1), t9 = titleAt(f9);
  g.check('title glyphs in the top quarter (y < 270) at 1 s and 9 s', [t1, t9].every((t) => t && t.ink >= 0.01 && t.ink <= 0.6 && t.edges >= 0.004),
    [t1, t9].map((t) => (t ? `ink ${L.round(t.ink, 3)} edges ${L.round(t.edges, 4)}` : 'no frame')).join('; '));

  const band = [0, 400, 1080, 680];
  const bandInk = (f) => (sq(f) ? L.maskCount(L.colorMask(f, BG, 15).map((v) => 1 - v), 1080, band) : 0);
  const [b2, b5, b8, b11] = [f2, f5, f8, f11].map(bandInk);
  const floor = 0.002 * 1080 * 280;
  const moves = sq(f2) && sq(f25) ? L.diffMask(f2, f25, 40).reduce((s, v, i) => s + (v && i >= 400 * 1080 && i < 680 * 1080 ? 1 : 0), 0) : 0;
  g.check('visualiser reacts: central band ink at 2, 8, 11 s >= 3x the silent gap (5 s); band changes between 2 s and 2.5 s',
    [b2, b8, b11].every((b) => b >= Math.max(3 * b5, floor)) && moves >= 0.002 * 1080 * 280,
    `band ink 2s ${b2}, 5s ${b5}, 8s ${b8}, 11s ${b11}; changed px 2→2.5 s ${moves}`);
  return g.result();
}
