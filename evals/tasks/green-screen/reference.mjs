// Reference solution with plain ffmpeg: chromakey the presenter over the city, a still at 1 s.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ffmpeg } from '../../lib/index.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ffmpeg(['-i', join(dir, 'city.mp4'), '-i', join(dir, 'presenter.mp4'), '-filter_complex', '[1:v]colorkey=0x00ff00:0.3:0.05[k];[0:v][k]overlay', '-ss', '1', '-frames:v', '1', join(dir, 'out/key.png')]);
}
