// Reference solution by hand-editing the JSON: rename the key, give the credit an existing track, fix the overlap.
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseLoose, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  const p = parseLoose(readFileSync(join(dir, 'broken.mgl.json'), 'utf8'));
  for (const c of p.clips) {
    if ('opactiy' in c) { c.opacity = c.opactiy; delete c.opactiy; }
    if (c.track === 'V3') c.track = 'T1';
    if (c.id === 'shot2') { c.at = 120; c.len = 90; }
  }
  writeFileSync(join(dir, 'broken.mgl.json'), formatProject(p));
}
