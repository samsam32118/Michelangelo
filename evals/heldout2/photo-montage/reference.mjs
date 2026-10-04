// Reference with plain ffmpeg + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff, X264, AAC } from '../_lib/h.mjs';
import { writeProject } from '../_lib/fx.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const lens = [4.5, 5, 5, 5, 4.5];
  const ins = lens.flatMap((d, k) => ['-loop', '1', '-framerate', '30', '-t', String(d), '-i', join(dir, `photos/${k + 1}.jpg`)]);
  let fc = lens.map((d, k) => `[${k}:v]scale=eval=frame:w='2*trunc(960*(1+0.15*t/${d}))':h='2*trunc(540*(1+0.15*t/${d}))',crop=1920:1080,setsar=1,format=yuv420p,fps=30[p${k}]`).join(';');
  let last = 'p0';
  [3.5, 7.5, 11.5, 15.5].forEach((off, i) => { fc += `;[${last}][p${i + 1}]xfade=transition=fade:duration=1:offset=${off}[x${i}]`; last = `x${i}`; });
  fc += `;[5:a]atrim=0:20,afade=t=out:st=18:d=2[a]`;
  await ff([...ins, '-i', join(dir, 'music.wav'), '-filter_complex', fc, '-map', `[${last}]`, '-map', '[a]', '-t', '20', ...X264, ...AAC, join(dir, 'out/montage.mp4')]);
  const clips = [0, 1, 2, 3, 4].map((k) => ({ id: `photo${k + 1}`, track: 'V1', at: k * 120, len: 120, asset: `p${k + 1}`, fit: 'cover', scale: [[0, 1], [119, 1.15]], ...(k ? { transition: { in: { type: 'crossfade', len: 30 } } } : {}) }));
  writeProject(join(dir, 'montage.mgl.json'), {
    assets: [...[1, 2, 3, 4, 5].map((k) => ({ id: `p${k}`, src: `photos/${k}.jpg` })), { id: 'music', src: 'music.wav' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'music' }],
    clips: [...clips, { id: 'bed', track: 'A1', at: 0, len: 600, asset: 'music', fade: [0, 60] }],
  });
}
