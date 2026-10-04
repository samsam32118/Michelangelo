/**
 * `mgl plugin test <dir>`: validate the manifest, import and validate the definition, type-check (when
 * TypeScript is installed), run the plugin's tests with `node --test`, and render .preview.png.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MglError } from '../core/errors.js';
import { readManifest } from './loader.js';
import { childEnv, childNodeArgs, fromSource, libraryTypes } from './resolve.js';
import { PLUGIN_KINDS } from './validate.js';

export interface PluginTestStep { step: 'manifest' | 'definition' | 'filters' | 'typecheck' | 'tests' | 'preview'; ok: boolean; skipped?: boolean; detail: string }

export interface PluginTestResult {
  ok: boolean;
  /** printable report */
  output: string;
  passed: number;
  failed: number;
  steps: PluginTestStep[];
  /** path of the preview PNG (effects, transitions, generators) */
  preview?: string;
}

interface Proc { code: number | null; out: string; timedOut: boolean }

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<Proc> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', timedOut = false;
    p.stdout.on('data', (b: Buffer) => { out += b; });
    p.stderr.on('data', (b: Buffer) => { out += b; });
    const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); done({ code, out, timedOut }); });
    p.on('error', (e) => { clearTimeout(t); done({ code: -1, out: String(e), timedOut }); });
  });
}

function resolveFrom(spec: string, dir: string): string | undefined {
  for (const base of [join(dir, 'package.json'), fileURLToPath(import.meta.url)]) {
    try { return createRequire(base).resolve(spec); } catch { /* next */ }
  }
  return undefined;
}

/**
 * Keeps only the tsc diagnostics that are the plugin's own problem: those in files outside `dir` are dropped
 * (library sources are checked by their own build), and without @types/node the ones that only say a Node
 * built-in is unknown are dropped too. tsc reports those in two ways: TS2307 "Cannot find module 'node:fs'" for a
 * static import and TS2591 "Cannot find name 'node:fs'" for a dynamic `import('node:fs')`; values that come out
 * of such an import are untyped, so the implicit-any errors (TS7006, TS7031) that follow in the same file are
 * consequences, not plugin bugs.
 */
export function filterDiagnostics(out: string, dir: string, hasNodeTypes: boolean): { kept: string[]; outside: number; skippedNode: number } {
  const kept: string[] = [];
  const nodeFiles = new Set<string>();
  let keep = false, outside = 0, skippedNode = 0;
  for (const l of out.split('\n')) {
    const m = /^(.+?)\(\d+,\d+\): (error|warning)/.exec(l);
    if (m) {
      const f = resolve(dir, m[1]!), rel = relative(dir, f);
      keep = !rel.startsWith('..') && !isAbsolute(rel);
      if (!keep) outside++;
      else if (!hasNodeTypes && /Cannot find (module|name) '(node:[^']*|Buffer|process|NodeJS)'/.test(l)) { keep = false; skippedNode++; nodeFiles.add(f); }
      else if (!hasNodeTypes && nodeFiles.has(f) && /error TS70(06|31):/.test(l)) { keep = false; skippedNode++; }
    } else if (!/^\s/.test(l)) keep = false;
    if (keep) kept.push(l);
  }
  return { kept, outside, skippedNode };
}

async function typecheck(dir: string, timeoutMs: number): Promise<PluginTestStep> {
  const tsPkg = resolveFrom('typescript/package.json', dir);
  if (!tsPkg) return { step: 'typecheck', ok: true, skipped: true, detail: 'skipped type-check: typescript not installed (npm install -D typescript to enable it)' };
  const bin = (JSON.parse(readFileSync(tsPkg, 'utf8')) as { bin?: { tsc?: string } }).bin?.tsc ?? 'bin/tsc';
  const nodeTypes = resolveFrom('@types/node/package.json', dir);
  // the same copy of the library the plugin runs against (the resolve hook): .d.ts in the built package, .ts from source
  const types = libraryTypes();
  const paths = Object.keys(types).length ? Object.fromEntries(Object.entries(types).map(([k, f]) => [k, [f]])) : undefined;
  const tmp = mkdtempSync(join(tmpdir(), 'mgl-tsc-'));
  try {
    const cfg = {
      compilerOptions: {
        target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, noEmit: true,
        allowImportingTsExtensions: true, esModuleInterop: true, resolveJsonModule: true,
        types: nodeTypes ? ['node'] : [], ...(nodeTypes ? { typeRoots: [dirname(dirname(nodeTypes))] } : {}), ...(paths ? { paths } : {}),
      },
      include: [join(dir, 'src', '**', '*.ts'), join(dir, 'test', '**', '*.ts')],
    };
    writeFileSync(join(tmp, 'tsconfig.json'), JSON.stringify(cfg));
    const r = await run(process.execPath, [resolve(dirname(tsPkg), bin), '-p', join(tmp, 'tsconfig.json')], dir, timeoutMs);
    const { kept, outside, skippedNode } = filterDiagnostics(r.out, dir, Boolean(nodeTypes));
    if (r.timedOut) return { step: 'typecheck', ok: false, detail: `tsc timed out after ${timeoutMs / 1000} s` };
    if (kept.length) return { step: 'typecheck', ok: false, detail: kept.join('\n') };
    if (r.code !== 0 && !outside && !skippedNode) return { step: 'typecheck', ok: false, detail: r.out.trim() || `tsc exited with ${r.code}` };
    const notes = [outside ? `${outside} diagnostics outside the plugin ignored` : '', skippedNode ? `${skippedNode} Node built-in references unchecked: @types/node not installed` : ''].filter(Boolean);
    return { step: 'typecheck', ok: true, detail: 'type-check passed' + (notes.length ? ` (${notes.join('; ')})` : '') };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const childScript = () => fileURLToPath(new URL(fromSource ? './test-child.ts' : './test-child.js', import.meta.url));

/** Run a plugin folder's checks and tests. Never throws for plugin problems; they are in the result. */
export async function runPluginTests(pluginDir: string, opts: { typecheck?: boolean; timeoutMs?: number } = {}): Promise<PluginTestResult> {
  const dir = resolve(pluginDir);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const steps: PluginTestStep[] = [];
  let passed = 0, failed = 0, preview: string | undefined;
  const finish = (): PluginTestResult => {
    const ok = steps.every((s) => s.ok) && failed === 0;
    const bad = steps.filter((s) => !s.ok).map((s) => s.step === 'typecheck' ? `typecheck (${(s.detail.match(/\): error /g) ?? []).length || 1} error(s))` : s.step === 'tests' ? `tests (${failed} failed)` : s.step);
    const output = [...steps.map((s) => `${s.skipped ? '-' : s.ok ? '✓' : '✗'} ${s.step}: ${s.detail}`), ok ? `ok: ${passed} test(s) passed` : `FAILED: ${bad.join(', ') || `${failed} test(s) failed`}; ${passed} test(s) passed`].join('\n');
    return { ok, output, passed, failed, steps, ...(preview ? { preview } : {}) };
  };

  // 1. manifest
  let declared: string[] = [];
  try {
    const m = readManifest(dir);
    const issues: string[] = [];
    if (m.pkg.type !== 'module') issues.push('package.json needs "type": "module" (fix: add it).');
    const unknown = m.kinds.filter((k) => !(PLUGIN_KINDS as readonly string[]).includes(k));
    if (!m.kinds.length) issues.push(`"michelangelo.kinds" is empty (fix: list what the plugin provides, e.g. ["effect"]; kinds: ${PLUGIN_KINDS.join(', ')}).`);
    if (unknown.length) issues.push(`unknown kinds ${unknown.join(', ')} (fix: use ${PLUGIN_KINDS.join(', ')}).`);
    declared = m.kinds;
    steps.push({ step: 'manifest', ok: !issues.length, detail: issues.join(' ') || `${m.name}@${m.version}, api ${m.api}, kinds ${m.kinds.join(', ')}` });
  } catch (e) {
    steps.push({ step: 'manifest', ok: false, detail: e instanceof MglError ? `${e.message} (fix: ${e.fix})` : String(e) });
    return finish();
  }

  // 2. definition + preview (child process: plugin code never runs in this one)
  const v = await run(process.execPath, [...childNodeArgs(), childScript(), dir], dir, timeoutMs);
  const line = v.out.split('\n').find((l) => l.startsWith('MGL_RESULT '));
  if (!line) {
    steps.push({ step: 'definition', ok: false, detail: `validation crashed${v.timedOut ? ' (timed out)' : ''}:\n${v.out.trim().slice(-3000)}` });
  } else {
    const r = JSON.parse(line.slice(11)) as { name?: string; errors: string[]; kinds: string[]; preview?: string; previewOf?: string; filters?: string[] };
    const missing = declared.filter((k) => !r.kinds.includes(k));
    const extra = r.kinds.filter((k) => !declared.includes(k));
    const errs = [...r.errors];
    if (!errs.length && missing.length) errs.push(`package.json declares ${missing.join(', ')} but the plugin defines none (fix: add them or remove them from "michelangelo.kinds").`);
    steps.push({ step: 'definition', ok: !errs.length, detail: errs.length ? errs.join('\n') : `plugin "${r.name}" defines ${r.kinds.join(', ')}${extra.length ? ` (note: add ${extra.join(', ')} to "michelangelo.kinds")` : ''}` });
    if (!errs.length && r.filters?.length) steps.push({ step: 'filters', ok: true, detail: r.filters.join(' | ') });
    if (r.preview) { preview = r.preview; steps.push({ step: 'preview', ok: true, detail: `${r.preview} (${r.previewOf}, default params)` }); }
  }

  // 3. type-check
  if (opts.typecheck !== false) steps.push(await typecheck(dir, timeoutMs));

  // 4. tests
  const testDir = join(dir, 'test');
  const files = existsSync(testDir) ? readdirSync(testDir).filter((f) => /\.test\.(ts|mts|js|mjs)$/.test(f)).sort().map((f) => join('test', f)) : [];
  if (!files.length) {
    steps.push({ step: 'tests', ok: false, detail: 'no tests found (fix: add test/<name>.test.ts using michelangelo/testing).' });
    return finish();
  }
  const t = await run(process.execPath, [...childNodeArgs(), '--test', '--test-reporter=tap', ...files], dir, timeoutMs);
  passed = Number(/^# pass (\d+)/m.exec(t.out)?.[1] ?? 0);
  failed = Number(/^# fail (\d+)/m.exec(t.out)?.[1] ?? 0) + (t.timedOut ? 1 : 0);
  if (t.code !== 0 && !failed) failed = 1;
  const failures = t.out.split('\n').filter((l) => /^\s*not ok /.test(l) || /^\s+(error|message|expected|actual|stack|location):/.test(l) || /^\s{6,}\S/.test(l)).slice(0, 60);
  steps.push({ step: 'tests', ok: failed === 0, detail: failed === 0 ? `${passed} passed (${files.join(', ')})` : `${failed} failed, ${passed} passed${t.timedOut ? ` (timed out after ${timeoutMs / 1000} s)` : ''}\n${(failures.length ? failures.join('\n') : t.out.trim().slice(-3000))}` });
  return finish();
}
