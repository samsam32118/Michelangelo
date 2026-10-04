// Reference solution by editing the JSON (roll a/b by 12 frames, slip c by 30).
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { readProject, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  const p = readProject(join(dir, 'trim.mgl.json'));
  const c = (id) => p.clips.find((x) => x.id === id);
  c('a').len += 12;
  Object.assign(c('b'), { at: c('b').at + 12, in: c('b').in + 12, len: c('b').len - 12 });
  c('c').in += 30;
  writeFileSync(join(dir, 'trim.mgl.json'), formatProject(p));
}
