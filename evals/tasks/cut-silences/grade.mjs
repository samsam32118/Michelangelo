import { join } from 'node:path';
import { grader, readSetup, probe, silences, rmsWindows, bestMatch, sha256, round, assertNotEmpty, readProject, validateRaw } from '../../lib/index.mjs';

const env = async (f, opts) => (await rmsWindows(f, { win: 0.02, ...opts })).map((d) => Math.max(-60, d));

export async function grade(dir) {
  const g = grader();
  const { info, hashes } = readSetup(dir);
  const out = join(dir, 'out/tight.wav');
  const p = await probe(out);
  const n = info.silences.length;
  const tol = Math.max(0.4, 0.08 * n);
  const proj = readProject(join(dir, 'tight.mgl.json'));
  await g.checkAsync(`out/tight.wav duration = original minus removed silences (+-${round(tol, 2)} s); tight.mgl.json valid; interview.wav unchanged`, async () => {
    if (!p) return { pass: false, detail: 'out/tight.wav missing' };
    const ne = await assertNotEmpty(out, { video: false, audio: true });
    const same = sha256(join(dir, 'interview.wav')) === hashes['interview.wav'];
    const valid = proj && !validateRaw(proj).length;
    return { pass: Math.abs(p.duration - info.expected) <= tol && ne.pass && same && !!valid, detail: `${round(p.duration, 2)} s (expected ${round(info.expected, 2)}); ${ne.detail}; project ${valid ? 'valid' : proj ? validateRaw(proj)[0] : 'missing'}${same ? '' : '; interview.wav MODIFIED'}` };
  });
  await g.checkAsync('silencedetect -40 dB d=0.6 finds no silence', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const s = await silences(out, { db: -40, minDuration: 0.6 });
    return { pass: s.length === 0, detail: s.length ? s.map((x) => `${round(x.start, 2)}-${round(x.end, 2)}`).join(', ') : 'none' };
  });
  await g.checkAsync('all 8 phrases present, in order (energy envelope cross-correlation)', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const src = join(dir, 'interview.wav');
    const o = await env(out);
    let from = 0;
    const corrs = [];
    for (const s of info.segments) {
      const e = await env(src, { start: s.start, duration: s.end - s.start });
      const m = bestMatch(o, e, from, Math.min(o.length - e.length, from + Math.round(6 / 0.02)));
      corrs.push(m.corr);
      if (m.corr < 0.7) break;
      from = m.offset + Math.floor(e.length * 0.8);
    }
    return { pass: corrs.length === info.segments.length && corrs.every((c) => c >= 0.7), detail: `${info.segments.length} segments, corr ${corrs.map((c) => round(c, 2)).join(' ')}` };
  });
  return g.result();
}
