import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  F.writeProject(join(dir, 'two.mgl.json'), {
    project: { name: 'Iris demo' },
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 180 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'red', track: 'V1', at: 0, len: 90, color: '#ff0000' }, { id: 'blue', track: 'V1', at: 90, len: 90, color: '#0000ff' }],
  });
  return F.finish(dir, {});
}
