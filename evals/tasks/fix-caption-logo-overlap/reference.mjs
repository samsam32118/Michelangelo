// Reference solution by editing the JSON: move the captions below the logo (same size, logo untouched).
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { readProject, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  const p = readProject(join(dir, 'promo.mgl.json'));
  p.clips.find((c) => c.captions).y = 700;
  writeFileSync(join(dir, 'promo.mgl.json'), formatProject(p));
}
