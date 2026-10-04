/**
 * How plugin code finds `michelangelo/plugin` and `michelangelo/testing`: in an installed package Node
 * resolves them through node_modules; when Michelangelo runs from its own sources (repository, tsx) a
 * resolve hook maps them to the sibling source files so plugins share this copy of the library.
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

function hookSource(): string {
  return `const map = ${JSON.stringify(libraryModules())};
export async function resolve(spec, ctx, next) {
  if (Object.hasOwn(map, spec)) return { url: map[spec], shortCircuit: true };
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
/** In a source run outside vitest (vite resolves modules itself), map the bare specifiers in this process. */
export function registerSourceHook(): void {
  if (registered || !fromSource || process.env.VITEST) return;
  registered = true;
  register(dataUrl(hookSource()));
}

/** Environment for child processes: without vitest's markers, so michelangelo/testing uses node:test. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('VITEST') || k === 'NODE_OPTIONS' || k === 'TEST' || k === 'NODE_TEST_CONTEXT') delete env[k];
  return env;
}
