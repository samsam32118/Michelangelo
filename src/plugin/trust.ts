/**
 * The trust store: plugins found next to a project load only after `mgl plugin trust <path>`, which records
 * the plugin's name and a sha256 of its files. Editing a plugin changes its hash, so it must be re-trusted.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fail } from '../core/errors.js';
import { pluginEntry } from './loader.js';

export interface TrustEntry { name: string; hash: string; path: string; trustedAt: string }
interface TrustFile { plugins: TrustEntry[] }

/**
 * Folders never hashed: dependencies, VCS data and the render cache. Code is never loaded from them: a plugin
 * whose entry lies in one is refused (see entryProblem). Everything else is hashed, including out/ or dist/.
 */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.mgl']);
const SKIP_FILES = new Set(['.preview.png', '.DS_Store']);

const inside = (root: string, p: string) => { const r = relative(root, p); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); };

/**
 * Why `entry` may not be loaded from plugin folder `dir`, or undefined when it may: its real path (symlinks
 * resolved) must be inside the plugin folder's real path and not under a folder the trust hash skips.
 */
export function entryProblem(dir: string, entry: string): string | undefined {
  let root: string, real: string;
  try { root = realpathSync(dir); real = realpathSync(entry); } catch (e) { return `cannot resolve ${entry} (${(e as Error).message})`; }
  if (!inside(root, real)) return `its entry ${entry} resolves to ${real}, outside the plugin folder`;
  const skipped = relative(root, real).split(sep).find((part) => SKIP_DIRS.has(part));
  if (skipped) return `its entry ${entry} is inside ${skipped}/, which the trust hash does not cover`;
  return undefined;
}

export function trustStorePath(override?: string): string {
  return override ?? process.env.MGL_TRUST_STORE ?? join(homedir(), '.config', 'michelangelo', 'trusted.json');
}

/**
 * Every hashed file of a plugin folder (relative path with "/"). Symlinks are followed when their target is
 * inside the folder (hashed under the link's path, so the content counts); one pointing outside is refused.
 */
function files(dir: string, root = dir, realRoot = realpathSync(root), out: string[] = [], seen = new Set<string>()): string[] {
  const here = realpathSync(dir);
  if (seen.has(here)) return out; // a symlink loop
  seen.add(here);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (e.isSymbolicLink()) {
      let real: string;
      try { real = realpathSync(p); } catch { fail('E_PLUGIN_SYMLINK', `${p} is a broken symlink.`, 'remove it or point it at a file inside the plugin folder, then trust the plugin again.'); }
      if (!inside(realRoot, real)) fail('E_PLUGIN_SYMLINK', `${p} is a symlink to ${real}, outside the plugin folder, so its content cannot be trusted.`, 'replace the symlink with a copy of the file, then trust the plugin again.');
      const st = statSync(real);
      isDir = st.isDirectory(); isFile = st.isFile();
    }
    if (isDir) { if (!SKIP_DIRS.has(e.name)) files(p, root, realRoot, out, seen); }
    else if (isFile && !SKIP_FILES.has(e.name) && !e.name.endsWith('.log')) out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

/** sha256 over the sorted relative paths and contents of a plugin folder ("sha256:<hex>"). Throws E_PLUGIN_SYMLINK. */
export function hashPlugin(dir: string): string {
  const h = createHash('sha256');
  for (const f of files(dir).sort()) {
    h.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0');
  }
  return 'sha256:' + h.digest('hex');
}

function read(store: string): TrustFile {
  if (!existsSync(store)) return { plugins: [] };
  try {
    const j = JSON.parse(readFileSync(store, 'utf8')) as Partial<TrustFile>;
    return { plugins: Array.isArray(j.plugins) ? j.plugins : [] };
  } catch {
    return fail('E_TRUST_STORE', `the trust store ${store} is not valid JSON.`, `fix or delete ${store}, then re-run "mgl plugin trust <path>" for each plugin.`);
  }
}

function write(store: string, t: TrustFile): void {
  mkdirSync(dirname(store), { recursive: true });
  const tmp = `${store}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(t, null, 2) + '\n');
  renameSync(tmp, store);
}

function pluginName(dir: string): string {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) fail('E_PLUGIN_MANIFEST', `${dir} has no package.json, so it is not a plugin folder.`, 'pass the plugin folder (e.g. plugins/glitch), or scaffold one with: mgl plugin new effect <name>');
  try {
    const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
    if (typeof name === 'string' && name) return name;
  } catch { /* reported below */ }
  return fail('E_PLUGIN_MANIFEST', `${pkg} has no "name".`, 'add "name": "<plugin-name>" to package.json.');
}

/** Trust a plugin folder as it is now (replaces earlier entries for the same name and path). */
export function trustPlugin(path: string, opts: { trustStore?: string } = {}): TrustEntry {
  const dir = resolve(path);
  const name = pluginName(dir);
  let entryFile: string | undefined;
  try { entryFile = pluginEntry(dir, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>); } catch { /* no entry yet: loading reports it */ }
  if (entryFile) {
    const why = entryProblem(dir, entryFile);
    if (why) fail('E_PLUGIN_ENTRY', `cannot trust ${dir}: ${why}.`, 'point "main" / "exports" at a file inside the plugin folder (not in node_modules/), then trust it again.');
  }
  const entry: TrustEntry = { name, hash: hashPlugin(dir), path: dir, trustedAt: new Date().toISOString() };
  const store = trustStorePath(opts.trustStore);
  const t = read(store);
  t.plugins = t.plugins.filter((e) => !(e.name === entry.name && e.path === entry.path));
  t.plugins.push(entry);
  write(store, t);
  return entry;
}

/** Remove trust by plugin folder path or by plugin name; returns the removed entries. */
export function untrustPlugin(pathOrName: string, opts: { trustStore?: string } = {}): TrustEntry[] {
  const store = trustStorePath(opts.trustStore);
  const t = read(store);
  const dir = resolve(pathOrName);
  const gone = t.plugins.filter((e) => e.path === dir || e.name === pathOrName);
  if (gone.length) write(store, { plugins: t.plugins.filter((e) => !gone.includes(e)) });
  return gone;
}

export function listTrusted(opts: { trustStore?: string } = {}): TrustEntry[] {
  return read(trustStorePath(opts.trustStore)).plugins;
}

/** Is this plugin folder trusted as it is now? */
export function isTrusted(dir: string, name: string, opts: { trustStore?: string } = {}): boolean {
  const list = listTrusted(opts).filter((e) => e.name === name);
  if (!list.length) return false;
  const hash = hashPlugin(dir);
  return list.some((e) => e.hash === hash);
}
