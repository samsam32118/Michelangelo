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
}, 300_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('eval tasks: files and fixtures', () => {
  it('has 33 main tasks, each with task.md, meta.json, setup.mjs and grade.mjs', () => {
    expect(TASKS.length).toBe(33);
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

describe('deliverable and library-only checks (DESIGN §17.2)', () => {
  it('meta.json lists the deliverables, the grader\'s check names verbatim, and library_only when every check is [lib]', async () => {
    for (const t of TASKS) {
      const meta = JSON.parse(readFileSync(join(EVALS, 'tasks', t, 'meta.json'), 'utf8'));
      expect(Array.isArray(meta.deliverables) && meta.deliverables.length > 0, `${t}: deliverables`).toBe(true);
      const r = await grade(t, dirOf(t));
      expect(meta.checks, `${t}: meta.checks`).toEqual(r.checks.map((c: any) => c.name));
      const libOnly = r.checks.every((c: any) => c.name.startsWith('[lib] '));
      expect(!!meta.library_only, `${t}: library_only`).toBe(libOnly);
      expect(r.deliverable.checks, t).toBe(r.checks.filter((c: any) => !c.name.startsWith('[lib] ')).length);
    }
  }, 120_000);

  it('graders that read a project, a plugin or a render of the project mark those checks [lib]', () => {
    for (const t of TASKS) {
      const src = readFileSync(join(EVALS, 'tasks', t, 'grade.mjs'), 'utf8');
      if (/readProject|findProjectUsing|renderStill|renderProject|readManifest|parseLoose/.test(src)) expect(src, t).toContain("'[lib] ");
    }
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

const NEEDS_CLI = new Set(['slip-roll', 'fix-caption-logo-overlap', 'j-and-l-cuts', 'gif-export']);
/** Always run; the others run too when a CLI build exists or EVALS_FULL=1. */
const CORE_REFS = new Set(['captions-from-srt', 'loudness-normalize', 'duck-music-under-vo', 'fix-broken-file', 'csv-variants-sdk', 'edit-200-clips',
  'nested-comp', 'script-only-short', 'polish-music-sfx', 'talking-head-youtube']);
/** Remove what only the library would make (projects, plugins, .mgl/): setup's projects back, new ones deleted. */
function stripLibrary(t: string, dir: string) {
  const setup = JSON.parse(readFileSync(join(dir, '.setup.json'), 'utf8'));
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (['plugins', '.mgl'].includes(e.name) && !rel) rmSync(join(dir, r), { recursive: true, force: true }); else if (!['node_modules', '.golden'].includes(e.name)) walk(r); continue; }
      if (!e.name.endsWith('.mgl.json')) continue;
      if (r in setup.hashes) writeFileSync(join(dir, r), readFileSync(join(dirOf(t), r)));
      else rmSync(join(dir, r));
    }
  };
  walk('');
}
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
    // the deliverable checks pass on the outputs alone: without the project edit, plugins or .mgl/ (the "without" arm)
    const meta = JSON.parse(readFileSync(join(EVALS, 'tasks', t, 'meta.json'), 'utf8'));
    if (meta.library_only) return;
    stripLibrary(t, dir);
    const d = await grade(t, dir);
    expect(d.deliverable.pass, JSON.stringify(d.checks.filter((c: any) => !c.pass), null, 1)).toBe(true);
  }, 150_000);
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

  it('script-only-short: a black, silent 24 s vertical video fails motion, sound and text', async () => {
    const dir = await setupTask('script-only-short', 'fake');
    mkdirSync(join(dir, 'out'));
    ff(['-f', 'lavfi', '-i', 'color=black:size=1080x1920:rate=30:duration=24', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=24', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'out/short.mp4')]);
    const r = await grade('script-only-short', dir);
    expect(r.checks[0].pass).toBe(true);
    expect(r.checks.slice(1).filter((c: any) => c.pass)).toEqual([]);
  }, 60_000);

  it('polish-music-sfx: the unchanged edit fails the sound checks; a steady bed without effects fails the effects check', async () => {
    const dir = await setupTask('polish-music-sfx', 'fake');
    mkdirSync(join(dir, 'out'));
    cpSync(join(dir, 'edit.mp4'), join(dir, 'out/final.mp4'));
    let r = await grade('polish-music-sfx', dir);
    expect(r.checks[0].pass, r.checks[0].detail).toBe(true);
    for (const i of [1, 2, 3]) expect(r.checks[i].pass, r.checks[i].name).toBe(false);
    ff(['-i', join(dir, 'edit.mp4'), '-f', 'lavfi', '-i', "aevalsrc='0.05*sin(2*PI*220*t)+0.05*sin(2*PI*277*t)':s=48000:c=stereo:d=20", '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,volume=8dB[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-t', '20', join(dir, 'out/final.mp4')]);
    r = await grade('polish-music-sfx', dir);
    expect(r.checks[1].pass, r.checks[1].detail).toBe(true);
    expect(r.checks[2].pass, r.checks[2].detail).toBe(false);
  }, 90_000);

  it('talking-head-youtube: the untouched interview as the output fails the edit checks', async () => {
    const dir = await setupTask('talking-head-youtube', 'fake');
    mkdirSync(join(dir, 'out'));
    cpSync(join(dir, 'interview.mp4'), join(dir, 'out/final.mp4'));
    const r = await grade('talking-head-youtube', dir);
    const by = (re: RegExp) => r.checks.find((c: any) => re.test(c.name));
    expect(by(/phrases kept/).pass).toBe(true);
    for (const re of [/^out\/final.mp4/, /no silence/, /burned captions/, /lower third/, /intro title/, /^chapters/]) expect(by(re).pass, by(re).name).toBe(false);
  }, 90_000);

  it('nested-comp: three discs at three sizes that do not rotate fail the rotation check', async () => {
    const dir = await setupTask('nested-comp', 'fake');
    mkdirSync(join(dir, 'out'));
    ff(['-f', 'lavfi', '-i', 'color=c=0x202830:s=1920x1080:r=30:d=6', '-filter_complex',
      "[0:v]drawbox=x=100:y=400:w=300:h=300:color=red:t=fill,drawbox=x=600:y=300:w=450:h=450:color=red:t=fill:enable='gte(t,2)',drawbox=x=1200:y=200:w=620:h=620:color=red:t=fill:enable='gte(t,4)',format=yuv420p[v]",
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'out/badges.mp4')]);
    const r = await grade('nested-comp', dir);
    expect(r.checks[1].pass, r.checks[1].detail).toBe(true);
    expect(r.checks[2].pass, r.checks[2].detail).toBe(false);
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

/** Tasks about the library whose graders now require the edit in a project (review findings 44-46, 48). */
const LIB_TASKS = ['speed-and-freeze', 'beat-cut', 'pip', 'import-hevc', 'import-prores', 'green-screen', 'loudness-normalize', 'duck-music-under-vo'];
describe('graders check that the library was used', () => {
  it.each(LIB_TASKS)('%s: the plain-ffmpeg output without the project edit fails the project check', async (t) => {
    if (!process.env.EVALS_FULL && !cli && !['loudness-normalize', 'duck-music-under-vo'].includes(t)) return;
    const dir = await setupTask(t, 'nolib');
    await (await load(join(EVALS, 'tasks', t, 'reference.mjs'))).solve(dir);
    // undo the reference's project edit: setup's projects back, new projects removed
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.mgl.json'))) {
      if (existsSync(join(dirOf(t), f))) writeFileSync(join(dir, f), readFileSync(join(dirOf(t), f)));
      else rmSync(join(dir, f));
    }
    const r = await grade(t, dir);
    const proj = r.checks.find((c: any) => /project/.test(c.name) && /library|edit|project \(|uses|carries|ducks|keys|plays/.test(c.name));
    expect(proj, JSON.stringify(r.checks.map((c: any) => c.name))).toBeTruthy();
    expect(proj.pass, proj.detail).toBe(false);
    expect(r.pass).toBe(false);
  }, 120_000);

  it('gif-export: a GIF of the background alone (no project label) fails', async () => {
    if (!cli) return;
    const dir = await setupTask('gif-export', 'nolib');
    mkdirSync(join(dir, 'out'), { recursive: true });
    ff(['-ss', '3', '-t', '3', '-i', join(dir, 'media/bg.mp4'), '-vf', 'fps=15,scale=480:-1,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', join(dir, 'out/clip.gif')]);
    const r = await grade('gif-export', dir);
    expect(r.checks[0].pass).toBe(true);
    expect(r.checks[2].pass, r.checks[2].detail).toBe(false);
  }, 90_000);

  it('color-match: mirrored shot A stills with an untouched project fail', async () => {
    const dir = await setupTask('color-match', 'nolib');
    mkdirSync(join(dir, 'out'), { recursive: true });
    ff(['-ss', '1', '-i', join(dir, 'media/a.mp4'), '-frames:v', '1', join(dir, 'out/a.png')]);
    ff(['-ss', '1', '-i', join(dir, 'media/a.mp4'), '-frames:v', '1', '-vf', 'hflip', join(dir, 'out/b.png')]);
    const r = await grade('color-match', dir);
    expect(r.pass).toBe(false);
    expect(r.checks[1].pass, r.checks[1].detail).toBe(false); // no colour fx on B
    if (cli) expect(r.checks[2].pass, r.checks[2].detail).toBe(false); // the project render still shows a warm B
  }, 90_000);
});

describe('per-word-animation and csv-variants-sdk', () => {
  it('per-word-animation: animate without "by" (the library default, by word) is accepted', async () => {
    const dir = await setupTask('per-word-animation', 'byword');
    writeFileSync(join(dir, 'w.mgl.json'), `{"michelangelo": 1,
"comps": [{"id": "main", "size": [1080, 1920], "fps": 30, "length": 90}],
"tracks": [{"id": "T1", "comp": "main"}],
"clips": [{"id": "t", "track": "T1", "at": 0, "len": 90, "text": "Make every second count", "animate": {"in": "pop", "stagger": 15}}]
}`);
    const r = await grade('per-word-animation', dir);
    const c = r.checks.find((x: any) => x.name.startsWith('[lib] 1080x1920 project'));
    expect(c?.pass, c?.detail).toBe(true);
  }, 90_000);

  it('csv-variants-sdk: a script edited after the PNGs still counts; variant projects with wrong prices fail', async () => {
    const dir = await setupTask('csv-variants-sdk', 'mtime');
    await (await load(join(EVALS, 'tasks/csv-variants-sdk/reference.mjs'))).solve(dir);
    const { utimesSync } = await import('node:fs');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'variants.mjs'), later, later);
    let r = await grade('csv-variants-sdk', dir);
    expect(r.pass, JSON.stringify(r.checks)).toBe(true);
    // 10 variant projects, one with the wrong price
    const setup = JSON.parse(readFileSync(join(dir, '.setup.json'), 'utf8'));
    mkdirSync(join(dir, 'variants'));
    for (const [id, name, price] of setup.info.products) {
      writeFileSync(join(dir, 'variants', `${id}.mgl.json`), `{"michelangelo": 1,
"comps": [{"id": "main", "size": [1080, 1080], "fps": 30, "length": 90}],
"tracks": [{"id": "T1", "comp": "main"}, {"id": "T2", "comp": "main"}],
"clips": [{"id": "name", "track": "T1", "at": 0, "len": 90, "text": ${JSON.stringify(name)}}, {"id": "price", "track": "T2", "at": 0, "len": 90, "text": "$${id === 'p03' ? '99.99' : price}"}]
}`);
    }
    r = await grade('csv-variants-sdk', dir);
    const c = r.checks.find((x: any) => /carry each product/.test(x.name));
    expect(c?.pass, JSON.stringify(r.checks)).toBe(false);
    expect(c.detail).toMatch(/p03/);
  }, 120_000);
});
