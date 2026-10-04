// Reference with plain ffmpeg (the known shake, inverted) + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff, X264 } from '../_lib/h.mjs';
import { writeProject } from '../_lib/fx.mjs';
import { SX, SY } from './setup.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ff(['-i', join(dir, 'handheld.mp4'), '-vf', `crop=1846:1038:x='77-(${SX})':y='43-(${SY})',scale=1920:1080`, ...X264, join(dir, 'out/stable.mp4')]);
  writeProject(join(dir, 'stable.mgl.json'), {
    assets: [{ id: 'handheld', src: 'handheld.mp4' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'shot', track: 'V1', at: 0, len: 240, asset: 'handheld', scale: 1.04, fx: [{ type: 'stabilize' }] }],
  });
}
