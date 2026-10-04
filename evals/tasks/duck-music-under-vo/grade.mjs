import { join } from 'node:path';
import { grader, readSetup, probe, bandEnergy, bandpassRmsDb, round, assertNotEmpty, findProjectUsing, isKeyframes } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const out = join(dir, 'out/pod.wav');
  const bed = join(dir, 'media/bed.wav');
  const p = await probe(out);
  await g.checkAsync('out/pod.wav 30 s +-0.1, not silent', async () => {
    if (!p) return { pass: false, detail: 'out/pod.wav missing' };
    const ne = await assertNotEmpty(out, { video: false, audio: true });
    return { pass: Math.abs(p.duration - 30) <= 0.1 && ne.pass, detail: `${round(p.duration)} s; ${ne.detail}` };
  });
  if (!p) {
    for (const n of ['music level kept outside the voice (+-1.5 dB) and not muted under it', 'music >= 8 dB lower during 8-18 s', 'speech present at 10 s']) g.check(n, false, 'no output');
    return g.result();
  }
  const lv = (f, start, duration) => bandEnergy(f, info.tones, { start, duration });
  const [o1, o2, oDuck, b1, b2, bDuck] = await Promise.all([lv(out, 1, 3), lv(out, 25, 4), lv(out, 8, 10), lv(bed, 1, 3), lv(bed, 25, 4), lv(bed, 8, 10)]);
  const d1 = o1 - b1, d2 = o2 - b2, dDuck = oDuck - bDuck;
  g.check('music level at 1-4 s and 25-29 s within +-1.5 dB of the original bed; not muted during 8-18 s (>= -30 dB)',
    Math.abs(d1) <= 1.5 && Math.abs(d2) <= 1.5 && dDuck >= -30, `vs bed: ${round(d1, 2)} dB, ${round(d2, 2)} dB; under voice ${round(dDuck, 2)} dB`);
  const outside = (o1 + o2) / 2;
  g.check('music during 8-18 s is >= 8 dB below its level at 1-4 s and 25-29 s', outside - oDuck >= 8, `ducked by ${round(outside - oDuck, 2)} dB`);
  const [speech, bedBand] = await Promise.all([bandpassRmsDb(out, 300, 3400, { start: 9.5, duration: 1 }), bandpassRmsDb(bed, 300, 3400, { start: 9.5, duration: 1 })]);
  g.check('speech present (300-3400 Hz energy) at 10 s', speech > -45 && speech > bedBand + 10, `speech band ${round(speech, 1)} dB (bed ${round(bedBand, 1)} dB)`);
  // made with the library: the edit is in a valid project that uses the task's inputs (not only in an ffmpeg output)
  const proj = findProjectUsing(dir, { inputs: ['media/vo.wav', 'media/bed.wav'], pred: (pp) => {
    const srcOf = new Map((pp.assets ?? []).map((a) => [a.id, String(a.src ?? '')]));
    const bed = (pp.clips ?? []).filter((c) => srcOf.get(c.asset)?.endsWith('bed.wav'));
    const duck = (pp.buses ?? []).some((b) => b?.duck);
    const keyed = bed.some((c) => isKeyframes(c.gain));
    const split = bed.length > 1 && new Set(bed.map((c) => JSON.stringify(c.gain ?? 0))).size > 1;
    return duck || keyed || split || 'no duck on a bus, gain keyframes or lowered part of the bed';
  } });
  g.check('the project ducks the bed: a bus duck, gain keyframes or a lowered part of the bed clip', !!proj.p, proj.p ? proj.f : proj.why);
  return g.result();
}
