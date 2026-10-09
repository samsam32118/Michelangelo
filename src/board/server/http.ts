/**
 * `mgl board serve`: a plain node:http server for one board (BOARD.md §6.2). Loopback only unless a host is given.
 * One BoardSession holds the board; every door (page, console, CLI on disk) ends up as an SSE `state` event.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { MglError } from '../../core/errors.js';
import type { BoardFile, BoardOp, BoardState, Outline, Presence, Who } from '../shared/types.js';
import { BoardSession, advise, projectOutline, resolveBoardPath } from '../model/index.js';
import { appModule, pageHtml } from './assets.js';
import { boardCacheDir, contentType, IMAGE_EXT, linkedProject, safeJoin, serverJsonPath } from './paths.js';
import { estimateLevel, recordSpend, renderLevel, renderStill, THUMB_W, variantProject } from './render.js';
import { SseHub } from './sse.js';
import { FileWatch } from './watch.js';

export const DEFAULT_PORT = 4477;
const BODY_LIMIT = 1 << 20;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface ServeOptions { file: string; port?: number; host?: string; quiet?: boolean; /** extra Host names to accept (tunnels, port forwarding) */ allowHost?: string[]; /** false: the caller owns SIGINT / SIGTERM (the CLI exits 0) */ handleSignals?: boolean }
export interface BoardServer { url: string; port: number; close(): Promise<void> }

class HttpError extends Error { constructor(public status: number, public code: string, message: string, public fix: string) { super(message); } }

const isWho = (v: unknown): v is Who => v === 'human' || v === 'ai';
/** the name in a Host header, without port or IPv6 brackets */
const hostName = (h: string): string => (/^\[([^\]]*)\]/.exec(h)?.[1] ?? h.replace(/:\d+$/, '')).toLowerCase();

/**
 * DNS-rebinding and cross-site guard (BOARD.md §8.1): the Host must be loopback, the bound host or allow-listed, and a
 * request that changes something from a browser must come from this server's own origin.
 */
function guard(req: IncomingMessage, allowed: Set<string>, path: string): void {
  const host = req.headers.host ?? '';
  if (!allowed.has(hostName(host))) throw new HttpError(403, 'E_HOST', `requests for host "${host}" are refused (the board only answers its own names).`, `if this is your tunnel or forwarded name: mgl board serve <file> --host 0.0.0.0 --allow-host ${hostName(host) || '<name>'}`);
  // another site's page may not use the board, even by GET: an <img src=/api/still?...> would burn CPU and add spend rows
  const site = req.headers['sec-fetch-site'];
  if ((site === 'cross-site' || site === 'same-site') && !(req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && (path === '/' || path === '/index.html'))) {
    throw new HttpError(403, 'E_ORIGIN', `a ${site} ${req.method} ${path} is refused (only the board page itself may use the board).`, 'open the board at its own URL; agents use the CLI (mgl board ...) or requests without browser fetch headers.');
  }
  const origin = req.headers.origin;
  if (origin === undefined || req.method === 'GET' || req.method === 'HEAD') return;
  let ok = false;
  try { ok = new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { /* "null" or junk */ }
  if (!ok) throw new HttpError(403, 'E_ORIGIN', `a ${req.method} from ${origin} is refused (only the board page itself may change the board).`, 'use the page this server serves, the CLI (mgl board edit) or a request without an Origin header.');
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((done, failed) => {
    const chunks: Buffer[] = [];
    let n = 0, over = false;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > BODY_LIMIT) {
        // stop collecting, answer 413, then drop the connection once the answer is out (destroying first loses it)
        if (!over) { over = true; chunks.length = 0; req.pause(); failed(new HttpError(413, 'E_TOO_LARGE', 'the request body is over 1 MB.', 'send fewer ops per request (batches of a few hundred).')); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return done({});
      try { done(JSON.parse(text)); } catch { failed(new HttpError(400, 'E_JSON', 'the request body is not JSON.', 'send a JSON object, e.g. {"ops": [{"op": "say", "text": "hi"}], "by": "ai"}.')); }
    });
    req.on('error', failed);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof HttpError && e.status === 413) {
    res.setHeader('connection', 'close');
    res.on('finish', () => res.req?.destroy());
  }
  if (e instanceof HttpError) return sendJson(res, e.status, { ok: false, error: { code: e.code, message: e.message, fix: e.fix } });
  if (e instanceof MglError) return sendJson(res, e.kind === 'environment' ? 500 : 400, { ok: false, error: e.toJSON() });
  sendJson(res, 500, { ok: false, error: { code: 'E_INTERNAL', message: (e as Error)?.message ?? String(e), fix: 'this is a bug in the board server; retry, and report it with the request that caused it.' } });
}

function sendFile(res: ServerResponse, file: string, type: string, extra: Record<string, string> = {}, head = false): void {
  res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size, 'cache-control': 'no-cache', 'accept-ranges': 'none', ...extra });
  if (head) return void res.end();
  createReadStream(file).pipe(res);
}

/** Bind, falling forward to the next free port when the default is busy (not when a port was asked for). */
function listen(server: Server, port: number, host: string, fallForward: boolean): Promise<number> {
  return new Promise((done, failed) => {
    let tries = 0;
    const attempt = (p: number) => {
      const onErr = (e: NodeJS.ErrnoException) => {
        server.off('listening', onOk);
        if (e.code === 'EADDRINUSE' && fallForward && tries++ < 20) return attempt(p + 1);
        failed(e.code === 'EADDRINUSE'
          ? new MglError({ code: 'E_PORT', message: `port ${p} is in use.`, fix: `use another port: mgl board serve <file> --port ${p + 1} (or --port 0 for any free port).` })
          : e);
      };
      const onOk = () => { server.off('error', onErr); done((server.address() as { port: number }).port); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, host);
    };
    attempt(port);
  });
}

export async function startBoardServer(opts: ServeOptions): Promise<BoardServer> {
  const host = opts.host ?? '127.0.0.1';
  const log = (s: string) => { if (!opts.quiet) process.stderr.write(s + '\n'); };
  if (opts.host !== undefined && !LOOPBACK.has(host)) process.stderr.write(`warning: the board server listens on ${host}; anyone who can reach it can read and edit the board (no authentication). Use the default (127.0.0.1) unless you need this.\n`);
  const { boardPath, projectPath: given } = resolveBoardPath(opts.file);
  const allowed = new Set(['127.0.0.1', 'localhost', '::1', ...(['0.0.0.0', '::'].includes(host) ? [] : [hostName(host)]), ...(opts.allowHost ?? []).map(hostName)]);
  const session = await BoardSession.open(boardPath);
  const cacheDir = boardCacheDir(boardPath);
  const boardDir = dirname(resolve(boardPath));
  const view: Partial<Record<Who, Presence>> = {};
  const hub = new SseHub();
  let projectPath = linkedProject(boardPath, session.board.project, given);
  let outline: Outline | null = null;
  let projectError: { code: string; message: string; fix: string } | undefined;
  const refreshOutline = async (): Promise<void> => {
    if (!projectPath || !existsSync(projectPath)) { outline = null; projectError = undefined; return; }
    try { outline = await projectOutline(projectPath); projectError = undefined; } catch (e) {
      // keep the last good outline while the project file is mid-edit or invalid
      projectError = e instanceof MglError ? { code: e.code, message: e.message, fix: e.fix } : { code: 'E_PROJECT', message: (e as Error).message, fix: 'fix the project file (mgl check <project>).' };
    }
  };
  await refreshOutline();

  const state = (): BoardState & { projectError?: typeof projectError } => ({ board: session.board, version: session.version, project: outline, view, advice: advise(session.board, outline, view), ...(projectError ? { projectError } : {}) });
  const broadcastState = () => hub.send('state', { board: session.board, version: session.version });
  const watcher = new FileWatch((f) => void onFileChange(f));
  const watchSet = () => watcher.set([boardPath, ...(projectPath ? [projectPath] : [])]);
  /** after the server wrote the board: remember its mtime so the watcher does not echo it back */
  const wrote = () => watcher.mark(boardPath);
  let busy: Promise<unknown> = Promise.resolve();
  /** serialise everything that touches the session */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; };
  const afterBoardChange = async () => {
    const next = linkedProject(boardPath, session.board.project, given);
    if (next !== projectPath) { projectPath = next; watchSet(); await refreshOutline(); hub.send('project', outline); }
  };
  async function onFileChange(f: string): Promise<void> {
    if (f === resolve(boardPath)) {
      await serial(async () => {
        let changed = false;
        try { changed = await session.reload(); } catch (e) { hub.send('toast', { by: 'ai', text: `board file did not load: ${(e as Error).message}` }); return; }
        if (changed) { await afterBoardChange(); broadcastState(); }
      });
    } else if (projectPath && f === resolve(projectPath)) {
      await refreshOutline();
      hub.send('project', projectError ? { ...(outline ?? {}), error: projectError } : outline);
    }
  }
  watchSet();

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://board.local');
    const path = url.pathname, method = req.method ?? 'GET';
    guard(req, allowed, path);
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await pageHtml();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return void res.end(html);
    }
    if (method === 'GET' && path.startsWith('/app/')) {
      const code = await appModule(path);
      if (code === undefined) throw new HttpError(404, 'E_NOT_FOUND', `${path} is not a page module.`, 'page modules are /app/client/<name>.js and /app/shared/<name>.js.');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return void res.end(code);
    }
    if (method === 'GET' && path === '/api/state') return sendJson(res, 200, state());
    if (method === 'GET' && path === '/api/events') {
      return hub.add(res, (send) => { send('state', { board: session.board, version: session.version }); if (outline) send('project', outline); for (const p of Object.values(view)) if (p) send('view', p); });
    }
    if (method === 'POST' && path === '/api/ops') {
      const body = (await readBody(req)) as { ops?: unknown; op?: unknown; by?: unknown };
      const ops = Array.isArray(body.ops) ? body.ops : typeof body.op === 'string' ? [body] : undefined;
      if (!ops) throw new HttpError(400, 'E_OPS', 'the body has no ops.', 'send {"ops": [{"op": "shape.add", "shape": {"type": "note", "x": 0, "y": 0, "text": "hi"}}], "by": "human"}.');
      if (body.by !== undefined && !isWho(body.by)) throw new HttpError(400, 'E_BY', `by "${String(body.by)}" is not human or ai.`, 'send "by": "human" (the page) or "by": "ai" (an agent).');
      const by: Who = isWho(body.by) ? body.by : 'ai'; // the page always sends "by"; scripts and agents default to ai (BOARD.md §5)
      const clean = (ops as Record<string, unknown>[]).map((o) => { if (o && typeof o === 'object' && 'by' in o) { const { by: _b, ...rest } = o; return rest; } return o; });
      const r = await serial(async () => { const r = await session.apply(clean as BoardOp[], by, outline); wrote(); await afterBoardChange(); return r; });
      broadcastState();
      if (by === 'ai') for (const o of clean as BoardOp[]) if (o?.op === 'say') hub.send('toast', { by, text: o.text });
      return sendJson(res, 200, { ok: true, version: r.version, changed: r.changed, created: r.created });
    }
    if (method === 'POST' && (path === '/api/undo' || path === '/api/redo')) {
      const body = (await readBody(req)) as { n?: unknown; by?: unknown; force?: unknown };
      const n = typeof body.n === 'number' && body.n > 0 ? Math.floor(body.n) : 1;
      if (body.by !== undefined && !isWho(body.by)) throw new HttpError(400, 'E_BY', `by "${String(body.by)}" is not human or ai.`, 'send "by": "human" (the page) or "by": "ai" (an agent).');
      // with "by", undo refuses a step the other party made (E_UNDO_OTHER) unless "force": true
      const so = { ...(isWho(body.by) ? { by: body.by } : {}), force: body.force === true };
      const r = await serial(async () => { const r = await (path === '/api/undo' ? session.undo(n, so) : session.redo(n, so)); wrote(); await afterBoardChange(); return r; });
      broadcastState();
      const extra = r && typeof r === 'object' ? (r as object) : {};
      return sendJson(res, 200, { ...extra, ok: true, version: session.version });
    }
    if (path === '/api/view') {
      if (method === 'GET') return sendJson(res, 200, view);
      if (method === 'POST') {
        const b = (await readBody(req)) as Partial<Presence>;
        if (!isWho(b.by)) throw new HttpError(400, 'E_BY', 'presence needs "by": "human" or "ai".', 'send {"by": "ai", "camera": {"x": 0, "y": 0, "zoom": 1}}.');
        const p: Presence = { by: b.by, at: Date.now() };
        for (const k of ['camera', 'selection', 'cursor', 'inView'] as const) if (b[k] !== undefined) (p as unknown as Record<string, unknown>)[k] = b[k];
        view[b.by] = { ...view[b.by], ...p };
        hub.send('view', view[b.by]);
        return sendJson(res, 200, { ok: true, pages: hub.size });
      }
    }
    if (method === 'POST' && path === '/api/focus') {
      const b = (await readBody(req)) as { ids?: unknown };
      if (!Array.isArray(b.ids) || !b.ids.every((x) => typeof x === 'string')) throw new HttpError(400, 'E_IDS', 'focus needs "ids": a list of shape ids.', 'send {"ids": ["s1", "n2"]}.');
      const known = new Set(((session.board as BoardFile).shapes ?? []).map((s) => s.id));
      const unknown = (b.ids as string[]).filter((id) => !known.has(id));
      if (unknown.length) throw new HttpError(400, 'E_BOARD_ID', `"${unknown.join('", "')}" ${unknown.length > 1 ? 'are not shapes' : 'is not a shape'} on the board.`, 'use ids from mgl board show (or GET /api/state).');
      hub.send('focus', { ids: b.ids });
      return sendJson(res, 200, { ok: true, pages: hub.size });
    }
    if (method === 'POST' && path === '/api/toast') {
      const b = (await readBody(req)) as { by?: unknown; text?: unknown };
      if (typeof b.text !== 'string' || !b.text) throw new HttpError(400, 'E_TEXT', 'toast needs "text".', 'send {"by": "ai", "text": "Rendered the stills."}.');
      hub.send('toast', { by: isWho(b.by) ? b.by : 'ai', text: b.text });
      return sendJson(res, 200, { ok: true, pages: hub.size });
    }
    if (method === 'GET' && path === '/api/still') {
      if (!projectPath) throw new HttpError(404, 'E_NO_PROJECT', 'the board has no linked project.', 'open the board through its project: mgl board serve video.mgl.json.');
      const t = url.searchParams.get('t') ?? '0';
      const w = Number(url.searchParams.get('w') ?? THUMB_W);
      if (!(w >= 16 && w <= 8192)) throw new HttpError(400, 'E_WIDTH', `w=${url.searchParams.get('w')} is not a width.`, 'use a width in px between 16 and 8192 (thumb 270).');
      const comp = url.searchParams.get('comp') || undefined;
      const by = url.searchParams.get('by');
      const variant = url.searchParams.get('project') || undefined;
      const proj = variant ? variantProject(boardPath, variant) : projectPath;
      const r = await renderStill(proj, { t: /^\d+$/.test(t) ? Number(t) : t, ...(comp ? { comp } : {}), width: w, cacheDir: resolve(cacheDir, 'stills') });
      if (!r.cached) {
        await serial(async () => { await recordSpend(session, { level: 1, what: `still ${t}${comp ? ` ${comp}` : ''}${variant ? ` ${variant}` : ''} ${r.width}px`, ms: r.ms }, isWho(by) ? by : 'human'); wrote(); });
        broadcastState();
      }
      return sendFile(res, r.path, 'image/png', { 'x-mgl-cost-ms': String(r.ms), 'x-mgl-cache': r.cached ? 'hit' : 'miss', 'x-mgl-frame': String(r.frame) });
    }
    if (method === 'POST' && path === '/api/render') {
      const b = (await readBody(req)) as { level?: unknown; ids?: unknown; range?: unknown; by?: unknown; dryRun?: unknown };
      if (b.ids !== undefined && !(Array.isArray(b.ids) && b.ids.every((x) => typeof x === 'string'))) throw new HttpError(400, 'E_IDS', '"ids" must be a list of still ids.', 'send {"level": 1, "ids": ["s1", "s2"]}.');
      if (b.range !== undefined && typeof b.range !== 'string') throw new HttpError(400, 'E_RANGE', '"range" must be a string like "2s-6s".', 'send {"level": 3, "range": "2s-6s"}.');
      if (b.dryRun === true) {
        const e = await estimateLevel(boardPath, { level: b.level as 1, session, ...(b.ids ? { ids: b.ids as string[] } : {}), ...(b.range ? { range: b.range as string } : {}) });
        return sendJson(res, 200, { ok: true, dryRun: true, files: [], ms: 0, spend: [], estimate: e });
      }
      // the render runs outside the session lock (a draft takes minutes); only its spend rows are serialised
      const record = (e: Parameters<typeof recordSpend>[1], who: Who) => serial(async () => { const x = await recordSpend(session, e, who); wrote(); broadcastState(); return x; });
      const addShape = (shape: Record<string, unknown>, who: Who) => serial(async () => { const x = await session.apply([{ op: 'shape.add', shape: shape as never }], who, outline); wrote(); broadcastState(); return x.created[0] ?? ''; });
      const r = await renderLevel(boardPath, { level: b.level as 1, session, record, addShape, by: isWho(b.by) ? b.by : 'human', ...(b.ids ? { ids: b.ids as string[] } : {}), ...(b.range ? { range: b.range as string } : {}) });
      const files = r.files.map((f) => '/files/' + f.slice(cacheDir.length + 1).split(/[\\/]/).map(encodeURIComponent).join('/'));
      return sendJson(res, 200, { ok: true, files, ms: r.ms, spend: r.spend, ...(r.shape ? { shape: r.shape } : {}), ...(r.summary ? { summary: r.summary } : {}), ...(r.estimate ? { estimate: { seconds: r.estimate.seconds, note: r.estimate.note } } : {}) });
    }
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/files/')) {
      let rel: string;
      try { rel = decodeURIComponent(path.slice('/files/'.length)); } catch { rel = ''; }
      const abs = safeJoin(cacheDir, rel);
      const type = abs && contentType(abs);
      if (!abs || !type || !['.png', '.mp4', '.json'].includes(extname(abs).toLowerCase()) || !existsSync(abs) || !statSync(abs).isFile()) {
        throw new HttpError(404, 'E_NOT_FOUND', `${path} is not a board file.`, 'files are served from .mgl/board/ only (stills, sheets, renders, snapshot): png, mp4 or json.');
      }
      return sendFile(res, abs, type, {}, method === 'HEAD');
    }
    if (method === 'GET' && path === '/api/image') {
      const src = url.searchParams.get('src') ?? '';
      const abs = safeJoin(boardDir, src);
      if (!abs || !IMAGE_EXT.has(extname(abs).toLowerCase()) || !existsSync(abs) || !statSync(abs).isFile()) {
        throw new HttpError(404, 'E_NOT_FOUND', `image "${src}" is not an image under the board's folder.`, 'image shapes take a png/jpg/webp/gif path relative to the board file, inside its folder.');
      }
      return sendFile(res, abs, contentType(abs)!);
    }
    if (path.startsWith('/api/') || path.startsWith('/files/')) throw new HttpError(path.startsWith('/api/') && ['GET', 'POST'].includes(method) ? 404 : 405, 'E_NOT_FOUND', `${method} ${path} is not a board route.`, 'routes: GET /api/state, POST /api/ops, POST /api/undo|redo, GET /api/events, GET|POST /api/view, POST /api/focus, POST /api/toast, GET /api/still, POST /api/render, GET /files/<path>.');
    throw new HttpError(404, 'E_NOT_FOUND', `${path} is not here.`, 'open / for the board.');
  };

  const server = createServer((req, res) => {
    route(req, res).catch((e) => { if (res.headersSent) res.end(); else sendError(res, e); });
  });
  server.keepAliveTimeout = 5000;
  const explicit = opts.port !== undefined;
  let port: number;
  try { port = await listen(server, opts.port ?? DEFAULT_PORT, host, !explicit); } catch (e) { watcher.close(); hub.close(); throw e; }
  // a wildcard bind is not an address to open: point the URL (and server.json, which the CLI uses) at loopback
  const wildcard = host === '0.0.0.0' || host === '::' || host === '[::]';
  const shown = wildcard ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `http://${shown}:${port}`;
  mkdirSync(cacheDir, { recursive: true });
  const infoFile = serverJsonPath(boardPath);
  writeFileSync(infoFile, JSON.stringify({ port, pid: process.pid, url, boardPath: resolve(boardPath) }) + '\n');
  log(`board: ${url}  (${boardPath})${wildcard ? `; listening on all interfaces: from another machine use this machine's name or your tunnel's, allowed with --allow-host` : ''}`);

  let closing: Promise<void> | undefined;
  const onSignal = () => { void close().then(() => process.exit(130)); };
  const close = (): Promise<void> => closing ??= (async () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    watcher.close();
    hub.close();
    try { const j = JSON.parse(readFileSync(infoFile, 'utf8')) as { pid?: number; port?: number }; if (j.pid === process.pid && j.port === port) rmSync(infoFile, { force: true }); } catch { /* already gone */ }
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    await busy;
  })();
  if (opts.handleSignals !== false) { process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); }
  return { url, port, close };
}

/** The server running for this board (from .mgl/board/server.json), if it is alive and serves this board. */
export async function findServer(boardPath: string): Promise<{ url: string; port: number } | null> {
  const file = serverJsonPath(boardPath);
  let info: { url?: string; port?: number; pid?: number; boardPath?: string };
  try { info = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!info.url || !info.port || (info.boardPath && resolve(info.boardPath) !== resolve(boardPath))) return null;
  if (info.pid) { try { process.kill(info.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return null; } }
  const ok = await new Promise<boolean>((done) => {
    const req = httpRequest(`${info.url}/api/view`, { method: 'GET', timeout: 1000 }, (res) => { res.resume(); done(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
    req.end();
  });
  return ok ? { url: info.url, port: info.port } : null;
}
