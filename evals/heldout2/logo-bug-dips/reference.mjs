// Reference with plain ffmpeg + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff, X264, AAC } from '../_lib/h.mjs';
import { writeProject } from '../_lib/fx.mjs';
import { CLIPS } from './setup.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const fades = ['fade=t=out:st=3.75:d=0.25', 'fade=t=in:st=0:d=0.25,fade=t=out:st=3.75:d=0.25', 'fade=t=in:st=0:d=0.25'];
  const fc = CLIPS.map((_, i) => `[${i}:v]${fades[i]}[v${i}]`).join(';') + ';[v0][0:a][v1][1:a][v2][2:a]concat=n=3:v=1:a=1[cv][a]'
    + ';[3:v]format=rgba,colorchannelmixer=aa=0.6[lg];[cv][lg]overlay=x=W-w-30:y=30[v]';
  await ff([...CLIPS.flatMap((c) => ['-i', join(dir, c.f)]), '-loop', '1', '-i', join(dir, 'logo.png'), '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', '12', ...X264, ...AAC, join(dir, 'out/bug.mp4')]);
  writeProject(join(dir, 'bug.mgl.json'), {
    assets: [...CLIPS.map((c, i) => ({ id: `c${i + 1}`, src: c.f })), { id: 'logo', src: 'logo.png' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }],
    clips: [
      { id: 'shot1', track: 'V1', at: 0, len: 120, asset: 'c1' },
      { id: 'shot2', track: 'V1', at: 120, len: 120, asset: 'c2', transition: { in: { type: 'dip', len: 15 } } },
      { id: 'shot3', track: 'V1', at: 240, len: 120, asset: 'c3', transition: { in: { type: 'dip', len: 15 } } },
      { id: 'bug', track: 'V2', at: 0, len: 360, asset: 'logo', x: 1150, y: 130, opacity: 0.6 },
    ],
  });
}
