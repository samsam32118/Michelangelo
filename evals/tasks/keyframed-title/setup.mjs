import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  F.writeProject(join(dir, 'title.mgl.json'), {
    project: { name: 'Title card' },
    comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 90, bg: '#101820' }],
    tracks: [{ id: 'BG', comp: 'main' }, { id: 'T1', comp: 'main' }],
    clips: [{ id: 'bg', track: 'BG', at: 0, len: 90, color: '#101820' }, { id: 'title', track: 'T1', at: 0, len: 90, text: 'Launch Day', style: 'title' }],
  });
  return F.finish(dir, { bg: '#101820', len: 90 });
}
