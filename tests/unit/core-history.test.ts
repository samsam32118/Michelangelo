/** Regression tests for save/history ordering (review 1, group core). */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project, emptyProject } from '../../src/sdk/project.js';
import { formatProject } from '../../src/core/format.js';

describe('a failed save records no history', () => {
  it('keeps undo working for the edit that did land, and restores the in-memory project', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mgl-hist-')), 'p.mgl.json');
    const d = emptyProject({ length: 900 });
    d.clips = [{ id: 't', track: 'T1', at: 0, len: 30, text: 'Hi' }];
    writeFileSync(file, formatProject(d));
    const p1 = await Project.open(file);
    const p2 = await Project.open(file);
    await p2.edit({ op: 'clip.set', id: 't', y: 100 });
    await expect(p1.edit({ op: 'clip.add', id: 'u', track: 'T1', at: 60, len: 30, text: 'U' })).rejects.toMatchObject({ code: 'E_CHANGED_ON_DISK' });
    expect(p1.clip('u')).toBeUndefined();
    expect(p1.historyStatus().undo).toHaveLength(1);
    const p3 = await Project.open(file);
    await p3.undo();
    expect(p3.clip('t')!.y).toBeUndefined();
  });
});
