import { join } from 'node:path';
import { video, writeText, finish } from '../_lib/fixtures.mjs';
import { writeProject } from '../_lib/project.mjs';

export const QUOTES = [
  { quote: 'Small daily improvements add up to remarkable results.', author: 'Jordan Ellis' },
  { quote: 'Ship it, learn from it, then make it better.', author: 'Priya Raman' },
];
export const SPANS = [[30, 150, '#22c55e'], [180, 300, '#ef4444']];

export async function setup(dir) {
  // desaturated background so neither accent colour occurs in it
  await video(join(dir, 'media/bg.mp4'), { src: 'testsrc2=size=1080x1350:rate=30', d: 11, vf: 'hue=s=0.25,format=yuv420p' });
  writeProject(join(dir, 'reel.mgl.json'), {
    project: { name: 'Quote reel' },
    assets: [{ id: 'bg-mp4', src: 'media/bg.mp4' }],
    comps: [{ id: 'main', size: [1080, 1350], fps: 30, length: 330 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'bg', track: 'V1', at: 0, len: 330, asset: 'bg-mp4' }],
  });
  writeText(join(dir, 'quotes.json'), `${JSON.stringify(QUOTES, null, 2)}\n`);
  return finish(dir, { quotes: QUOTES, spans: SPANS });
}
