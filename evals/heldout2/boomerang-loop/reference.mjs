// Reference with plain ffmpeg + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff, X264 } from '../_lib/h.mjs';
import { writeProject } from '../_lib/fx.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const fc = '[0:v]trim=start_frame=30:end_frame=75,setpts=PTS-STARTPTS,split[f][r0];[r0]reverse[r];[f][r]concat=n=2:v=1:a=0,split=3[a][b][c];[a][b][c]concat=n=3:v=1:a=0[v]';
  await ff(['-i', join(dir, 'jump.mp4'), '-filter_complex', fc, '-map', '[v]', '-an', ...X264, join(dir, 'out/boomerang.mp4')]);
  const clips = [];
  for (let k = 0; k < 3; k++) {
    clips.push({ id: `fwd${k + 1}`, track: 'V1', at: k * 90, len: 45, asset: 'jump', in: 30 });
    clips.push({ id: `back${k + 1}`, track: 'V1', at: k * 90 + 45, len: 45, asset: 'jump', in: 74, speed: -1 });
  }
  writeProject(join(dir, 'boomerang.mgl.json'), {
    assets: [{ id: 'jump', src: 'jump.mp4' }],
    comps: [{ id: 'main', size: [1080, 1080], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips,
  });
}
