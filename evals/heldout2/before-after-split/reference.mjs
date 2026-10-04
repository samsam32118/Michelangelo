// Reference with plain ffmpeg + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff, X264, AAC } from '../_lib/h.mjs';
import { writeProject, drawtext, hasDrawtext } from '../_lib/fx.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  await hasDrawtext();
  const lab = (t, x) => drawtext(t, { fontsize: 72, fontcolor: 'white', borderw: 4, bordercolor: 'black', x, y: 80 });
  const fc = '[0:v]crop=960:1080:480:0[l];[1:v]crop=960:1080:480:0[r];[l][r]hstack=inputs=2,drawbox=x=957:y=0:w=6:h=1080:color=white:t=fill'
    + `,${lab('BEFORE', '(480-text_w)/2')},${lab('AFTER', '960+(480-text_w)/2')}[v]`;
  await ff(['-i', join(dir, 'before.mp4'), '-i', join(dir, 'after.mp4'), '-filter_complex', fc, '-map', '[v]', '-map', '1:a', ...X264, ...AAC, join(dir, 'out/split.mp4')]);
  writeProject(join(dir, 'split.mgl.json'), {
    assets: [{ id: 'before', src: 'before.mp4' }, { id: 'after', src: 'after.mp4' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }, { id: 'V3', comp: 'main' }, { id: 'T1', comp: 'main' }],
    clips: [
      { id: 'left', track: 'V1', at: 0, len: 240, asset: 'before', x: 480, crop: [480, 0, 480, 0], muted: true },
      { id: 'right', track: 'V2', at: 0, len: 240, asset: 'after', x: 1440, crop: [480, 0, 480, 0] },
      { id: 'divider', track: 'V3', at: 0, len: 240, shape: { type: 'rect', size: [6, 1080], fill: '#ffffff' } },
      { id: 'label-before', track: 'T1', at: 0, len: 240, text: 'BEFORE', style: 'title', x: 480, y: 120 },
    ],
  });
  // second label on its own track (clips on one track must not overlap)
  const { readFileSync, writeFileSync } = await import('node:fs');
  const f = join(dir, 'split.mgl.json');
  const p = JSON.parse(readFileSync(f, 'utf8'));
  p.tracks.push({ id: 'T2', comp: 'main' });
  p.clips.push({ id: 'label-after', track: 'T2', at: 0, len: 240, text: 'AFTER', style: 'title', x: 1440, y: 120 });
  writeProject(f, p);
}
