import { join } from 'node:path';
import { grader, readSetup, probe, allFrames, meanColor, hex, round, assertNotEmpty } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const out = join(dir, 'out/beat.mp4');
  const p = await probe(out);
  const pal = info.colors.map(hex);
  let seq = [];
  if (p) {
    const frames = await allFrames(out, { width: 96, height: 96, fps: 30 });
    // classify each frame by the colour of a border band (avoids the photo numbers)
    seq = frames.map((f) => {
      const c = meanColor(f, [0, 0, 96, 12]);
      let best = -1, bd = 70;
      pal.forEach((q, i) => { const d = Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]); if (d < bd) { bd = d; best = i; } });
      return best;
    });
  }
  // cuts: frame index where the photo changes to the next one
  const firsts = info.colors.map((_, i) => seq.indexOf(i));
  await g.checkAsync('cut times (frame-colour changes) within 2 frames of the beats 0.5, 1.0, ... 4.0 s; 1080x1080', async () => {
    if (!p) return { pass: false, detail: 'out/beat.mp4 missing' };
    const ne = await assertNotEmpty(out);
    const errs = firsts.map((f, i) => (f < 0 ? Infinity : i === 0 ? Math.max(0, f - 15) : Math.abs(f - info.beats[i] * 30)));
    return { pass: errs.every((e) => e <= 2) && p.displayWidth === 1080 && p.displayHeight === 1080 && ne.pass, detail: `photo starts (frames) ${firsts.join(',')}; expected ${info.beats.map((b) => b * 30).join(',')}` };
  });
  g.check('8 distinct colours appear in order', firsts.every((f) => f >= 0) && firsts.every((f, i) => i === 0 || f > firsts[i - 1]), `first frames ${firsts.join(',')}`);
  void round;
  return g.result();
}
