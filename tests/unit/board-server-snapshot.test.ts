/** The Skia snapshot of the board: not blank, within 1568 px, by frame or ids. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyProject, formatProject } from '../../src/sdk/index.js';
import { BoardSession } from '../../src/board/model/index.js';
import { snapshotBoard } from '../../src/board/server/snapshot.js';

let dir: string;
const project = () => join(dir, 'v.mgl.json');
const board = () => join(dir, 'v.board.json');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mgl-board-snap-'));
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

describe('snapshot', () => {
  it('draws a PNG that is not blank, long edge within 1568', async () => {
    const out = join(dir, 'snap.png');
    const r = await snapshotBoard(board(), { out });
    expect(r.path).toBe(out);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(1568);
    const img = await loadImage(out);
    const cv = createCanvas(img.width, img.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i]! < 240 || px[i + 1]! < 240 || px[i + 2]! < 240) ink++;
    expect(ink / (px.length / 4)).toBeGreaterThan(0.01);
    expect(r.warnings ?? []).toEqual([]);
  });

  it('snapshots a frame or ids, and names a bad id', async () => {
    const f = await snapshotBoard(board(), { frame: 'f1', out: join(dir, 'f.png') });
    expect(f.width / f.height).toBeCloseTo(980 / 680, 1);
    await expect(snapshotBoard(board(), { frame: 'n1' })).rejects.toMatchObject({ code: 'E_BOARD_ID' });
    await expect(snapshotBoard(board(), { ids: ['zz'] })).rejects.toMatchObject({ code: 'E_BOARD_ID' });
  });
});
