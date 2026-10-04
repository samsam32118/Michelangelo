/**
 * Every ```sh and ```js block in SKILL.md and docs/reference/*.md runs here, in order, one temp folder per
 * page: sh blocks with `mgl` = this checkout's CLI, js blocks as ESM with `michelangelo` = this checkout's SDK.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const PAGES = ['SKILL.md', ...readdirSync(join(ROOT, 'docs/reference')).filter((f) => f.endsWith('.md')).sort().map((f) => `docs/reference/${f}`)];

export interface Block { lang: 'sh' | 'js'; code: string; line: number }

export function blocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /^```(\w+)[^\n]*\n([\s\S]*?)^```\s*$/gm;
  for (let m; (m = re.exec(text));) {
    if (m[1] === 'sh' || m[1] === 'js') out.push({ lang: m[1], code: m[2]!, line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mgl-docs-'));
  dirs.push(dir);
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  for (const name of ['mgl', 'michelangelo']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec node --import ${TSX} ${join(ROOT, 'src/cli/main.ts')} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const pkg = join(dir, 'node_modules', 'michelangelo');
  mkdirSync(pkg, { recursive: true });
  symlinkSync(join(ROOT, 'src'), join(pkg, 'src'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'michelangelo', type: 'module', exports: { '.': './src/sdk/index.ts', './plugin': './src/plugin/api.ts', './testing': './src/plugin/testing.ts' } }));
  return dir;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'NODE_OPTIONS' && k !== 'TEST')), PATH: `${join(cwd, '.bin')}:${process.env.PATH}`, MGL_TRUST_STORE: join(cwd, '.trusted.json'), NO_COLOR: '1' };
    const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b: Buffer) => { out += b; });
    p.stderr.on('data', (b: Buffer) => { out += b; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => { clearTimeout(t); done({ code, out }); });
  });
}

describe.concurrent('docs examples run', () => {
  for (const page of PAGES) {
    const list = blocks(readFileSync(join(ROOT, page), 'utf8'));
    if (!list.length) continue;
    it(`${page} (${list.length} blocks)`, async () => {
      const dir = sandbox();
      for (const [i, b] of list.entries()) {
        let r;
        if (b.lang === 'sh') r = await run('bash', ['-e', '-o', 'pipefail', '-c', b.code], dir);
        else {
          const f = join(dir, `block-${i}.mjs`);
          writeFileSync(f, b.code);
          r = await run('node', ['--import', TSX, f], dir);
        }
        expect(r.code, `${page}:${b.line} (${b.lang} block ${i + 1}) failed:\n${b.code}\n--- output ---\n${r.out}`).toBe(0);
      }
    }, 300_000);
  }
});
