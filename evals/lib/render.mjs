// Graders that need a frame of the agent's project render it with the package under test, from the runner's
// pristine template install (MGL_EVAL_MGL), never from the sandbox's own node_modules unless no template exists.
// Pixels are then analysed with plain ffmpeg like any other output.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from './util.mjs';

export function mglCli(dir) {
  const env = process.env.MGL_EVAL_MGL;
  if (env && existsSync(env)) return env;
  const local = join(dir, 'node_modules', 'michelangelo', 'dist', 'cli', 'main.js');
  return existsSync(local) ? local : undefined;
}

/** Plugin folders the agent made next to its projects (plugins/<name>/package.json). */
export function localPlugins(dir) {
  const root = join(dir, 'plugins');
  try { return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'package.json'))).map((e) => `plugins/${e.name}`); } catch { return []; }
}

/**
 * Render `project` (relative to dir) to a temp file with extra args (e.g. ['--still', '2.5s']). Returns {file} or {error}.
 * The render gets a fresh HOME in which the run dir's own plugins are trusted (a project with an agent-made effect
 * renders as it did for the agent), and runs as MGL_EVAL_RUN_AS when the grader is root and that user is set: the
 * plugins are the agent's code.
 */
export async function renderProject(dir, project, ext, args = [], { timeoutMs = 300_000 } = {}) {
  const cli = mglCli(dir);
  if (!cli) return { error: 'no Michelangelo CLI to render with (set MGL_EVAL_MGL)' };
  const work = mkdtempSync(join(tmpdir(), 'mgl-grade-'));
  const home = join(work, 'home');
  mkdirSync(home);
  const out = join(work, `render.${ext}`);
  const user = process.env.MGL_EVAL_RUN_AS;
  const asUser = !!user && process.getuid?.() === 0;
  if (asUser) { chmodSync(work, 0o777); chmodSync(home, 0o777); }
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  const exec = (a) => (asUser ? run('runuser', ['-u', user, '--', 'env', `HOME=${home}`, `XDG_CONFIG_HOME=${join(home, '.config')}`, `PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, process.execPath, cli, ...a], { cwd: dir, timeoutMs })
    : run(process.execPath, [cli, ...a], { cwd: dir, timeoutMs, env }));
  for (const pl of localPlugins(dir)) await exec(['plugin', 'trust', pl]);
  const r = await exec(['render', project, out, ...args]);
  if (r.code !== 0 || !existsSync(out)) return { error: `render failed (${r.code}${r.timedOut ? ', timed out' : ''}): ${(r.stdout.toString() + r.stderr).trim().slice(-600)}` };
  return { file: out };
}

export const renderStill = (dir, project, seconds) => renderProject(dir, project, 'png', ['--still', `${seconds}s`]);

/**
 * Where a render of the project differs from a plain source frame (the project's own content: text, overlays),
 * does the output show the project rather than the source? Images are {width, height, data} of equal size.
 * Returns {pixels, share}: the number of such pixels and the share of them closer to the render.
 */
export function projectContentShare(out, rendered, source, { thresh = 60 } = {}) {
  let n = 0, closer = 0;
  for (let i = 0; i < rendered.data.length; i += 4) {
    const d = (a, b) => Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d(rendered, source) / 3 <= thresh) continue;
    n++;
    if (d(out, rendered) < d(out, source)) closer++;
  }
  return { pixels: n, share: n ? closer / n : 0 };
}
