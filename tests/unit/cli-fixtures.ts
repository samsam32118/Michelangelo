/** Helpers for the CLI tests: run this checkout's CLI in a temp folder; generate media with ffmpeg lavfi. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = resolve(import.meta.dirname, '../..');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const MAIN = join(ROOT, 'src/cli/main.ts');

/** The environment without vitest's markers (the CLI must behave as it does for a user). */
export function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'NODE_OPTIONS' && k !== 'TEST'));
}

export interface CliResult { code: number | null; stdout: string; stderr: string; json: any; lines: string[] }

export function mgl(args: string[], opts: { cwd: string; env?: Record<string, string>; input?: string }): Promise<CliResult> {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['--import', TSX, MAIN, ...args], {
      cwd: opts.cwd,
      env: { ...cleanEnv(), MGL_TRUST_STORE: join(opts.cwd, '.trusted.json'), ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (b: Buffer) => { stdout += b; });
    p.stderr.on('data', (b: Buffer) => { stderr += b; });
    p.stdin.end(opts.input ?? '');
    p.on('close', (code) => {
      let json: unknown;
      if (args.includes('--json')) { try { json = JSON.parse(stdout); } catch { json = undefined; } }
      done({ code, stdout, stderr, json, lines: stdout.split('\n').filter((l, i, a) => l || i < a.length - 1) });
    });
  });
}

export function tempDir(prefix = 'mgl-cli-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function ff(args: string[], cwd: string): void {
  execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

/** A short test clip with sound. */
export function makeClip(cwd: string, out = 'clip.mp4', seconds = 2, size = '320x180'): string {
  ff(['-f', 'lavfi', '-i', `testsrc2=s=${size}:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out], cwd);
  return out;
}
