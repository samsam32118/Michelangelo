import { join } from 'node:path';
import * as L from '../_lib/index.mjs';
import { BOUNDS } from './setup.mjs';

const W = 160, H = 90, FPS = 30; // 160x90: the two cameras are mutually dissimilar (SSIM < 0.4) at this scale

export async function grade(dir) {
  const g = L.grader();
  const bounds = L.readSetup(dir).info.bounds ?? BOUNDS;
  const out = join(dir, 'out/podcast.mp4'), host = join(dir, 'host.mp4'), guest = join(dir, 'guest.mp4'), room = join(dir, 'room.wav');
  const p = await L.probe(out);
  g.check('out/podcast.mp4: 1920x1080, H.264 + AAC, 24 s +/- 0.2', p?.video?.width === 1920 && p.video.height === 1080 && p.video.codec === 'h264' && p.audio?.codec === 'aac' && Math.abs(p.duration - 24) <= 0.2,
    p ? `${p.video?.width}x${p.video?.height} ${p.video?.codec}/${p.audio?.codec ?? 'no audio'} ${L.round(p.duration, 2)} s` : 'missing');
  await g.checkAsync('not black, not static; audio not silent (> -40 LUFS)', () => (p ? L.notEmpty(out, { audio: true, minLufs: -40 }) : { pass: false, detail: 'missing' }));

  const [so, sh, sg] = p ? await Promise.all([out, host, guest].map((f) => L.frameSeq(f, { fps: FPS, width: W, height: H, dur: 24 }))) : [[], [], []];
  const n = Math.min(so.length, sh.length, sg.length);
  const labels = [], sims = [];
  for (let i = 0; i < n; i++) {
    const a = L.ssim(so[i], sh[i], W, H), b = L.ssim(so[i], sg[i], W, H);
    sims.push([a, b]);
    labels.push(Math.max(a, b) < 0.5 ? null : a > b ? 'host' : 'guest');
  }
  const segs = bounds.slice(0, -1).map((s, i) => ({ s, e: bounds[i + 1], who: i % 2 ? 'guest' : 'host' }));
  const mids = segs.map((sg_) => {
    const i = Math.round((sg_.s + sg_.e) / 2 * FPS);
    if (i >= n) return { ok: false, d: `${sg_.who}@${(sg_.s + sg_.e) / 2}s: no frame` };
    const [a, b] = sims[i], right = sg_.who === 'host' ? a : b, wrong = sg_.who === 'host' ? b : a, mutual = L.ssim(sh[i], sg[i], W, H);
    return { ok: right >= 0.8 && right > wrong, d: `${sg_.who}@${(sg_.s + sg_.e) / 2}s ${L.round(right, 2)} (other ${L.round(wrong, 2)}, cams ${L.round(mutual, 2)})` };
  });
  g.check('at every segment midpoint the frame matches the speaking camera (SSIM >= 0.8)', n > 0 && mids.every((m) => m.ok), mids.map((m) => m.d).join('; ') || 'no frames');

  const bf = bounds.slice(1, -1).map((b) => Math.round(b * FPS));
  const near = (i) => bf.some((b) => Math.abs(i - b) <= 3);
  const changes = [];
  let last = null;
  for (let i = 0; i < n; i++) { if (labels[i] && last && labels[i] !== last) changes.push(i); if (labels[i]) last = labels[i]; }
  const drops = [];
  for (let i = 1; i < n; i++) if (L.ssim(so[i - 1], so[i], W, H) < 0.5) drops.push(i);
  const badC = changes.filter((i) => !near(i)), badD = drops.filter((i) => !near(i));
  g.check('every picture cut lands within 3 frames of a segment boundary', n >= 700 && changes.length >= bf.length && !badC.length && !badD.length,
    `${changes.length} camera changes at frames ${changes.join(',')}; ${drops.length} SSIM drops${badC.length + badD.length ? `; off-boundary: ${[...badC, ...badD].join(',')}` : ''}; boundaries ${bf.join(',')}`);

  await g.checkAsync('audio is room.wav only: decoy tones > 25 dB below speech band; aligned with room.wav (lag 0 +/- 1 frame)', async () => {
    const [xo, xr] = await Promise.all([L.pcm(out), L.pcm(room)]);
    if (!xo || !xr) return { pass: false, detail: 'no audio' };
    // A constant decoy tone concentrates in a ~0.05 Hz bin over 24 s; speech spreads over the band.
    const d = Math.min(xo.length, xr.length) / 48000;
    const tones = [1000, 440].map((f) => {
      const to = L.toneDb(xo, 48000, f, 0, d) - L.rmsDb(xo), tr = L.toneDb(xr, 48000, f, 0, d) - L.rmsDb(xr);
      return { f, rel: to, excess: to - tr, ok: to <= -25 && to - tr <= 6 };
    });
    const lag = L.envelopeLag(xo, xr, 48000, 0.5);
    const ok = tones.every((t) => t.ok) && Math.abs(lag.lag) <= 1 / FPS + 0.004 && lag.r >= 0.8;
    return { pass: ok, detail: `${tones.map((t) => `${t.f} Hz ${L.round(t.rel, 1)} dB re speech (excess ${L.round(t.excess, 1)})`).join(', ')}; lag ${L.round(lag.lag * 1000, 0)} ms r=${L.round(lag.r, 2)}` };
  });

  const pj = L.readProject(join(dir, 'podcast.mgl.json'));
  g.check('podcast.mgl.json validates; clips reference both cameras and one audio clip references room.wav', (() => {
    if (!pj || L.validateRaw(pj).length) return false;
    const clips = L.tables(pj, 'clips');
    const uses = (name) => clips.filter((c) => L.assetsNamed(pj, name).some((a) => a.id === c.asset));
    return uses('host.mp4').length > 0 && uses('guest.mp4').length > 0 && uses('room.wav').length >= 1;
  })(), pj ? (L.validateRaw(pj)[0] ?? `${L.tables(pj, 'clips').length} clips`) : 'podcast.mgl.json missing or not JSON');
  return g.result();
}
