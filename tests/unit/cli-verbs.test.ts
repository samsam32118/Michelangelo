/** The CLI verbs end to end (spawned like an agent would run them), with --json. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_LINES } from '../../src/cli/io.js';
import { mgl, tempDir } from './cli-fixtures.js';

const t = tempDir();
afterAll(() => t.cleanup());
const cwd = t.dir;
const run = (...args: string[]) => mgl(args, { cwd });

describe('new / show / edit / check', () => {
  it('new creates the file, refuses to overwrite, and ignores .mgl/ in a git repo', async () => {
    mkdirSync(join(cwd, '.git'));
    const r = await run('new', 'shorts', '--json');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, preset: 'shorts', size: [1080, 1920], fps: 30 });
    expect(existsSync(join(cwd, 'video.mgl.json'))).toBe(true);
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain('.mgl/');
    const again = await run('new', '--json');
    expect(again.code).toBe(1);
    expect(again.json.error).toMatchObject({ code: 'E_EXISTS' });
    expect(again.json.error.fix).toContain('--force');
    const text = await run('new', 'youtube', '-o', 'wide.mgl.json', '--name', 'Wide one', '--fps', '25');
    expect(text.code).toBe(0);
    expect(text.lines[0]).toMatch(/^created wide\.mgl\.json \(\d+ lines, youtube 1920x1080 25fps\)/);
    expect(text.lines).toContain('next: mgl show wide.mgl.json');
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8').match(/\.mgl\//g)).toHaveLength(1);
  });

  it('new --from builds a first edit from a script', async () => {
    writeFileSync(join(cwd, 'script.txt'), 'Three tips to focus. Put your phone in another room. Work in short sprints of twenty five minutes.\n');
    const r = await run('new', 'shorts', '--from', 'script.txt', '-o', 'script.mgl.json', '--json');
    expect(r.code).toBe(0);
    expect(r.json.clips).toBe(3);
    expect(r.json.cues).toBeGreaterThan(2);
    const p = JSON.parse(readFileSync(join(cwd, 'script.mgl.json'), 'utf8'));
    expect(p.clips.map((c: { id: string }) => c.id).sort()).toEqual(['bg', 'subs', 'title']);
    // 2.5 s title + 17 words at 2.6 words/s ≈ 6.5 s of speech
    const subs = p.clips.find((c: { id: string }) => c.id === 'subs');
    expect(subs.at).toBe(75);
    expect(subs.len).toBeGreaterThan(180);
  });

  it('edit with k=v, dry run, undo, redo, history', async () => {
    const add = await run('edit', 'video.mgl.json', 'clip.add', 'text=Hello there', 'id=hello', 'track=T1', 'len=2s', '--json');
    expect(add.code).toBe(0);
    expect(add.json.changes).toEqual([expect.objectContaining({ kind: 'add', id: 'hello', line: expect.any(Number) })]);
    const txt = await run('edit', 'video.mgl.json', 'clip.set', 'hello', 'y=380');
    expect(txt.code).toBe(0);
    expect(txt.lines[0]).toContain('clip "hello"');
    expect(txt.lines.some((l) => /^ {2}L\d+ ~ \{"id": "hello"/.test(l))).toBe(true);
    const dry = await run('edit', 'video.mgl.json', 'clip.move', 'hello', 'at=1s', '--dry-run');
    expect(dry.lines).toContain('dry run: nothing written');
    expect(readFileSync(join(cwd, 'video.mgl.json'), 'utf8')).toContain('"at": 0');
    const undo = await run('edit', 'video.mgl.json', 'undo', '--json');
    expect(undo.json.summary[0]).toMatch(/^undid:/);
    expect(readFileSync(join(cwd, 'video.mgl.json'), 'utf8')).not.toContain('"y": 380');
    await run('edit', 'video.mgl.json', 'redo');
    expect(readFileSync(join(cwd, 'video.mgl.json'), 'utf8')).toContain('"y": 380');
    const h = await run('edit', 'video.mgl.json', 'history', '--json');
    expect(h.json.undo).toHaveLength(2);
  });

  it('edit with JSON and --batch (atomic)', async () => {
    const j = await run('edit', 'video.mgl.json', '{"op": "clip.add", "id": "solid", "track": "V1", "color": "#202020", "len": "3s"}', '--json');
    expect(j.code).toBe(0);
    writeFileSync(join(cwd, 'b.jsonl'), '{"op": "clip.split", "id": "solid", "at": "1s"}\n{"op": "clip.set", "id": "nope", "y": 1}\n');
    const bad = await run('edit', 'video.mgl.json', '--batch', 'b.jsonl', '--json');
    expect(bad.code).toBe(1);
    expect(bad.json.error.message).toContain('command 2');
    expect(readFileSync(join(cwd, 'video.mgl.json'), 'utf8')).not.toContain('solid-2');
    writeFileSync(join(cwd, 'b.json'), '[{"op": "clip.split", "id": "solid", "at": "1s"}]');
    expect((await run('edit', 'video.mgl.json', '--batch', 'b.json')).code).toBe(0);
    expect(readFileSync(join(cwd, 'video.mgl.json'), 'utf8')).toContain('solid-2');
  });

  it('show: outline, --clip, --at, --frames, --assets', async () => {
    const s = await run('show', 'video.mgl.json');
    expect(s.code).toBe(0);
    expect(s.lines[0]).toMatch(/^main 1080x1920 30fps 3\.00s \(auto\) · 4 tracks · 3 clips · 0 cues/);
    expect(s.lines[1]).toMatch(/^T1 +hello +text +0\.00–2\.00 +"Hello there"/);
    expect(s.lines.some((l) => /^V1 +solid-2 +solid +1\.00–3\.00 +#202020/.test(l))).toBe(true);
    const f = await run('show', 'video.mgl.json', '--frames', '--json');
    expect(f.json.clips.find((c: { id: string }) => c.id === 'solid-2')).toMatchObject({ at: 30, len: 60, line: expect.any(Number) });
    const c = await run('show', 'video.mgl.json', '--clip', 'hello');
    expect(c.lines[0]).toMatch(/^clip "hello" line \d+ · track T1 · text/);
    expect(c.lines).toContain('  y: 380');
    const at = await run('show', 'video.mgl.json', '--at', '1.5s', '--json');
    expect(at.json.visible.map((v: { id: string }) => v.id)).toEqual(['hello', 'solid-2']);
    const as = await run('show', 'video.mgl.json', '--assets');
    expect(as.code).toBe(0);
    const miss = await run('show', 'video.mgl.json', '--clip', 'helo', '--json');
    expect(miss.json.error).toMatchObject({ code: 'E_REF' });
    expect(miss.json.error.fix).toContain('hello');
  });

  it('show stays within 40 lines and writes the full outline for big projects', async () => {
    const cmds = Array.from({ length: 80 }, (_, i) => JSON.stringify({ op: 'clip.add', id: `s${i}`, track: i % 2 ? 'V1' : 'T1', at: 100 + i * 10, len: 10, ...(i % 2 ? { color: '#111111' } : { text: `word ${i}` }) }));
    writeFileSync(join(cwd, 'many.jsonl'), cmds.join('\n'));
    expect((await run('edit', 'video.mgl.json', '--batch', 'many.jsonl', '--quiet')).code).toBe(0);
    const s = await run('show', 'video.mgl.json');
    expect(s.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(s.stdout).toContain('.mgl/video/show.txt');
    expect(readFileSync(join(cwd, '.mgl/video/show.txt'), 'utf8').split('\n').length).toBeGreaterThan(80);
    const all = await run('show', 'video.mgl.json', '--all');
    expect(all.lines.length).toBeGreaterThan(80);
    const track = await run('show', 'video.mgl.json', '--track', 'V1', '--from', '5s', '--to', '6s');
    expect(track.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(track.lines.slice(1).every((l) => l.startsWith('V1 '))).toBe(true);
  });

  it('check: ok, load errors with line + fix (exit 1), --strict', async () => {
    const ok = await run('check', 'wide.mgl.json', '--json');
    expect(ok.code).toBe(0);
    expect(ok.json).toMatchObject({ ok: true, issues: expect.any(Number) });
    const text = readFileSync(join(cwd, 'wide.mgl.json'), 'utf8').replace('"fps": 25', '"fps": 25, "opactiy": 1');
    writeFileSync(join(cwd, 'broken.mgl.json'), text);
    const bad = await run('check', 'broken.mgl.json');
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/error E_UNKNOWN_KEY: line \d+:/);
    expect(bad.stdout).toContain('fix:');
    const badJson = await run('check', 'broken.mgl.json', '--json');
    expect(badJson.json).toMatchObject({ ok: false, issues: 1 });
    expect(badJson.json.problems[0]).toMatchObject({ code: 'E_UNKNOWN_KEY', line: expect.any(Number) });
    // other verbs refuse a broken file with exit 1 and the first problem
    const show = await run('show', 'broken.mgl.json', '--json');
    expect(show.code).toBe(1);
    expect(show.json.error).toMatchObject({ code: 'E_UNKNOWN_KEY', line: expect.any(Number), fix: expect.stringContaining('allowed: id, size, fps') });
  });
});

describe('docs, help, errors', () => {
  it('docs: skill ≤ 40 lines, one command, the command list, topics, schema', async () => {
    const skill = await run('docs');
    expect(skill.code).toBe(0);
    expect(skill.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(skill.lines.at(-1)).toMatch(/more \(use --all or --json\)$/);
    const op = await run('docs', 'clip.split', '--json');
    expect(op.json.command).toMatchObject({ op: 'clip.split', primary: 'id' });
    expect(op.json.command.fields.map((f: { name: string }) => f.name)).toContain('at');
    const list = await run('docs', 'commands');
    expect(list.lines.some((l) => l.startsWith('clip: ') && l.includes('clip.split'))).toBe(true);
    const topic = await run('docs', 'editing');
    expect(topic.lines[0]).toMatch(/^# Editing/);
    const schema = await run('docs', 'schema', '--json');
    expect(existsSync(schema.json.file)).toBe(true);
    const fx = await run('docs', 'blur');
    expect(fx.lines[0]).toMatch(/^effect blur:/);
    const nope = await run('docs', 'edting', '--json');
    expect(nope.code).toBe(1);
    expect(nope.json.error.fix).toContain('editing');
  });

  it('help, unknown verbs and options, internal errors', async () => {
    const h = await run('help');
    expect(h.code).toBe(0);
    expect(h.lines.length).toBeLessThanOrEqual(MAX_LINES);
    const v = await run('shwo', '--json');
    expect(v.code).toBe(1);
    expect(v.json.error).toMatchObject({ code: 'E_USAGE' });
    expect(v.json.error.fix).toContain('mgl show');
    const o = await run('show', 'video.mgl.json', '--frame');
    expect(o.code).toBe(1);
    expect(o.stderr).toContain('--frames');
    const missing = await run('show', 'nope.mgl.json', '--json');
    expect(missing.json.error).toMatchObject({ code: 'E_NO_FILE' });
  });
});
