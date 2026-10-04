import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

/** Deterministic PRNG so the fixture (and the expected result) is the same on every run. */
function rng(seed) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); }

export function build() {
  const r = rng(42);
  const clips = [];
  let t = 0;
  for (let i = 1; i <= 100; i++) { const len = 20 + Math.floor(r() * 21); clips.push({ id: `v${i}`, track: 'V1', at: t, len, asset: 'footage', in: Math.floor(r() * 1500) }); t += len; }
  const shortIdx = new Set();
  while (shortIdx.size < 17) shortIdx.add(2 + Math.floor(r() * 72));
  const colors = ['#ff3366', '#33ccff', '#ffee33', '#66ff99', '#cc66ff'];
  t = 0;
  for (let i = 1; i <= 75; i++) {
    const len = shortIdx.has(i) ? 4 + Math.floor(r() * 6) : 12 + Math.floor(r() * 29);
    clips.push({ id: `g${i}`, track: 'V2', at: t, len, color: colors[i % 5], opacity: 0.35, blend: 'screen' });
    t += len;
  }
  const chorusAt = new Set([3, 7, 11, 15, 19, 23]);
  const lyrics = ['Hey', 'Here we go', 'Lights down', 'Hands up', 'One more time', 'All night', 'Feel it', 'Turn around', 'Again', 'Louder'];
  for (let i = 1; i <= 25; i++) {
    clips.push({ id: `t${i}`, track: 'T1', at: (i - 1) * 120 + 10, len: 90, text: chorusAt.has(i) ? 'CHORUS' : lyrics[i % lyrics.length], style: 'lyric', y: 1500 });
  }
  return clips;
}

export async function setup(dir) {
  await F.video(join(dir, 'media/footage.mp4'), { src: 'testsrc2', d: 60, size: '320x568' });
  const clips = build();
  F.writeProject(join(dir, 'big.mgl.json'), {
    project: { name: 'Music video', platform: 'shorts' },
    assets: [{ id: 'footage', src: 'media/footage.mp4' }],
    styles: [{ id: 'lyric', base: 'pop', size: 110, color: '#ffffff' }],
    comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 'auto' }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }, { id: 'T1', comp: 'main' }],
    clips,
  });
  return F.finish(dir, { clips });
}
