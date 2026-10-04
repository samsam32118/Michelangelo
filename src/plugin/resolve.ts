/**
 * How plugin code finds `michelangelo`, `michelangelo/plugin` and `michelangelo/testing`: a module resolve
 * hook (node:module register) maps them to the entry points of the copy of Michelangelo that is running,
 * built (dist/*.js) or from source (src/*.ts). So a plugin folder next to a project loads with a global
 * install, an npx run or the repository, with no node_modules/michelangelo, and every plugin shares one copy
 * of the library. Other `michelangelo/<path>` specifiers resolve inside this package's folder.
 */
import { existsSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** True when this module is TypeScript source (repository / tsx), not the built package. */
export const fromSource = import.meta.url.endsWith('.ts');

function sibling(rel: string): string | undefined {
  for (const ext of fromSource ? ['.ts', '.js'] : ['.js']) {
    const u = new URL(rel + ext, import.meta.url);
    if (existsSync(fileURLToPath(u))) return u.href;
  }
  return undefined;
}

/** Bare specifier → file URL of this copy of the library. */
export function libraryModules(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const [spec, rel] of [['michelangelo/plugin', './api'], ['michelangelo/testing', './testing'], ['michelangelo', '../sdk/index']] as const) {
    const u = sibling(rel);
    if (u) m[spec] = u;
  }
  return m;
}

/** Folder of this package (the one holding package.json): src/plugin/ and dist/plugin/ are both two levels down. */
export function packageRoot(): string {
  return new URL('../../', import.meta.url).href;
}

/** Type declarations for the library modules (for type-checking plugins): .d.ts next to built .js, the .ts sources otherwise. */
export function libraryTypes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [spec, u] of Object.entries(libraryModules())) {
    const f = fileURLToPath(u);
    const dts = f.replace(/\.js$/, '.d.ts');
    if (f.endsWith('.ts')) out[spec] = f;
    else if (existsSync(dts)) out[spec] = dts;
  }
  return out;
}

/** Source of the resolve hook module (exported for tests). */
export function hookSource(): string {
  return `const map = ${JSON.stringify(libraryModules())};
const root = ${JSON.stringify(packageRoot())};
export async function resolve(spec, ctx, next) {
  if (Object.hasOwn(map, spec)) return { url: map[spec], shortCircuit: true };
  if (spec.startsWith('michelangelo/') && !spec.includes('..')) {
    try { return await next(spec, ctx); } catch { return next(new URL(spec.slice(13), root).href, ctx); }
  }
  return next(spec, ctx);
}`;
}

const dataUrl = (code: string) => 'data:text/javascript,' + encodeURIComponent(code);

/** Node flags for a child process that runs plugin code (tests, validation) against this library. */
export function childNodeArgs(): string[] {
  const args: string[] = [];
  if (fromSource) {
    const tsx = createRequire(import.meta.url).resolve('tsx');
    args.push('--import', pathToFileURL(tsx).href);
  }
  args.push('--import', dataUrl(`import { register } from 'node:module'; register(${JSON.stringify(dataUrl(hookSource()))});`));
  return args;
}

let registered = false;
/**
 * Map the bare specifiers in this process before plugin code is imported, for built and source runs alike.
 * Not under vitest: vite resolves modules itself (aliases in vitest.config.ts).
 */
export function registerLibraryHook(): void {
  if (registered || process.env.VITEST) return;
  registered = true;
  register(dataUrl(hookSource()));
}

/** Environment for child processes: without vitest's markers, so michelangelo/testing uses node:test. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('VITEST') || k === 'NODE_OPTIONS' || k === 'TEST' || k === 'NODE_TEST_CONTEXT') delete env[k];
  return env;
}
