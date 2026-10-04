import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project, emptyProject } from '../../src/sdk/project.js';
import { formatProject } from '../../src/core/format.js';

let file: string;
async function fresh(extra: (p: ReturnType<typeof emptyProject>) => void = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mgl-'));
  file = path.join(dir, 'p.mgl.json');
  const p = emptyProject({ length: 900 });
  p.assets = [{ id: 'cam', src: 'cam.mp4' }];
  extra(p);
  writeFileSync(file, formatProject(p));
  return Project.open(file);
}

describe('clip commands', () => {
  let p: Project;
  beforeEach(async () => {
    p = await fresh((d) => {
      d.clips = [
        { id: 'a', track: 'V1', at: 0, len: 60, asset: 'cam' },
        { id: 'b', track: 'V1', at: 60, len: 60, asset: 'cam', in: 100 },
        { id: 'c', track: 'V1', at: 120, len: 60, asset: 'cam', in: 300 },
        { id: 'title', track: 'T1', at: 0, len: 90, text: 'Hello', opacity: [[0, 0], [30, 1]] },
      ];
    });
  });
  it('adds a text clip with edge times and a generated id', async () => {
    const r = await p.edit({ op: 'clip.add', track: 'T1', at: '4s', len: '2s', text: 'Second line' });
    expect(r.out[0]!.id).toBe('second-line');
    expect(p.clip('second-line')).toMatchObject({ at: 120, len: 60 });
    expect(r.changes[0]!.line).toBeGreaterThan(0);
  });
  it('splits keeping the animation clock and source offset', async () => {
    await p.edit({ op: 'clip.split', id: 'title', at: 15 });
    const second = p.clip('title-2')!;
    expect(second).toMatchObject({ at: 15, len: 75, clock: 15 });
    expect(second.opacity).toEqual([[-15, 0], [15, 1]]);
    await p.edit({ op: 'clip.split', id: 'b', at: '2.5s' });
    expect(p.clip('b-2')).toMatchObject({ at: 75, len: 45, in: 115 });
  });
  it('ripple-deletes', async () => {
    await p.edit({ op: 'clip.ripple-delete', id: 'b' });
    expect(p.clip('c')!.at).toBe(60);
  });
  it('rolls a cut', async () => {
    await p.edit({ op: 'clip.roll', id: 'a', by: 12 });
    expect(p.clip('a')!.len).toBe(72);
    expect(p.clip('b')).toMatchObject({ at: 72, len: 48, in: 112 });
  });
  it('slips without moving', async () => {
    await p.edit({ op: 'clip.slip', id: 'c', by: '1s' });
    expect(p.clip('c')).toMatchObject({ at: 120, len: 60, in: 330 });
  });
  it('slides between neighbours', async () => {
    await p.edit({ op: 'clip.slide', id: 'b', by: -6 });
    expect(p.clip('a')!.len).toBe(54);
    expect(p.clip('b')!.at).toBe(54);
    expect(p.clip('c')).toMatchObject({ at: 114, len: 66, in: 294 });
  });
  it('changes speed keeping the source range', async () => {
    await p.edit({ op: 'clip.speed', id: 'c', speed: 2 });
    expect(p.clip('c')).toMatchObject({ len: 30, speed: 2 });
  });
  it('freezes a frame and ripples', async () => {
    await p.edit({ op: 'clip.freeze', id: 'a', at: 30, len: 30 });
    const hold = p.clip('a-hold')!;
    expect(hold).toMatchObject({ at: 30, len: 30, in: 30, speed: 0, muted: true });
    expect(p.clip('a-2')!.at).toBe(60);
    expect(p.clip('b')!.at).toBe(90);
  });
  it('refuses overlaps with a fix', async () => {
    await expect(p.edit({ op: 'clip.add', track: 'V1', at: 30, len: 30, color: '#fff' })).rejects.toThrow(/overlap/);
  });
  it('rejects unknown fields with did-you-mean', async () => {
    await expect(p.edit({ op: 'clip.split', id: 'a', att: 10 })).rejects.toMatchObject({ code: 'E_ARG', fix: expect.stringContaining('"at"') });
    await expect(p.edit({ op: 'clip.splt', id: 'a', at: 10 })).rejects.toMatchObject({ code: 'E_UNKNOWN_OP' });
  });
  it('dry-runs without writing', async () => {
    const before = readFileSync(file, 'utf8');
    const r = await p.edit({ op: 'clip.remove', id: 'b' }, { dryRun: true });
    expect(r.changes).toEqual([{ kind: 'remove', table: 'clips', id: 'b' }]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(p.clip('b')).toBeDefined();
  });
  it('undoes and redoes across processes, surviving unrelated hand edits', async () => {
    await p.edit({ op: 'clip.set', id: 'title', y: 300 });
    // a hand edit of another line
    writeFileSync(file, readFileSync(file, 'utf8').replace('"id": "c", "track": "V1", "at": 120', '"id": "c", "track": "V1", "at": 121'));
    const p2 = await Project.open(file);
    await p2.undo();
    expect(p2.clip('title')!.y).toBeUndefined();
    expect(p2.clip('c')!.at).toBe(121);
    await p2.redo();
    expect((await Project.open(file)).clip('title')!.y).toBe(300);
  });
  it('refuses a constant over keyframes', async () => {
    await expect(p.edit({ op: 'clip.set', id: 'title', opacity: 0.5 })).rejects.toMatchObject({ code: 'E_KEYFRAMED' });
  });
  it('detaches audio and keeps linked clips together', async () => {
    await p.edit({ op: 'clip.detach-audio', id: 'a' });
    await p.edit({ op: 'clip.split', id: 'a', at: 30 });
    expect(p.clips({ track: 'A1' }).length).toBe(2);
  });
  it('renames ids everywhere', async () => {
    await p.edit({ op: 'id.rename', id: 'V1', to: 'video' });
    expect(p.clip('a')!.track).toBe('video');
  });
});
