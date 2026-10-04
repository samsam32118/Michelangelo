import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

/** Hand-written on purpose: a trailing comma, "opactiy", a clip on missing track V3, and an overlap on V1. */
export const BROKEN = `{"michelangelo": 1,
"project": {"name": "Broken edit"},
"assets": [
{"id": "beach-mp4", "src": "media/beach.mp4"},
{"id": "city-mp4", "src": "media/city.mp4"}
],
"comps": [
{"id": "main", "size": [1280, 720], "fps": 30, "length": 300}
],
"tracks": [
{"id": "V1", "comp": "main"},
{"id": "V2", "comp": "main"},
{"id": "T1", "comp": "main"}
],
"clips": [
{"id": "shot1", "track": "V1", "at": 0, "len": 120, "asset": "beach-mp4"},
{"id": "shot2", "track": "V1", "at": 100, "len": 110, "asset": "city-mp4", "in": 30},
{"id": "shot3", "track": "V1", "at": 210, "len": 90, "asset": "beach-mp4", "in": 150},
{"id": "overlay", "track": "V2", "at": 30, "len": 150, "color": "#ff6600", "opactiy": 0.8, "scale": 0.3, "x": 1100, "y": 600},
{"id": "title", "track": "T1", "at": 0, "len": 90, "text": "Summer", "style": "title"},
{"id": "credit", "track": "V3", "at": 240, "len": 60, "text": "Shot on location", "style": "label", "y": 650},
]
}
`;

export async function setup(dir) {
  await F.video(join(dir, 'media/beach.mp4'), { src: 'testsrc2', d: 10, size: '1280x720' });
  await F.video(join(dir, 'media/city.mp4'), { src: 'smptebars', d: 10, size: '1280x720' });
  F.writeText(join(dir, 'broken.mgl.json'), BROKEN);
  return F.finish(dir, { ids: ['shot1', 'shot2', 'shot3', 'overlay', 'title', 'credit'] });
}
