// Reference solution: mask + blend by JSON edit; the still composited with ffmpeg (feathered ellipse, screen blend).
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, readProject, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  const p = readProject(join(dir, 'layers.mgl.json'));
  p.clips.find((c) => c.id === 'top').masks = [{ shape: 'ellipse', box: [340, 160, 600, 400], feather: 40 }];
  p.clips.find((c) => c.id === 'leak').blend = 'screen';
  writeFileSync(join(dir, 'layers.mgl.json'), formatProject(p));
  mkdirSync(join(dir, 'out'), { recursive: true });
  const m = (n) => ['-ss', '2', '-i', join(dir, `media/${n}.mp4`)];
  await ffmpeg([...m('base'), ...m('bars'), ...m('leak'), '-filter_complex',
    "[1:v]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip((1-hypot((X-640)/300,(Y-360)/200))*5,0,1)'[top];[0:v][top]overlay=format=auto,format=gbrp[mid];[2:v]format=gbrp[lk];[mid][lk]blend=all_mode=screen",
    '-frames:v', '1', join(dir, 'out/still.png')]);
}
