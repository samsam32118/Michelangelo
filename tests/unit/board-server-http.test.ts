/** The board server end to end on port 0: ops, undo, SSE from another door, stills (cached), files, discovery. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyProject, formatProject } from '../../src/sdk/index.js';
import { BoardSession } from '../../src/board/model/index.js';
import { findServer, startBoardServer, type BoardServer } from '../../src/board/server/http.js';

let dir: string, srv: BoardServer;
const boardPath = () => join(dir, 'v.board.json');

function tinyProject(d: string): string {
  const p = emptyProject({ size: [180, 320], fps: 30 });
  (p as any).clips = [{ id: 'bg', track: 'V1', at: 0, len: 60, color: '#2040a0' }, { id: 'title', track: 'T1', at: 0, len: 45, text: 'Hello' }];
  const file = join(d, 'v.mgl.json');
  writeFileSync(file, formatProject(p));
  return file;
}

function call(method: string, path: string, body?: unknown): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer; json: any }> {
  return new Promise((done, failed) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(srv.url + path, { method, headers: data ? { 'content-type': 'application/json' } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        let json: unknown;
        try { json = JSON.parse(b.toString('utf8')); } catch { /* not json */ }
        done({ status: res.statusCode ?? 0, headers: res.headers, body: b, json });
      });
    });
    req.on('error', failed);
    req.end(data);
  });
}

/** Collect SSE events until `until` matches one (or timeout). */
function sse(until: (ev: string, data: any) => boolean, ms = 4000): { ready: Promise<void>; done: Promise<{ ev: string; data: any }[]> } {
  let ready!: () => void;
  const readyP = new Promise<void>((r) => { ready = r; });
  const done = new Promise<{ ev: string; data: any }[]>((resolve, reject) => {
    const events: { ev: string; data: any }[] = [];
    const req = get(srv.url + '/api/events', (res) => {
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`timeout; got ${events.map((e) => e.ev).join(',')}`)); }, ms);
      res.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!ev || data === undefined) continue;
          const e = { ev, data: JSON.parse(data) };
          events.push(e);
          if (events.length === 1) ready();
          if (until(e.ev, e.data)) { clearTimeout(timer); req.destroy(); resolve(events); return; }
        }
      });
    });
    req.on('error', () => {});
  });
  return { ready: readyP, done };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mgl-board-srv-'));
  tinyProject(dir);
  srv = await startBoardServer({ file: join(dir, 'v.mgl.json'), port: 0, quiet: true });
});
afterAll(async () => { await srv?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('board server', () => {
  it('serves state with the project outline and writes server.json', async () => {
    const r = await call('GET', '/api/state');
    expect(r.status).toBe(200);
    expect(r.json.board.michelangeloBoard).toBe(1);
    expect(r.json.project.comps[0].id).toBe('main');
    const info = JSON.parse(readFileSync(join(dir, '.mgl/board/server.json'), 'utf8'));
    expect(info.port).toBe(srv.port);
    expect(info.pid).toBe(process.pid);
    expect(await findServer(boardPath())).toEqual({ url: srv.url, port: srv.port });
  });

  it('applies ops, rejects bad ones with code + fix, undoes and redoes', async () => {
    const ok = await call('POST', '/api/ops', { ops: [{ op: 'shape.add', shape: { type: 'note', x: 0, y: 0, text: 'hi' } }], by: 'ai' });
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
    expect(ok.json.created).toHaveLength(1);
    const id = ok.json.created[0];
    const bad = await call('POST', '/api/ops', { ops: [{ op: 'shape.set', id: 'nope', props: { x: 1 } }] });
    expect(bad.status).toBe(400);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error.code).toMatch(/^E_/);
    expect(bad.json.error.fix).toBeTruthy();
    expect((await call('POST', '/api/ops', '{nope')).json.error.code).toBe('E_JSON');
    expect((await call('POST', '/api/ops', { ops: [], by: 'robot' })).status).toBe(400);
    await call('POST', '/api/undo');
    expect((await call('GET', '/api/state')).json.board.shapes ?? []).toEqual([]);
    await call('POST', '/api/redo');
    const st = (await call('GET', '/api/state')).json;
    expect(st.board.shapes.map((s: any) => s.id)).toEqual([id]);
    expect(st.board.shapes[0].by).toBe('ai');
  });

  it('pushes a state event when another door writes the board file', async () => {
    const s = sse((ev, d) => ev === 'state' && (d.board.log ?? []).some((m: any) => m.text === 'from the cli'));
    await s.ready;
    const other = await BoardSession.open(boardPath());
    await other.apply([{ op: 'say', text: 'from the cli' }], 'ai');
    const events = await s.done;
    expect(events[0]!.ev).toBe('state');
    expect(events.at(-1)!.data.board.log.at(-1).by).toBe('ai');
  });

  it('broadcasts view, focus and toast', async () => {
    const s = sse((ev) => ev === 'toast');
    await s.ready;
    expect((await call('POST', '/api/view', { by: 'ai', camera: { x: 1, y: 2, zoom: 1 } })).json.ok).toBe(true);
    expect((await call('POST', '/api/focus', { ids: ['zzz'] })).status).toBe(400);
    const id = (await call('GET', '/api/state')).json.board.shapes[0].id;
    expect((await call('POST', '/api/focus', { ids: [id] })).json.pages).toBeGreaterThan(0);
    await call('POST', '/api/toast', { by: 'ai', text: 'hello' });
    const evs = (await s.done).map((e) => e.ev);
    expect(evs).toEqual(expect.arrayContaining(['view', 'focus', 'toast']));
    expect((await call('GET', '/api/view')).json.ai.camera).toEqual({ x: 1, y: 2, zoom: 1 });
  });

  it('renders a still PNG, caches it, and records spend on a miss only', async () => {
    const before = ((await call('GET', '/api/state')).json.board.spend ?? []).length;
    const a = await call('GET', '/api/still?t=0.5s&w=90');
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toBe('image/png');
    expect(a.body.subarray(1, 4).toString()).toBe('PNG');
    expect(a.headers['x-mgl-cache']).toBe('miss');
    expect(Number(a.headers['x-mgl-cost-ms'])).toBeGreaterThanOrEqual(0);
    const b = await call('GET', '/api/still?t=15&w=90');
    expect(b.headers['x-mgl-cache']).toBe('hit');
    const spend = (await call('GET', '/api/state')).json.board.spend;
    expect(spend.length).toBe(before + 1);
    expect(spend.at(-1).level).toBe(1);
  });

  it('serves files under .mgl/board only, and page modules by strict name', async () => {
    expect((await call('GET', '/files/server.json')).status).toBe(200);
    for (const p of ['/files/../v.mgl.json', '/files/%2e%2e/v.mgl.json', '/files/..%2fv.mgl.json', '/files/%2fetc%2fpasswd', '/files/stills/../../../v.mgl.json']) {
      expect((await call('GET', p)).status, p).toBe(404);
    }
    expect((await call('GET', '/api/image?src=../../etc/passwd')).status).toBe(404);
    expect((await call('GET', '/api/image?src=v.mgl.json')).status).toBe(404);
    expect((await call('GET', '/app/shared/../server/http.js')).status).toBe(404);
    expect((await call('GET', '/app/shared/Types.js')).status).toBe(404);
    const mod = await call('GET', '/app/shared/types.js');
    expect(mod.status).toBe(200);
    expect(mod.body.toString()).toContain('BOARD_FORMAT');
    const shapes = await call('GET', '/app/shared/shapes.js');
    expect(shapes.status).toBe(200);
    expect(shapes.body.toString()).toMatch(/from "\.\/[a-z-]+\.js"/);
    const page = await call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
  });

  it('refuses foreign Host names (DNS rebinding) and cross-site writes', async () => {
    const raw = (method: string, path: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; json: any }>((done, failed) => {
      const req = request(srv.url + path, { method, headers }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => done({ status: res.statusCode ?? 0, json: JSON.parse(b || 'null') })); });
      req.on('error', failed);
      req.end(body);
    });
    const evil = await raw('GET', '/api/state', { host: 'evil.example:80' });
    expect(evil.status).toBe(403);
    expect(evil.json.error.code).toBe('E_HOST');
    const host = new URL(srv.url).host;
    const op = JSON.stringify({ ops: [{ op: 'say', text: 'x' }], by: 'ai' });
    const cross = await raw('POST', '/api/ops', { host, origin: 'http://evil.example', 'content-type': 'text/plain' }, op);
    expect(cross.status).toBe(403);
    expect(cross.json.error.code).toBe('E_ORIGIN');
    expect((await raw('POST', '/api/ops', { host, origin: 'null' }, op)).status).toBe(403);
    const same = await raw('POST', '/api/ops', { host, origin: srv.url, 'content-type': 'application/json' }, op);
    expect(same.status).toBe(200);
    expect((await raw('GET', '/api/state', { host: `localhost:${srv.port}` })).status).toBe(200);
  });
  it('refuses a busy port that was asked for', async () => {
    await expect(startBoardServer({ file: join(dir, 'v.mgl.json'), port: srv.port, quiet: true })).rejects.toMatchObject({ code: 'E_PORT' });
  });

  it('removes server.json on close and findServer then finds nothing', async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'mgl-board-srv2-'));
    try {
      tinyProject(d2);
      const s2 = await startBoardServer({ file: join(d2, 'v.mgl.json'), port: 0, quiet: true });
      expect(existsSync(join(d2, '.mgl/board/server.json'))).toBe(true);
      await s2.close();
      expect(existsSync(join(d2, '.mgl/board/server.json'))).toBe(false);
      expect(await findServer(join(d2, 'v.board.json'))).toBeNull();
    } finally { rmSync(d2, { recursive: true, force: true }); }
  });
});
