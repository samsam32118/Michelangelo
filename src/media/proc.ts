/** Subprocess helpers for ffmpeg/ffprobe: collect output, turn failures into MglErrors. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { MglError } from '../core/errors.js';

export interface RunResult { stdout: Buffer; stderr: string; code: number }

export interface RunOptions { input?: Buffer | string; cwd?: string; allowFail?: boolean; what?: string; fix?: string; timeoutMs?: number }

/** Run a program to completion; reject with E_MEDIA (naming the last stderr lines) on a non-zero exit. */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const so: SpawnOptions = { stdio: ['pipe', 'pipe', 'pipe'] };
    if (opts.cwd) so.cwd = opts.cwd;
    let p: ChildProcess;
    try { p = spawn(bin, args, so); } catch (e) { reject(new MglError({ code: 'E_NATIVE', message: `${bin} could not be started: ${(e as Error).message}.`, fix: 'check the path and permissions of the program (mgl doctor).' })); return; }
    const out: Buffer[] = [];
    let err = '';
    p.stdout!.on('data', (d: Buffer) => out.push(d));
    p.stderr!.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 200_000) err = err.slice(-100_000); });
    const timer = opts.timeoutMs ? setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs) : undefined;
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new MglError({ code: 'E_NATIVE', message: `${bin} could not be started: ${e.message}.`, fix: opts.fix ?? `install ${bin.split(/[\\/]/).pop()} or put it on PATH (mgl doctor shows what is missing).` }));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const r = { stdout: Buffer.concat(out), stderr: err, code: code ?? -1 };
      if (r.code !== 0 && !opts.allowFail) reject(procError(bin, args, r.stderr, opts.what, opts.fix));
      else resolve(r);
    });
    p.stdin!.on('error', () => {});
    if (opts.input !== undefined) p.stdin!.end(opts.input);
    else p.stdin!.end();
  });
}

export function procError(bin: string, args: string[], stderr: string, what?: string, fix?: string): MglError {
  const tail = stderr.trim().split('\n').filter((l) => l.trim()).slice(-3).join(' | ');
  const name = bin.split(/[\\/]/).pop();
  return new MglError({
    code: 'E_MEDIA',
    message: `${what ?? name + ' failed'}: ${tail || 'no output'}`,
    fix: fix ?? `check that the input file is a readable media file (mgl show <file> probes it); command: ${name} ${args.slice(0, 12).join(' ')}${args.length > 12 ? ' ...' : ''}`,
  });
}
