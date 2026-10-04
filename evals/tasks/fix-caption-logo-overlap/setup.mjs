import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export const LOGO = { x: 930, y: 250, size: 240, color: '#ff7a00' };
const CUES = [
  ['c1', 0, 60, 'New season, new deals'],
  ['c2', 60, 60, 'Everything must go'],
  ['c3', 120, 60, 'Up to half off'],
  ['c4', 180, 60, 'This weekend only'],
  ['c5', 240, 90, 'Visit any of our stores across the country this weekend and bring a friend along for even bigger savings'],
  ['c6', 330, 90, 'See you there'],
];

export async function setup(dir) {
  F.ensureDir(join(dir, 'media/logo.png'));
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=0xff7a00:size=${LOGO.size}x${LOGO.size}`, '-frames:v', '1', join(dir, 'media/logo.png')]);
  F.writeProject(join(dir, 'promo.mgl.json'), {
    project: { name: 'Weekend promo', platform: 'shorts' },
    assets: [{ id: 'logo-png', src: 'media/logo.png' }],
    styles: [{ id: 'caps', base: 'caption', size: 64, maxWidth: 1000, maxLines: 3 }],
    comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 450 }],
    tracks: [{ id: 'BG', comp: 'main' }, { id: 'CAP', comp: 'main' }, { id: 'LOGO', comp: 'main' }],
    clips: [
      { id: 'bg', track: 'BG', at: 0, len: 450, color: '#203040' },
      { id: 'subs', track: 'CAP', at: 0, len: 450, captions: true, style: 'caps', y: 440 },
      { id: 'logo', track: 'LOGO', at: 0, len: 450, asset: 'logo-png', fit: 'none', x: LOGO.x, y: LOGO.y },
    ],
    cues: CUES.map(([id, at, len, text]) => ({ id, clip: 'subs', at, len, text })),
  });
  return F.finish(dir, { logo: LOGO, cues: CUES, t: 9.5 });
}
