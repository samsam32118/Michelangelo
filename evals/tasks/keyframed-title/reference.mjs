// Reference solution: keyframes by JSON edit; the three stills drawn with ffmpeg drawtext at the keyframed positions.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, readProject, formatProject } from '../../lib/index.mjs';
import { hasDrawtext, drawtext } from '../../lib/fixtures.mjs';

export async function solve(dir) {
  const p = readProject(join(dir, 'title.mgl.json'));
  Object.assign(p.clips.find((c) => c.id === 'title'), { x: [[0, -400, 'outCubic'], [15, 960]], opacity: [[0, 1], [74, 1], [89, 0]] });
  writeFileSync(join(dir, 'title.mgl.json'), formatProject(p));
  mkdirSync(join(dir, 'out'), { recursive: true });
  const dt = await hasDrawtext();
  for (const [name, cx, alpha] of [['t025', 700, 1], ['t150', 960, 1], ['last', 960, 0]]) {
    const vf = dt ? drawtext('Launch Day', { fontsize: 120, fontcolor: `white@${alpha}`, x: `${cx}-text_w/2` }) : `drawbox=x=${cx - 300}:y=480:w=600:h=120:color=white@${alpha}:t=fill`;
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x101820:size=1920x1080', '-frames:v', '1', '-vf', vf, join(dir, `out/${name}.png`)]);
  }
}
