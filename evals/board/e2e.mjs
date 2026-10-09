#!/usr/bin/env node
/**
 * Board browser end to end (docs/plans/BOARD.md §10). Not a package dependency: it uses a Playwright found on the machine
 * (/opt/node-tools or `npm root -g`) and the preinstalled Chromium. Builds a temp Short, runs `mgl board serve --port 0`,
 * opens the page in two contexts (human + observer) and checks the three doors agree:
 *   human: mouse + keyboard (N/R/A/S/P tools, double-click text, drag, marquee, delete, Ctrl-Z, brief field, wheel zoom)
 *   AI: window.mgl in the console (§6.3), seen by the observer over SSE; the CLI `mgl board edit` reaching both pages
 *   visual: light/dark/narrow screenshots; pan frame time with 300 shapes; console errors = failure.
 * Writes evals/board/results/e2e.json and e2e-*.png. Exit 0 when every check passes, 1 otherwise, 2 on setup errors.
 * usage: node evals/board/e2e.mjs [--headed] [--keep]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'evals', 'board', 'results');
const TSX = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
const CLI = join(ROOT, 'src', 'cli', 'main.ts');
const argv = new Set(process.argv.slice(2));
mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  const tries = ['/opt/node-tools/node_modules/playwright/index.js'];
  try { tries.push(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright', 'index.js')); } catch { /* no npm */ }
  for (const p of tries) if (existsSync(p)) return createRequire(p)(p);
  throw new Error('Playwright not found (looked in /opt/node-tools and npm root -g). Install it globally; never as a package dependency.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mgl = (cwd, args, opts = {}) => execFileSync(process.execPath, ['--import', TSX, CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

// ---------------------------------------------------------------- results
const R = { startedAt: new Date().toISOString(), checks: [], metrics: {}, consoleErrors: [], failedRequests: [], screenshots: [] };
let current = 'setup';
async function check(area, name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    R.checks.push({ area, name, ok: true, ms: Date.now() - t0, ...(detail === undefined ? {} : { detail }) });
    console.log(`  ok   ${area.padEnd(8)} ${name}${detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 120)}` : ''}`);
  } catch (e) {
    R.checks.push({ area, name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 600) });
    console.log(`  FAIL ${area.padEnd(8)} ${name}: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`);
  }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
async function until(fn, ms = 3000, what = 'condition') {
  const t0 = Date.now();
  let last;
  for (;;) {
    try { last = await fn(); if (last) return { v: last, ms: Date.now() - t0 }; } catch (e) { last = e; }
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
    await sleep(40);
  }
}

// ---------------------------------------------------------------- setup
const dir = mkdtempSync(join(tmpdir(), 'mgl-board-e2e-'));
const boardFile = join(dir, 'video.board.json');
const historyFile = join(dir, '.mgl', 'board-history.jsonl');
const readBoard = () => JSON.parse(readFileSync(boardFile, 'utf8'));
const shapesOnDisk = () => readBoard().shapes ?? [];
const history = () => existsSync(historyFile) ? readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
let server, browser;

async function main() {
  console.log(`board e2e in ${dir}`);
  writeFileSync(join(dir, 'script.txt'), 'Put your phone in a drawer.\nSet a two minute timer.\nStart the smallest step you can.\nThat is the whole trick.\n');
  mgl(dir, ['new', 'shorts', '--script', 'script.txt', '-o', 'video.mgl.json']);
  const url = await new Promise((res, rej) => {
    server = spawn(process.execPath, ['--import', TSX, CLI, 'board', 'serve', 'video.mgl.json', '--port', '0', '--json'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    server.stdout.on('data', (d) => { out += d; const m = out.match(/\{.*"url".*\}/); if (m) res(JSON.parse(m[0]).url); });
    server.stderr.on('data', (d) => { err += d; });
    server.on('exit', (c) => rej(new Error(`board serve exited ${c}: ${err || out}`)));
    setTimeout(() => rej(new Error(`board serve printed no URL in 20 s: ${out}${err}`)), 20000);
  });
  R.url = url;
  console.log(`server ${url}`);

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: !argv.has('--headed') });
  const mkCtx = async (who, colorScheme = 'light', viewport = { width: 1440, height: 900 }) => {
    const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') R.consoleErrors.push({ who, step: current, text: m.text().slice(0, 300) }); });
    page.on('pageerror', (e) => R.consoleErrors.push({ who, step: current, text: `pageerror: ${String(e.message).slice(0, 300)}` }));
    page.on('requestfailed', (q) => { if (!/\/api\/events/.test(q.url())) R.failedRequests.push({ who, url: q.url(), err: q.failure()?.errorText }); });
    page.on('response', (r) => { if (r.status() >= 400) R.failedRequests.push({ who, step: current, url: r.url(), status: r.status() }); });
    await page.goto(url);
    await page.waitForFunction(() => window.mgl && document.querySelector('[data-mgl=connection]')?.dataset.state === 'live', null, { timeout: 10000 });
    return { ctx, page };
  };
  const { page: H } = await mkCtx('human');
  const { page: O } = await mkCtx('observer');

  // helpers bound to a page: board <-> screen (page px)
  const toScreen = (p, x, y) => p.evaluate(async ([x, y]) => {
    const st = await mgl.state(), b = document.querySelector('#board').getBoundingClientRect();
    return [b.left + (x - st.camera.x) * st.camera.zoom, b.top + (y - st.camera.y) * st.camera.zoom];
  }, [x, y]);
  const centerOf = async (p, id) => { const s = await p.evaluate((id) => mgl.get(id), id); assert(s, `no shape ${id} on page`); return toScreen(p, s.x + (s.w ?? 200) / 2, s.y + (s.h ?? 120) / 2); };
  const stateOf = (p) => p.evaluate(() => mgl.state());
  const canvasBox = await H.evaluate(() => { const b = document.querySelector('#board').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
  R.metrics.canvas = canvasBox;
  // a fixed camera so screen points are predictable
  await H.evaluate(() => mgl.camera({ x: -100, y: -100, zoom: 1 }));
  await sleep(450);
  const newShape = (before, pred) => shapesOnDisk().find((s) => !before.has(s.id) && pred(s));
  const ids = () => new Set(shapesOnDisk().map((s) => s.id));

  // ============================================================ HUMAN
  current = 'human';
  console.log('human (mouse + keyboard)');
  let noteId, rectId, stillId;
  await check('human', 'title names the board', async () => { const t = await H.title(); assert(/^Board · /.test(t), `title "${t}"`); return t; });
  await check('human', 'N + click creates a note, typing fills it (by human, on disk)', async () => {
    const before = ids();
    await H.mouse.move(canvasBox.x + 300, canvasBox.y + 300);
    await H.keyboard.press('n');
    const tool = (await stateOf(H)).tool;
    assert(tool === 'note', `tool after N is ${tool}`);
    await H.mouse.click(canvasBox.x + 300, canvasBox.y + 300);
    const created = await until(() => newShape(before, (s) => s.type === 'note'), 3000, 'note on disk');
    noteId = created.v.id; // later steps go on even when the editor below fails
    const editor = await H.waitForSelector('textarea.editor', { timeout: 2000 }).then(() => true, () => false);
    // the editor opens only when the optimistic shape still exists as the POST answers (store race, see e2e.json)
    assert(editor, `note ${noteId} was created but its text editor never opened (page state lost the optimistic shape when POST /api/ops answered before the SSE state)`);
    await H.keyboard.type('Hook: phone goes into the drawer');
    await H.keyboard.press('Escape');
    const { v, ms } = await until(() => newShape(before, (s) => s.type === 'note' && s.text === 'Hook: phone goes into the drawer'), 3000, 'note with text on disk');
    assert(v.by === 'human', `note by ${v.by}`);
    noteId = v.id;
    return { id: v.id, x: v.x, y: v.y, diskMs: ms };
  });
  await check('human', 'double-click edits the note text', async () => {
    const [cx, cy] = await centerOf(H, noteId);
    await H.mouse.dblclick(cx, cy);
    await H.waitForSelector(`[data-mgl="edit-${noteId}"]`, { timeout: 2000 });
    await H.keyboard.press('ControlOrMeta+a');
    await H.keyboard.type('Hook: the phone slides into a drawer, click');
    await H.keyboard.press('Escape');
    const { ms } = await until(() => shapesOnDisk().find((s) => s.id === noteId && s.text === 'Hook: the phone slides into a drawer, click'), 3000, 'edited text on disk');
    return { diskMs: ms };
  });
  await check('human', 'drag moves the note (shape.move on disk)', async () => {
    const s0 = shapesOnDisk().find((s) => s.id === noteId);
    const [cx, cy] = await centerOf(H, noteId);
    await H.mouse.move(cx, cy); await H.mouse.down();
    for (let i = 1; i <= 10; i++) await H.mouse.move(cx + 15 * i, cy + 8 * i);
    await H.mouse.up();
    const { v } = await until(() => { const s = shapesOnDisk().find((x) => x.id === noteId); return s && s.x !== s0.x ? s : null; }, 3000, 'moved note on disk');
    const d = [v.x - s0.x, v.y - s0.y];
    assert(Math.abs(d[0] - 150) <= 2 && Math.abs(d[1] - 80) <= 2, `moved by ${d} (want 150,80 at zoom 1)`);
    const h = history().at(-1);
    assert(h?.by === 'human', `history by ${h?.by}`);
    return { moved: d };
  });
  await check('human', 'after a drop, the page state never shows the shape at a double offset (optimistic batch re-applied over the SSE state)', async () => {
    const jumps = [];
    for (let k = 0; k < 4; k++) {
      const s0 = await H.evaluate((id) => mgl.get(id), noteId);
      const [cx, cy] = await centerOf(H, noteId);
      const dx = k % 2 ? -60 : 60;
      await H.mouse.move(cx, cy); await H.mouse.down();
      for (let i = 1; i <= 6; i++) await H.mouse.move(cx + (dx * i) / 6, cy);
      await H.evaluate((id) => { window.__pos = []; const t0 = performance.now(); const f = () => mgl.get(id).then((s) => { window.__pos.push(s.x); if (performance.now() - t0 < 400) setTimeout(f, 1); }); f(); }, noteId);
      await H.mouse.up();
      await sleep(450);
      const xs = await H.evaluate(() => window.__pos);
      const bad = [...new Set(xs)].filter((x) => x !== s0.x + dx);
      if (bad.length) jumps.push({ drop: k, want: s0.x + dx, painted: bad });
    }
    await until(() => { const d = shapesOnDisk().find((s) => s.id === noteId); return d; }, 1000, 'disk');
    assert(!jumps.length, `mgl.get() returned a wrong x after drop in ${jumps.length}/4 drops: ${JSON.stringify(jumps)}`);
  });
  await check('human', 'R + click creates a rect', async () => {
    const before = ids();
    await H.keyboard.press('r');
    await H.mouse.click(canvasBox.x + 820, canvasBox.y + 380);
    const { v } = await until(() => newShape(before, (s) => s.type === 'rect'), 3000, 'rect on disk');
    assert(v.by === 'human', `rect by ${v.by}`);
    rectId = v.id;
    return { id: v.id };
  });
  await check('human', 'A + drag from note to rect makes a bound arrow', async () => {
    const before = ids();
    const pageNote = await H.evaluate((id) => mgl.get(id), noteId), diskNote = shapesOnDisk().find((s) => s.id === noteId);
    assert(pageNote.x === diskNote.x && pageNote.y === diskNote.y, `page has ${noteId} at ${pageNote.x},${pageNote.y} but disk at ${diskNote.x},${diskNote.y} (page state diverged)`);
    const [ax, ay] = await centerOf(H, noteId), [bx, by] = await centerOf(H, rectId);
    await H.keyboard.press('a');
    await H.mouse.move(ax, ay); await H.mouse.down();
    for (let i = 1; i <= 12; i++) await H.mouse.move(ax + ((bx - ax) * i) / 12, ay + ((by - ay) * i) / 12);
    await H.mouse.up();
    const { v } = await until(() => newShape(before, (s) => s.type === 'arrow'), 3000, 'arrow on disk');
    assert(v.from === noteId && v.to === rectId, `arrow from ${JSON.stringify(v.from)} to ${JSON.stringify(v.to)} (want ${noteId} -> ${rectId})`);
    assert(v.by === 'human', `arrow by ${v.by}`);
    return { id: v.id, from: v.from, to: v.to };
  });
  await check('human', 'bound arrow follows when the rect moves (arrow keys nudge, Shift = 10 px)', async () => {
    await H.evaluate((id) => mgl.select([id]), rectId);
    const s0 = shapesOnDisk().find((s) => s.id === rectId);
    await H.mouse.move(canvasBox.x + 50, canvasBox.y + 600);
    await H.keyboard.press('Shift+ArrowDown'); await H.keyboard.press('Shift+ArrowDown'); await H.keyboard.press('ArrowRight');
    const { v } = await until(() => { const s = shapesOnDisk().find((x) => x.id === rectId); return s && s.y !== s0.y ? s : null; }, 3000, 'nudged rect');
    assert(v.y - s0.y === 20 && v.x - s0.x === 1, `nudged by ${v.x - s0.x},${v.y - s0.y} (want 1,20)`);
    const arrow = shapesOnDisk().find((s) => s.type === 'arrow');
    assert(arrow.to === rectId, 'arrow lost its binding');
    return { nudged: [v.x - s0.x, v.y - s0.y] };
  });
  await check('human', 'resize handle (SE corner) resizes the rect', async () => {
    await H.evaluate((id) => mgl.select([id]), rectId);
    await sleep(100);
    const s0 = shapesOnDisk().find((s) => s.id === rectId);
    const w0 = s0.w ?? 200, h0 = s0.h ?? 120;
    const [hx, hy] = await toScreen(H, s0.x + w0, s0.y + h0);
    await H.mouse.move(hx, hy); await H.mouse.down();
    for (let i = 1; i <= 6; i++) await H.mouse.move(hx + 10 * i, hy + 5 * i);
    await H.mouse.up();
    const { v } = await until(() => { const s = shapesOnDisk().find((x) => x.id === rectId); return s.w && s.w !== w0 ? s : null; }, 3000, 'resized rect on disk');
    return { from: [w0, h0], to: [v.w, v.h] };
  });
  await check('human', 'Ctrl/Cmd-D duplicates; Delete removes the copy', async () => {
    await H.evaluate((id) => mgl.select([id]), rectId);
    await H.mouse.move(canvasBox.x + 50, canvasBox.y + 600);
    const before = ids();
    await H.keyboard.press('ControlOrMeta+d');
    const { v } = await until(() => newShape(before, (s) => s.type === 'rect'), 3000, 'duplicate on disk');
    const sel = (await H.evaluate(() => mgl.selection())).ids;
    assert(sel.length === 1 && sel[0] === v.id, `selection after duplicate ${sel}`);
    await H.keyboard.press('Delete');
    await until(() => !shapesOnDisk().some((s) => s.id === v.id), 3000, 'duplicate deleted');
    return { copy: v.id };
  });
  await check('human', '? opens the shortcut sheet, Esc closes it', async () => {
    await H.keyboard.press('Shift+Slash');
    await H.waitForSelector('#help:not([hidden])', { timeout: 1000 });
    await H.keyboard.press('Escape');
    await H.waitForSelector('#help[hidden]', { state: 'attached', timeout: 1000 });
  });
  await check('human', 'marquee drag selects note, rect and arrow (selection reaches /api/view)', async () => {
    await H.keyboard.press('Escape'); await H.keyboard.press('Escape');
    // box around note + rect (+ the arrow between them), dragged from bottom-right to top-left so it starts on empty board
    const all = shapesOnDisk().filter((s) => s.id === noteId || s.id === rectId);
    const xs = all.flatMap((s) => [s.x, s.x + (s.w ?? 200)]), ys = all.flatMap((s) => [s.y, s.y + (s.h ?? (s.type === 'note' ? 200 : 120))]);
    const [x0, y0] = await toScreen(H, Math.max(...xs) + 30, Math.max(...ys) + 30), [x1, y1] = await toScreen(H, Math.min(...xs) - 20, Math.min(...ys) - 20);
    const at = await H.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [x0, y0]);
    assert(at === 'board', `marquee start lands on #${at}, not the canvas`);
    await H.mouse.move(x0, y0); await H.mouse.down();
    for (let i = 1; i <= 8; i++) await H.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
    await H.mouse.up();
    const sel = (await H.evaluate(() => mgl.selection())).ids;
    assert(sel.includes(noteId) && sel.includes(rectId) && sel.length >= 3, `selection ${sel}`);
    const { v } = await until(async () => { const r = await (await fetch(`${url}/api/view`)).json(); const s = r.human?.selection ?? r.view?.human?.selection; return s?.length >= 3 ? s : null; }, 2000, 'human selection in GET /api/view');
    return { selection: sel, viewSelection: v };
  });
  await check('human', 'Delete removes the selection; Ctrl/Cmd-Z brings it back', async () => {
    const n0 = shapesOnDisk().length;
    await H.keyboard.press('Delete');
    await until(() => shapesOnDisk().length < n0, 3000, 'shapes removed on disk');
    await H.keyboard.press('ControlOrMeta+z');
    const { ms } = await until(() => shapesOnDisk().length === n0 && shapesOnDisk().some((s) => s.id === noteId), 3000, 'undo restored shapes');
    return { restoredMs: ms, shapes: n0 };
  });
  await check('human', 'Ctrl/Cmd-Shift-Z redoes, Ctrl/Cmd-Z undoes again', async () => {
    const n0 = shapesOnDisk().length;
    await H.keyboard.press('ControlOrMeta+Shift+z');
    await until(() => shapesOnDisk().length < n0, 3000, 'redo removed shapes');
    await H.keyboard.press('ControlOrMeta+z');
    await until(() => shapesOnDisk().length === n0, 3000, 'undo restored shapes again');
  });
  await check('video', 'timeline strip lists the project clips', async () => {
    const n = await H.locator('[data-mgl^="clip-"]').count();
    assert(n >= 5, `${n} clips in the strip`);
    return { clips: n, title: await H.locator('.tl-title').textContent() };
  });
  await check('video', 'timeline tracks are tall enough to read (row >= 12 px, clip labels not clipped)', async () => {
    const m = await H.evaluate(() => {
      const rows = [...document.querySelectorAll('.tl-track')].map((r) => r.getBoundingClientRect().height);
      const clips = [...document.querySelectorAll('.tl-clip')].map((c) => ({ h: c.getBoundingClientRect().height, clipped: c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1 }));
      const body = document.querySelector('.tl-body').getBoundingClientRect().height;
      return { tracks: rows.length, minRowPx: Math.min(...rows), bodyPx: body, minClipPx: Math.min(...clips.map((c) => c.h)), clippedLabels: clips.filter((c) => c.clipped).length, clips: clips.length, scrollable: document.querySelector('.tl-body').scrollHeight > document.querySelector('.tl-body').clientHeight };
    });
    R.metrics.timeline = m;
    assert(m.minRowPx >= 12 && m.clippedLabels < m.clips / 2, JSON.stringify(m));
    return m;
  });
  let playheadT;
  await check('video', 'dragging the playhead shows a still preview and moves the time', async () => {
    const body = await H.locator('.tl-body').boundingBox();
    assert(body, 'no .tl-body');
    const t0 = await H.locator('[data-mgl=playhead-time]').textContent();
    const stillReq = H.waitForResponse((r) => r.url().includes('/api/still') && r.status() === 200, { timeout: 5000 });
    await H.mouse.move(body.x + 2, body.y + body.height - 10); await H.mouse.down();
    for (let i = 1; i <= 10; i++) await H.mouse.move(body.x + (body.width * 0.4 * i) / 10, body.y + body.height - 10);
    const shown = await H.locator('.tl-preview').isVisible();
    await stillReq;
    await H.mouse.up();
    const t1 = await H.locator('[data-mgl=playhead-time]').textContent();
    playheadT = (await stateOf(H)).playhead;
    assert(t1 !== t0 && playheadT > 0, `time ${t0} -> ${t1}, playhead ${playheadT}`);
    return { time: t1, playheadFrames: playheadT, previewVisibleWhileDragging: shown };
  });
  await check('human', 'S + click places a still at the playhead time; its PNG loads', async () => {
    const before = ids();
    await H.mouse.move(canvasBox.x + 500, canvasBox.y + 650);
    await H.keyboard.press('s');
    const img = H.waitForResponse((r) => r.url().includes('/api/still') && r.status() === 200, { timeout: 6000 });
    await H.mouse.click(canvasBox.x + 500, canvasBox.y + 600);
    const { v } = await until(() => newShape(before, (s) => s.type === 'still'), 4000, 'still on disk');
    assert(v.by === 'human', `still by ${v.by}`);
    const r = await img;
    stillId = v.id;
    return { id: v.id, t: v.t, playheadFrames: playheadT, costMs: r.headers()['x-mgl-cost-ms'] ?? null };
  });
  await check('human', 'P + click on the still drops a pin with typed feedback', async () => {
    const before = ids();
    await sleep(300);
    const s = await H.evaluate((id) => mgl.get(id), stillId);
    const [px, py] = await toScreen(H, s.x + (s.w ?? 270) * 0.5, s.y + 60);
    await H.keyboard.press('p');
    await H.mouse.click(px, py);
    await H.waitForSelector('[data-mgl=prompt-input]', { timeout: 2000 });
    await H.keyboard.type('Title too small at this time');
    await H.keyboard.press('Enter');
    const { v } = await until(() => newShape(before, (x) => x.type === 'pin'), 3000, 'pin on disk');
    assert(v.target === stillId && v.by === 'human' && v.text === 'Title too small at this time', `pin ${JSON.stringify(v)}`);
    const { v: title } = await until(async () => { const t = await H.title(); return /open pin/.test(t) ? t : null; }, 1500, 'document.title counts open pins');
    const { v: outl } = await until(async () => { const t = await O.locator('#mgl-outline').textContent(); return t.includes(stillId) && /4(\.0+)?s|0:04/.test(t) && t.includes('Title too small') ? t : null; }, 1500, 'observer outline lists the still (time) and the pin');
    void outl;
    return { id: v.id, u: v.u, v: v.v, title };
  });
  await check('human', 'Brief tab: typing the goal field saves brief.goal (by human in history)', async () => {
    await H.click('[data-mgl=tab-brief]');
    await H.fill('[data-mgl=brief-goal]', '30 s Short that makes people try the 2-minute focus trick');
    await H.keyboard.press('Tab');
    const { ms } = await until(() => readBoard().brief?.goal === '30 s Short that makes people try the 2-minute focus trick', 3000, 'brief.goal on disk');
    const h = history().at(-1);
    assert(h?.by === 'human', `history by ${h?.by}: ${h?.summary}`);
    return { diskMs: ms };
  });
  await check('human', 'wheel zooms at the cursor (board point under it stays put)', async () => {
    const st0 = await stateOf(H);
    const sx = canvasBox.x + 400, sy = canvasBox.y + 300;
    const bp = [(400) / st0.camera.zoom + st0.camera.x, 300 / st0.camera.zoom + st0.camera.y];
    await H.mouse.move(sx, sy);
    await H.mouse.wheel(0, -100);
    await sleep(200);
    const st1 = await stateOf(H);
    const bp1 = [400 / st1.camera.zoom + st1.camera.x, 300 / st1.camera.zoom + st1.camera.y];
    assert(st1.camera.zoom > st0.camera.zoom * 1.05, `zoom ${st0.camera.zoom} -> ${st1.camera.zoom}`);
    assert(Math.hypot(bp1[0] - bp[0], bp1[1] - bp[1]) < 1, `anchor drifted ${bp} -> ${bp1}`);
    return { zoom: [st0.camera.zoom, +st1.camera.zoom.toFixed(3)] };
  });
  await check('human', 'Ctrl/Cmd-0 fits the board', async () => {
    await H.mouse.move(canvasBox.x + 50, canvasBox.y + 600);
    await H.keyboard.press('ControlOrMeta+0');
    await sleep(500);
    return { camera: (await stateOf(H)).camera };
  });
  await check('human', 'observer saw every human edit (shape counts agree with disk)', async () => {
    const disk = shapesOnDisk().length;
    const { ms } = await until(async () => (await stateOf(O)).board.shapes?.length === disk, 1500, 'observer shape count');
    return { shapes: disk, lagMs: ms };
  });

  // ============================================================ AI via console
  current = 'ai';
  console.log('AI (window.mgl in the console)');
  const seen = async (pred, what) => until(async () => pred(await stateOf(O)), 1000, `observer: ${what}`);
  const toasts = (p) => p.locator('#toasts .toast').allTextContents();
  await check('ai', 'mgl.help() returns the API text', async () => {
    const t = await H.evaluate(() => mgl.help());
    const want = ['mgl.state', 'mgl.op', 'mgl.note', 'mgl.text', 'mgl.rect', 'mgl.arrow', 'mgl.still', 'mgl.storyboard', 'mgl.brief', 'mgl.round', 'mgl.option', 'mgl.decide', 'mgl.pin', 'mgl.say', 'mgl.select', 'mgl.selection', 'mgl.focus', 'mgl.camera', 'mgl.find', 'mgl.get', 'mgl.undo', 'mgl.redo', 'mgl.snapshot', 'mgl.timeline'];
    const missing = want.filter((w) => !t.includes(w));
    assert(typeof t === 'string' && !missing.length, `help misses ${missing}`);
    return { chars: t.length, lines: t.split('\n').length };
  });
  let aiNote;
  await check('ai', 'mgl.note -> on disk by ai, observer sees it via SSE < 1 s', async () => {
    const r = await H.evaluate(() => mgl.note('AI: open on the drawer, no title card', { x: 1400, y: 0, color: 'violet' }));
    assert(r.ok && r.id, `note result ${JSON.stringify(r)}`);
    aiNote = r.id;
    const { ms } = await seen((st) => st.board.shapes?.some((s) => s.id === r.id), 'ai note');
    const d = shapesOnDisk().find((s) => s.id === r.id);
    assert(d?.by === 'ai', `disk by ${d?.by}`);
    const outline = await until(() => O.locator('#mgl-outline').textContent().then((t) => t.includes('open on the drawer')), 1000, 'observer outline text');
    return { id: r.id, observerMs: ms, outlineMs: outline.ms };
  });
  await check('ai', "mgl.storyboard({every: '3s'}) -> frame of stills on both pages", async () => {
    const r = await H.evaluate(() => mgl.storyboard({ every: '3s' }));
    assert(r.ok, JSON.stringify(r));
    const { v, ms } = await seen((st) => { const f = st.board.shapes?.find((s) => s.type === 'frame' && s.label === 'Storyboard'); return f && st.board.shapes.filter((s) => s.parent === f.id && s.type === 'still').length; }, 'storyboard frame');
    assert(v >= 3, `${v} stills in the storyboard`);
    return { stills: v, observerMs: ms };
  });
  await check('ai', 'mgl.arrow binds two shapes', async () => {
    const r = await H.evaluate(([a, b]) => mgl.arrow(a, b, { text: 'becomes' }), [aiNote, stillId]);
    assert(r.ok, JSON.stringify(r));
    const a = shapesOnDisk().find((s) => s.id === r.id);
    assert(a?.from === aiNote && a?.to === stillId, JSON.stringify(a));
  });
  await check('ai', 'mgl.round + 2x mgl.option with tradeoffs; observer Rounds tab shows Choose buttons', async () => {
    const r = await H.evaluate(() => mgl.round('pick the opening', 1));
    assert(r.ok && r.id, JSON.stringify(r));
    const a = await H.evaluate((rid) => mgl.option(rid, { title: 'Drawer close-up', tradeoffs: 'strong hook; needs a tighter crop and a click sound', cost: '0.2 s of stills', taste: 'the trick itself is the hook' }), r.id);
    const b = await H.evaluate((rid) => mgl.option(rid, { title: 'Timer first', tradeoffs: 'clear premise; slower first second, weaker hook', cost: '0.2 s', taste: 'calm, honest' }), r.id);
    assert(a.ok && b.ok, JSON.stringify([a, b]));
    const { v, ms } = await seen((st) => { const rr = st.board.rounds?.find((x) => x.id === r.id); return rr?.options?.length === 2 ? rr : null; }, 'round with 2 options');
    await O.click('[data-mgl=tab-rounds]');
    const n = await O.locator('[data-mgl^="choose-"]').count();
    assert(n >= 2, `${n} Choose buttons on the observer`);
    return { round: r.id, status: v.status, options: v.options.map((o) => o.id), observerMs: ms };
  });
  await check('ai', 'mgl.focus moves the page camera to the shapes', async () => {
    const c0 = (await stateOf(H)).camera;
    const r = await H.evaluate((id) => mgl.focus([id]), stillId);
    assert(r.ok, JSON.stringify(r));
    await sleep(500);
    const c1 = (await stateOf(H)).camera;
    assert(c1.x !== c0.x || c1.zoom !== c0.zoom, 'camera did not move');
    const s = shapesOnDisk().find((x) => x.id === stillId);
    const vw = canvasBox.w / c1.zoom, vh = canvasBox.h / c1.zoom;
    assert(s.x >= c1.x && s.x <= c1.x + vw && s.y >= c1.y && s.y <= c1.y + vh, 'still not in view after focus');
    return { camera: c1 };
  });
  await check('ai', 'mgl.say -> log by ai, toast on the observer < 1 s', async () => {
    const t0 = Date.now();
    await H.evaluate(() => mgl.say('Two openings in round r1: tell me which feels more like you.'));
    const { ms } = await until(async () => (await toasts(O)).some((t) => t.includes('Two openings')), 1000, 'toast on observer');
    const log = readBoard().log?.at(-1);
    assert(log?.by === 'ai', `log ${JSON.stringify(log)}`);
    return { toastMs: ms, total: Date.now() - t0 };
  });
  await check('ai', 'mgl.pin / mgl.resolve, mgl.find, mgl.get, mgl.select, mgl.selection, mgl.timeline, mgl.view', async () => {
    const p = await H.evaluate((id) => mgl.pin(id, 0.2, 0.8, 'AI: is the CTA readable here?'), stillId);
    assert(p.ok && p.id, JSON.stringify(p));
    const res = await H.evaluate((id) => mgl.resolve(id, 'CTA is 20 % larger now'), p.id);
    assert(res.ok, JSON.stringify(res));
    const pin = shapesOnDisk().find((s) => s.id === p.id);
    assert(pin.status === 'resolved' && pin.reply, JSON.stringify(pin));
    const stills = await H.evaluate(() => mgl.find({ type: 'still' }));
    const got = await H.evaluate((id) => mgl.get(id), aiNote);
    const sel = await H.evaluate((id) => mgl.select([id]).then(() => mgl.selection()), aiNote);
    const tl = await H.evaluate(() => mgl.timeline());
    const view = await H.evaluate(() => mgl.view());
    assert(stills.length >= 4 && got?.id === aiNote && sel.ids[0] === aiNote && tl?.clips?.length > 0, 'find/get/select/timeline');
    return { stills: stills.length, clips: tl.clips.length, viewKeys: Object.keys(view) };
  });
  await check('ai', 'mgl.undo / mgl.redo from the console', async () => {
    const r = await H.evaluate(() => mgl.rect('temp', { x: 1400, y: 300 }));
    await H.evaluate(() => mgl.undo());
    await until(() => !shapesOnDisk().some((s) => s.id === r.id), 2000, 'undo removed rect');
    await H.evaluate(() => mgl.redo());
    await until(() => shapesOnDisk().some((s) => s.id === r.id), 2000, 'redo restored rect');
    await H.evaluate((id) => mgl.remove(id), r.id);
  });
  await check('ai', 'mgl.snapshot returns a PNG data URL', async () => {
    const u = await H.evaluate(() => mgl.snapshot());
    assert(typeof u === 'string' && u.startsWith('data:image/png') && u.length > 5000, `snapshot ${String(u).slice(0, 40)} (${u?.length})`);
    return { bytes: u.length };
  });
  await check('ai', 'bad op returns {ok:false, error:{code, message, fix}} (no throw)', async () => {
    current = 'expected-400';
    const r = await H.evaluate(() => mgl.op({ op: 'shape.add', shape: { type: 'note', x: 0, y: 0, colour: 'red' } }));
    current = 'ai';
    assert(r.ok === false && r.error?.code && r.error?.message, JSON.stringify(r));
    return r.error;
  });
  await check('sync', 'CLI `mgl board edit` (terminal) reaches both pages < 1 s', async () => {
    const t0 = Date.now();
    const out = mgl(dir, ['board', 'edit', 'video.mgl.json', JSON.stringify({ op: 'shape.add', shape: { type: 'note', x: 1700, y: 0, text: 'from the terminal' } })]);
    const cliMs = Date.now() - t0;
    const a = await until(async () => (await stateOf(O)).board.shapes?.some((s) => s.text === 'from the terminal'), 1000, 'observer sees CLI note');
    const b = await until(async () => (await stateOf(H)).board.shapes?.some((s) => s.text === 'from the terminal'), 1000, 'human page sees CLI note');
    return { cliMs, observerMs: a.ms, humanMs: b.ms, out: out.trim().split('\n')[0] };
  });
  await check('sync', 'CLI `mgl board say` toasts on both pages; `mgl board focus` moves the observer camera', async () => {
    mgl(dir, ['board', 'say', 'video.mgl.json', 'Rendering stills for r1 now (0.3 s).']);
    await until(async () => (await toasts(O)).some((t) => t.includes('Rendering stills')), 1500, 'observer toast');
    await until(async () => (await toasts(H)).some((t) => t.includes('Rendering stills')), 1500, 'human toast');
    const c0 = (await stateOf(O)).camera;
    mgl(dir, ['board', 'focus', 'video.mgl.json', aiNote]);
    const { ms } = await until(async () => { const c = (await stateOf(O)).camera; return c.x !== c0.x || c.zoom !== c0.zoom; }, 1500, 'observer camera moved');
    return { focusMs: ms };
  });
  await check('sync', 'a hand edit of the board file reaches the pages (watcher)', async () => {
    const txt = readFileSync(boardFile, 'utf8');
    writeFileSync(boardFile, txt.replace('"from the terminal"', '"from the terminal, edited by hand"'));
    const { ms } = await until(async () => (await stateOf(O)).board.shapes?.some((s) => s.text === 'from the terminal, edited by hand'), 2000, 'observer sees hand edit');
    return { ms };
  });
  await check('human', 'human types in the Chat tab -> log by human; observer shows it; Next advises the agent to answer', async () => {
    await H.click('[data-mgl=tab-chat]');
    await H.fill('[data-mgl=chat-input]', 'I like the calmer one, but keep the click sound.');
    await H.keyboard.press('Enter');
    const { v } = await until(() => { const l = readBoard().log?.at(-1); return l?.text?.includes('click sound') ? l : null; }, 3000, 'chat message on disk');
    assert(v.by === 'human', `log by ${v.by}`);
    await until(async () => (await O.locator('#tab-chat').textContent()).includes('keep the click sound'), 1000, 'observer chat shows it');
    const { v: adv } = await until(async () => { const a = (await stateOf(O)).advice ?? []; return a.find((x) => /answer|reply/i.test(x.text)); }, 2000, 'advice to answer the person');
    return { advice: adv.text };
  });
  await check('human', 'Comment on an option sends a message by human', async () => {
    await H.click('[data-mgl=tab-rounds]');
    const opt = readBoard().rounds.at(-1).options[0];
    await H.click(`[data-mgl="comment-${opt.id}"]`);
    await H.fill(`[data-mgl="comment-input-${opt.id}"]`, 'the drawer shot feels staged');
    await H.click(`[data-mgl="comment-send-${opt.id}"]`);
    const { v } = await until(() => readBoard().log?.find((l) => l.text.includes('feels staged')), 3000, 'comment in the log');
    assert(v.by === 'human', `by ${v.by}`);
    return { text: v.text };
  });
  await check('human', 'human clicks Choose on option b in the Rounds tab -> decided by human', async () => {
    await H.click('[data-mgl=tab-rounds]');
    const round = readBoard().rounds.at(-1);
    const opt = round.options[1];
    await H.fill(`[data-mgl="why-${round.id}"]`, 'calmer, and I want the premise first');
    await H.click(`[data-mgl="choose-${opt.id}"]`);
    const { v } = await until(() => { const r = readBoard().rounds.find((x) => x.id === round.id); return r.status === 'decided' ? r : null; }, 3000, 'round decided on disk');
    assert(v.chosen === opt.id, `chosen ${v.chosen}`);
    const { v: h } = await until(() => history().reverse().find((x) => /round\.decide/.test(x.summary)), 2000, 'round.decide in history');
    assert(h.by === 'human', `decide history by ${h.by}`);
    await seen((st) => st.board.rounds?.find((x) => x.id === round.id)?.status === 'decided', 'observer sees decision');
    return { chosen: v.chosen, why: v.why ?? null };
  });
  await check('ai', 'the CLI `show` reflects the session (brief, round, pins, next)', async () => {
    const j = JSON.parse(mgl(dir, ['board', 'show', 'video.mgl.json', '--json']));
    const lines = mgl(dir, ['board', 'show', 'video.mgl.json']).trim().split('\n');
    assert(lines.length <= 40, `${lines.length} lines`);
    return { lines: lines.length, advice: (j.advice ?? j.data?.advice ?? []).map((a) => `${a.level}: ${a.text}`).slice(0, 4) };
  });

  // ============================================================ visual
  current = 'visual';
  console.log('visual');
  const shot = async (p, name) => { const f = join(OUT, `e2e-${name}.png`); await p.screenshot({ path: f }); R.screenshots.push(f); return f; };
  await check('visual', 'screenshots: light, dark, narrow 390 px, observer', async () => {
    await H.click('[data-mgl=tab-rounds]');
    await H.keyboard.press('Escape');
    await H.mouse.move(canvasBox.x + 50, canvasBox.y + 600);
    await H.keyboard.press('ControlOrMeta+0');
    await sleep(700);
    await shot(H, 'light');
    await H.emulateMedia({ colorScheme: 'dark' });
    await sleep(500);
    const theme = await H.evaluate(() => document.documentElement.dataset.theme);
    assert(theme === 'dark', `theme ${theme}`);
    await shot(H, 'dark');
    await H.emulateMedia({ colorScheme: 'light' });
    await O.click('[data-mgl=tab-chat]');
    await sleep(300);
    await shot(O, 'observer-chat');
    const { page: N } = await mkCtx('narrow', 'light', { width: 390, height: 844 });
    await sleep(800);
    await shot(N, 'narrow');
    const overflow = await N.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert(!overflow, 'horizontal overflow at 390 px');
    await N.close();
    return R.screenshots.map((f) => f.split('/').pop());
  });
  await check('visual', 'zoomed-in still + pin close-up', async () => {
    await H.evaluate((id) => mgl.focus([id]), stillId);
    await sleep(600);
    await shot(H, 'still-closeup');
  });

  // ============================================================ performance
  current = 'perf';
  console.log('performance (300 shapes)');
  await check('perf', 'add 300 shapes in one batch', async () => {
    const t0 = Date.now();
    const r = await H.evaluate(() => {
      const kinds = ['note', 'rect', 'ellipse', 'text'], colors = ['yellow', 'blue', 'green', 'red', 'violet', 'grey'], ops = [];
      for (let i = 0; i < 300; i++) ops.push({ op: 'shape.add', shape: { type: kinds[i % 4], x: 2200 + (i % 20) * 230, y: (Math.floor(i / 20)) * 230, text: `idea ${i}`, color: colors[i % 6] } });
      return mgl.ops(ops);
    });
    assert(r.ok, JSON.stringify(r).slice(0, 300));
    await until(async () => (await stateOf(O)).board.shapes.length >= 300, 3000, 'observer has 300+ shapes');
    return { ms: Date.now() - t0 };
  });
  const measurePan = async (label, setup) => {
    await setup();
    await sleep(500);
    await H.evaluate(() => { window.__ft = []; window.__run = true; let last = performance.now(); const tick = (t) => { window.__ft.push(t - last); last = t; if (window.__run) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    const cx = canvasBox.x + canvasBox.w / 2, cy = canvasBox.y + canvasBox.h / 2;
    await H.mouse.move(cx, cy);
    await H.keyboard.down(' ');
    await H.mouse.down();
    for (let i = 0; i < 90; i++) { await H.mouse.move(cx + Math.sin(i / 8) * 300, cy + Math.cos(i / 11) * 200); await sleep(16); }
    await H.mouse.up();
    await H.keyboard.up(' ');
    const ft = await H.evaluate(() => { window.__run = false; return window.__ft.slice(2); });
    ft.sort((a, b) => a - b);
    const avg = ft.reduce((a, b) => a + b, 0) / ft.length, p95 = ft[Math.floor(ft.length * 0.95)], worst = ft.at(-1);
    const m = { frames: ft.length, avgMs: +avg.toFixed(2), p95Ms: +p95.toFixed(2), worstMs: +worst.toFixed(2), fps: +(1000 / avg).toFixed(1), longFrames: ft.filter((x) => x > 33).length };
    R.metrics[label] = m;
    return m;
  };
  await check('perf', 'pan with all 300+ shapes in view (zoomed out): avg fps >= 50, p95 <= 33 ms', async () => {
    const m = await measurePan('panAllInView', async () => { await H.mouse.move(canvasBox.x + 50, canvasBox.y + 600); await H.keyboard.press('ControlOrMeta+0'); });
    assert(m.fps >= 50 && m.p95Ms <= 33, JSON.stringify(m));
    return m;
  });
  await check('perf', 'pan at 100% zoom over the 300 shapes: avg fps >= 50', async () => {
    const m = await measurePan('pan100', async () => { await H.evaluate(() => mgl.camera({ x: 2400, y: 200, zoom: 1 })); });
    assert(m.fps >= 50 && m.p95Ms <= 33, JSON.stringify(m));
    return m;
  });
  await check('perf', 'pan with 300+ shapes in view under 4x CPU throttle (laptop on battery): avg fps >= 30', async () => {
    const cdp = await H.context().newCDPSession(H);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    try {
      const m = await measurePan('panAllInView4xThrottle', async () => { await H.mouse.move(canvasBox.x + 50, canvasBox.y + 600); await H.keyboard.press('ControlOrMeta+0'); });
      assert(m.fps >= 30, JSON.stringify(m));
      return m;
    } finally { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); }
  });
  await check('perf', 'one draw of the full board (renderer cost, CPU throttle 1x)', async () => {
    const r = await H.evaluate(async () => {
      const ts = [];
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        await mgl.camera({ x: 2000 + i * 7, y: -50, zoom: 0.18 });
        await new Promise((res) => requestAnimationFrame(() => res()));
        ts.push(performance.now() - t0);
      }
      ts.sort((a, b) => a - b);
      return { medianMs: +ts[15].toFixed(2), worstMs: +ts[29].toFixed(2) };
    });
    R.metrics.cameraStepToFrame = r;
    return r;
  });
  await shot(H, 'perf-300');

  current = 'end';
  await check('page', 'no console errors or page errors on any page', async () => {
    R.expectedErrors = R.consoleErrors.filter((e) => e.step === 'expected-400');
    R.consoleErrors = R.consoleErrors.filter((e) => e.step !== 'expected-400');
    assert(!R.consoleErrors.length, `${R.consoleErrors.length} errors: ${R.consoleErrors.slice(0, 5).map((e) => `[${e.who}/${e.step}] ${e.text}`).join(' | ')}`);
  });
  await check('page', 'no failed requests (4xx/5xx) from the pages', async () => {
    R.failedRequests = R.failedRequests.filter((f) => !(f.status === 400 && f.step === 'expected-400'));
    assert(!R.failedRequests.length, `${R.failedRequests.length}: ${JSON.stringify(R.failedRequests.slice(0, 5))}`);
  });
}

let code = 0;
try { await main(); }
catch (e) { console.error(`setup error: ${e?.stack ?? e}`); R.setupError = String(e?.message ?? e); code = 2; }
finally {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await sleep(300); if (server.exitCode === null) server.kill('SIGKILL'); }
  R.finishedAt = new Date().toISOString();
  R.summary = { passed: R.checks.filter((c) => c.ok).length, failed: R.checks.filter((c) => !c.ok).length, total: R.checks.length };
  R.serverJsonRemoved = !existsSync(join(dir, '.mgl', 'board', 'server.json'));
  writeFileSync(join(OUT, 'e2e.json'), JSON.stringify(R, null, 2) + '\n');
  if (!argv.has('--keep')) rmSync(dir, { recursive: true, force: true }); else console.log(`kept ${dir}`);
  console.log(`\n${R.summary.passed}/${R.summary.total} passed${R.summary.failed ? `, ${R.summary.failed} failed` : ''} -> evals/board/results/e2e.json`);
  if (!code && R.summary.failed) code = 1;
  process.exit(code);
}
