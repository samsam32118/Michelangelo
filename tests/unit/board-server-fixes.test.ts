/** Regressions from review round 1: wildcard binds, cross-site GETs, default `by`, 413, HEAD, media-aware still cache, rungs on the board. */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyProject, formatProject } from '../../src/sdk/index.js';
import { BoardSession, advise } from '../../src/board/model/index.js';
import { findServer, startBoardServer, type BoardServer } from '../../src/board/server/http.js';
import { estimateLevel, renderLevel, renderStill } from '../../src/board/server/render.js';

let dir: string, srv: BoardServer;
const boardPath = () => join(dir, 'v.board.json');

function png(file: string, colour: string) {
  const cv = createCanvas(64, 64);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = colour; ctx.fillRect(0, 0, 64, 64);
  writeFileSync(file, cv.toBuffer('image/png'));
}

function call(method: string, path: string, o: { body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer; json: any }> {
  return new Promise((done, failed) => {
    const req = request(srv.url + path, { method, headers: { ...(o.body ? { 'content-type': 'application/json' } : {}), ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); let json: unknown; try { json = JSON.parse(b.toString('utf8')); } catch { /* */ } done({ status: res.statusCode ?? 0, headers: res.headers, body: b, json }); });
    });
    req.on('error', failed);
    req.end(o.body);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mgl-board-fix-'));
  png(join(dir, 'a.png'), '#ff0000');
  const p = emptyProject({ size: [180, 320], fps: 30 });
  (p as any).assets = [{ id: 'a', src: 'a.png', kind: 'image' }];
  (p as any).clips = [{ id: 'img', track: 'V1', at: 0, len: 60, asset: 'a' }];
  writeFileSync(join(dir, 'v.mgl.json'), formatProject(p));
  const v = emptyProject({ size: [180, 320], fps: 30 });
  (v as any).clips = [{ id: 'bg', track: 'V1', at: 0, len: 60, color: '#00ff00' }];
  writeFileSync(join(dir, 'calm.mgl.json'), formatProject(v));
  srv = await startBoardServer({ file: join(dir, 'v.mgl.json'), port: 0, host: '0.0.0.0', quiet: true, handleSignals: false });
}, 30000);
afterAll(async () => { await srv?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('server', () => {
  it('a wildcard bind prints and records a loopback URL the CLI can use', async () => {
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(JSON.parse(readFileSync(join(dir, '.mgl', 'board', 'server.json'), 'utf8')).url).toBe(srv.url);
    expect(await findServer(boardPath())).toMatchObject({ url: srv.url });
  });
  it('refuses cross-site GETs that would render (no CPU, no spend); same-origin works', async () => {
    const evil = await call('GET', '/api/still?t=0.5s&w=170', { headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } });
    expect(evil.status).toBe(403);
    expect(evil.json.error.code).toBe('E_ORIGIN');
    expect((await call('GET', '/api/state', { headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
    expect((await call('GET', '/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })).status).toBe(200);
    const own = await call('GET', '/api/still?t=0.5s&w=8000', { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(own.status).toBe(200);
    expect(own.body.readUInt32BE(16)).toBe(180); // capped at the comp's width
  });
  it('POST /api/ops without "by" is the agent; undo with "by" refuses the other party', async () => {
    const r = await call('POST', '/api/ops', { body: JSON.stringify({ ops: [{ op: 'say', text: 'from a script' }] }) });
    expect(r.json.ok).toBe(true);
    const s = await BoardSession.open(boardPath());
    expect(s.board.log!.at(-1)).toMatchObject({ text: 'from a script', by: 'ai' });
    const u = await call('POST', '/api/undo', { body: JSON.stringify({ by: 'human' }) });
    expect(u.status).toBe(400);
    expect(u.json.error.code).toBe('E_UNDO_OTHER');
  });
  it('answers an over-limit body with 413 before closing', async () => {
    const r = await call('POST', '/api/ops', { body: 'x'.repeat((1 << 20) + 10) });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe('E_TOO_LARGE');
  });
});

describe('ladder', () => {
  it('the still cache key covers the media the project references', async () => {
    const a = await renderStill(join(dir, 'v.mgl.json'), { t: 5, width: 90 });
    png(join(dir, 'a.png'), '#0000ff');
    utimesSync(join(dir, 'a.png'), new Date(), new Date(Date.now() + 5000));
    const b = await renderStill(join(dir, 'v.mgl.json'), { t: 5, width: 90 });
    expect(b.cached).toBe(false);
    expect(b.path).not.toBe(a.path);
  }, 30000);
  it('variant stills render their own project through the same cache and spend', async () => {
    const s = await BoardSession.open(boardPath());
    await s.apply([{ op: 'still.add', t: '0.5s', project: 'calm.mgl.json' }], 'ai');
    const id = s.board.shapes!.at(-1)!.id;
    const r = await renderLevel(boardPath(), { level: 1, ids: [id] });
    expect(r.spend[0]!.what).toContain('variant calm.mgl.json');
    expect((await estimateLevel(boardPath(), { level: 1, ids: [id] })).stills).toBe(1);
    await expect(s.apply([{ op: 'still.add', t: '0.5s', project: '../x.mgl.json' }], 'ai')).rejects.toMatchObject({ code: 'E_SCHEMA' });
    const st = await call('GET', '/api/still?t=0.5s&w=90&project=calm.mgl.json');
    expect(st.status).toBe(200);
  }, 30000);
  it('a draft appears on the board with a poster linked to /files; HEAD works; advice moves on', async () => {
    const r = await renderLevel(boardPath(), { level: 3, range: '0-10' });
    expect(r.shape).toBeTruthy();
    const s = await BoardSession.open(boardPath());
    const shape = s.board.shapes!.find((x) => x.id === r.shape)!;
    expect(shape).toMatchObject({ type: 'image', src: '.mgl/board/renders/draft-1.png', tags: ['render'] });
    expect(shape.label).toContain('/files/renders/draft-1.mp4');
    expect(existsSync(join(dir, '.mgl', 'board', 'renders', 'draft-1.png'))).toBe(true);
    const head = await call('HEAD', '/files/renders/draft-1.mp4');
    expect(head.status).toBe(200);
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
    expect(head.body.length).toBe(0);
    await s.apply([{ op: 'brief.set', goal: 'g', audience: 'a', success: ['s'] }], 'ai');
    expect(advise(s.board, null).some((x) => x.text.startsWith('level 3 (draft) is rendered'))).toBe(true);
  }, 90000);
});
