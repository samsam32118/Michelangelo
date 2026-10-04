import { join } from 'node:path';
import { grader, probe, loudness, round, assertNotEmpty, bandpassRmsDb } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const wav = join(dir, 'out/mix.wav'), mp3 = join(dir, 'out/mix.mp3');
  const [pw, pm] = await Promise.all([probe(wav), probe(mp3)]);
  await g.checkAsync('out/mix.wav integrated loudness -14 +-1 LU, true peak <= -1.0 dBTP, 12 s, content kept', async () => {
    if (!pw?.audio) return { pass: false, detail: 'out/mix.wav missing' };
    const [l, ne, sp] = await Promise.all([loudness(wav), assertNotEmpty(wav, { video: false, audio: true }), bandpassRmsDb(wav, 300, 3400, { start: 2, duration: 3 })]);
    return { pass: Math.abs(l.integrated + 14) <= 1 && l.truePeak <= -1.0 && Math.abs(pw.duration - 12) <= 0.2 && ne.pass && sp > -40, detail: `${l.integrated} LUFS, ${l.truePeak} dBTP, ${round(pw.duration, 2)} s, speech band ${round(sp, 1)} dB` };
  });
  await g.checkAsync('out/mix.mp3 exists, mp3 codec, loudness -14 +-1.5', async () => {
    if (!pm?.audio) return { pass: false, detail: 'out/mix.mp3 missing' };
    const l = await loudness(mp3);
    return { pass: pm.audio.codec === 'mp3' && Math.abs(l.integrated + 14) <= 1.5, detail: `${pm.audio.codec}, ${l.integrated} LUFS` };
  });
  return g.result();
}
