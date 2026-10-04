// Mutants for grader validation: degrade a reference output in place, return a restore function.
import { renameSync, rmSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ff, probe } from './proc.mjs';

/** Replace dir/rel by the result of make(src, dst); restore() puts the original back. */
export async function swap(dir, rel, make) {
  const f = join(dir, rel), bak = `${f}.orig${extname(f)}`;
  renameSync(f, bak);
  try { await make(bak, f); } catch (e) { renameSync(bak, f); throw e; }
  return () => { rmSync(f, { force: true }); renameSync(bak, f); };
}

const vcodec = (f) => (/\.webm$/.test(f) ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M'] : /\.mov$/.test(f) ? ['-c:v', 'prores_ks', '-profile:v', '2'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
const acodec = (f) => (/\.webm$/.test(f) ? ['-c:a', 'libopus'] : /\.mov$/.test(f) ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac']);

/** Same container/codecs; vf applied to video, af to audio (copy when omitted). */
export const refilter = (dir, rel, { vf, af }) => swap(dir, rel, (src, dst) => ff(['-i', src, ...(vf ? ['-vf', vf, ...vcodec(dst)] : ['-c:v', 'copy']), ...(af ? ['-af', af, ...acodec(dst)] : ['-c:a', 'copy']), dst]));

export const black = (dir, rel) => refilter(dir, rel, { vf: 'drawbox=t=fill:c=black' });
export const silent = (dir, rel) => refilter(dir, rel, { af: 'volume=0' });

/** The first frame held for the whole duration, audio kept. */
export const frozen = (dir, rel) => swap(dir, rel, async (src, dst) => {
  const p = await probe(src);
  await ff(['-i', src, '-vf', `trim=end_frame=1,tpad=stop_mode=clone:stop_duration=${p.duration + 1},setpts=PTS-STARTPTS`, '-map', '0:v', '-map', '0:a?', '-t', String(p.duration), ...vcodec(dst), ...acodec(dst), dst]);
});

/** Edit a JSON-ish text file via fn(text) → text. */
export function editText(dir, rel, fn) {
  const f = join(dir, rel), orig = readFileSync(f);
  writeFileSync(f, fn(orig.toString()));
  return () => writeFileSync(f, orig);
}

/** Copy file a over file b (b restored afterwards). */
export function replaceWith(dir, fromRel, rel) {
  const f = join(dir, rel), bak = `${f}.orig${extname(f)}`;
  if (existsSync(f)) renameSync(f, bak);
  copyFileSync(join(dir, fromRel), f);
  return () => { rmSync(f, { force: true }); if (existsSync(bak)) renameSync(bak, f); };
}
