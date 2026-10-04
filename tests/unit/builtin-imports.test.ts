/**
 * Built-ins are written against the public plugin API only: every import in src/builtin/** must resolve to
 * src/plugin/api.ts or stay inside the importing file's own built-in folder (src/builtin/<folder>/).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUILTIN = join(ROOT, 'src/builtin');
const API = join(ROOT, 'src/plugin/api.ts');
/** The aggregator (src/builtin/index.ts) is not a plugin; it may assemble the registry from the built-in folders. */
const AGGREGATOR_EXTRA = new Set([join(ROOT, 'src/plugin/registry.ts')]);

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|mts|js|mjs)$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
});

/** Module specifiers of static imports, re-exports, side-effect imports and dynamic import() / require(). */
function specifiers(code: string): string[] {
  const src = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const out: string[] = [];
  const res = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];
  for (const re of res) for (const m of src.matchAll(re)) out.push(m[1]!);
  if (/\bimport\s*\(\s*[^'"`\s)]/.test(src) || /\brequire\s*\(\s*[^'"`\s)]/.test(src)) out.push('<computed import>');
  return out;
}

const toTs = (p: string) => p.replace(/\.(m?)js$/, '.$1ts');

function violations(file: string, code: string): string[] {
  const rel = relative(BUILTIN, file).split(sep);
  const folder = rel.length > 1 ? join(BUILTIN, rel[0]!) : null;
  const bad: string[] = [];
  for (const s of specifiers(code)) {
    if (!s.startsWith('.')) { bad.push(s); continue; }
    const target = toTs(resolve(dirname(file), s));
    if (target === API) continue;
    if (folder && (target + sep).startsWith(folder + sep)) continue;
    // the aggregator may import each built-in folder's entry
    if (!folder && relative(BUILTIN, target).split(sep).length === 2 && target.endsWith(`${sep}index.ts`)) continue;
    if (!folder && AGGREGATOR_EXTRA.has(target)) continue;
    bad.push(s);
  }
  return bad;
}

describe('built-ins use only the public plugin API', () => {
  const files = walk(BUILTIN);
  it('finds the built-in sources', () => {
    expect(files.length).toBeGreaterThan(5);
  });
  for (const f of files) {
    it(relative(ROOT, f), () => {
      expect(violations(f, readFileSync(f, 'utf8')), `${relative(ROOT, f)} imports outside the plugin API (fix: import from '../../plugin/api.js' or add it to the API)`).toEqual([]);
    });
  }
  it('the checker catches violations', () => {
    const f = join(BUILTIN, 'effects/fx/x.ts');
    expect(violations(f, "import { fail } from '../../../core/errors.js';")).toEqual(['../../../core/errors.js']);
    expect(violations(f, "import { z } from 'zod';")).toEqual(['zod']);
    expect(violations(f, "import { createSurface } from '../../../plugin/surface.js';")).toHaveLength(1);
    expect(violations(f, "export * from '../../text/styles.js';")).toHaveLength(1);
    expect(violations(f, "const m = await import('node:fs');")).toEqual(['node:fs']);
    expect(violations(f, "import type {\n  Surface,\n} from '../../../plugin/api.js';\nimport { x } from '../util.js';")).toEqual([]);
    expect(violations(join(BUILTIN, 'index.ts'), "import { PluginRegistry } from '../plugin/registry.js'; import t from './text/index.js';")).toEqual([]);
    expect(violations(join(BUILTIN, 'index.ts'), "import { evaluate } from '../render/evaluate.js';")).toHaveLength(1);
  });
});
