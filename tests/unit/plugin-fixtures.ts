/** Temp projects for plugin tests: a node_modules/michelangelo whose exports point at this repo's sources. */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A temp folder with node_modules/michelangelo → this repo's src (so plugins resolve 'michelangelo/plugin'). */
export function tempProjectDir(prefix = 'mgl-plugin-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const pkg = join(dir, 'node_modules', 'michelangelo');
  mkdirSync(pkg, { recursive: true });
  symlinkSync(join(REPO, 'src'), join(pkg, 'src'), 'dir');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: 'michelangelo', version: '0.1.0', type: 'module',
    exports: { './plugin': './src/plugin/api.ts', './testing': './src/plugin/testing.ts' },
  }));
  return dir;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const f = join(root, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
}
