/**
 * Regression tests (exploration round 2): mgl --version, show columns / markers / generator params / bus fx,
 * docs effects from the live registry, delivery flags, multi-platform check, audio-only plugin scaffolds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, mgl, tempDir } from './cli-fixtures.js';
import { parseArgs } from '../../src/cli/io.js';
import { deliveryFlags } from '../../src/cli/render.js';
import { catalogPage } from '../../src/cli/docs.js';
import { genSummary, busText } from '../../src/cli/show.js';
import { parsePlatforms } from '../../src/sdk/index.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { PluginRegistry } from '../../src/plugin/registry.js';
import { checkPluginDef } from '../../src/plugin/validate.js';
import { defineEffect, definePlugin, z, type FilterSpec } from '../../src/plugin/api.js';
import { effectFilters, renderEffect, renderGenerator, testLevels } from '../../src/plugin/testing.js';

const { dir, cleanup } = tempDir('mgl-round2-');
afterAll(cleanup);

const PROJECT = {
  michelangelo: 1,
  comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 1200 }],
  tracks: [{ id: 'V1', comp: 'main' }, { id: 'FX', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }],
  clips: [
    { id: 'bg', track: 'V1', at: 0, len: 1200, color: '#202024' },
    { id: 'redact', track: 'FX', at: 180, len: 1020, adjustment: true, fx: [{ type: 'blur', radius: 12 }] },
  ],
  buses: [{ id: 'dialogue', fx: [{ type: 'highpass' }, { type: 'deesser' }] }],
  markers: [{ id: 'm1', comp: 'main', at: 0, note: 'Intro' }, { id: 'm2', comp: 'main', at: 600, note: 'Setup and install' }, { id: 'm3', comp: 'main', at: 900 }],
};

beforeAll(() => {
  writeFileSync(join(dir, 'v.mgl.json'), JSON.stringify(PROJECT, null, 2));
});

describe('mgl --version', () => {
  it('prints the package version for --version, -v and version', async () => {
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    for (const flag of ['--version', '-v', 'version']) {
      const r = await mgl([flag], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`^mgl ${version.replace(/\./g, '\\.')} \\(plugin API \\d+\\.\\d+\\.\\d+`));
      expect(r.stdout).not.toContain('usage');
    }
    const j = await mgl(['--version', '--json'], { cwd: dir });
    expect(j.json).toMatchObject({ ok: true, version });
  }, 30_000);
});

describe('mgl show', () => {
  it('separates the kind column from the time for every kind (no "adjust6.00")', async () => {
    const r = await mgl(['show', 'v.mgl.json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/adjust\d/);
    expect(r.stdout).toMatch(/redact\s+adjust\s+6\.00–40\.00/);
    expect(r.stdout).toMatch(/bg\s+solid\s+0\.00–40\.00/);
  }, 30_000);

  it('lists markers with their notes and the buses with their fx', async () => {
    const r = await mgl(['show', 'v.mgl.json', '--json'], { cwd: dir });
    const text = (await mgl(['show', 'v.mgl.json'], { cwd: dir })).stdout;
    expect(text).toContain('markers: m1 0.00 "Intro", m2 20.00 "Setup and install", m3 30.00');
    expect(text).toContain('buses: dialogue fx highpass,deesser → master');
    expect(r.json.markers).toEqual([{ id: 'm1', at: 0, note: 'Intro' }, { id: 'm2', at: 600, note: 'Setup and install' }, { id: 'm3', at: 900 }]);
  }, 30_000);

  it('summarises generator params and bus settings', () => {
    expect(genSummary({ type: 'counter', from: 3, to: 1, round: 'ceil' })).toBe('counter from=3 to=1 round=ceil');
    expect(genSummary({ type: 'waveform', asset: 'vo', color: '#fff', bars: [[0, 10], [30, 40]] })).toBe('waveform asset=vo color=#fff bars~2keys');
    expect(genSummary({ type: 'counter', prefix: 'Day one' })).toBe('counter prefix="Day one"');
    expect(busText({ id: 'music', gain: -6, duck: { by: 'dialogue', db: 12 }, fx: [{ type: 'eq' }] })).toBe('music -6dB fx eq ducked 12dB by dialogue → master');
    expect(busText({ id: 'master', loudness: { lufs: -14, peak: -1 } })).toBe('master -14 LUFS / -1 dBTP');
  });
});

describe('mgl docs effects', () => {
  it('comes from the live registry (defaults and stages as defined, audio effects marked)', async () => {
    const reg = builtinRegistry();
    const page = catalogPage(reg).join('\n');
    const spill = (reg.effects.get('chroma-key')!.params as z.ZodObject).shape.spill as z.ZodType;
    expect(page).toContain(`\`spill?\` number = \`${JSON.stringify(spill.parse(undefined))}\``);
    expect(page).toMatch(/\*\*highpass\*\* \(audio\)/);
    // a changed registry changes the page: nothing is read from a file
    const r2 = new PluginRegistry().add({ name: 'x', effects: [defineEffect({ type: 'zz-test', describe: 'Test effect.', params: z.object({ k: z.number().default(7) }), audio: () => [] })] });
    expect(catalogPage(r2).join('\n')).toContain('**zz-test** (audio): Test effect.  \n  `k?` number = `7`');
    const r = await mgl(['docs', 'effects'], { cwd: dir });
    expect(r.stdout.trim()).toBe(page.trim());
    const t = await mgl(['docs', 'generators'], { cwd: dir });
    expect(t.stdout.split('\n')[0]).toBe('## Generators');
    expect(t.stdout).not.toContain('## Templates');
  }, 30_000);
});

describe('mgl docs <op>', () => {
  it('prints a long command doc whole (fields and example past 40 lines)', async () => {
    const r = await mgl(['docs', 'clip.add'], { cwd: dir });
    expect(r.lines.length).toBeGreaterThan(40);
    expect(r.stdout).toMatch(/^example: mgl edit/m);
    expect(r.stdout).toMatch(/^json: /m);
  }, 30_000);
});

describe('render delivery flags', () => {
  const flags = (argv: string[]) => deliveryFlags(parseArgs(argv, { values: ['bus', 'crf', 'bitrate', 'audio-bitrate', 'pcm', 'prores', 'timecode', 'color-range'] }));
  it('parses every delivery flag into RenderOpts', () => {
    expect(flags(['--crf', '18', '--bitrate', '8M', '--audio-bitrate', '320k', '--pcm', '24', '--prores', '422HQ', '--timecode', '10:00:00:00', '--color-range', 'full', '--bus', 'all']))
      .toEqual({ crf: 18, bitrate: '8M', audioBitrate: '320k', pcmDepth: 24, prores: 'hq', timecode: '10:00:00:00', colorRange: 'pc', bus: 'all' });
    expect(flags(['--prores', '4444'])).toEqual({ prores: '4444' });
    expect(flags([])).toEqual({});
  });
  it('refuses bad values with the accepted ones', () => {
    expect(() => flags(['--pcm', '32'])).toThrow(/not a PCM bit depth/);
    expect(() => flags(['--prores', 'ultra'])).toThrow(/not a ProRes profile/);
    expect(() => flags(['--color-range', 'wide'])).toThrow(/not a colour range/);
    expect(() => flags(['--bitrate', 'fast'])).toThrow(/not a bitrate/);
    expect(() => flags(['--crf', '-1'])).toThrow();
  });
  it('the CLI passes the flags to the pipeline (which refuses crf for a .wav)', async () => {
    const r = await mgl(['render', 'v.mgl.json', 'out/x.wav', '--crf', '18', '--json'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.json.error.message).toMatch(/crf/);
  }, 60_000);
});

describe('check --platform a,b', () => {
  it('validates platform lists', () => {
    expect(parsePlatforms('tiktok, reels,shorts,tiktok')).toEqual(['tiktok', 'reels', 'shorts']);
    expect(() => parsePlatforms('tiktok,myspace')).toThrow(/"myspace" is not a platform/);
  });
  it('tags platform-specific findings (SDK and --json)', async () => {
    const v = { michelangelo: 1, project: { platform: 'shorts' }, comps: [{ id: 'main', size: [540, 960], fps: 30, length: 60 }], tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
      clips: [{ id: 'bg', track: 'V1', at: 0, len: 60, color: '#203040' }, { id: 'handle', track: 'T1', at: 0, len: 60, text: '@handle', style: 'label', x: 400, y: 820 }] };
    writeFileSync(join(dir, 'vert.mgl.json'), JSON.stringify(v));
    const { open } = await import('../../src/sdk/index.js');
    const rep = await (await open(join(dir, 'vert.mgl.json'))).check({ platforms: ['tiktok', 'reels'] });
    const safe = rep.findings.filter((f) => f.rule === 'text-outside-safe');
    expect(safe.map((f) => f.platform).sort()).toEqual(['reels', 'tiktok']);
    expect(safe.find((f) => f.platform === 'tiktok')!.message).toMatch(/^\[tiktok\] /);
    const r = await mgl(['check', 'vert.mgl.json', '--platform', 'tiktok,reels', '--json'], { cwd: dir });
    expect(r.json.findings.filter((f: { platform?: string }) => f.platform).length).toBeGreaterThanOrEqual(2);
  }, 60_000);
  it('check --alpha enables the alpha-with-bg rule', async () => {
    writeFileSync(join(dir, 'bg.mgl.json'), JSON.stringify({ michelangelo: 1, comps: [{ id: 'main', size: [320, 180], fps: 30, length: 30, bg: '#000000' }], tracks: [{ id: 'V1', comp: 'main' }], clips: [{ id: 's', track: 'V1', at: 0, len: 30, shape: { type: 'ellipse', size: [80, 80] } }] }));
    const without = await mgl(['check', 'bg.mgl.json', '--json'], { cwd: dir });
    const withAlpha = await mgl(['check', 'bg.mgl.json', '--alpha', '--json'], { cwd: dir });
    expect(without.json.findings.some((f: { rule: string }) => f.rule === 'alpha-with-bg')).toBe(false);
    expect(withAlpha.json.findings.some((f: { rule: string }) => f.rule === 'alpha-with-bg')).toBe(true);
  }, 60_000);

  it('mgl check --platform runs and names the platforms', async () => {
    const r = await mgl(['check', 'v.mgl.json', '--platform', 'tiktok,shorts'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split('\n')[0]).toContain('[platforms: tiktok, shorts]');
    const bad = await mgl(['check', 'v.mgl.json', '--platform', 'vine'], { cwd: dir });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('"vine" is not a platform');
    const plural = await mgl(['check', 'v.mgl.json', '--platforms', 'tiktok,shorts'], { cwd: dir });
    expect(plural.code, plural.stderr).toBe(0);
    expect(plural.stdout.split('\n')[0]).toContain('[platforms: tiktok, shorts]');
  }, 60_000);
});

describe('plugins: source-only and audio-only effects', () => {
  const voice = defineEffect({
    type: 'voice-x', describe: 'Voice chain.', params: z.object({ f: z.number().default(90) }),
    audio: (p) => { const c: FilterSpec[] = [{ filter: 'highpass', args: { f: p.f } }, { filter: 'acompressor', args: { ratio: 3 } }]; return c; },
  });
  it('an effect with only audio() is a valid definition', () => {
    expect(checkPluginDef(definePlugin({ name: 'voice-x', effects: [voice] }), true)).toEqual([]);
    expect(checkPluginDef(definePlugin({ name: 'nothing', effects: [{ type: 'n', describe: 'No stage.', params: z.object({}) }] }))).toEqual(['effect "n" has no draw, source or audio function (fix: implement it).']);
  });
  it('effectFilters checks and builds the filter graph; renderEffect points to it', async () => {
    const f = await effectFilters(voice, {});
    expect(f.audioGraph).toBe('highpass=f=90,acompressor=ratio=3');
    expect(f.sourceGraph).toBe('');
    const bad = defineEffect({ type: 'bad', describe: 'Bad.', params: z.object({}), audio: () => [{ filter: 'amovie', args: { filename: 'x.wav' } }] });
    await expect(effectFilters(bad)).rejects.toThrow(/not allowed/);
    expect(() => renderEffect(voice)).toThrow(/no draw\(\) \(an audio effect\)/);
    try { renderEffect(voice); } catch (e) { expect((e as { fix: string }).fix).toContain('effectFilters'); }
  });
  it('audio-reactive generators get synthetic levels in renderGenerator', () => {
    const lv = testLevels(10);
    expect(lv.rms.length).toBe(300);
    expect(lv.spectrum.length).toBe(300 * lv.bands);
    const reg = builtinRegistry();
    const wave = reg.generators.get('waveform');
    if (wave?.audioSource) {
      const { stats } = renderGenerator(wave, { asset: 'vo' }, 10);
      expect(stats.coverage).toBeGreaterThan(0);
    }
  });
  it('the catalog tells commands which stages an effect has', () => {
    const r = new PluginRegistry().add({ name: 'x', effects: [voice] });
    expect(r.catalog().effects.get('voice-x')!.stages).toEqual({ draw: false, source: false, audio: true });
  });
});
