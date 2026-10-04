import { join } from 'node:path';
import { grader, assertNotEmpty, round, mediaFacts, namedProject, inputsUnchanged, toneOnsets, flashTimes, pcm, bestLag } from '../_lib/h.mjs';
import { FLASH, LAG } from './setup.mjs';

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/synced.mp4'), src = join(dir, 'interview.mp4');
  const facts = await mediaFacts(out, { w: 1280, h: 720, dur: 12, durTol: 0.2, audio: true });
  const ne = facts.ok ? await assertNotEmpty(out, { audio: true }) : { pass: false, detail: '' };
  g.check('out/synced.mp4: 1280x720 with audio, 12 s, not empty', facts.ok && ne.pass, `${facts.detail}; ${ne.detail}`);
  const flashes = facts.ok ? await flashTimes(out) : [];
  const fOk = flashes.length === FLASH.length && FLASH.every((t, i) => Math.abs(flashes[i] - t) <= 1 / 30 + 0.002);
  g.check('picture timing unchanged (flashes within 1 frame)', fOk, `flashes at ${flashes.map((t) => round(t, 3)).join(', ') || 'none'} (want ${FLASH.join(', ')})`);
  const onsets = facts.ok ? await toneOnsets(out, 2000) : [];
  const match = FLASH.map((t) => onsets.reduce((b, o) => (Math.abs(o - t) < Math.abs(b - t) ? o : b), Infinity));
  const bOk = onsets.length >= FLASH.length && match.every((o, i) => Math.abs(o - FLASH[i]) <= 0.045);
  g.check('every beep within 45 ms of its flash', bOk, `beep onsets ${onsets.map((t) => round(t, 3)).join(', ') || 'none'}`);
  await g.checkAsync('speech kept, at the corrected offset', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const [o, s] = await Promise.all([pcm(out, { rate: 8000 }), pcm(src, { rate: 8000 })]);
    // s[i + lag] ~ o[i]: the source is late by LAG, so lag should be +LAG*8000
    const b = bestLag(s, o, 6400, { from: 16000, len: 40000 });
    return { pass: b.corr >= 0.85 && Math.abs(b.lag / 8000 - LAG) <= 1 / 30, detail: `best lag ${round(b.lag / 8000, 3)} s (want ${round(LAG, 3)}), corr ${round(b.corr, 3)}` };
  });
  const pr = namedProject(dir, 'synced.mgl.json', { inputs: ['interview.mp4'] });
  const inp = await inputsUnchanged(dir, ['interview.mp4']);
  g.check('input unchanged', inp.ok, inp.detail);
  g.check('[lib] synced.mgl.json valid, uses interview.mp4', pr.ok, pr.detail);
  return g.result();
}
