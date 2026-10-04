// Reference solution with plain ffmpeg + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff } from '../_lib/proc.mjs';
import { writeProject } from '../_lib/project.mjs';
import { BOUNDS } from './setup.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const segs = BOUNDS.slice(0, -1).map((s, i) => ({ s, e: BOUNDS[i + 1], src: i % 2 ? 1 : 0 }));
  const fc = segs.map((g, i) => `[${g.src}:v]trim=start_frame=${Math.round(g.s * 30)}:end_frame=${Math.round(g.e * 30)},setpts=PTS-STARTPTS[v${i}]`).join(';')
    + `;${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[v]`;
  await ff(['-i', join(dir, 'host.mp4'), '-i', join(dir, 'guest.mp4'), '-i', join(dir, 'room.wav'), '-filter_complex', fc, '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', join(dir, 'out/podcast.mp4')]);
  writeProject(join(dir, 'podcast.mgl.json'), {
    assets: [{ id: 'host', src: 'host.mp4' }, { id: 'guest', src: 'guest.mp4' }, { id: 'room-wav', src: 'room.wav' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 720 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true }],
    clips: [...segs.map((g, i) => ({ id: `shot${i + 1}`, track: 'V1', at: Math.round(g.s * 30), len: Math.round((g.e - g.s) * 30), asset: g.src ? 'guest' : 'host', in: Math.round(g.s * 30), muted: true })),
      { id: 'room', track: 'A1', at: 0, len: 720, asset: 'room-wav' }],
  });
}
