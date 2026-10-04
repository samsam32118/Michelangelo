// The main-set graders: every task's setup builds valid fixtures, every grader fails on an untouched sandbox,
// reference solutions (plain ffmpeg / JSON, no Michelangelo) pass, and black / silent fake outputs fail.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseProjectText } from '../../src/core/load.js';

const EVALS = resolve(__dirname, '../../evals');
const TASKS = readdirSync(join(EVALS, 'tasks')).filter((d) => existsSync(join(EVALS, 'tasks', d, 'task.md'))).sort();
const load = (p: string): Promise<any> => import(pathToFileURL(p).href);
const root = mkdtempSync(join(tmpdir(), 'mgl-evals-graders-'));
const dirOf = (t: string, kind = 'empty') => join(root, kind, t);
const dist = resolve(__dirname, '../../dist/cli/main.js');
const cli = process.env.MGL_EVAL_MGL || (existsSync(dist) ? dist : '');
if (cli) process.env.MGL_EVAL_MGL = cli;

async function setupTask(t: string, kind: string) {
  const dir = dirOf(t, kind);
  rmSync(dir, { recursive: true, force: true });
  if (kind !== 'empty' && existsSync(dirOf(t))) { cpSync(dirOf(t), dir, { recursive: true }); return dir; }
  mkdirSync(dir, { recursive: true });
  await (await load(join(EVALS, 'tasks', t, 'setup.mjs'))).setup(dir);
  return dir;
}
const grade = async (t: string, dir: string) => (await load(join(EVALS, 'tasks', t, 'grade.mjs'))).grade(dir);
async function inPool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]!); }));
}
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

beforeAll(async () => {
  await inPool(TASKS, 4, async (t) => { await setupTask(t, 'empty'); });
}, 170_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('eval tasks: files and fixtures', () => {
  it('has 30 main tasks, each with task.md, meta.json, setup.mjs and grade.mjs', () => {
    expect(TASKS.length).toBe(30);
    for (const t of TASKS) for (const f of ['task.md', 'meta.json', 'setup.mjs', 'grade.mjs']) expect(existsSync(join(EVALS, 'tasks', t, f)), `${t}/${f}`).toBe(true);
  });

  it('setup writes .setup.json with fixture hashes, and project fixtures load with the library (except the broken one)', () => {
    for (const t of TASKS) {
      const dir = dirOf(t);
      const setup = JSON.parse(readFileSync(join(dir, '.setup.json'), 'utf8'));
      for (const f of Object.keys(setup.hashes)) {
        if (!f.endsWith('.mgl.json')) continue;
        const text = readFileSync(join(dir, f), 'utf8');
        if (t === 'fix-broken-file') expect(() => parseProjectText(text)).toThrow(/opactiy/);
        else expect(parseProjectText(text).problems.filter((p) => p.severity === 'error'), `${t}/${f}`).toEqual([]);
      }
    }
  });

  it('graders use only evals/lib (no Michelangelo imports), and media graders call assertNotEmpty', () => {
    const projectOnly = new Set(['edit-200-clips', 'fix-broken-file', 'slip-roll']);
    for (const t of TASKS) {
      const src = readFileSync(join(EVALS, 'tasks', t, 'grade.mjs'), 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) expect(m[1]!.startsWith('node:') || m[1]!.startsWith('../../lib/'), `${t}: ${m[1]}`).toBe(true);
      if (!projectOnly.has(t)) expect(src, t).toContain('assertNotEmpty');
    }
    for (const f of readdirSync(join(EVALS, 'lib'))) expect(readFileSync(join(EVALS, 'lib', f), 'utf8'), f).not.toMatch(/from '\.\.\/\.\.\/src|from 'michelangelo/);
  });
});

describe('graders fail on untouched sandboxes', () => {
  it.each(TASKS)('%s', async (t) => {
    const r = await grade(t, dirOf(t));
    expect(r.pass, JSON.stringify(r.checks)).toBe(false);
    expect(r.score).toBeLessThan(1);
    expect(r.checks.length).toBeGreaterThanOrEqual(2);
    for (const c of r.checks) expect(typeof c.name === 'string' && typeof c.pass === 'boolean' && typeof c.detail === 'string').toBe(true);
  }, 60_000);
});

const NEEDS_CLI = new Set(['slip-roll', 'fix-caption-logo-overlap', 'j-and-l-cuts']);
/** Always run; the others run too when a CLI build exists or EVALS_FULL=1. */
const CORE_REFS = new Set(['captions-from-srt', 'gif-export', 'loudness-normalize', 'duck-music-under-vo', 'fix-broken-file', 'csv-variants-sdk', 'edit-200-clips']);
const REFS = TASKS.filter((t) => existsSync(join(EVALS, 'tasks', t, 'reference.mjs')));
describe('reference solutions (plain ffmpeg / JSON) pass', () => {
  it('there are at least 6 reference solutions that need no Michelangelo', () => {
    expect(REFS.filter((t) => !NEEDS_CLI.has(t)).length).toBeGreaterThanOrEqual(6);
  });
  it.each(REFS)('%s', async (t) => {
    if ((NEEDS_CLI.has(t) && !cli) || (!CORE_REFS.has(t) && !process.env.EVALS_FULL && !cli)) return;
    const dir = await setupTask(t, 'ref');
    await (await load(join(EVALS, 'tasks', t, 'reference.mjs'))).solve(dir);
    const r = await grade(t, dir);
    expect(r.pass, JSON.stringify(r.checks, null, 1)).toBe(true);
    expect(r.score).toBe(1);
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.mgl.json'))) expect(parseProjectText(readFileSync(join(dir, f), 'utf8')).problems.filter((p) => p.severity === 'error')).toEqual([]);
  }, 90_000);
});

describe('black and silent fake outputs fail', () => {
  it('gif-export: a black looping GIF of the right size fails', async () => {
    const dir = await setupTask('gif-export', 'fake');
    mkdirSync(join(dir, 'out'));
    ff(['-f', 'lavfi', '-i', 'color=black:size=480x270:rate=15:duration=3', '-loop', '0', join(dir, 'out/clip.gif')]);
    const r = await grade('gif-export', dir);
    expect(r.pass).toBe(false);
    expect(r.checks[0].pass).toBe(false);
  }, 60_000);

  it('duck-music-under-vo: a silent 30 s WAV fails every check', async () => {
    const dir = await setupTask('duck-music-under-vo', 'fake');
    mkdirSync(join(dir, 'out'));
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=30', join(dir, 'out/pod.wav')]);
    const r = await grade('duck-music-under-vo', dir);
    expect(r.pass).toBe(false);
    expect(r.checks.filter((c: any) => c.pass)).toEqual([]);
  }, 60_000);

  it('loudness-normalize: silent WAV and MP3 fail', async () => {
    const dir = await setupTask('loudness-normalize', 'fake');
    mkdirSync(join(dir, 'out'));
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=12', join(dir, 'out/mix.wav')]);
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=12', '-c:a', 'libmp3lame', join(dir, 'out/mix.mp3')]);
    const r = await grade('loudness-normalize', dir);
    expect(r.checks.filter((c: any) => c.pass)).toEqual([]);
  }, 60_000);

  it('captions-from-srt: the right cues but a black draft fails the render checks', async () => {
    const dir = await setupTask('captions-from-srt', 'fake');
    await (await load(join(EVALS, 'tasks/captions-from-srt/reference.mjs'))).solve(dir);
    ff(['-f', 'lavfi', '-i', 'color=black:size=960x540:rate=30:duration=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(dir, 'out/draft.mp4')]);
    const r = await grade('captions-from-srt', dir);
    expect(r.pass).toBe(false);
    expect(r.checks[0].pass).toBe(true);
    expect(r.checks[2].pass).toBe(false);
  }, 90_000);

  it('short-from-script: a black, silent video of the right size and length fails', async () => {
    const dir = await setupTask('short-from-script', 'fake');
    mkdirSync(join(dir, 'out'));
    ff(['-f', 'lavfi', '-i', 'color=black:size=1080x1920:rate=30:duration=11', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=11', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'out/short.mp4')]);
    const r = await grade('short-from-script', dir);
    expect(r.pass).toBe(false);
    expect(r.checks[1].pass).toBe(false);
    expect(r.checks[2].pass).toBe(false);
  }, 60_000);

  it('fix-broken-file: deleting the problem clips (losing a clip) fails', async () => {
    const dir = await setupTask('fix-broken-file', 'fake');
    const text = readFileSync(join(dir, 'broken.mgl.json'), 'utf8').split('\n').filter((l) => !/"credit"|"shot2"/.test(l)).join('\n').replace('"opactiy"', '"opacity"');
    writeFileSync(join(dir, 'broken.mgl.json'), text);
    const r = await grade('fix-broken-file', dir);
    expect(r.checks[0].pass).toBe(true);
    expect(r.checks[1].pass).toBe(false);
  }, 30_000);
});
