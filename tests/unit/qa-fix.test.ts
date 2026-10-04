// @vitest-environment node
/** `check --fix` / `look --fix` (src/qa/fix.ts) and the retention rules static-visuals, low-contrast, edge-gap. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import type { ProjectFile } from '../../src/core/schema/index.js';
import type { Finding } from '../../src/plugin/api.js';
import { builtinChecks } from '../../src/builtin/checks/index.js';
import { coverZoom, staticStretches, textLook } from '../../src/builtin/checks/retention.js';
import { makeContext, type Layers } from '../../src/qa/check.js';
import { findingKey, fixProject, formatFix, newProblems, parseFix, shellWords } from '../../src/qa/fix.js';
import { Project } from '../../src/sdk/project.js';
import { open } from '../../src/sdk/index.js';
import { Out, parseArgs } from '../../src/cli/io.js';
import '../../src/core/commands/index.js';

const run = (id: string, p: ProjectFile, extra: Parameters<typeof makeContext>[3] = {}) =>
  builtinChecks.find((c) => c.id === id)!.run(makeContext(p, 'main', undefined, extra)) as Finding[];

function shorts(clips: unknown[], extra: Record<string, unknown> = {}): ProjectFile {
  return {
    michelangelo: 1, project: { platform: 'shorts' },
    assets: [{ id: 'pic', src: 'pic.png', kind: 'image' }, { id: 'pic2', src: 'pic2.png', kind: 'image' }, { id: 'vid', src: 'lavfi:testsrc2' }],
    comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 180 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
    clips, ...extra,
  } as unknown as ProjectFile;
}

const full: [number, number, number, number] = [0, 0, 1080, 1920];

describe('fix parsing', () => {
  it('splits shell words with quotes, escapes and comments', () => {
    expect(shellWords(`mgl edit 'my file.json' clip.set a 'tags=["x y"]' text="say \\"hi\\"" # note`)).toEqual(['mgl', 'edit', 'my file.json', 'clip.set', 'a', 'tags=["x y"]', 'text=say "hi"']);
  });

  it('turns edit fixes into commands, && chains into several, and refuses what needs a person', async () => {
    expect(await parseFix(`mgl edit v.json clip.punch-in bg 'box=[49,87.5,982,1745]' at=0 len=90 ease=inOutSine`)).toEqual({ cmds: [{ op: 'clip.punch-in', id: 'bg', box: [49, 87.5, 982, 1745], at: 0, len: 90, ease: 'inOutSine' }] });
    const two = await parseFix('mgl edit v.json track.add id=V3 comp=main above=V1 && mgl edit v.json clip.move t track=V3');
    expect('cmds' in two && two.cmds.map((c) => c.op)).toEqual(['track.add', 'clip.move']);
    expect(await parseFix('mgl edit v.json asset.relink a src=<path to the .mp4 file>')).toMatchObject({ reason: expect.stringContaining('placeholder') });
    expect(await parseFix('mgl plugin list # report it')).toMatchObject({ reason: expect.stringContaining('not an edit') });
    expect(await parseFix(undefined)).toMatchObject({ reason: 'no fix command' });
  });

  it('new problems are counted by rule, clip and severity', () => {
    const w = (rule: string, clip?: string, severity: Finding['severity'] = 'warning'): Finding => ({ rule, severity, message: 'm', ...(clip ? { clip } : {}) });
    expect(newProblems([w('a', 'x')], [w('a', 'x')])).toEqual([]);
    expect(newProblems([w('a', 'x')], [w('a', 'x'), w('a', 'x')])).toHaveLength(1);
    expect(newProblems([], [w('i', 'x', 'info')])).toEqual([]);
    expect(newProblems([w('a', 'x')], [w('a', 'x', 'error')])).toHaveLength(1);
    expect(findingKey(w('a', 'x'))).toBe('a|x|');
  });
});

describe('static-visuals', () => {
  it('a still image for 6 s in a 9:16 comp: one finding with a slow punch-in that keeps the layer in place', () => {
    const f = run('static-visuals', shorts([{ id: 'bg', track: 'V1', at: 0, len: 180, asset: 'pic', fit: 'cover' }]));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'static-visuals', severity: 'warning', clip: 'bg', frame: 0 });
    expect(f[0]!.fix).toBe(`mgl edit <file> clip.punch-in bg 'box=[70.5,125,939,1670]' at=0 len=180 ease=inOutSine`);
  });

  it('video, keyframed motion, cuts every 2 s and landscape comps are not static', () => {
    expect(run('static-visuals', shorts([{ id: 'bg', track: 'V1', at: 0, len: 180, asset: 'vid' }]))).toEqual([]);
    expect(run('static-visuals', shorts([{ id: 'bg', track: 'V1', at: 0, len: 180, asset: 'pic', scale: [[0, 1], [180, 1.1]] }]))).toEqual([]);
    expect(run('static-visuals', shorts([0, 60, 120].map((at, i) => ({ id: `s${i}`, track: 'V1', at, len: 60, asset: i % 2 ? 'pic2' : 'pic' }))))).toEqual([]);
    const wide = shorts([{ id: 'bg', track: 'V1', at: 0, len: 180, asset: 'pic' }]);
    wide.comps[0]!.size = [1920, 1080];
    expect(run('static-visuals', wide)).toEqual([]);
  });

  it('motion over part of a clip leaves the rest; captions do not count as motion', () => {
    const p = shorts([
      { id: 'bg', track: 'V1', at: 0, len: 180, asset: 'pic', x: [[0, 540], [30, 600]] },
      { id: 'subs', track: 'T1', at: 0, len: 180, captions: true },
    ]);
    const f = run('static-visuals', p);
    expect(f).toHaveLength(1);
    expect(f[0]!.frame).toBe(30);
    expect(f[0]!.fix).toBeUndefined(); // x is keyframed: punch-in cannot write its own keys, so no automatic fix
  });

  it('a still generator background gets its motion parameter; spans split at cuts', () => {
    const f = run('static-visuals', shorts([{ id: 'g', track: 'V1', at: 0, len: 180, gen: { type: 'gradient', colors: ['#123', '#456'] } }]));
    expect(f[0]!.fix).toBe('mgl edit <file> clip.set g gen.animate=24');
    expect(staticStretches(10, [[2, 4]], [7])).toEqual([[0, 2], [4, 7], [7, 10]]);
  });
});

describe('edge-gap', () => {
  const layers = (box: [number, number, number, number]): Layers => new Map([[30, [{ clipId: 'bg', kind: 'image', box }]]]);

  it('a zoomed-out picture: the scale that fills the frame', () => {
    const p = shorts([{ id: 'bg', track: 'V1', at: 0, len: 180, asset: 'pic', scale: 0.9 }]);
    const f = run('edge-gap', p, { layers: layers([54, 96, 972, 1728]) });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'edge-gap', clip: 'bg', frame: 30, fix: 'mgl edit <file> clip.set bg scale=1.001' });
  });

  it('keyframed scale: every key grows by what the smallest one needs', () => {
    const p = shorts([{ id: 'bg', track: 'V1', at: 0, len: 180, asset: 'pic', scale: [[0, 0.9], [60, 1.2]] }]);
    const f = run('edge-gap', p, { layers: layers([54, 96, 972, 1728]) });
    // sampled at frame 30 (scale ≈ 1.05 linear) with a 0.9 box: the 0.9 key must reach 1.0
    const v = JSON.parse(f[0]!.fix!.match(/'scale=(.*)'/)![1]!) as [number, number][];
    expect(v[0]![1]).toBeGreaterThanOrEqual(1);
    expect(v[1]![1]).toBeGreaterThan(1.2);
  });

  it('insets, slides from off frame, other layers covering the gap and contain-fit pictures are not gaps', () => {
    const p = shorts([{ id: 'bg', track: 'V1', at: 0, len: 180, asset: 'pic' }, { id: 'under', track: 'V1', at: 0, len: 0, color: '#000' }]);
    expect(run('edge-gap', p, { layers: layers([0, 0, 1080, 607]) })).toEqual([]); // 16:9 contain: 32 % of the frame
    expect(run('edge-gap', p, { layers: layers([100, 0, 1080, 1920]) })).toHaveLength(1);
    expect(run('edge-gap', p, { layers: layers([-1000, 0, 1080, 1920]) })).toEqual([]);
    const covered: Layers = new Map([[30, [{ clipId: 'under', kind: 'solid', box: full }, { clipId: 'bg', kind: 'image', box: [54, 96, 972, 1728] }]]]);
    expect(run('edge-gap', p, { layers: covered })).toEqual([]);
    expect(coverZoom([54, 96, 972, 1728], [0.5, 0.5], 1080, 1920)).toBeCloseTo(1 / 0.9, 5);
  });
});

describe('low-contrast', () => {
  /** A 1080x1920 frame at scale 0.25: `bg` everywhere, white "glyph" bars inside the text box. */
  function frame(bg: string): Map<number, { width: number; height: number; data: Uint8Array; scale: number }> {
    const cv = createCanvas(270, 480), g = cv.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, 270, 480);
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 6; i++) g.fillRect(70 + i * 22, 140, 8, 25);
    const d = g.getImageData(0, 0, 270, 480).data;
    return new Map([[60, { width: 270, height: 480, data: new Uint8Array(d.buffer, d.byteOffset, d.length), scale: 0.25 }]]);
  }
  const lay: Layers = new Map([[60, [{ clipId: 'bg', kind: 'image', box: full }, { clipId: 't', kind: 'text', box: [270, 560, 540, 100], text: 'Wait for it', fontPx: 100 }]]]);
  const proj = (style?: unknown) => shorts([{ id: 'bg', track: 'V1', at: 0, len: 180, asset: 'pic' }, { id: 't', track: 'T1', at: 0, len: 180, text: 'Wait for it', ...(style ? { style } : {}) }]);

  it('white text on a light backdrop: a black stroke; on a dark one: nothing', () => {
    const f = run('low-contrast', proj({ size: 100, color: '#ffffff' }), { frames: frame('#e8eef4'), layers: lay });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'low-contrast', clip: 't', frame: 60, fix: 'mgl edit <file> clip.set t style.stroke=#000000 style.strokeWidth=8' });
    expect(f[0]!.message).toMatch(/contrast 1\.\d:1/);
    expect(run('low-contrast', proj({ size: 100, color: '#ffffff' }), { frames: frame('#101820'), layers: lay })).toEqual([]);
  });

  it('outlined, plated or shadowed styles (inline, project or built-in) are readable anywhere', () => {
    const light = { frames: frame('#e8eef4'), layers: lay };
    expect(run('low-contrast', proj({ size: 100, stroke: '#000000', strokeWidth: 8 }), light)).toEqual([]);
    expect(run('low-contrast', proj('title'), light)).toEqual([]);
    expect(run('low-contrast', proj({ base: 'boxed' }), light)).toEqual([]);
    expect(run('low-contrast', proj('cta'), light)).toHaveLength(1);
    const p = proj('mine');
    p.styles = [{ id: 'mine', base: 'cta', shadow: '#000000cc' }] as never;
    expect(run('low-contrast', p, light)).toEqual([]);
    expect(textLook(p, p.clips![1]!)).toMatchObject({ color: '#ffffff', shadow: '#000000cc' });
  });

  it('small text gets a plate instead of a stroke', () => {
    const small: Layers = new Map([[60, [{ clipId: 't', kind: 'text', box: [400, 580, 280, 40], text: 'note', fontPx: 40 }]]]);
    const f = run('low-contrast', proj({ size: 40, color: '#ffffff' }), { frames: frame('#f0f0f0'), layers: small });
    expect(f[0]!.fix).toBe("mgl edit <file> clip.set t style.bg=#000000b3 'style.bgPadding=[18,10]' style.bgRadius=10");
  });
});

// ------------------------------------------------------------------------------------------- the fix loop

function pngs(dir: string) {
  const mk = (name: string, draw: (g: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void) => {
    const cv = createCanvas(540, 960);
    draw(cv.getContext('2d'));
    writeFileSync(join(dir, name), cv.toBuffer('image/png'));
  };
  mk('pic.png', (g) => { const gr = g.createLinearGradient(0, 0, 0, 960); gr.addColorStop(0, '#dfeaf5'); gr.addColorStop(1, '#f4efe6'); g.fillStyle = gr; g.fillRect(0, 0, 540, 960); });
  mk('pic2.png', (g) => { g.fillStyle = '#1b2a41'; g.fillRect(0, 0, 540, 960); for (let i = 0; i < 12; i++) { g.fillStyle = `hsl(${i * 30},50%,40%)`; g.fillRect(i * 45, 400 + (i % 3) * 40, 40, 560); } });
}

/** A Shorts project with seeded defects: a still picture (static), a zoomed-out picture (edge gap, static), tiny and low-contrast text. */
function seeded(dir: string): string {
  pngs(dir);
  const file = join(dir, 'seeded.mgl.json');
  const p = shorts([
    { id: 'sky', track: 'V1', at: 0, len: 120, asset: 'pic', fit: 'cover' },
    { id: 'city', track: 'V1', at: 120, len: 120, asset: 'pic2', fit: 'cover', scale: 0.9 },
    { id: 'hook', track: 'T1', at: 0, len: 120, text: 'Wait for it', style: { size: 110, color: '#ffffff' }, y: 700 },
    { id: 'note', track: 'T1', at: 120, len: 120, text: 'small note', style: { size: 40, color: '#2a3a55' }, y: 500 },
  ]);
  p.comps[0]!.length = 240;
  writeFileSync(file, JSON.stringify(p));
  return file;
}

describe('fixProject', () => {
  it('check --fix converges on seeded defects in one undo step, and a second run finds nothing to fix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-fix-'));
    const file = seeded(dir);
    const before = readFileSync(file, 'utf8');
    const p = await open(file);
    const { fixCheck } = await import('../../src/qa/fix.js');
    const r = await fixCheck(p);
    expect(r.before.map((f) => f.rule).sort()).toEqual(['edge-gap', 'static-visuals', 'static-visuals', 'tiny-text']);
    expect(r.remaining).toEqual([]);
    expect(r.applied.map((a) => a.finding.rule).sort()).toEqual(['edge-gap', 'static-visuals', 'static-visuals', 'tiny-text']);
    expect(r.rounds).toBeLessThanOrEqual(3);
    const q = await Project.open(file);
    expect(q.historyStatus().undo).toHaveLength(1);
    expect((await fixCheck(await open(file))).applied).toEqual([]);
    await q.undo();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(before));
    const lines = formatFix(r, 'seeded.mgl.json', 'check');
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[0]).toMatch(/^fix: applied 4 fixes in \d rounds?; findings 4 → 0 \(one undo step: mgl edit seeded\.mgl\.json undo\)$/);
    expect(lines.at(-1)).toBe('remaining: none, QA is clean');
  });

  it('look --fix also fixes low-contrast text judged on rendered frames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-fix-look-'));
    const file = seeded(dir);
    const { fixLook } = await import('../../src/qa/fix.js');
    const r = await fixLook(await open(file), { n: 6, audio: false });
    expect(r.before.filter((f) => f.rule === 'low-contrast').map((f) => f.clip).sort()).toEqual(['hook', 'note']);
    expect(r.remaining.filter((f) => f.severity !== 'info')).toEqual([]);
    const hook = JSON.parse(readFileSync(file, 'utf8')).clips.find((c: { id: string }) => c.id === 'hook');
    expect(hook.style).toMatchObject({ stroke: '#000000' });
  });

  it('never keeps a fix that adds a problem or leaves its finding, and stops when no fix helps', async () => {
    const data = shorts([{ id: 'a', track: 'V1', at: 0, len: 30, color: '#000' }, { id: 'b', track: 'V1', at: 30, len: 30, color: '#111' }]);
    const p = Project.create(join(mkdtempSync(join(tmpdir(), 'mgl-fix-unit-')), 'p.mgl.json'), data);
    let calls = 0;
    const qa = async (d: ProjectFile) => {
      calls++;
      const a = d.clips!.find((c) => c.id === 'a')!, b = d.clips!.find((c) => c.id === 'b')!;
      const fs: Finding[] = [];
      // "x": fixed by opacity 0.5 on a, which then makes "y" appear on a; "z": its fix changes nothing that clears it
      if (a.opacity === undefined) fs.push({ rule: 'x', severity: 'warning', clip: 'a', message: 'x', fix: 'mgl edit f clip.set a opacity=0.5' });
      else fs.push({ rule: 'y', severity: 'warning', clip: 'a', message: 'y' });
      fs.push({ rule: 'z', severity: 'warning', clip: 'b', message: 'z', fix: 'mgl edit f clip.set b note=tried' });
      if (b.color === '#111') fs.push({ rule: 'w', severity: 'error', clip: 'b', message: 'w', fix: 'mgl edit f clip.set b color=#222' });
      return { findings: fs, report: null };
    };
    const r = await fixProject(p, { qa });
    expect(r.applied.map((a) => a.finding.rule)).toEqual(['w']);
    expect(Object.fromEntries(r.rejected.map((x) => [x.finding.rule, x.reason]))).toEqual({ x: 'adds a warning: y on a', z: 'the finding remains after the fix' });
    expect(p.data.clips!.find((c) => c.id === 'a')!.opacity).toBeUndefined();
    expect(p.data.clips!.find((c) => c.id === 'b')!.color).toBe('#222');
    expect(r.remaining.map((f) => f.rule).sort()).toEqual(['x', 'z']);
    expect(calls).toBeLessThan(12);
  });

  it('a fix whose command fails is reported with the command error; info findings are left alone', async () => {
    const p = Project.create('', shorts([{ id: 'a', track: 'V1', at: 0, len: 30, color: '#000' }]));
    const qa = async () => ({ findings: [
      { rule: 'bad', severity: 'warning', clip: 'a', message: 'm', fix: 'mgl edit f clip.set nope y=1' },
      { rule: 'hint', severity: 'info', clip: 'a', message: 'm', fix: 'mgl edit f clip.set a y=1' },
    ] as Finding[], report: null });
    const r = await fixProject(p, { qa });
    expect(r.applied).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.reason).toMatch(/nope/);
    expect(formatFix(r, 'f', 'check')[0]).toBe('fix: no fix helped; findings 2 → 2');
  });

  it('the CLI verb prints at most 10 lines and --dry-run writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-fix-cli-'));
    const file = seeded(dir);
    const before = readFileSync(file, 'utf8');
    const { check } = await import('../../src/cli/check.js');
    const spec = { values: ['platform'], bools: ['strict', 'alpha', 'fix', 'dry-run'] };
    const o = new Out(false, false);
    const lines: string[] = [];
    o.line = (...l: string[]) => { lines.push(...l); };
    await check(parseArgs([file, '--fix', '--dry-run'], spec), o);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[0]).toMatch(/would apply 4 fixes/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
