import { join } from 'node:path';
import {
  grader, assertNotEmpty, frameAt, round, mediaFacts, regionSsim, namedProject, inputsUnchanged, channelPcm, bestLag, goertzelDb, rmsDb, loudness,
} from '../_lib/h.mjs';

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/fixed.mp4'), src = join(dir, 'interview.mp4');
  const facts = await mediaFacts(out, { w: 1280, h: 720, dur: 10, durTol: 0.15, audio: true, channels: 2 });
  const ne = facts.ok ? await assertNotEmpty(out, { audio: true }) : { pass: false, detail: '' };
  g.check('out/fixed.mp4: 1280x720, 10 s, stereo, not empty', facts.ok && ne.pass, `${facts.detail}; ${ne.detail}`);
  let ch = null;
  if (facts.ok) {
    const [l, r, lav, cam] = await Promise.all([channelPcm(out, 0, { rate: 16000 }), channelPcm(out, 1, { rate: 16000 }), channelPcm(src, 0, { rate: 16000 }), channelPcm(src, 1, { rate: 16000 })]);
    ch = { l, r, lav, cam };
  }
  await g.checkAsync('both channels are the lav', async () => {
    if (!ch) return { pass: false, detail: 'no output' };
    const bl = bestLag(ch.l, ch.lav, 400, { from: 8000, len: 120000 }), br = bestLag(ch.r, ch.lav, 400, { from: 8000, len: 120000 });
    return { pass: bl.corr >= 0.95 && br.corr >= 0.95, detail: `corr L ${round(bl.corr, 3)} (lag ${bl.lag}), R ${round(br.corr, 3)} (lag ${br.lag})` };
  });
  await g.checkAsync('camera mic gone (whine and noise)', async () => {
    if (!ch) return { pass: false, detail: 'no output' };
    const wl = goertzelDb(ch.l, 3150, 16000), wr = goertzelDb(ch.r, 3150, 16000), ws = goertzelDb(ch.cam, 3150, 16000);
    const pl = rmsDb(ch.l.subarray(8.7 * 16000, 9.8 * 16000)), prr = rmsDb(ch.r.subarray(8.7 * 16000, 9.8 * 16000));
    return { pass: Math.max(wl, wr) <= ws - 25 && pl < -55 && prr < -55, detail: `3150 Hz L ${round(wl, 1)} R ${round(wr, 1)} dB (source right ${round(ws, 1)}); pause RMS L ${round(pl, 1)} R ${round(prr, 1)} dBFS` };
  });
  g.check('channels balanced within 1.5 dB', !!ch && Math.abs(rmsDb(ch.l) - rmsDb(ch.r)) <= 1.5, ch ? `L ${round(rmsDb(ch.l), 2)} R ${round(rmsDb(ch.r), 2)} dBFS` : 'no output');
  await g.checkAsync('integrated loudness -16 +/- 1.2 LUFS', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const l = await loudness(out);
    return { pass: Math.abs(l.integrated + 16) <= 1.2, detail: `${l.integrated} LUFS` };
  });
  await g.checkAsync('picture unchanged', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const s = [];
    for (const t of [2, 5, 8]) { const [a, b] = await Promise.all([frameAt(out, t), frameAt(src, t)]); s.push(a && b ? await regionSsim(a, [0, 0, 1280, 720], b, [0, 0, 1280, 720], 640) : 0); }
    return { pass: s.every((v) => v >= 0.9), detail: `SSIM ${s.map((v) => round(v, 3)).join('/')}` };
  });
  const pr = namedProject(dir, 'fixed.mgl.json', { inputs: ['interview.mp4'] });
  const inp = await inputsUnchanged(dir, ['interview.mp4']);
  g.check('fixed.mgl.json valid, uses interview.mp4; input unchanged', pr.ok && inp.ok, `${pr.detail}; ${inp.detail}`);
  return g.result();
}
