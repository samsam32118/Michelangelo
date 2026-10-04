import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { checkProject, missingMedia, restFrames } from '../../src/qa/check.js';
import { builtinRegistry } from '../../src/builtin/index.js';

const dir = mkdtempSync(join(tmpdir(), 'mgl-qa-check-'));
mkdirSync(join(dir, 'media'));
writeFileSync(join(dir, 'media', 'beach.mp4'), 'x');
writeFileSync(join(dir, 'present.png'), 'x');

const project = {
  michelangelo: 1,
  project: { platform: 'shorts' },
  assets: [{ id: 'beach', src: 'beach.mp4' }, { id: 'logo', src: 'present.png' }, { id: 'gone', src: 'nowhere/gone.wav' }, { id: 'gen', src: 'lavfi:testsrc2' }],
  comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 120 }],
  tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
  clips: [
    { id: 'a', track: 'V1', at: 0, len: 30, color: '#335' },
    { id: 'b', track: 'V1', at: 45, len: 75, asset: 'beach' },
    { id: 'title', track: 'T1', at: 0, len: 60, text: 'Follow for more', y: 1780 },
    { id: 'centre', track: 'T1', at: 60, len: 60, text: 'OK' },
  ],
} as unknown as ProjectFile;

describe('checkProject', () => {
  it('missing media: relink suggestion when a same-named file exists, remove when unused', () => {
    const f = missingMedia(project, dir);
    expect(f.map((x) => x.rule)).toEqual(['missing-media', 'missing-media']);
    expect(f[0]).toMatchObject({ severity: 'error', clip: 'b', fix: 'mgl edit <file> asset.relink beach src=media/beach.mp4' });
    expect(f[1]).toMatchObject({ severity: 'warning', fix: 'mgl edit <file> asset.remove gone' });
  });

  it('rest frames: the middle of each text clip', () => {
    expect(restFrames(project, 'main')).toEqual([30, 90]);
  });

  it('runs the project-stage checks with evaluated layer boxes', async () => {
    const f = await checkProject(project, { baseDir: dir, registry: builtinRegistry() });
    const rules = f.map((x) => `${x.rule}:${x.clip ?? ''}`);
    expect(rules).toContain('missing-media:b');
    expect(rules).toContain('gaps:b');
    expect(rules).toContain('text-outside-safe:title');
    expect(rules).not.toContain('text-outside-safe:centre');
    expect(f[0]!.severity).toBe('error');
    const safe = f.find((x) => x.rule === 'text-outside-safe')!;
    expect(safe.frame).toBe(30);
    expect(safe.box![1] + safe.box![3]).toBeGreaterThan(1536);
    expect(safe.fix).toMatch(/^mgl edit <file> clip\.set title y=\d+$/);
  }, 30_000);

  it('loads the registry itself and reports plugin problems', async () => {
    const p = { ...project, project: { platform: 'shorts', plugins: { 'not-installed-plugin': '^1.0.0' } } } as ProjectFile;
    const f = await checkProject(p, { baseDir: dir });
    expect(f.find((x) => x.rule === 'plugin')?.message).toContain('not-installed-plugin');
  }, 30_000);
});
