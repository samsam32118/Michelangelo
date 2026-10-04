// Reference with plain ffmpeg + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff, X264 } from '../_lib/h.mjs';
import { writeProject } from '../_lib/fx.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ff(['-i', join(dir, 'tutorial.mp4'), '-f', 'lavfi', '-i', 'color=c=0xff3b30:s=1920x12:r=30:d=10', '-filter_complex', "[0:v][1:v]overlay=x='-1920+1920*t/10':y=1068:eof_action=pass[v]", '-map', '[v]', '-map', '0:a', ...X264, '-c:a', 'copy', join(dir, 'out/progress.mp4')]);
  writeProject(join(dir, 'progress.mgl.json'), {
    assets: [{ id: 'tutorial', src: 'tutorial.mp4' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }],
    clips: [
      { id: 'screen', track: 'V1', at: 0, len: 300, asset: 'tutorial' },
      { id: 'bar', track: 'V2', at: 0, len: 300, shape: { type: 'rect', size: [1920, 12], fill: '#ff3b30' }, anchor: [0, 1], x: 0, y: 1080, scale: [[0, [0, 1]], [299, [1, 1]]] },
    ],
  });
}
