// Process and file helpers shared by the eval library. Plain ESM, no Michelangelo imports.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const FFMPEG = process.env.MGL_EVAL_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.MGL_EVAL_FFPROBE || 'ffprobe';

/** Run a command; resolves {code, stdout (Buffer), stderr (string), timedOut}. Never rejects on exit code. */
export function run(cmd, args, { cwd, input, timeoutMs = 300_000, env } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e), timedOut }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString(), timedOut }); });
    p.stdin.on('error', () => {});
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

/** Run ffmpeg quietly; throws with stderr on failure. */
export async function ffmpeg(args, opts = {}) {
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], opts);
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.slice(-1500)}\nargs: ${args.join(' ')}`);
  return r;
}

/** ffmpeg with a filter that reports on stderr (ebur128, silencedetect, ssim); returns stderr. */
export async function ffmpegLog(args, opts = {}) {
  const r = await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], opts);
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.slice(-1500)}`);
  return r.stderr;
}

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.cache', '.npm']);

/** Files under dir (relative paths) matching re, skipping node_modules and dot-tool dirs (optionally .mgl). */
export function findFiles(dir, re, { includeMgl = false, maxDepth = 6 } = {}) {
  const res = [];
  const walk = (d, depth) => {
    if (depth > maxDepth || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (!includeMgl && e.name === '.mgl')) continue;
        walk(join(d, e.name), depth + 1);
      } else if (e.isFile() && re.test(e.name)) res.push(relative(dir, join(d, e.name)));
    }
  };
  walk(dir, 0);
  return res.sort();
}

/** Setup info written by setup.mjs (fixture hashes, values the grader needs). */
export function readSetup(dir) {
  try { return JSON.parse(readFileSync(join(dir, '.setup.json'), 'utf8')); } catch { return { hashes: {}, info: {} }; }
}

/** Output files: matching re, not a fixture (by setup hash list), newest first. */
export function outputs(dir, re, opts) {
  const setup = readSetup(dir);
  return findFiles(dir, re, opts)
    .filter((f) => !(f in (setup.hashes ?? {})) && !f.startsWith('golden/') && !f.startsWith('.golden/'))
    .sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
}

export const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
