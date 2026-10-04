// Reference solution by editing the JSON: ripple-delete short V2 clips, recolour CHORUS clips.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { readProject, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  const p = readProject(join(dir, 'big.mgl.json'));
  let t = 0;
  p.clips = p.clips.filter((c) => !(c.track === 'V2' && c.len < 10));
  for (const c of p.clips.filter((c) => c.track === 'V2').sort((a, b) => a.at - b.at)) { c.at = t; t += c.len; }
  for (const c of p.clips) if (c.text === 'CHORUS') c.style = { base: 'lyric', color: '#ffcc00' };
  writeFileSync(join(dir, 'big.mgl.json'), formatProject(p));
}
