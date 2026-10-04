// @vitest-environment node
/**
 * Review 3 (render + media): levels aligned to the mix zero, waveform gens honour clip.clock, drop-frame timecode
 * rules, timecode gen clock with drop-frame, the fast path refuses alpha sources, 24-bit mov audio, shape trim
 * across subpaths, notes for delivery flags a format ignores, and the short last chapter warning.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { z } from 'zod';
import { checkDelivery, isDropFrameRate } from '../../src/media/encode.js';
import { analyzeLevels, levelsAlignFilter } from '../../src/media/levels.js';
import { chapterList } from '../../src/render/chapters.js';
import { evaluate, type EvaluateOptions } from '../../src/render/evaluate.js';
import { passthroughSource, render, renderStills } from '../../src/render/pipeline.js';
import { trimWindows } from '../../src/render/skia/shapes.js';
import { timecodeText } from '../../src/builtin/effects/generators/timecode.js';
import { PluginRegistry } from '../../src/plugin/registry.js';
import { defineGenerator, definePlugin } from '../../src/plugin/api.js';
import type { DisplayList, LayerNode, RGBAFrame, TextLayouter } from '../../src/render/types.js';
import { ff, ffprobeJson, tempDir } from './media-fixtures.js';

let dir: string, cleanup: () => void;
beforeAll(() => {
  ({ dir, cleanup } = tempDir('mgl-r3render-'));
  // video from 0 s, audio from 0.5 s on the container clock; the tone starts at 1.0 s (container clock)
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=2', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'aevalsrc=exprs=0.5*sin(2*PI*1000*t)*gte(t\\,0.5):s=48000:d=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', join(dir, 'off.mov')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'clip.mp4')]);
  // VP9 with alpha: the left half is transparent white
  ff(['-f', 'lavfi', '-i', 'color=c=white:s=160x90:r=30:d=1,format=rgba,geq=r=255:g=255:b=255:a=\'if(lt(X\\,W/2)\\,0\\,255)\'', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', join(dir, 'alpha.webm')]);
});
afterAll(() => cleanup());

const px = (img: RGBAFrame, x: number, y: number) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!]; };

describe('waveform / spectrum levels', () => {
  it('start at the mix zero (first video frame), not at the first audio sample', async () => {
    expect(levelsAlignFilter({ hasVideo: true, startTime: 0, audioStart: 0.5, formatStart: 0 })).toBe('aresample=22050:async=1:first_pts=0');
    expect(levelsAlignFilter({ hasVideo: true, startTime: 0.1, formatStart: 0 })).toContain('atrim=start_sample=2205');
    const lv = await analyzeLevels(join(dir, 'off.mov'), { num: 30, den: 1 }, { noCache: true });
    expect(lv.rms[20]!).toBeLessThan(0.1); // 0.67 s: silent on the container clock (the old decode put the tone here)
    expect(lv.rms[36]!).toBeGreaterThan(0.5); // 1.2 s: the tone
  });

  it('a split waveform gen continues the sound (clip.clock), instead of replaying from the start', () => {
    const layouter: TextLayouter = { layout: (t, st) => ({ w: 1, h: 1, size: st.size, lines: [], words: [] }) };
    const registry = new PluginRegistry().add(definePlugin({
      name: 't',
      generators: [defineGenerator({ type: 'meter', describe: 'm', params: z.object({ src: z.string().default('a') }), audioSource: (p) => p.src, draw() {} })],
    }));
    const opts: EvaluateOptions = { layouter, registry, assetKind: () => 'audio' };
    const p = {
      michelangelo: 1, assets: [{ id: 'a', src: 'a.wav' }], comps: [{ id: 'main', size: [64, 64], fps: 30 }], tracks: [{ id: 'V1', comp: 'main' }],
      clips: [{ id: 'wf-2', track: 'V1', at: 30, len: 60, gen: { type: 'meter', src: 'a' }, clock: 30 }, { id: 'sp', track: 'V1', at: 100, len: 60, gen: { type: 'meter', src: 'a' }, clock: 10, in: 5, speed: 2 }],
    } as unknown as ProjectFile;
    const gen = (f: number) => ((evaluate(p, 'main', f, opts).nodes[0] as LayerNode).source as { audio?: { frame: number } }).audio!.frame;
    expect(gen(30)).toBe(30);
    expect(gen(45)).toBe(45);
    expect(gen(100)).toBe(5 + 2 * 10);
  });
});

describe('timecode', () => {
  it('drop-frame ";" only at 29.97 / 59.94, refused at 23.976 with a fix', () => {
    expect(isDropFrameRate({ num: 30000, den: 1001 })).toBe(true);
    expect(isDropFrameRate({ num: 60000, den: 1001 })).toBe(true);
    expect(isDropFrameRate({ num: 24000, den: 1001 })).toBe(false);
    expect(() => checkDelivery({ timecode: '01:00:00;00' }, 'mov', { num: 24000, den: 1001 })).toThrowError(expect.objectContaining({ code: 'E_ARG', fix: expect.stringContaining('01:00:00:00') }));
    expect(() => checkDelivery({ timecode: '01:00:00:00' }, 'mov', { num: 24000, den: 1001 })).not.toThrow();
  });

  it('render reports the timecode it verified in the file', async () => {
    const p = {
      michelangelo: 1, assets: [{ id: 'clip', src: 'clip.mp4' }], comps: [{ id: 'main', size: [160, 90], fps: '30000/1001' }],
      tracks: [{ id: 'V1', comp: 'main' }], clips: [{ id: 'c', track: 'V1', at: 0, len: 20, asset: 'clip', muted: true }],
    } as unknown as ProjectFile;
    const r = await render(p, join(dir, 'df.mov'), { baseDir: dir, timecode: '01:00:00;00', quality: 'draft' });
    expect(r.probe?.timecode).toBe('01:00:00;00');
    expect(r.notes).toContain('start timecode 01:00:00;00');
    const q = { ...p, comps: [{ id: 'main', size: [160, 90], fps: '24000/1001' }] } as unknown as ProjectFile;
    await expect(render(q, join(dir, 'df24.mov'), { baseDir: dir, timecode: '01:00:00;00', quality: 'draft' })).rejects.toMatchObject({ code: 'E_ARG' });
  });

  it('the timecode gen clock/seconds read the same instant the same way with drop-frame', () => {
    const fps = 30000 / 1001;
    const p = { start: '01:00:00;00', format: 'seconds' as const, drop: true, prefix: '' };
    expect(timecodeText(p, 0, fps)).toBe(timecodeText({ ...p, start: '00:00:00;00' }, 107892, fps));
    expect(timecodeText({ ...p, format: 'clock' }, 0, fps)).toBe(timecodeText({ ...p, format: 'clock', start: '00:00:00;00' }, 107892, fps));
    // non-drop labels still read at their nominal rate
    expect(timecodeText({ ...p, drop: false, start: '01:00:00:00', format: 'clock' }, 0, fps)).toBe('01:00:00');
  });
});

describe('fast path and alpha sources', () => {
  it('refuses a source whose probe says it has alpha (VP8/VP9 alpha reports yuv420p)', () => {
    const node: LayerNode = {
      type: 'layer', clipId: 'c', box: { w: 160, h: 90 }, matrix: [1, 0, 0, 1, 0, 0], opacity: 1, blend: 'normal', fx: [], masks: [], localFrame: 0, seed: 1,
      source: { type: 'media', assetId: 'v', src: 'v.webm', kind: 'video', sourceFrame: 0, rate: { num: 30, den: 1 }, filters: [], fit: 'cover', size: { w: 160, h: 90 } },
    };
    const list: DisplayList = { compId: 'main', width: 160, height: 90, frame: 0, rate: { num: 30, den: 1 }, nodes: [node] };
    const info = (o: object) => new Map([['v', { kind: 'video', pixFmt: 'yuv420p', width: 160, height: 90, ...o }]]) as never;
    expect(passthroughSource({ W: 160, H: 90, info: info({}) }, list, 160, 90)).not.toBeNull();
    expect(passthroughSource({ W: 160, H: 90, info: info({ alpha: true }) }, list, 160, 90)).toBeNull();
    expect(passthroughSource({ W: 160, H: 90, info: info({ pixFmt: 'yuva444p10le' }) }, list, 160, 90)).toBeNull(); // ProRes 4444
    expect(passthroughSource({ W: 160, H: 90, info: info({ pixFmt: 'rgba' }) }, list, 160, 90)).toBeNull(); // PNG
  });

  it('a VP9-alpha clip over a red comp bg shows red where it is transparent', async () => {
    const p = {
      michelangelo: 1, assets: [{ id: 'a', src: 'alpha.webm' }], comps: [{ id: 'main', size: [160, 90], fps: 30, bg: '#ff0000' }],
      tracks: [{ id: 'V1', comp: 'main' }], clips: [{ id: 'c', track: 'V1', at: 0, len: 10, asset: 'a' }],
    } as unknown as ProjectFile;
    const out = join(dir, 'wa.mp4');
    await render(p, out, { baseDir: dir, crf: 0 });
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const at = (x: number, y: number) => Array.from(raw.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3));
    const [r, g, b] = at(30, 45);
    expect(r).toBeGreaterThan(200); expect(g).toBeLessThan(60); expect(b).toBeLessThan(60);
    expect(at(130, 45).every((v) => v > 200)).toBe(true);
  });
});

describe('24-bit mov audio and delivery notes', () => {
  const p = {
    michelangelo: 1, assets: [{ id: 'clip', src: 'clip.mp4' }], comps: [{ id: 'main', size: [160, 90], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }], clips: [{ id: 'c', track: 'V1', at: 0, len: 30, asset: 'clip', gain: -7.3 }],
  } as unknown as ProjectFile;

  it('--pcm 24 on .mov carries real 24-bit samples', async () => {
    const out = join(dir, 'p24.mov');
    await render(p, out, { baseDir: dir, pcmDepth: 24, quality: 'draft' });
    expect(ffprobeJson(out).streams.find((s) => s.codec_type === 'audio')!.codec_name).toBe('pcm_s24le');
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-map', '0:a', '-c:a', 'pcm_s24le', '-f', 's24le', '-'], { maxBuffer: 1 << 26 });
    let low = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] !== 0) low++;
    expect(low / (raw.length / 3)).toBeGreaterThan(0.5);
  });

  it('flags a format does not use are noted, not silently dropped', async () => {
    const r30 = { num: 30, den: 1 };
    expect(checkDelivery({ pcmDepth: 24 }, 'mp4', r30).join(' ')).toMatch(/pcmDepth 24 ignored: mp4 audio is AAC/);
    expect(checkDelivery({ audioBitrate: '320k' }, 'mov', r30).join(' ')).toMatch(/audioBitrate 320k ignored: mov audio is uncompressed PCM/);
    expect(checkDelivery({ audioBitrate: '320k' }, 'gif', r30).join(' ')).toMatch(/no audio/);
    expect(checkDelivery({ pcmDepth: 24 }, 'mov', r30)).toEqual([]);
    expect(checkDelivery({ audioBitrate: '320k' }, 'webm', r30)).toEqual([]);
    const r = await render(p, join(dir, 'x.mp4'), { baseDir: dir, pcmDepth: 24, quality: 'draft' });
    expect(r.notes.join(' | ')).toMatch(/pcmDepth 24 ignored/);
  });
});

describe('shape trim across subpaths', () => {
  const shot = async (shape: object) => {
    const p = {
      michelangelo: 1, comps: [{ id: 'main', size: [400, 200], fps: 30, bg: '#000000' }], tracks: [{ id: 'V1', comp: 'main' }],
      clips: [{ id: 's', track: 'V1', at: 0, len: 10, x: 200, y: 100, shape: { type: 'path', d: 'M0 0 L200 0 M0 100 L200 100', fill: 'none', stroke: '#ffffff', strokeWidth: 10, ...shape } }],
    } as unknown as ProjectFile;
    const [s] = await renderStills(p, { baseDir: dir, frames: [0], scale: 1 });
    // layer box 200 × 100 centred at (200, 100): the lines run at y = 50 and y = 150, x 100–300
    return { top: px(s!.image, 150, 50)[0]!, bottom: px(s!.image, 150, 150)[0]!, topRight: px(s!.image, 280, 50)[0]! };
  };

  it('trim windows wrap like trimDash', () => {
    expect(trimWindows(0, 1, 0)).toBeNull();
    expect(trimWindows(0.2, 0.2, 0)).toBe('none');
    expect(trimWindows(0, 0.5, 0.75)).toEqual([[0, 0.25], [0.75, 1]]);
  });

  it('trim 0.5 draws only the first contour; trimStart 0.5 only the second; 0.25 half of the first', async () => {
    const a = await shot({ trim: 0.5 });
    expect(a.top).toBeGreaterThan(200); expect(a.bottom).toBeLessThan(30);
    const b = await shot({ trimStart: 0.5, trim: 1 });
    expect(b.top).toBeLessThan(30); expect(b.bottom).toBeGreaterThan(200);
    const c = await shot({ trim: 0.25 });
    expect(c.topRight).toBeLessThan(30);
    const d = await shot({ trim: 0.75 });
    expect(d.top).toBeGreaterThan(200); expect(d.bottom).toBeGreaterThan(200);
  });
});

describe('chapters', () => {
  it('warn when the last chapter is under 10 s', () => {
    const p = { michelangelo: 1, comps: [{ id: 'main', size: [64, 64], fps: 30, length: 35 * 30 }], tracks: [], clips: [], markers: [{ id: 'a', comp: 'main', at: 0, note: 'Start' }, { id: 'b', comp: 'main', at: 360, note: 'Middle' }, { id: 'c', comp: 'main', at: 900, note: 'End' }] } as unknown as ProjectFile;
    expect(chapterList(p, 'main', [0, 35 * 30]).notes.join(' | ')).toMatch(/"End" \(0:30\) is shorter than 10 s/);
    expect(chapterList(p, 'main').notes.join(' | ')).toMatch(/"End" \(0:30\) is shorter/);
    expect(chapterList(p, 'main', [0, 45 * 30]).notes.join(' | ')).not.toMatch(/shorter/);
  });
});
