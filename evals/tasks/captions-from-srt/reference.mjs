// Reference solution with plain JSON edits + ffmpeg (no Michelangelo): proves the grader can pass.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readCaptions, readProject, formatProject, ffmpeg } from '../../lib/index.mjs';
import { hasDrawtext, drawtext } from '../../lib/fixtures.mjs';

export async function solve(dir) {
  const cues = readCaptions(join(dir, 'talk.srt'));
  const p = readProject(join(dir, 'talk.mgl.json'));
  p.tracks.push({ id: 'T1', comp: 'main' });
  p.clips.push({ id: 'subs', track: 'T1', at: 0, len: 900, captions: true, style: { base: 'caption', color: '#ffffff', stroke: '#000000' }, y: 880 });
  p.cues = cues.map((c, i) => ({ id: `c${i + 1}`, clip: 'subs', at: Math.round(c.start * 30), len: Math.round(c.end * 30) - Math.round(c.start * 30), text: c.text }));
  writeFileSync(join(dir, 'talk.mgl.json'), formatProject(p));
  if (!(await hasDrawtext())) throw new Error('drawtext unavailable');
  const vf = ['scale=960:540', ...cues.map((c) => drawtext(c.text, { fontsize: 40, fontcolor: 'white', borderw: 4, bordercolor: 'black', y: 'h*0.8', enable: `'between(t,${c.start},${c.end})'` }))].join(',');
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ffmpeg(['-i', join(dir, 'media/talk.mp4'), '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', join(dir, 'out/draft.mp4')]);
}
