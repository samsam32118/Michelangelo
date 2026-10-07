/** The storyboard's text surfaces: show --scenes / --scene, the scenes line of edit, scene markers (marker.add / marker.set). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_LINES } from '../../src/cli/io.js';
import { readPrevious, writeSnapshot } from '../../src/qa/storyboard.js';
import { mgl, tempDir } from './cli-fixtures.js';

const t = tempDir('mgl-story-');
afterAll(() => t.cleanup());
const cwd = t.dir;
const run = (...args: string[]) => mgl(args, { cwd });
const FILE = 'story.mgl.json';

// two shots under five caption sentences, then an idea scene past the last clip (comp length 12 s)
const PROJECT = {
  michelangelo: 1,
  comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 360 }],
  tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
  clips: [
    { id: 'shot1', track: 'V1', at: 0, len: 150, color: '#204060' },
    { id: 'shot2', track: 'V1', at: 150, len: 150, color: '#406020' },
    { id: 'subs', track: 'T1', at: 0, len: 300, captions: true, style: 'karaoke', y: 1300 },
  ],
  cues: [
    { id: 'c1', clip: 'subs', at: 0, len: 60, text: 'Three tips to focus.' },
    { id: 'c2', clip: 'subs', at: 60, len: 40, text: 'Put your phone' },
    { id: 'c3', clip: 'subs', at: 100, len: 50, text: 'in another room.' },
    { id: 'c4', clip: 'subs', at: 150, len: 90, text: 'Work in 25-minute blocks.' },
    { id: 'c5', clip: 'subs', at: 240, len: 60, text: 'Follow for more.' },
  ],
};
writeFileSync(join(cwd, FILE), JSON.stringify(PROJECT, null, 1));
const sceneOf = (lines: string[], n: number) => lines.find((l) => l.startsWith(`${n} "`) || l.startsWith(`${n} note "`));

describe('show --scenes / --scene', () => {
  it('level 1: one line per sentence, lanes in words, a header, ≤ 40 lines', async () => {
    const r = await run('show', FILE, '--scenes');
    expect(r.code).toBe(0);
    expect(r.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(r.lines[0]).toMatch(/^story\.mgl\.json main: 4 scenes, 12\.0s · no earlier storyboard/);
    expect(sceneOf(r.lines, 1)).toMatch(/^1 "Three tips to focus\." 0\.0–2\.0s \| picture shot1 .*\| captions c1 \|/);
    expect(sceneOf(r.lines, 2)).toContain('captions c2–c3');
    expect(sceneOf(r.lines, 3)).toMatch(/"Work in 25-minute blocks\.".*picture shot2/);
    expect(sceneOf(r.lines, 4)).toContain('"Follow for more."');
    expect(r.lines.some((l) => l.includes(`mgl show ${FILE} --scene <n>`))).toBe(true);
  });

  it('marker.add scene=true makes an idea scene; a scene without len is E_SCENE', async () => {
    const add = await run('edit', FILE, 'marker.add', 'id=timer', 'at=10s', 'len=2s', 'note=show a timer', 'scene=true');
    expect(add.code).toBe(0);
    expect(add.lines).toContain('scenes: 5 "show a timer"');
    expect(JSON.parse(readFileSync(join(cwd, FILE), 'utf8')).markers[0]).toMatchObject({ id: 'timer', at: 300, len: 60, scene: true });
    const bad = await run('edit', FILE, 'marker.add', 'id=x', 'at=1s', 'scene=true', '--json');
    expect(bad.code).toBe(1);
    expect(bad.json.error.code).toBe('E_SCENE');
    const unset = await run('edit', FILE, 'marker.set', 'timer', 'len=null', '--json');
    expect(unset.json.error.code).toBe('E_SCENE');
    const r = await run('show', FILE, '--scenes', '--json');
    expect(r.json.scenes).toHaveLength(5);
    expect(r.json.scenes[4]).toMatchObject({ n: 5, id: 'timer', source: 'marker', label: 'show a timer', idea: true });
    const txt = await run('show', FILE, '--scenes');
    expect(sceneOf(txt.lines, 5)).toMatch(/^5 note "show a timer" 10\.0–12\.0s idea/);
  });

  it('a hand-written scene without len does not load (E_SCENE)', async () => {
    writeFileSync(join(cwd, 'bad.mgl.json'), JSON.stringify({ ...PROJECT, markers: [{ id: 'm', comp: 'main', at: 30, scene: true }] }));
    const r = await run('show', 'bad.mgl.json', '--scenes', '--json');
    expect(r.code).toBe(1);
    expect(JSON.stringify(r.json.error)).toContain('E_SCENE');
  });

  it('marker.set turns a point marker into a scene and back', async () => {
    await run('edit', FILE, 'marker.add', 'id=drop', 'at=1s');
    const pts = await run('show', FILE, '--scenes', '--json');
    expect(pts.json.points.map((m: { id: string }) => m.id)).toContain('drop');
    const set = await run('edit', FILE, 'marker.set', 'drop', 'len=1s', 'scene=true', '--json');
    expect(set.code).toBe(0);
    expect(set.json.scenes.length).toBeGreaterThan(0);
    const on = await run('show', FILE, '--scenes', '--json');
    expect(on.json.scenes.some((s: { id: string; source: string }) => s.id === 'drop' && s.source === 'marker')).toBe(true);
    await run('edit', FILE, 'marker.remove', 'drop');
  });

  it('level 2: one scene by number or id, with file lines, ≤ 40 lines; a missing scene is E_REF', async () => {
    const r = await run('show', FILE, '--scene', '3');
    expect(r.code).toBe(0);
    expect(r.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(r.lines[0]).toMatch(/^scene 3 "Work in 25-minute blocks\." 5\.0–8\.0s \(sentence c4\)/);
    expect(r.lines).toContain('picture:');
    expect(r.lines.some((l) => /^ {2}shot2 .*· line \d+$/.test(l))).toBe(true);
    expect(r.lines.some((l) => l.startsWith('moments: start '))).toBe(true);
    const byId = await run('show', FILE, '--scene', 'timer', '--json');
    expect(byId.json.scene).toMatchObject({ n: 5, idea: true });
    const idea = await run('show', FILE, '--scene', '5');
    expect(idea.lines).toContain('idea: nothing visual here yet');
    const miss = await run('show', FILE, '--scene', '99', '--json');
    expect(miss.code).toBe(1);
    expect(miss.json.error.code).toBe('E_REF');
  });
});

describe('the scenes line of edit and ● against the previous storyboard', () => {
  it('edit names the scenes it touched (text, dry run and --json); none → no line', async () => {
    const r = await run('edit', FILE, 'clip.set', 'shot2', 'color=#ff0000');
    expect(r.code).toBe(0);
    expect(r.lines.find((l) => l.startsWith('scenes: '))).toBe('scenes: 3 "Work in 25-minute blocks.", 4 "Follow for more."');
    const dry = await run('edit', FILE, 'cue.set', 'c1', 'text=Three tips to focus better.', '--dry-run', '--json');
    expect(dry.json.dryRun).toBe(true);
    expect(dry.json.scenes.map((s: { n: number }) => s.n)).toEqual([1]);
    const none = await run('edit', FILE, 'clip.set', 'shot2', 'color=#ff0000', '--json');
    expect(none.json.scenes).toEqual([]);
  });

  it('show marks ● the scenes changed since the snapshot and never writes it', async () => {
    const file = join(cwd, FILE);
    writeSnapshot(file, JSON.parse(readFileSync(file, 'utf8')), new Date('2026-10-07T10:00:00Z'));
    await run('edit', FILE, 'clip.set', 'shot1', 'color=#00ff00');
    const r = await run('show', FILE, '--scenes');
    expect(r.lines[0]).toContain('● 2 changed since the storyboard of 2026-10-07 10:00');
    expect(sceneOf(r.lines, 1)).toMatch(/0\.0–2\.0s ● \|/);
    expect(sceneOf(r.lines, 3)).not.toContain('●');
    const d = await run('show', FILE, '--scene', '1');
    expect(d.lines.some((l) => l.startsWith('● changed: ') && l.includes('shot1'))).toBe(true);
    expect(readPrevious(file)?.at).toBe('2026-10-07T10:00:00.000Z');
  });

  it('undo after the storyboard is a recorded command (not "by hand"); show prints the last look\'s ⚠ per scene', async () => {
    const f = 'u.mgl.json', file = join(cwd, f);
    writeFileSync(file, JSON.stringify(PROJECT, null, 1));
    await run('edit', f, 'clip.set', 'shot1', 'color=#00ff00');
    const findings = [{ rule: 'silence', severity: 'warning' as const, message: '2.0 s of silence in "x"', frame: 200, fix: 'mgl edit u.mgl.json audio.cut-silences x' }, { rule: 'loudness', severity: 'warning' as const, message: 'mix is quiet' }];
    writeSnapshot(file, JSON.parse(readFileSync(file, 'utf8')), new Date(Date.now() - 1000), { comp: 'main', findings });
    await run('edit', f, 'undo');
    const d = await run('show', f, '--scene', '1');
    expect(d.lines.find((l) => l.startsWith('● changed: '))).toMatch(/shot1/);
    expect(d.lines.join('\n')).not.toContain('by hand');
    const r = await run('show', f, '--scenes');
    expect(r.lines[0]).toMatch(/⚠ 1 scene \+ 1 for the whole video at the look of /);
    expect(sceneOf(r.lines, 3)).toMatch(/⚠/);
    expect(r.lines).toContain('⚠ mix is quiet');
    const s3 = await run('show', f, '--scene', '3');
    expect(s3.lines[1]).toBe('⚠ issue: 2.0 s of silence in "x" · fix: mgl edit u.mgl.json audio.cut-silences x');
  });
});
