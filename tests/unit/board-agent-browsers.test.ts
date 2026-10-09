/** What the browsers agents drive need from the server and CLI (BOARD.md §8.1): a strict CSP, allow-listed Host names, per-subcommand help. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyProject, formatProject } from '../../src/sdk/index.js';
import { pageCsp, startBoardServer, type BoardServer } from '../../src/board/server/http.js';
import { pageHtml } from '../../src/board/server/assets.js';
import { main } from '../../src/cli/main.js';

let dir: string, srv: BoardServer;

const get = (path: string, host: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> => new Promise((done, failed) => {
  const req = request({ host: '127.0.0.1', port: srv.port, path, headers: { host } }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
  });
  req.on('error', failed);
  req.end();
});

/** directive → sources */
const parse = (csp: string) => Object.fromEntries(csp.split(';').map((x) => x.trim().split(/\s+/)).filter((x) => x[0]).map(([k, ...v]) => [k!, v]));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mgl-board-agents-'));
  const p = emptyProject({ size: [180, 320], fps: 30 });
  writeFileSync(join(dir, 'v.mgl.json'), formatProject(p));
  srv = await startBoardServer({ file: join(dir, 'v.mgl.json'), port: 0, host: '0.0.0.0', allowHost: ['MyHost.test'], quiet: true, handleSignals: false });
}, 30000);
afterAll(async () => { await srv?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('content security policy', () => {
  it('is strict: scripts and requests from the server only, no eval, no plugins, no base or form targets', () => {
    const d = parse(pageCsp());
    expect(d['default-src']).toEqual(["'none'"]);
    expect(d['script-src']).toEqual(["'self'"]);
    expect(d['connect-src']).toEqual(["'self'"]);
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'none'"]);
    expect(pageCsp()).not.toMatch(/unsafe-eval/);
  });
  it('allows framing from loopback and allow-listed names only; junk names are dropped', () => {
    const d = parse(pageCsp(['tunnel.example', 'bad name;script-src *', '[::1]']));
    expect(d['frame-ancestors']).toEqual(["'self'", 'http://127.0.0.1:*', 'https://127.0.0.1:*', 'http://localhost:*', 'https://localhost:*', 'http://tunnel.example:*', 'https://tunnel.example:*']);
    expect(d['script-src']).toEqual(["'self'"]);
  });
  it('is sent with the page; the page itself has no inline script or handler attributes', async () => {
    const r = await get('/', `127.0.0.1:${srv.port}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toBe(pageCsp(['MyHost.test']));
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const html = await pageHtml();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('--host 0.0.0.0 --allow-host', () => {
  it('answers the allow-listed name (any case, with a port) and refuses others, including look-alikes', async () => {
    expect((await get('/api/state', `myhost.test:${srv.port}`)).status).toBe(200);
    expect((await get('/api/state', `MYHOST.TEST:${srv.port}`)).status).toBe(200);
    const page = await get('/', `myhost.test:${srv.port}`);
    expect(page.status).toBe(200);
    expect(parse(String(page.headers['content-security-policy']))['frame-ancestors']).toContain('http://myhost.test:*');
    for (const host of [`evil.test:${srv.port}`, `myhost.test.evil.test:${srv.port}`, `0.0.0.0:${srv.port}`]) {
      const r = await get('/api/state', host);
      expect(r.status, host).toBe(403);
      expect(JSON.parse(r.body).error.code).toBe('E_HOST');
    }
  });
});

describe('help', () => {
  it('mgl board <sub> --help prints that subcommand; mgl board --help the guide', async () => {
    let out = '';
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
    try {
      expect(await main(['board', 'render', '--help'])).toBe(0);
      expect(out).toMatch(/^mgl board render <file> --level 1\.\.4/m);
      expect(out).not.toContain('mgl board: a shared canvas');
      out = '';
      expect(await main(['board', 'export', '--help'])).toBe(0);
      expect(out).toMatch(/^mgl board export <file>/m);
      out = '';
      expect(await main(['board', '--help'])).toBe(0);
      expect(out).toContain('mgl board: a shared canvas');
    } finally { w.mockRestore(); }
  });
});
