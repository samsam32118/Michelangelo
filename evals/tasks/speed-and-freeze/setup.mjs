import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';
import { counterVideo } from '../../lib/counter.mjs';

export async function setup(dir) {
  await counterVideo(join(dir, 'media/counter.mp4'), { d: 10, w: 1280, h: 720 });
  F.writeProject(join(dir, 'run.mgl.json'), {
    project: { name: 'Run' },
    assets: [{ id: 'counter', src: 'media/counter.mp4' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 'auto' }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'run', track: 'V1', at: 0, len: 240, asset: 'counter' }],
  });
  return F.finish(dir, {});
}
