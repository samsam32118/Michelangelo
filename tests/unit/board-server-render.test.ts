/** The ladder: stills cached by content, spend rows recorded on misses only, a draft render with its estimate. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyProject, formatProject } from '../../src/sdk/index.js';
import { BoardSession } from '../../src/board/model/index.js';
import { parseRange, renderLevel, renderStill, timecode } from '../../src/board/server/render.js';

let dir: string;
const project = () => join(dir, 'v.mgl.json');
const board = () => join(dir, 'v.board.json');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mgl-board-render-'));
  const p = emptyProject({ size: [180, 320], fps: 30 });
  (p as any).clips = [{ id: 'bg', track: 'V1', at: 0, len: 60, color: '#2040a0' }, { id: 'title', track: 'T1', at: 0, len: 45, text: 'Hello' }];
  writeFileSync(project(), formatProject(p));
  const s = await BoardSession.open(board());
  await s.apply([
    { op: 'shape.add', shape: { id: 'f1', type: 'frame', x: 0, y: 0, w: 900, h: 600, label: 'Opening' } },
    { op: 'shape.add', shape: { id: 'n1', type: 'note', x: 40, y: 60, text: 'Open on the title', color: 'yellow', parent: 'f1' } },
    { op: 'shape.add', shape: { id: 'r1', type: 'rect', x: 300, y: 60, w: 200, h: 120, text: 'hook', fill: 'solid', color: 'blue' } },
    { op: 'shape.add', shape: { id: 's1', type: 'still', x: 560, y: 60, t: '0.5s' } },
    { op: 'shape.add', shape: { id: 'a1', type: 'arrow', x: 0, y: 0, from: 'n1', to: 's1' } },
  ], 'ai');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('stills', () => {
  it('caches by project content + comp + frame + width', async () => {
    const a = await renderStill(project(), { t: '1s', width: 90 });
    expect(a.cached).toBe(false);
    expect([a.width, a.height, a.frame]).toEqual([90, 160, 30]);
    const b = await renderStill(project(), { t: 30, width: 90 });
    expect(b.cached).toBe(true);
    expect(b.path).toBe(a.path);
    expect((await renderStill(project(), { t: 30, width: 60 })).path).not.toBe(a.path);
  });

  it('level 1 renders the board stills and records spend once', async () => {
    const r = await renderLevel(board(), { level: 1 });
    expect(r.files).toHaveLength(1);
    const s = await BoardSession.open(board());
    const n = (s.board.spend ?? []).length;
    expect(r.spend.length + (r.cached ?? 0)).toBe(1);
    const again = await renderLevel(board(), { level: 1, ids: ['s1'] });
    expect(again.spend).toEqual([]);
    await s.reload();
    expect((s.board.spend ?? []).length).toBe(n);
    await expect(renderLevel(board(), { level: 1, ids: ['n1'] })).rejects.toMatchObject({ code: 'E_BOARD_ID' });
  });

  it('level 3 drafts a range and reports the estimate', async () => {
    let est: unknown;
    const r = await renderLevel(board(), { level: 3, range: '0-10', onEstimate: (e) => { est = e; } });
    expect(r.files[0]).toMatch(/renders[\\/]draft-1\.mp4$/);
    expect(est).toBeTruthy();
    expect(r.spend[0]!.level).toBe(3);
  }, 60000);

  it('parses ranges and formats timecodes', () => {
    expect(parseRange('2s-6s')).toEqual(['2s', '6s']);
    expect(parseRange('30-90')).toEqual([30, 90]);
    expect(() => parseRange('2s')).toThrow(/range/);
    expect(timecode(75, 30)).toBe('0:02.50');
  });
});
