// Reference solution with plain ffmpeg: keep everything except the silences (minus 0.15 s of breath each side).
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, readSetup, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  const { info } = readSetup(dir);
  const keep = [];
  let t = 0;
  for (const s of info.silences) { const a = s.start + (s.start > 0 ? 0.15 : 0), b = s.end - 0.15; if (a > t) keep.push([t, a]); t = Math.max(t, b); }
  keep.push([t, info.duration]);
  const fr = (s) => Math.round(s * 30);
  let at = 0;
  const clips = keep.map(([a, b], i) => { const c = { id: `k${i + 1}`, track: 'A1', at, len: fr(b) - fr(a), asset: 'interview-wav', in: fr(a) }; at += c.len; return c; });
  writeFileSync(join(dir, 'tight.mgl.json'), formatProject({ michelangelo: 1, assets: [{ id: 'interview-wav', src: 'interview.wav' }], comps: [{ id: 'main', size: [640, 360], fps: 30, length: at }], tracks: [{ id: 'A1', comp: 'main', audio: true }], clips }));
  mkdirSync(join(dir, 'out'), { recursive: true });
  const graph = keep.map(([a, b], i) => `[0:a]atrim=${a}:${b},asetpts=PTS-STARTPTS[p${i}]`).join(';') + `;${keep.map((_, i) => `[p${i}]`).join('')}concat=n=${keep.length}:v=0:a=1[o]`;
  await ffmpeg(['-i', join(dir, 'interview.wav'), '-filter_complex', graph, '-map', '[o]', join(dir, 'out/tight.wav')]);
}
