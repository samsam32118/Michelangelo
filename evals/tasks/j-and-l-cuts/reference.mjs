// Reference solution by editing the JSON: A's audio runs 30 frames past the picture cut; B's audio starts 30 later.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { readProject, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  const p = readProject(join(dir, 'dialog.mgl.json'));
  const c = (id) => p.clips.find((x) => x.id === id);
  c('a-audio').len += 30;
  Object.assign(c('b-audio'), { at: c('b-audio').at + 30, in: c('b-audio').in + 30, len: c('b-audio').len - 30 });
  writeFileSync(join(dir, 'dialog.mgl.json'), formatProject(p));
}
