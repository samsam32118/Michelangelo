import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';
import { counterVideo } from '../../lib/counter.mjs';

export const CLIPS = [
  { id: 'a', track: 'V1', at: 0, len: 90, asset: 'counter', in: 0 },
  { id: 'b', track: 'V1', at: 90, len: 90, asset: 'counter', in: 150 },
  { id: 'c', track: 'V1', at: 180, len: 90, asset: 'counter', in: 300 },
];

export async function setup(dir) {
  await counterVideo(join(dir, 'media/counter.mp4'), { d: 20, w: 1280, h: 720 });
  F.writeProject(join(dir, 'trim.mgl.json'), {
    project: { name: 'Trims' },
    assets: [{ id: 'counter', src: 'media/counter.mp4' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 270 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: CLIPS,
  });
  return F.finish(dir, { clips: CLIPS });
}
