/**
 * Locating ffmpeg/ffprobe: MGL_FFMPEG/MGL_FFPROBE → system PATH (≥ 6.0 with libx264 + aac) →
 * cached static build → pinned download (verified by SHA-256 before extraction).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, rename, rm, stat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { MglError, fail } from '../core/errors.js';
import manifestJson from './ffmpeg-builds.json' with { type: 'json' };
import type { FfmpegInfo } from './types.js';
import { run } from './proc.js';

export interface BuildEntry { url: string; sha256: string; size: number; archive: 'tar.xz'; dir: string; licence: string }
export interface BuildManifest { version: string; note?: string; platforms: Record<string, BuildEntry> }

export const MIN_VERSION: [number, number] = [6, 0];
const REQUIRED_ENCODERS = ['libx264', 'aac'];

/** Root of Michelangelo's caches (MGL_CACHE_DIR, else $XDG_CACHE_HOME/michelangelo, else ~/.cache/michelangelo). */
export function cacheRoot(): string {
  if (process.env.MGL_CACHE_DIR) return process.env.MGL_CACHE_DIR;
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'michelangelo');
}

export function loadManifest(): BuildManifest { return manifestJson as BuildManifest; }

export function platformKey(): string { return `${process.platform}-${process.arch}`; }

/** "6.1.1-3ubuntu5" → [6, 1]; git builds ("N-112233-g…") count as new. */
export function parseVersion(text: string): { version: string; major: number; minor: number } | null {
  const m = /(?:ffmpeg|ffprobe) version (\S+)/.exec(text);
  if (!m) return null;
  const v = m[1]!;
  const n = /^n?(\d+)\.(\d+)/.exec(v);
  if (n) return { version: v, major: Number(n[1]), minor: Number(n[2]) };
  if (/^N-|^git|^\d{4}-/.test(v)) return { version: v, major: 99, minor: 0 };
  return { version: v, major: 0, minor: 0 };
}

/** Names from `ffmpeg -encoders/-decoders/-filters` listings. */
export function parseList(text: string, kind: 'codec' | 'filter'): string[] {
  const names: string[] = [];
  let started = kind === 'filter';
  for (const line of text.split('\n')) {
    if (!started) { if (/^\s*-{6}/.test(line)) started = true; continue; }
    const m = kind === 'codec' ? /^\s[VASFXBD.]{6}\s+(\S+)/.exec(line) : /^\s[TSC.]{3}\s+(\S+)\s+\S+->\S+/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === 'win32' ? ['.exe', ''] : ['']) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

async function describe(ffmpeg: string, ffprobe: string, source: FfmpegInfo['source'], licence?: string): Promise<FfmpegInfo | { error: string }> {
  let v;
  const t0 = Date.now();
  try { v = await run(ffmpeg, ['-hide_banner', '-version'], { allowFail: true, timeoutMs: 20_000 }); } catch (e) { return { error: `${ffmpeg} does not run (${(e as Error).message})` }; }
  const ver = parseVersion(v.stdout.toString());
  if (!ver && Date.now() - t0 >= 19_000) return { error: `${ffmpeg} -version did not answer within 20 s (the machine may be overloaded)` };
  if (!ver) return { error: `${ffmpeg} is not ffmpeg` };
  if (!(await exists(ffprobe))) return { error: `ffprobe not found next to ${ffmpeg}` };
  const [enc, dec, fil] = await Promise.all(['-encoders', '-decoders', '-filters'].map((f) => run(ffmpeg, ['-hide_banner', f], { allowFail: true, timeoutMs: 20_000 })));
  const encoders = parseList(enc!.stdout.toString(), 'codec');
  const decoders = parseList(dec!.stdout.toString(), 'codec');
  const filters = parseList(fil!.stdout.toString(), 'filter');
  const old = ver.major < MIN_VERSION[0] || (ver.major === MIN_VERSION[0] && ver.minor < MIN_VERSION[1]);
  const missing = REQUIRED_ENCODERS.filter((e) => !encoders.includes(e));
  if (old) return { error: `${ffmpeg} is version ${ver.version} (need ≥ ${MIN_VERSION.join('.')})` };
  if (missing.length) return { error: `${ffmpeg} lacks encoders ${missing.join(', ')}` };
  const conf = v.stdout.toString();
  return {
    ffmpeg, ffprobe, version: ver.version, source, encoders, decoders, filters,
    licence: licence ?? (/--enable-gpl/.test(conf) ? 'GPL (system build)' : /--enable-nonfree/.test(conf) ? 'non-free (system build)' : 'LGPL (system build)'),
  };
}

let cached: FfmpegInfo | undefined;
let pending: Promise<FfmpegInfo> | undefined;

/** Find (and with allowDownload, fetch) ffmpeg. Cached per process once found. */
export function getFfmpeg(opts: { allowDownload?: boolean; quiet?: boolean } = {}): Promise<FfmpegInfo> {
  if (cached) return Promise.resolve(cached);
  if (pending && !opts.allowDownload) return pending;
  const p = locate(opts).then((i) => (cached = i), (e) => { if (pending === p) pending = undefined; throw e; });
  pending = p;
  return p;
}

/** Forget the located ffmpeg (tests, after doctor --fetch). */
export function resetFfmpeg(): void { cached = undefined; pending = undefined; }

/** The information `doctor` prints. Same as getFfmpeg, without downloading. */
export async function ffmpegInfo(): Promise<FfmpegInfo> { return getFfmpeg({ allowDownload: false }); }

async function locate(opts: { allowDownload?: boolean; quiet?: boolean }): Promise<FfmpegInfo> {
  const problems: string[] = [];
  const envF = process.env.MGL_FFMPEG;
  if (envF) {
    const probe = process.env.MGL_FFPROBE || join(dirname(envF), envF.endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe');
    const d = await describe(envF, probe, 'env');
    if ('error' in d) fail('E_FFMPEG', `MGL_FFMPEG is set but unusable: ${d.error}.`, 'point MGL_FFMPEG (and MGL_FFPROBE) at ffmpeg ≥ 6.0 with libx264 and aac, or unset it and run "mgl doctor --fetch".');
    return d;
  }
  const sys = which('ffmpeg'), sysProbe = which('ffprobe');
  if (sys && sysProbe) {
    const d = await describe(sys, sysProbe, 'system');
    if (!('error' in d)) return d;
    problems.push(d.error);
  } else if (sys) problems.push('ffprobe is not on PATH');
  const manifest = loadManifest();
  const entry = manifest.platforms[platformKey()];
  const dir = join(cacheRoot(), 'ffmpeg', manifest.version);
  const exe = process.platform === 'win32' ? '.exe' : '';
  if (await exists(join(dir, 'ffmpeg' + exe))) {
    const d = await describe(join(dir, 'ffmpeg' + exe), join(dir, 'ffprobe' + exe), 'cache', entry?.licence);
    if (!('error' in d)) return d;
    problems.push(d.error);
  }
  if (!entry) {
    fail('E_FFMPEG', `no usable ffmpeg found${problems.length ? ' (' + problems.join('; ') + ')' : ''}, and no pinned build exists for ${platformKey()}.`,
      process.platform === 'darwin' ? 'install ffmpeg ≥ 6 (brew install ffmpeg) or set MGL_FFMPEG to its path.' : 'install ffmpeg ≥ 6 with libx264 and aac (your package manager or ffmpeg.org) or set MGL_FFMPEG to its path.');
  }
  if (!opts.allowDownload) {
    fail('E_FFMPEG', `no usable ffmpeg found${problems.length ? ' (' + problems.join('; ') + ')' : ''}.`, `run "mgl doctor --fetch" (downloads a pinned static build, ${Math.round(entry.size / 1e6)} MB), install ffmpeg ≥ 6, or set MGL_FFMPEG.`);
  }
  await downloadBuild(entry, dir, { quiet: opts.quiet });
  const d = await describe(join(dir, 'ffmpeg'), join(dir, 'ffprobe'), 'download', entry.licence);
  if ('error' in d) fail('E_FFMPEG', `the downloaded ffmpeg does not work: ${d.error}.`, 'install ffmpeg ≥ 6 with libx264 and aac and put it on PATH, or set MGL_FFMPEG.');
  return d;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Download (resumable), verify, extract the ffmpeg and ffprobe binaries into `dir`. */
export async function downloadBuild(entry: BuildEntry, dir: string, opts: { quiet?: boolean } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const archive = join(dir, 'download.tar.xz');
  const part = archive + '.part';
  const { fetch, EnvHttpProxyAgent } = await import('undici');
  const dispatcher = new EnvHttpProxyAgent();
  const have = (await exists(part)) ? (await stat(part)).size : 0;
  const headers: Record<string, string> = have > 0 && have < entry.size ? { range: `bytes=${have}-` } : {};
  let res;
  try {
    res = await fetch(entry.url, { dispatcher, headers, redirect: 'follow' });
  } catch (e) {
    throw new MglError({ code: 'E_DOWNLOAD', message: `could not download ${entry.url}: ${(e as Error).message}${(e as { cause?: Error }).cause ? ' (' + (e as { cause: Error }).cause.message + ')' : ''}.`, fix: 'check network access (HTTPS_PROXY/NO_PROXY are honoured, extra CAs via NODE_EXTRA_CA_CERTS), or install ffmpeg ≥ 6 yourself and set MGL_FFMPEG.' });
  }
  if (!res.ok || !res.body) fail('E_DOWNLOAD', `download of ${entry.url} failed: HTTP ${res.status}.`, 'retry "mgl doctor --fetch" later, or install ffmpeg ≥ 6 yourself and set MGL_FFMPEG.');
  const append = res.status === 206 && have > 0;
  const out = createWriteStream(part, { flags: append ? 'a' : 'w' });
  let got = append ? have : 0, lastPrint = 0;
  const total = entry.size;
  const progress = (end = false) => {
    if (opts.quiet) return;
    const now = Date.now();
    if (!end && now - lastPrint < 500) return;
    lastPrint = now;
    process.stderr.write(`\rdownloading ffmpeg ${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB${end ? '\n' : ''}`);
  };
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    progress();
  }
  await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  progress(true);
  const sum = await sha256File(part);
  if (sum !== entry.sha256) {
    await rm(part, { force: true });
    fail('E_DOWNLOAD', `checksum mismatch for ${entry.url} (got ${sum.slice(0, 12)}…, expected ${entry.sha256.slice(0, 12)}…); the file was deleted.`, 'retry "mgl doctor --fetch"; if it keeps failing, a proxy may be altering downloads: install ffmpeg ≥ 6 yourself and set MGL_FFMPEG.');
  }
  await rename(part, archive);
  const tmp = join(dir, 'extract');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await run('tar', ['-xJf', archive, '-C', tmp, `${entry.dir}/ffmpeg`, `${entry.dir}/ffprobe`], { what: 'extracting the ffmpeg archive', fix: 'make sure "tar" with xz support is installed, then retry "mgl doctor --fetch".' });
  for (const b of ['ffmpeg', 'ffprobe']) {
    await rename(join(tmp, entry.dir, b), join(dir, b));
    await chmod(join(dir, b), 0o755);
  }
  await rm(tmp, { recursive: true, force: true });
  await rm(archive, { force: true });
  if ((await readdir(dir)).length === 0) fail('E_DOWNLOAD', 'extraction produced no files.', 'retry "mgl doctor --fetch".');
}
