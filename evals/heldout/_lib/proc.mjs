// Process, ffmpeg and ffprobe helpers for the held-out graders. Plain ESM; never imports Michelangelo.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

export const FFMPEG = process.env.MGL_EVAL_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.MGL_EVAL_FFPROBE || 'ffprobe';

/** Run a command; resolves {code, stdout: Buffer, stderr: string, timedOut}. Never rejects. */
export function run(cmd, args, { cwd, env, timeoutMs = 300_000, input } = {}) {
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
    p.stdin.end(input);
  });
}

/** ffmpeg, quiet; throws (with the tail of stderr) on failure. */
export async function ff(args, opts) {
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], opts);
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-800)}\nargs: ${args.join(' ')}`);
  return r;
}

/** ffmpeg returning stderr (for reporting filters such as ebur128). */
export async function ffLog(args, opts) {
  const r = await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], opts);
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-800)}`);
  return r.stderr;
}

export const isFile = (f) => { try { return statSync(f).isFile() && statSync(f).size > 0; } catch { return false; } };
export const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
export const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

const rate = (s) => { const [n, d] = String(s ?? '0/1').split('/').map(Number); return d ? n / d : n; };

/** ffprobe summary or null when the file is missing or unreadable. */
export async function probe(file) {
  if (!isFile(file)) return null;
  const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) return null;
  let j;
  try { j = JSON.parse(r.stdout.toString()); } catch { return null; }
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = (j.streams ?? []).find((s) => s.codec_type === 'audio');
  const duration = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? NaN);
  return {
    duration,
    format: j.format?.format_name ?? '',
    video: v ? { codec: v.codec_name, profile: v.profile ?? '', width: v.width, height: v.height, fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate), rFps: rate(v.r_frame_rate), pixFmt: v.pix_fmt, frames: Number(v.nb_frames ?? NaN) } : null,
    audio: a ? { codec: a.codec_name, sampleFmt: a.sample_fmt, rate: Number(a.sample_rate), channels: a.channels, profile: a.profile ?? '' } : null,
  };
}

/**
 * Run a program written by the tested agent. When MGL_EVAL_RUN_AS names a user and we are root, it runs as
 * that user (never as root), with that user's HOME.
 */
export async function runAgentCode(cmd, args, { cwd, timeoutMs = 600_000, env = {} } = {}) {
  const user = process.env.MGL_EVAL_RUN_AS;
  if (user && process.getuid?.() === 0) {
    const home = process.env.MGL_EVAL_HOME || homeOf(user) || `/home/${user}`;
    return run('runuser', ['-u', user, '--', 'env', `HOME=${home}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`), cmd, ...args], { cwd, timeoutMs });
  }
  return run(cmd, args, { cwd, timeoutMs, env: { ...process.env, ...env } });
}

function homeOf(user) {
  try { return readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find((f) => f[0] === user)?.[5]; } catch { return undefined; }
}

export const exists = existsSync;
