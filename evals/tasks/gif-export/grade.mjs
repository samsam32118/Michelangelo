import { join } from 'node:path';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { grader, probe, ssim, round, assertNotEmpty, frameAt, renderStill, projectContentShare, findProjectUsing } from '../../lib/index.mjs';

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
  // the GIF is the project's (with its moving "Demo" label), not just the background cut with ffmpeg
  await g.checkAsync('the GIF shows the project (its moving label) at 3 s and 5 s, like a render of demo.mgl.json', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const proj = findProjectUsing(dir, { inputs: ['media/bg.mp4'], files: ['demo.mgl.json'], pred: (pp) => (pp.clips ?? []).some((c) => c.text === 'Demo') || 'the "Demo" label is gone' });
    if (!proj.p) return { pass: false, detail: proj.why };
    const S = { width: 480, height: 270 };
    const parts = [];
    let ok = true;
    for (const t of [3, 5]) {
      const r = await renderStill(dir, 'demo.mgl.json', t);
      if (r.error) return { pass: false, detail: r.error };
      const [o, rr, src] = await Promise.all([frameAt(f, t - 3, S), frameAt(r.file, 0, S), frameAt(join(dir, 'media/bg.mp4'), t, S)]);
      if (!o || !rr || !src) return { pass: false, detail: 'no frame' };
      const c = projectContentShare(o, rr, src);
      if (!(c.pixels >= 50 && c.share >= 0.6)) ok = false;
      parts.push(`${t} s: ${Math.round(c.share * 100)} % of ${c.pixels} label px follow the project`);
    }
    return { pass: ok, detail: parts.join('; ') };
  });
  return g.result();
}
