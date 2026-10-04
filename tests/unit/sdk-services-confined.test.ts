// @vitest-environment node
/** confined(): project-relative paths only, also through symlinks; names that merely start with ".." are fine. */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confined, makeServices } from '../../src/sdk/services.js';

describe('confined', () => {
  it('refuses symlinks that leave the project and accepts in-project names starting with ".."', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mgl-conf-'));
    try {
      const proj = join(root, 'proj');
      mkdirSync(proj);
      writeFileSync(join(root, 'secret.txt'), 'secret');
      writeFileSync(join(proj, '..script.txt'), 'hello');
      symlinkSync(root, join(proj, 's'));
      symlinkSync(join(proj, '..script.txt'), join(proj, 'inside-link.txt'));
      expect(confined(proj, '..script.txt')).toBe(join(proj, '..script.txt'));
      expect(confined(proj, 'inside-link.txt')).toBe(join(proj, 'inside-link.txt'));
      expect(confined(proj, 'not/yet/made.txt')).toBe(join(proj, 'not/yet/made.txt'));
      expect(() => confined(proj, '../secret.txt')).toThrow(/outside the project/);
      expect(() => confined(proj, '..')).toThrow(/outside the project/);
      expect(() => confined(proj, 's/secret.txt')).toThrow(/outside the project/);
      expect(() => confined(proj, 's/new-file.txt')).toThrow(/outside the project/);
      await expect(makeServices(proj).readText!('s/secret.txt')).rejects.toThrow(/outside the project/);
      expect(await makeServices(proj).readText!('..script.txt')).toBe('hello');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
