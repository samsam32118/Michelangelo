// Reference solution: B gets a correcting colour fx in the project; the stills are made with per-channel gains in ffmpeg.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, readProject, formatProject, frameAt, meanColor } from '../../lib/index.mjs';

export async function solve(dir) {
  const p = readProject(join(dir, 'match.mgl.json'));
  p.clips.find((c) => c.id === 'b').fx = [{ type: 'color', temperature: -0.3 }];
  writeFileSync(join(dir, 'match.mgl.json'), formatProject(p));
  mkdirSync(join(dir, 'out'), { recursive: true });
  const [a, b] = await Promise.all(['a', 'b'].map(async (s) => meanColor(await frameAt(join(dir, `media/${s}.mp4`), 1, { width: 320, height: 180 }))));
  await ffmpeg(['-ss', '1', '-i', join(dir, 'media/a.mp4'), '-frames:v', '1', join(dir, 'out/a.png')]);
  await ffmpeg(['-ss', '1', '-i', join(dir, 'media/b.mp4'), '-frames:v', '1', '-vf', `colorchannelmixer=rr=${a[0] / b[0]}:gg=${a[1] / b[1]}:bb=${a[2] / b[2]}`, join(dir, 'out/b.png')]);
}
