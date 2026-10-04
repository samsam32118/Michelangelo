// Reference solution with plain ffmpeg: chromakey the presenter over the city, a still at 1 s.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ffmpeg(['-i', join(dir, 'city.mp4'), '-i', join(dir, 'presenter.mp4'), '-filter_complex', '[1:v]colorkey=0x00ff00:0.3:0.05[k];[0:v][k]overlay', '-ss', '1', '-frames:v', '1', join(dir, 'out/key.png')]);
  // the edit as a project too (plain JSON): graders check the library's file carries it
  writeFileSync(join(dir, 'key.mgl.json'), formatProject({ michelangelo: 1, project: { name: 'Key' },
    assets: [{ id: 'city', src: 'city.mp4' }, { id: 'presenter', src: 'presenter.mp4' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 120 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }],
    clips: [{ id: 'city-shot', track: 'V1', at: 0, len: 120, asset: 'city' }, { id: 'presenter-shot', track: 'V2', at: 0, len: 120, asset: 'presenter', fx: [{ type: 'chroma-key', color: '#00ff00' }] }] }));
}
