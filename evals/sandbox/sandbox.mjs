// The eval sandbox (DESIGN §16 #1): a separate Unix user, a pre-installed copy of the packed library, a fresh
// HOME with only the Claude credentials, and the repository made unreadable for the duration of the runs.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { run } from '../lib/util.mjs';

export const USER = process.env.MGL_EVAL_USER || 'mgleval';
export const HOME = `/home/${USER}`;
export const TEMPLATE = join(HOME, 'template');

const sh = async (cmd, args, opts = {}) => {
  const r = await run(cmd, args, { timeoutMs: 1_200_000, ...opts });
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.code}): ${(r.stdout.toString() + r.stderr).trim().slice(-2000)}`);
  return r.stdout.toString();
};
export const isRoot = () => process.getuid?.() === 0;

/** Create the eval user if missing; returns {uid, gid, created}. */
export async function ensureUser() {
  if (!isRoot()) throw new Error('the sandbox needs root (useradd, chown, runuser). fix: run the eval runner as root, or use --dry-run --no-sandbox.');
  let created = false;
  if ((await run('id', ['-u', USER])).code !== 0) { await sh('useradd', ['-m', '-s', '/bin/bash', USER]); created = true; }
  const uid = Number((await sh('id', ['-u', USER])).trim()), gid = Number((await sh('id', ['-g', USER])).trim());
  mkdirSync(HOME, { recursive: true });
  await sh('chown', [`${USER}:${USER}`, HOME]);
  chmodSync(HOME, 0o755);
  return { uid, gid, created };
}

// ------------------------------------------------------------------------------------------------
// Repository lock: chmod 0700 (root-owned) while agents run, restored in finally / on signals / next start.
// ------------------------------------------------------------------------------------------------
const LOCK_STATE = process.env.MGL_EVAL_LOCK_STATE || '/var/tmp/mgl-eval-repo-lock.json';

export function lockState() { try { return JSON.parse(readFileSync(LOCK_STATE, 'utf8')); } catch { return null; } }

/** Restore the repository mode recorded by a previous lock (crash recovery). Returns what it did. */
export function restoreRepo() {
  const s = lockState();
  if (!s) return null;
  try { chmodSync(s.path, s.mode); } catch (e) { if (existsSync(s.path)) throw e; }
  rmSync(LOCK_STATE, { force: true });
  return s;
}

/** Make `repo` unreadable to other users; returns an idempotent unlock function. Signal handlers restore it too. */
export function lockRepo(repo) {
  const path = resolve(repo);
  restoreRepo();
  const st = statSync(path);
  if (st.uid !== 0) throw new Error(`${path} is not owned by root, so mode 0700 would not keep the eval user out. fix: chown root ${path}.`);
  const mode = st.mode & 0o7777;
  writeFileSync(LOCK_STATE, JSON.stringify({ path, mode, at: new Date().toISOString(), pid: process.pid }));
  chmodSync(path, 0o700);
  let done = false;
  const unlock = () => {
    if (done) return;
    done = true;
    try { chmodSync(path, mode); } finally { rmSync(LOCK_STATE, { force: true }); }
    for (const [sig, h] of handlers) process.off(sig, h);
  };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => [sig, () => { unlock(); process.exit(130); }]);
  for (const [sig, h] of handlers) process.on(sig, h);
  process.once('exit', unlock);
  return unlock;
}

// ------------------------------------------------------------------------------------------------
// Template install: npm pack of the repository, installed once into /home/mgleval/template.
// ------------------------------------------------------------------------------------------------
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** Build and pack the repository; returns the tarball path. */
export async function packRepo(repo, outDir, { build = true, log = () => {} } = {}) {
  mkdirSync(outDir, { recursive: true });
  if (build) { log('npm run build'); await sh('npm', ['run', 'build'], { cwd: repo }); }
  log('npm pack');
  const out = await sh('npm', ['pack', '--pack-destination', outDir, '--silent'], { cwd: repo });
  const name = out.trim().split('\n').pop();
  return join(outDir, name);
}

/**
 * Install the tarball into the template dir (offline first, from npm's cache; online once otherwise) and copy the
 * skill. Skips the install when the template already holds this tarball. Returns the template record.
 */
export async function buildTemplate(tarball, { log = () => {} } = {}) {
  const recFile = join(TEMPLATE, '.mgl-eval.json');
  const hash = sha(tarball);
  const prev = existsSync(recFile) ? JSON.parse(readFileSync(recFile, 'utf8')) : null;
  if (prev?.tarballSha256 === hash && existsSync(join(TEMPLATE, 'node_modules/michelangelo/package.json'))) { log('template up to date'); return prev; }
  rmSync(TEMPLATE, { recursive: true, force: true });
  mkdirSync(TEMPLATE, { recursive: true });
  copyFileSync(tarball, join(TEMPLATE, 'michelangelo.tgz'));
  writeFileSync(join(TEMPLATE, 'package.json'), JSON.stringify({ name: 'mgl-eval-sandbox', private: true, type: 'module' }, null, 2) + '\n');
  let offline = true;
  const args = ['install', '--no-audit', '--no-fund', '--loglevel', 'error', './michelangelo.tgz'];
  if ((await run('npm', [...args, '--offline'], { cwd: TEMPLATE, timeoutMs: 600_000 })).code !== 0) {
    offline = false;
    log('offline install failed; installing online once');
    await sh('npm', args, { cwd: TEMPLATE });
  }
  const pkg = join(TEMPLATE, 'node_modules/michelangelo');
  const skill = [join(pkg, 'SKILL.md'), join(pkg, 'docs/SKILL.md')].find(existsSync);
  const skillDir = join(TEMPLATE, '.claude/skills/michelangelo');
  mkdirSync(skillDir, { recursive: true });
  if (skill) copyFileSync(skill, join(skillDir, 'SKILL.md'));
  if (existsSync(join(pkg, 'docs'))) cpSync(join(pkg, 'docs'), join(skillDir, 'docs'), { recursive: true });
  const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
  const rec = { tarball: tarball.split('/').pop(), tarballSha256: hash, version, offline, skill: !!skill, installedAt: new Date().toISOString() };
  writeFileSync(recFile, JSON.stringify(rec, null, 2));
  await sh('chown', ['-R', 'root:root', TEMPLATE]);
  await sh('chmod', ['-R', 'a+rX,go-w', TEMPLATE]);
  return rec;
}

export const templateCli = () => join(TEMPLATE, 'node_modules/michelangelo/dist/cli/main.js');

// ------------------------------------------------------------------------------------------------
// HOME: only the Claude credentials and a seeded ffmpeg cache.
// ------------------------------------------------------------------------------------------------
/** Env var names passed through to the agent when set (auth, proxy, CA). Extra names via --pass-env. */
export const PASS_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_REGION', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'LANG'];

/** Prepare the eval user's HOME; returns the env for the agent process. */
export async function prepareHome({ passEnv = [], credentials = true, log = () => {} } = {}) {
  const claudeDir = join(HOME, '.claude');
  rmSync(claudeDir, { recursive: true, force: true });
  mkdirSync(claudeDir, { recursive: true });
  const rootClaude = join(homedir(), '.claude');
  let creds = false;
  if (credentials && existsSync(join(rootClaude, '.credentials.json'))) { copyFileSync(join(rootClaude, '.credentials.json'), join(claudeDir, '.credentials.json')); chmodSync(join(claudeDir, '.credentials.json'), 0o600); creds = true; }
  // no settings, memory or projects from root: a fresh HOME
  const env = { HOME, USER, LOGNAME: USER, SHELL: '/bin/bash', PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, TERM: 'dumb', CI: '1', DISABLE_AUTOUPDATER: '1' };
  if (credentials) for (const k of [...PASS_ENV, ...passEnv]) if (process.env[k] !== undefined) env[k] = process.env[k];
  // CA bundles under /root are unreadable to the eval user: copy them into its HOME
  for (const k of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE']) {
    const f = process.env[k];
    if (f && existsSync(f)) { const dst = join(HOME, `.ca-${k.toLowerCase()}.pem`); copyFileSync(f, dst); chmodSync(dst, 0o644); env[k] = dst; }
  }
  const cache = join(homedir(), '.cache/michelangelo');
  if (existsSync(cache)) cpSync(cache, join(HOME, '.cache/michelangelo'), { recursive: true });
  await sh('chown', ['-R', `${USER}:${USER}`, claudeDir, ...(existsSync(join(HOME, '.cache')) ? [join(HOME, '.cache')] : [])]);
  log(`HOME ${HOME}: credentials file ${creds ? 'copied' : 'absent'}; env passed: ${Object.keys(env).filter((k) => [...PASS_ENV, ...passEnv].includes(k)).join(', ') || 'none'}`);
  return { env, creds };
}

// ------------------------------------------------------------------------------------------------
// Run dirs
// ------------------------------------------------------------------------------------------------
/** Hidden grader inputs written by setup: moved out of the sandbox while the agent runs, restored for grading. */
export const STASHED = ['.golden', '.setup.json'];

export function stash(dir, stashDir) {
  rmSync(stashDir, { recursive: true, force: true });
  mkdirSync(stashDir, { recursive: true });
  for (const n of STASHED) if (existsSync(join(dir, n))) renameSync(join(dir, n), join(stashDir, n));
}
export function unstash(dir, stashDir) {
  for (const n of STASHED) {
    rmSync(join(dir, n), { recursive: true, force: true });
    if (existsSync(join(stashDir, n))) cpSync(join(stashDir, n), join(dir, n), { recursive: true });
  }
}

/** Copy the template install (node_modules, package.json, the skill) into a fresh run dir. */
export function populateFromTemplate(dir) {
  if (!existsSync(TEMPLATE)) return false;
  for (const n of readdirSync(TEMPLATE)) {
    if (n === 'michelangelo.tgz' || n === '.mgl-eval.json') continue;
    cpSync(join(TEMPLATE, n), join(dir, n), { recursive: true, verbatimSymlinks: true });
  }
  return true;
}

export async function chownTree(dir) { await sh('chown', ['-R', `${USER}:${USER}`, dir]); }

/** Kill every process of the eval user (after all runs). */
export async function killUserProcs() { if (isRoot()) await run('pkill', ['-KILL', '-u', USER]); }
