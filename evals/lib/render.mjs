// Graders that need a frame of the agent's project render it with the package under test, from the runner's
// pristine template install (MGL_EVAL_MGL), never from the sandbox's own node_modules unless no template exists.
// Pixels are then analysed with plain ffmpeg like any other output.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './util.mjs';

export function mglCli(dir) {
  const env = process.env.MGL_EVAL_MGL;
  if (env && existsSync(env)) return env;
  const local = join(dir, 'node_modules', 'michelangelo', 'dist', 'cli', 'main.js');
  return existsSync(local) ? local : undefined;
}

/** Render `project` (relative to dir) to a temp file with extra args (e.g. ['--still', '2.5s']). Returns {file} or {error}. */
export async function renderProject(dir, project, ext, args = [], { timeoutMs = 300_000 } = {}) {
  const cli = mglCli(dir);
  if (!cli) return { error: 'no Michelangelo CLI to render with (set MGL_EVAL_MGL)' };
  const out = join(mkdtempSync(join(tmpdir(), 'mgl-grade-')), `render.${ext}`);
  const r = await run(process.execPath, [cli, 'render', project, out, ...args], { cwd: dir, timeoutMs });
  if (r.code !== 0 || !existsSync(out)) return { error: `render failed (${r.code}${r.timedOut ? ', timed out' : ''}): ${(r.stdout.toString() + r.stderr).trim().slice(-600)}` };
  return { file: out };
}

export const renderStill = (dir, project, seconds) => renderProject(dir, project, 'png', ['--still', `${seconds}s`]);
