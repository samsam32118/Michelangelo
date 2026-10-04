import { join } from 'node:path';
import * as L from '../_lib/index.mjs';

export async function grade(dir) {
  const g = L.grader();
  const { hashes } = L.readSetup(dir);
  const web = join(dir, 'out/web.webm'), mov = join(dir, 'out/master.mov'), thumb = join(dir, 'out/thumb.jpg');
  const [pw, pm, pt] = await Promise.all([web, mov, thumb].map((f) => L.probe(f)));
  const fmt = (p) => (p ? `${p.video?.codec ?? '-'}${p.video?.profile ? `(${p.video.profile})` : ''}/${p.audio?.codec ?? 'no audio'} ${p.video?.width}x${p.video?.height} ${L.round(p.video?.fps, 2)} fps ${L.round(p.duration, 2)} s` : 'missing');
  g.check('out/web.webm: VP9 + Opus, 1920x1080, 25 fps, 8 s +/- 0.1',
    pw && /webm|matroska/.test(pw.format) && pw.video?.codec === 'vp9' && pw.audio?.codec === 'opus' && pw.video.width === 1920 && pw.video.height === 1080 && Math.abs(pw.video.fps - 25) < 0.05 && Math.abs(pw.duration - 8) <= 0.1, fmt(pw));
  g.check('out/master.mov: ProRes 422 / 422 HQ, PCM 16/24-bit audio, 1920x1080, 8 s +/- 0.1',
    pm && /mov/.test(pm.format) && pm.video?.codec === 'prores' && /^(standard|hq|422|422 hq)$/i.test(pm.video.profile.trim()) && ['pcm_s16le', 'pcm_s24le'].includes(pm.audio?.codec) && pm.video.width === 1920 && pm.video.height === 1080 && Math.abs(pm.duration - 8) <= 0.1, fmt(pm));

  await g.checkAsync('both renders: not black, not static (2 s vs 6 s SSIM < 0.5), audio not silent; webm and mov agree at 6 s (SSIM >= 0.9)', async () => {
    if (!pw || !pm) return { pass: false, detail: 'a render is missing' };
    const [nw, nm] = await Promise.all([L.notEmpty(web, { audio: true }), L.notEmpty(mov, { audio: true })]);
    const small = { width: 160, height: 90 }, mid = { width: 480, height: 270 };
    const [w2, w6, m2, m6, W6, M6] = await Promise.all([L.frameAt(web, 2, small), L.frameAt(web, 6, small), L.frameAt(mov, 2, small), L.frameAt(mov, 6, small), L.frameAt(web, 6, mid), L.frameAt(mov, 6, mid)]);
    const sw = L.ssim(w2, w6), sm = L.ssim(m2, m6), agree = L.ssim(W6, M6);
    return { pass: nw.pass && nm.pass && sw < 0.5 && sm < 0.5 && agree >= 0.9, detail: `webm: ${nw.detail}, 2/6 s ${L.round(sw, 2)}; mov: ${nm.detail}, 2/6 s ${L.round(sm, 2)}; webm~mov@6s ${L.round(agree, 3)}` };
  });

  await g.checkAsync('out/thumb.jpg: 1280x720 JPEG matching master.mov at 4 s (SSIM >= 0.85), not one colour', async () => {
    if (!pt) return { pass: false, detail: 'missing' };
    const isJpeg = pt.video?.codec === 'mjpeg' && pt.video.width === 1280 && pt.video.height === 720;
    const img = await L.imageRGB(thumb, { width: 640, height: 360 });
    // 4 s is the first frame of the second shot; one frame either side is tolerated.
    const refs = pm ? await Promise.all([4, 3.96, 4.04].map((t) => L.frameAt(mov, t + 0.001, { width: 640, height: 360 }))) : [];
    const best = Math.max(0, ...refs.map((r) => L.ssim(img, r)));
    const spread = img ? L.colourSpread(img) : { std: 0 };
    return { pass: isJpeg && best >= 0.85 && spread.std > 5, detail: `${pt.video?.codec} ${pt.video?.width}x${pt.video?.height}; SSIM vs master@4s ${L.round(best, 3)}; std ${L.round(spread.std, 1)}` };
  });

  g.check('spot.mgl.json byte-identical to the fixture (media too)', ['spot.mgl.json', 'media/bars.mp4', 'media/test.mp4', 'media/tone.wav'].every((f) => {
    try { return L.sha256(join(dir, f)) === hashes[f]; } catch { return false; }
  }), hashes['spot.mgl.json'] ? 'compared against setup hashes' : 'no setup hashes');
  return g.result();
}
