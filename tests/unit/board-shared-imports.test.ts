import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../src/board/shared/', import.meta.url));
const clientDir = fileURLToPath(new URL('../../src/board/client/', import.meta.url));
const specs = (src: string) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]!);

describe('board shared imports', () => {
  it('src/board/shared imports only from itself (no Node, no DOM, no packages)', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(dir + f, 'utf8');
      for (const s of specs(src)) expect(s, `${f} imports ${s}`).toMatch(/^\.\/[a-z0-9-]+\.js$/);
      expect(src, `${f} uses the DOM`).not.toMatch(/\b(document|window|HTMLElement|navigator)\b\./);
      expect(src, `${f} uses Node`).not.toMatch(/\bprocess\.|\brequire\(/);
    }
  });
  it('src/board/client imports only client and shared modules (served as-is to the browser)', () => {
    for (const f of readdirSync(clientDir).filter((x) => x.endsWith('.ts'))) {
      for (const s of specs(readFileSync(clientDir + f, 'utf8'))) expect(s, `${f} imports ${s}`).toMatch(/^\.\.?\/(shared\/)?[a-z0-9-]+\.js$/);
    }
  });
});
