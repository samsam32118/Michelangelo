// @vitest-environment node
/** Review 3 (audio): fx latency compensation, clip fx over the continuous clip sound, gain → fx → fades, bus fx before the duck. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { audioEffects } from '../../src/builtin/effects/fx/audio.js';
import { planAudio } from '../../src/media/audio-plan.js';
import { buildMixGraph, filterLatency, renderAudio } from '../../src/media/audio-render.js';
import { ff, tempDir } from './media-fixtures.js';

let dir: string, cleanup: () => void;
beforeAll(() => {
  ({ dir, cleanup } = tempDir('mgl-r3audio-'));
  // a 1 kHz burst starting exactly at sample 24000 (0.5 s), 2 s long in all
  ff(['-f', 'lavfi', '-i', 'aevalsrc=exprs=0.5*sin(2*PI*1000*t)*between(t\\,0.5\\,0.6):s=48000:d=2', '-c:a', 'pcm_s16le', join(dir, 'burst.wav')]);
  ff(['-f', 'lavfi', '-i', 'anoisesrc=r=48000:a=0.1:d=1:seed=7', '-c:a', 'pcm_s16le', join(dir, 'n1.wav')]);
  ff(['-f', 'lavfi', '-i', 'aevalsrc=exprs=0.125*sin(2*PI*440*t):s=48000:d=2', '-c:a', 'pcm_f32le', join(dir, 'quiet.wav')]);
});
afterAll(() => cleanup());

function project(clips: object[], buses?: object[]): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'burst', src: 'burst.wav' }, { id: 'n1', src: 'n1.wav', kind: 'audio' }, { id: 'quiet', src: 'quiet.wav' }],
    comps: [{ id: 'main', size: [64, 64], fps: 30 }],
    tracks: [{ id: 'A1', comp: 'main', audio: true, bus: 'fxbus' }],
    clips,
    ...(buses ? { buses } : {}),
  } as ProjectFile;
}

function pcm(file: string): Float32Array {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-af', 'pan=mono|c0=c0', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}
const onset = (a: Float32Array) => { let pk = 0; for (const x of a) pk = Math.max(pk, Math.abs(x)); return a.findIndex((x) => Math.abs(x) > 0.05 * pk); };
const rms = (a: Float32Array, at: number, n: number) => { let s = 0; for (let i = at; i < at + n; i++) s += a[i]! ** 2; return Math.sqrt(s / n); };
const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

async function mix(p: ProjectFile, name: string): Promise<Float32Array> {
  const plan = planAudio(p, 'main', { baseDir: dir, registry: builtinRegistry(), duration: (id) => (id === 'n1' ? 1 : 2) });
  const out = join(dir, `${name}.wav`);
  await renderAudio(plan, out, { baseDir: dir });
  return pcm(out);
}

describe('audio fx keep transients in place (latency compensation)', () => {
  it('knows the lookahead of afftdn / anlmdn / superequalizer and honours FilterSpec.latency', () => {
    expect(filterLatency({ filter: 'afftdn', args: { nr: 12 } })).toBe(1200);
    expect(filterLatency({ filter: 'anlmdn' })).toBe(384);
    expect(filterLatency({ filter: 'volume' })).toBe(0);
    expect(filterLatency({ filter: 'volume', latency: 64 })).toBe(64);
  });

  it('every built-in audio effect leaves the onset at the same sample, on a clip and on a bus, with no tail lost', async () => {
    const ref = await mix(project([{ id: 'b', track: 'A1', at: 0, len: 60, asset: 'burst' }]), 'ref');
    const o0 = onset(ref);
    expect(Math.abs(o0 - 24000)).toBeLessThanOrEqual(2);
    for (const def of audioEffects) {
      const fx = [{ type: def.type, ...(def.type === 'eq' ? { mid: 3 } : {}) }];
      const clip = await mix(project([{ id: 'b', track: 'A1', at: 0, len: 60, asset: 'burst', fx }]), `c-${def.type}`);
      expect(clip.length, def.type).toBe(96000);
      expect(Math.abs(onset(clip) - o0), `clip ${def.type}`).toBeLessThanOrEqual(2);
      const bus = await mix(project([{ id: 'b', track: 'A1', at: 0, len: 60, asset: 'burst' }], [{ id: 'fxbus', fx }]), `b-${def.type}`);
      expect(Math.abs(onset(bus) - o0), `bus ${def.type}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('clip fx run once over the clip\'s continuous sound', () => {
  it('a looped clip with denoise-audio has no dropout at the loop wraps', async () => {
    const a = await mix(project([{ id: 'n', track: 'A1', at: 0, len: 90, asset: 'n1', loop: true, fx: [{ type: 'denoise-audio', amount: 0.2 }] }]), 'loop');
    expect(a.length).toBe(144000);
    for (const at of [0, 48000, 96000]) expect(rms(a, at, 1200), `window at ${at}`).toBeGreaterThan(0.01);
  });

  it('one fx chain per clip in the graph, not one per piece', async () => {
    const p = project([{ id: 'n', track: 'A1', at: 0, len: 90, asset: 'n1', loop: true, fx: [{ type: 'denoise-audio' }] }]);
    const plan = planAudio(p, 'main', { baseDir: dir, registry: builtinRegistry(), duration: () => 1 });
    expect(plan.segments.length).toBe(3);
    const g = await buildMixGraph(plan, { baseDir: dir });
    expect(g.script.match(/afftdn/g)!.length).toBe(1);
  });
});

describe('order in a clip: gain → fx → fades; on a bus: fx → duck → gain', () => {
  it('clip gain runs before the limiter, so the ceiling holds', async () => {
    const a = await mix(project([{ id: 'q', track: 'A1', at: 0, len: 60, asset: 'quiet', gain: 12, fx: [{ type: 'limiter', ceiling: -6 }] }]), 'gainlim');
    expect(peak(a)).toBeLessThan(0.52);
    expect(peak(a)).toBeGreaterThan(0.4);
  });

  it('fades apply after the fx (a fade-out reaches silence even through a limiter)', async () => {
    const a = await mix(project([{ id: 'q', track: 'A1', at: 0, len: 60, asset: 'quiet', gain: 12, fade: [0, 15], fx: [{ type: 'limiter', ceiling: -6 }] }]), 'fade');
    expect(rms(a, 96000 - 480, 480)).toBeLessThan(0.02);
  });

  it('a bus runs its own fx before the sidechain duck', async () => {
    const p = { ...project([{ id: 'q', track: 'A1', at: 0, len: 60, asset: 'quiet' }], [{ id: 'fxbus', duck: { by: 'vo', db: 12 }, fx: [{ type: 'compressor', threshold: -30, ratio: 4 }] }, { id: 'vo' }]) } as ProjectFile;
    p.tracks!.push({ id: 'A2', comp: 'main', audio: true, bus: 'vo' } as never);
    (p.clips as object[]).push({ id: 'v', track: 'A2', at: 0, len: 60, asset: 'burst' });
    const plan = planAudio(p, 'main', { baseDir: dir, registry: builtinRegistry() });
    const s = (await buildMixGraph(plan, { baseDir: dir })).script;
    expect(s.indexOf('[bus_fxbus_fx]')).toBeGreaterThan(-1);
    expect(s.indexOf('acompressor')).toBeLessThan(s.indexOf('sidechaincompress'));
  });
});
