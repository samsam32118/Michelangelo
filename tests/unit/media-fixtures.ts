/** Generated media fixtures for the media tests (ffmpeg lavfi; nothing committed). */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RGBAFrame } from '../../src/render/types.js';

export const BITS = 10;

export function tempDir(prefix = 'mgl-media-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

export function ffprobeJson(file: string): { streams: Record<string, any>[]; format: Record<string, any> } {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
}

/** A lavfi source whose frame N shows N in binary as BITS vertical bars (white = 1), bit 0 on the left. */
export function counterSource(w: number, h: number, fps: number | string, seconds: number): string {
  return `color=black:s=${w}x${h}:r=${fps}:d=${seconds},format=gray,geq=lum='if(bitand(N\\,pow(2\\,floor(X*${BITS}/W)))\\,235\\,16)'`;
}

/** Make a counter clip. */
export function makeCounter(out: string, o: { w?: number; h?: number; fps?: number | string; seconds?: number; codec?: string[] } = {}): string {
  ff(['-f', 'lavfi', '-i', counterSource(o.w ?? 320, o.h ?? 180, o.fps ?? 24, o.seconds ?? 3), ...(o.codec ?? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '12', '-bf', '2']), out]);
  return out;
}

/** Read the frame number from a decoded counter frame (bars sampled at mid-height). */
export function readCounter(f: RGBAFrame): number {
  let n = 0;
  const y = Math.floor(f.height / 2);
  for (let b = 0; b < BITS; b++) {
    const x = Math.floor(((b + 0.5) * f.width) / BITS);
    const r = f.data[(y * f.width + x) * 4]!;
    if (r > 128) n |= 1 << b;
  }
  return n;
}
