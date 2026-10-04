// Reference solution with plain ffmpeg: black until the first beat, then one photo per beat (0.5 s), last one to 4.5 s.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const inputs = ['-f', 'lavfi', '-t', '0.5', '-i', 'color=black:size=1080x1080:rate=30'];
  for (let i = 1; i <= 8; i++) inputs.push('-loop', '1', '-framerate', '30', '-t', '0.5', '-i', join(dir, `photos/photo${i}.png`));
  inputs.push('-i', join(dir, 'beat.wav'));
  const v = Array.from({ length: 9 }, (_, i) => `[${i}:v]format=yuv420p,setsar=1[v${i}]`).join(';');
  await ffmpeg([...inputs, '-filter_complex', `${v};${Array.from({ length: 9 }, (_, i) => `[v${i}]`).join('')}concat=n=9:v=1:a=0[v]`, '-map', '[v]', '-map', '9:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', join(dir, 'out/beat.mp4')]);
  // the edit as a project too (plain JSON): graders check the library's file carries it
  writeFileSync(join(dir, 'beat.mgl.json'), formatProject({ michelangelo: 1, project: { name: 'Beat cut' },
    assets: [...Array.from({ length: 8 }, (_, i) => ({ id: `photo${i + 1}`, src: `photos/photo${i + 1}.png` })), { id: 'beat', src: 'beat.wav' }],
    comps: [{ id: 'main', size: [1080, 1080], fps: 30, length: 150 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'music' }],
    clips: [...Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, track: 'V1', at: 15 + 15 * i, len: 15, asset: `photo${i + 1}` })), { id: 'music', track: 'A1', at: 0, len: 150, asset: 'beat' }] }));
}
