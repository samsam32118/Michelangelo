// Plugin checks for plugin tasks: the manifest (raw JSON) and the plugin's own tests run with `node --test`.
// When MGL_EVAL_RUN_AS names a user (the runner sets it), the tests run as that user, never as root.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from './util.mjs';

export function readManifest(pluginDir) {
  try { return JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')); } catch { return undefined; }
}

/** The manifest declares michelangelo.api within 1.x. */
export function apiIsV1(m) {
  const api = m?.michelangelo?.api;
  return typeof api === 'string' && /^(\^|~|>=\s*)?1(\.\d+){0,2}$/.test(api.trim());
}

/** Run the plugin's tests (test/*.test.{ts,mts,js,mjs}). Returns {pass, detail}. */
export async function runPluginTests(pluginDir, { timeoutMs = 180_000 } = {}) {
  const testDir = join(pluginDir, 'test');
  const files = existsSync(testDir) ? readdirSync(testDir).filter((f) => /\.test\.(ts|mts|js|mjs)$/.test(f)).map((f) => join('test', f)) : [];
  if (!files.length) return { pass: false, detail: 'no tests in test/' };
  const user = process.env.MGL_EVAL_RUN_AS;
  const [cmd, args] = user && process.getuid?.() === 0
    ? ['runuser', ['-u', user, '--', process.execPath, '--test', '--test-reporter=tap', ...files]]
    : [process.execPath, ['--test', '--test-reporter=tap', ...files]];
  // the plugin is the agent's code: give it a minimal environment, never the grader's
  const env = { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: user ? `/home/${user}` : process.env.HOME ?? '/tmp', LANG: 'C.UTF-8' };
  const r = await run(cmd, args, { cwd: pluginDir, timeoutMs, env });
  const out = r.stdout.toString();
  const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0), fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0);
  return { pass: r.code === 0 && pass > 0 && fail === 0 && !r.timedOut, detail: `${pass} passed, ${fail} failed${r.timedOut ? ' (timed out)' : ''}${r.code !== 0 ? `: ${(out + r.stderr).trim().split('\n').filter((l) => /not ok|Error|error/.test(l)).slice(0, 3).join(' | ')}` : ''}` };
}
