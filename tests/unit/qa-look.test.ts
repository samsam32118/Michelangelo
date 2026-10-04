import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadImage } from '@napi-rs/canvas';
import type { ProjectFile } from '../../src/core/schema/index.js';
import type { AudioAnalysisReport } from '../../src/media/types.js';
import type { AudioPlan } from '../../src/render/types.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { chooseFrames, cropFinding, look, lookDir, sheetLayout, SHEET_MAX } from '../../src/qa/look.js';

const dir = mkdtempSync(join(tmpdir(), 'mgl-qa-look-'));
const file = join(dir, 'video.mgl.json');

const project = {
  michelangelo: 1,
  project: { platform: 'shorts' },
  comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 300, bg: '#000000' }],
  tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'music' }],
  assets: [{ id: 'bed', src: 'lavfi:sine' }],
  clips: [
    { id: 'a', track: 'V1', at: 0, len: 150, color: '#336699' },
    { id: 'b', track: 'V1', at: 150, len: 150, color: '#996633' },
    { id: 'logo', track: 'T1', at: 0, len: 300, shape: { type: 'rect', size: [200, 200] } },
    { id: 'cap', track: 'T1', at: 0, len: 300, text: 'Follow for more tips', y: 1760 },
    { id: 'm', track: 'A1', at: 0, len: 300, asset: 'bed' },
  ],
} as unknown as ProjectFile;

describe('frame choice and sheet layout', () => {
  it('n centred frames, cuts added, at most 24', () => {
    expect(chooseFrames(project, 'main', 300, { n: 12 })).toEqual([12, 37, 62, 87, 112, 137, 162, 187, 212, 237, 262, 287]);
    expect(chooseFrames(project, 'main', 300, { n: 4, cuts: true })).toEqual([37, 112, 150, 187, 262]);
    expect(chooseFrames(project, 'main', 300, { frames: [500, -3, 10, 10] })).toEqual([0, 10, 299]);
    expect(chooseFrames(project, 'main', 3, { n: 12 })).toEqual([0, 1, 2]);
    expect(chooseFrames(project, 'main', 3000, { n: 40 }).length).toBe(24);
  });

  it('grid fits the long edge in 1568 px for portrait, landscape and square', () => {
    for (const [n, W, H] of [[12, 1080, 1920], [12, 1920, 1080], [24, 1080, 1920], [5, 1080, 1080], [1, 1080, 1920], [16, 3840, 2160]] as const) {
      const l = sheetLayout(n, W, H);
      expect(Math.max(l.width, l.height)).toBeLessThanOrEqual(SHEET_MAX);
      expect(l.cols * l.rows).toBeGreaterThanOrEqual(n);
      expect(l.tileW / l.tileH).toBeCloseTo(W / H, 1);
    }
    const p = sheetLayout(12, 1080, 1920);
    expect([p.cols, p.rows]).toEqual([4, 3]);
    expect(p.scale).toBeGreaterThan(0.24);
    expect(p.scale).toBeLessThan(0.36);
    expect([sheetLayout(12, 1920, 1080).cols, sheetLayout(12, 1920, 1080).rows]).toEqual([3, 4]);
  });

  it('crop: padded, at least 512 px on the long edge, at most 1568', async () => {
    const img = { width: 270, height: 480, data: new Uint8Array(270 * 480 * 4).fill(200) };
    const c = cropFinding(img, 0.25, [440, 1200, 200, 200]);
    expect(Math.max(c.width, c.height)).toBe(512);
    expect(c.width).toBe(c.height);
    const big = cropFinding(img, 0.25, [0, 0, 1080, 1920]);
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(SHEET_MAX);
    expect(Math.max(big.width, big.height)).toBeGreaterThanOrEqual(512);
  });
});

describe('look with fakes', () => {
  it('writes the sheet, crops per boxed finding, runs frame + audio checks and summarises sound', async () => {
    const calls: { frames: number[]; scale?: number }[] = [];
    let wav = '';
    const report = await look(project, {
      baseDir: dir, file, registry: builtinRegistry(),
      deps: {
        renderStills: async (_p, o) => {
          calls.push({ frames: o.frames, scale: o.scale });
          const s = o.scale ?? 1, w = Math.round(1080 * s), h = Math.round(1920 * s);
          return o.frames.map((frame) => {
            const data = new Uint8Array(w * h * 4);
            const black = frame < 20; // the first sampled frame is black
            for (let i = 0; i < w * h; i++) data.set(black ? [0, 0, 0, 255] : [frame % 255, 90, 120, 255], i * 4);
            return { frame, image: { width: w, height: h, data }, layers: [
              { clipId: frame < 150 ? 'a' : 'b', kind: 'solid', box: [0, 0, 1080, 1920] },
              { clipId: 'cap', kind: 'text', box: [240, 1720, 600, 90], text: 'Follow for more tips', fontPx: 72 },
            ] };
          });
        },
        planAudio: (): AudioPlan => ({ sampleRate: 48000, length: 480000, buses: [], segments: [{ clipId: 'm', src: 'x', start: 0, end: 480000, sourceFrame: 0, rate: { num: 30, den: 1 }, speed: { num: 1, den: 1 }, bus: 'music', gain: [[0, 0]], fadeIn: 0, fadeOut: 0 }] }),
        backend: {
          renderAudio: async (_plan, out) => { wav = out; },
          analyzeAudio: async (): Promise<AudioAnalysisReport> => ({ duration: 10, loudness: { integrated: -9, truePeak: 0.4, lra: 3 }, silences: [{ start: 4, end: 7 }], beats: [0.5, 1, 1.5], bpm: 120, rms: [] }),
        },
      },
    });
    expect(report.sheet).toBe(join(lookDir(file), 'sheet.png'));
    expect(lookDir(file)).toBe(join(dir, '.mgl', 'video', 'look'));
    const sheet = await loadImage(readFileSync(report.sheet));
    expect([sheet.width, sheet.height]).toEqual(report.size);
    expect(Math.max(...report.size)).toBeLessThanOrEqual(SHEET_MAX);
    expect(report.frames).toHaveLength(12);
    expect(calls[0]!.scale).toBeCloseTo(report.scale);
    expect(wav).toBe(join(lookDir(file), 'mix.wav'));
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['black-frames', 'clipping', 'loudness', 'long-silence']));
    expect(report.findings[0]!.severity).toBe('error');
    expect(report.sound).toMatchObject({ integrated: -9, truePeak: 0.4, bpm: 120, beats: 3, silences: [{ start: 4, end: 7 }] });
    for (const c of report.crops) {
      expect(existsSync(c.path)).toBe(true);
      expect(c.path).toMatch(new RegExp(`qa-${c.finding + 1}\\.png$`));
      expect(report.findings[c.finding]!.box).toBeDefined();
      const im = await loadImage(readFileSync(c.path));
      expect(Math.max(im.width, im.height)).toBeGreaterThanOrEqual(512);
    }
    expect(report.seconds).toBeLessThan(10);
  });

  it('audio: false skips the mix; no audio segments gives a note', async () => {
    const stills = async (_p: ProjectFile, o: { frames: number[]; scale?: number }) => o.frames.map((frame) => ({ frame, image: { width: 4, height: 8, data: new Uint8Array(4 * 8 * 4).fill(128) }, layers: [] }));
    const r1 = await look(project, { baseDir: dir, file, n: 3, audio: false, registry: builtinRegistry(), deps: { renderStills: stills } });
    expect(r1.sound).toBeUndefined();
    const r2 = await look(project, { baseDir: dir, file, n: 3, registry: builtinRegistry(), deps: { renderStills: stills, planAudio: () => ({ sampleRate: 48000, length: 0, buses: [], segments: [] }), backend: { renderAudio: async () => {}, analyzeAudio: async () => { throw new Error('unused'); } } } });
    expect(r2.notes).toContain('no audio in this comp');
  });
});

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!hasFfmpeg)('look end to end (real renderer and ffmpeg)', () => {
  it('12 frames at 1080x1920 in under 10 s, with a caption-overlap refined by pixels and a sound line', async () => {
    const wavDir = mkdtempSync(join(tmpdir(), 'mgl-qa-look-e2e-'));
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-af', 'volume=-6dB', join(wavDir, 'tone.wav')]);
    const p = {
      ...project,
      assets: [{ id: 'bed', src: 'tone.wav' }],
      clips: [
        { id: 'a', track: 'V1', at: 0, len: 300, color: '#336699' },
        { id: 'cap', track: 'T1', at: 0, len: 300, text: 'Follow for more tips', y: 1000 },
        { id: 'm', track: 'A1', at: 0, len: 300, asset: 'bed' },
      ],
    } as unknown as ProjectFile;
    const r = await look(p, { baseDir: wavDir, file: join(wavDir, 'p.mgl.json'), registry: builtinRegistry() });
    expect(r.frames).toHaveLength(12);
    expect(r.seconds).toBeLessThan(10);
    expect(existsSync(r.sheet)).toBe(true);
    expect(r.sound?.integrated).toBeLessThan(-5);
    expect(r.findings.some((f) => f.rule === 'black-frames')).toBe(false);
  }, 60_000);
});
