// Reference solution: the project's frames (its moving label included) from the package's renderer for 3-6 s,
// turned into a 480 px looping GIF with plain ffmpeg. Needs a Michelangelo CLI (MGL_EVAL_MGL or dist/).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ffmpeg, renderProject } from '../../lib/index.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const r = await renderProject(dir, 'demo.mgl.json', 'mp4', ['--range', '3s-6s']);
  if (r.error) throw new Error(r.error);
  await ffmpeg(['-i', r.file, '-vf', 'fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', join(dir, 'out/clip.gif')]);
}
