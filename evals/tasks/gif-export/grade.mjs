import { join } from 'node:path';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { grader, probe, ssim, round, assertNotEmpty } from '../../lib/index.mjs';

/** Walk the GIF blocks: frame count, total delay (s) and the NETSCAPE2.0 loop count (0 = forever, undefined = plays once). */
export function gifInfo(buf) {
  if (buf.length < 13 || buf.toString('latin1', 0, 3) !== 'GIF') return undefined;
  let i = 13, frames = 0, delay = 0, loops;
  if (buf[10] & 0x80) i += 3 * 2 ** ((buf[10] & 7) + 1);
  const skipSub = () => { while (i < buf.length && buf[i] !== 0) i += buf[i] + 1; i++; };
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[i + 1];
      if (label === 0xf9) delay += (buf[i + 4] | (buf[i + 5] << 8)) / 100;
      if (label === 0xff && buf.toString('latin1', i + 3, i + 14) === 'NETSCAPE2.0') loops = buf[i + 16] | (buf[i + 17] << 8);
      i += 2; skipSub();
    } else if (b === 0x2c) {
      frames++;
      const packed = buf[i + 9];
      i += 10;
      if (packed & 0x80) i += 3 * 2 ** ((packed & 7) + 1);
      i++; skipSub();
    } else return { frames, delay, loops, corrupt: true };
  }
  return { frames, delay, loops };
}

export async function grade(dir) {
  const g = grader();
  const f = join(dir, 'out/clip.gif');
  const p = existsSync(f) ? await probe(f) : undefined;
  await g.checkAsync('out/clip.gif: width 480, 3 s +-0.2, loops, < 5 MB, animated', async () => {
    if (!p) return { pass: false, detail: 'out/clip.gif missing' };
    const buf = readFileSync(f);
    const gi = gifInfo(buf) ?? {}, loops = gi.loops, dur = gi.delay ?? 0, size = statSync(f).size;
    const ne = await assertNotEmpty(f);
    return { pass: p.video?.codec === 'gif' && p.width === 480 && Math.abs(dur - 3) <= 0.2 && loops === 0 && size < 5 * 1024 * 1024 && ne.pass && gi.frames > 1, detail: `${p.video?.codec} ${p.width}x${p.height}, ${gi.frames} frames, ${round(dur, 2)} s, loop ${loops}, ${round(size / 1048576, 2)} MB; ${ne.detail}` };
  });
  await g.checkAsync('first frame matches the project at 3 s (SSIM > 0.6 at 480 px)', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const s = await ssim(f, join(dir, 'media/bg.mp4'), { ta: 0, tb: 3, width: 480, height: 270 });
    return { pass: s > 0.6, detail: `SSIM ${round(s, 3)} against the source at 3 s` };
  });
  return g.result();
}
