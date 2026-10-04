// @vitest-environment node
/** A looping (or repeated) bed keeps playing past its first source pass, ducked or not, and after the voice ends. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { planAudio } from '../../src/media/audio-plan.js';
import { renderAudio } from '../../src/media/audio-render.js';
import { ff, tempDir } from './media-fixtures.js';

let dir: string, cleanup: () => void;
beforeAll(() => {
  ({ dir, cleanup } = tempDir('mgl-loopduck-'));
  ff(['-f', 'lavfi', '-i', 'sine=f=220:d=3:r=48000', '-ac', '2', '-c:a', 'pcm_s16le', join(dir, 'bed.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=1000:d=4:r=48000', '-c:a', 'pcm_s16le', join(dir, 'vo.wav')]);
});
afterAll(() => cleanup());

function project(music: object[], duck: boolean): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'bed', src: 'bed.wav' }, { id: 'vo', src: 'vo.wav' }],
    comps: [{ id: 'main', size: [64, 64], fps: 30 }],
    tracks: [{ id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }],
    buses: [{ id: 'dialogue' }, { id: 'music', ...(duck ? { duck: { by: 'dialogue', db: 9 } } : {}) }],
    clips: [{ id: 'v', track: 'A1', asset: 'vo', at: 0, len: 120 }, ...music],
  } as ProjectFile;
}

async function levels(p: ProjectFile, name: string): Promise<number[]> {
  const plan = planAudio(p, 'main', { baseDir: dir, registry: builtinRegistry(), duration: (id) => (id === 'bed' ? 3 : 4) });
  const out = join(dir, `${name}.wav`);
  await renderAudio(plan, out, { baseDir: dir });
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-af', 'pan=mono|c0=c0', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const a = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  // RMS of 0.25 s windows at 1, 3.5, 5, 7 and 9.5 s
  return [1, 3.5, 5, 7, 9.5].map((t) => { let s = 0; const i0 = Math.round(t * 48000), n = 12000; for (let i = i0; i < i0 + n; i++) s += (a[i] ?? 0) ** 2; return Math.sqrt(s / n); });
}

describe('looping beds in the mix', () => {
  const loop = [{ id: 'm', track: 'A2', asset: 'bed', at: 0, len: 300, loop: true }];
  const repeats = [0, 90, 180, 270].map((at, i) => ({ id: `m${i}`, track: 'A2', asset: 'bed', at, len: Math.min(90, 300 - at) }));
  for (const [name, music] of [['loop', loop], ['repeated clips', repeats]] as const) {
    for (const duck of [true, false]) {
      it(`${name}, ${duck ? 'ducked' : 'not ducked'}: the bed plays to the end`, async () => {
        const l = await levels(project(music as object[], duck), `${name.replace(' ', '-')}-${duck}`);
        for (const x of l) expect(x).toBeGreaterThan(0.01);
        // after the voice (4 s) only the bed is left, at its full level
        expect(Math.abs(l[3]! - l[4]!)).toBeLessThan(0.02);
      });
    }
  }
});
