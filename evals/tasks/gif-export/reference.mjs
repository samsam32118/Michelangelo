// Reference solution with plain ffmpeg: seconds 3-6 of the background, 480 px wide, looping.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ffmpeg } from '../../lib/index.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ffmpeg(['-ss', '3', '-t', '3', '-i', join(dir, 'media/bg.mp4'), '-vf', 'fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', join(dir, 'out/clip.gif')]);
}
