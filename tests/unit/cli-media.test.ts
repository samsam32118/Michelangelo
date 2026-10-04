/** CLI verbs that touch media and the environment: render, look, show <media>, doctor, plugin; exit code 2. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_LINES } from '../../src/cli/io.js';
import { makeClip, mgl, tempDir } from './cli-fixtures.js';

const t = tempDir();
afterAll(() => t.cleanup());
const cwd = t.dir;
const run = (...args: string[]) => mgl(args, { cwd });
const noFfmpeg = { MGL_FFMPEG: '/nonexistent/ffmpeg' };

beforeAll(async () => {
  makeClip(cwd, 'clip.mp4', 2);
  expect((await run('new', 'youtube', '-o', 'm.mgl.json')).code).toBe(0);
  expect((await run('edit', 'm.mgl.json', 'clip.add', 'src=clip.mp4', 'id=shot', 'track=V1')).code).toBe(0);
  expect((await run('edit', 'm.mgl.json', 'clip.add', 'id=title', 'track=T1', 'text=Hello', 'len=1s', 'y=300')).code).toBe(0);
}, 60_000);

describe('render', () => {
  it('prints the estimate first, then the result line', async () => {
    const r = await run('render', 'm.mgl.json', 'out/m.mp4', '--draft');
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^est\. [\d.]+ s \(draft 960x540, 2\.0 s, ≈[\d.]+x real time\)/);
    expect(r.lines[1]).toMatch(/^wrote out\/m\.mp4 \(2\.0 s, 960x540, H\.264\/AAC, [\d.]+ [KM]B\) in [\d.]+ s \([\d.]+x real time\)$/);
    expect(existsSync(join(cwd, 'out/m.mp4'))).toBe(true);
  });

  it('writes a still and defaults to out/<name>.png; --json has the result', async () => {
    const r = await run('render', 'm.mgl.json', '--still', '0.5s', '--draft', '--json');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, estimate: { note: expect.stringMatching(/^est\./) }, result: { width: 960, height: 540, codec: 'png' } });
    expect(existsSync(join(cwd, 'out/m.png'))).toBe(true);
  });

  it('--detach returns at once and --status reports the result', async () => {
    const r = await run('render', 'm.mgl.json', 'out/bg.mp4', '--draft', '--detach', '--json');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ detached: true, pid: expect.any(Number) });
    let s;
    for (let i = 0; i < 60; i++) {
      s = await run('render', 'm.mgl.json', '--status', '--json');
      if (s.json.status.status !== 'running') break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    expect(s!.json.status).toMatchObject({ status: 'done', result: { width: 960 } });
    expect(existsSync(join(cwd, 'out/bg.mp4'))).toBe(true);
  });

  it('refuses render-blocking issues and bad options with exit 1', async () => {
    const r = await run('render', 'm.mgl.json', 'out/x.avi', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('E_FORMAT');
    const q = await run('render', 'm.mgl.json', '--draft', '--hq', '--json');
    expect(q.code).toBe(1);
    expect(q.json.error.code).toBe('E_ARG');
  });

  it('exits 2 when ffmpeg is missing', async () => {
    const r = await mgl(['render', 'm.mgl.json', 'out/n.mp4', '--draft', '--json'], { cwd, env: noFfmpeg });
    expect(r.code).toBe(2);
    expect(r.json.error).toMatchObject({ code: 'E_FFMPEG' });
    expect(r.json.error.fix).toContain('MGL_FFMPEG');
  });
});

describe('look, show <media>', () => {
  it('look writes a contact sheet and reports QA within 40 lines', async () => {
    const r = await run('look', 'm.mgl.json', '-n', '4');
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^wrote \.mgl\/m\/look\/sheet\.png \(4 frames/);
    expect(r.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(existsSync(join(cwd, '.mgl/m/look/sheet.png'))).toBe(true);
    const j = await run('look', 'm.mgl.json', '--at', '0.5s,1s', '--no-audio', '--json');
    expect(j.json).toMatchObject({ ok: true, frames: [15, 30], issues: expect.any(Number) });
  });

  it('show probes a media file', async () => {
    const r = await run('show', 'clip.mp4');
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^clip\.mp4: video · h264 320x180 30fps · 2\.\d\ds · audio aac/);
  });
});

describe('doctor and plugin', () => {
  it('doctor reports the environment; exit 2 without ffmpeg', async () => {
    const r = await run('doctor', '--json');
    expect(r.code).toBe(0);
    expect(r.json.ffmpeg).toMatchObject({ version: expect.any(String), encoders: expect.arrayContaining(['libx264', 'aac']) });
    expect(r.json.fonts).toEqual(expect.arrayContaining(['Inter']));
    const text = await run('doctor');
    expect(text.lines.length).toBeLessThanOrEqual(MAX_LINES);
    const bad = await mgl(['doctor'], { cwd, env: noFfmpeg });
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain('no usable ffmpeg');
    expect(bad.stdout).toContain('fix:');
  });

  it('plugin new / trust / list; an untrusted plugin blocks render with the fix', async () => {
    const n = await run('plugin', 'new', 'effect', 'tint-x', '--json');
    expect(n.code).toBe(0);
    expect(existsSync(join(cwd, 'plugins/tint-x/src/index.ts'))).toBe(true);
    expect((await run('edit', 'm.mgl.json', 'project.set', 'plugins={"tint-x": "^0.1.0"}')).code).toBe(0);
    const blocked = await run('render', 'm.mgl.json', 'out/p.png', '--still', '0', '--json');
    expect(blocked.code).toBe(1);
    expect(blocked.json.error).toMatchObject({ code: 'E_PLUGIN_UNTRUSTED', fix: 'mgl plugin trust plugins/tint-x' });
    expect((await run('plugin', 'trust', 'plugins/tint-x')).code).toBe(0);
    const list = await run('plugin', 'list', 'm.mgl.json', '--json');
    expect(list.json.loaded).toEqual([expect.objectContaining({ name: 'tint-x', version: '0.1.0' })]);
    expect((await run('edit', 'm.mgl.json', 'fx.add', 'shot', 'type=tint-x', 'amount=0.5')).code).toBe(0);
    const r = await run('render', 'm.mgl.json', 'out/p.png', '--still', '0', '--draft');
    expect(r.code).toBe(0);
  });
});
