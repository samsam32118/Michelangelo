#!/usr/bin/env node
/**
 * The board in the browsers agents drive (docs/plans/BOARD.md §8.1): the Claude app's browser pane (reads pages as text
 * and accessibility trees, fills forms by label, runs console JS; cannot reach a cloud session's localhost, so it sees
 * an exported page or an Artifact), Claude in Chrome, Codex's browser and Playwright. Not a package dependency: it uses
 * a Playwright found on the machine (/opt/node-tools or `npm root -g`) and the preinstalled Chromium.
 *   text      document.body.innerText (get_page_text) has every shape, the brief, rounds, options, open pins, next
 *   a11y      aria snapshot: tools, tabs, brief fields; getByLabel fill → board file by human; Choose by role decides
 *   small     360x640 and 375x700: no horizontal overflow, panel as a bottom sheet, every tool reachable (screenshots)
 *   poll      EventSource deleted → the page polls and shows a CLI edit within 2 s
 *   net       no request leaves the server origin, no dialogs, no console errors, works framed by a loopback page
 *   csp       the page's Content-Security-Policy is strict (script-src 'self', no eval, connect-src 'self')
 *   export    the exported HTML from file:// with every network route aborted, and under an Artifact-like CSP in a
 *             sandboxed frame: shapes, stills, outline, detached edits → mgl.pending() → mgl board edit --batch
 *   host      serve --host 0.0.0.0 --allow-host myhost.test: that Host works, others are refused, the CLI finds it
 * Writes evals/board/results/agent-browsers.json and agent-*.png. Exit 0 when every check passes, 1 otherwise, 2 on
 * setup errors. usage: node evals/board/agent-browsers.mjs [--headed] [--keep]
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
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
const R = { startedAt: new Date().toISOString(), checks: [], consoleErrors: [], external: [], dialogs: [], cspViolations: [], screenshots: [] };
let current = 'setup';
async function check(area, name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    R.checks.push({ area, name, ok: true, ms: Date.now() - t0, ...(detail === undefined ? {} : { detail }) });
    console.log(`  ok   ${area.padEnd(8)} ${name}${detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 140)}` : ''}`);
  } catch (e) {
    R.checks.push({ area, name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 800) });
    console.log(`  FAIL ${area.padEnd(8)} ${name}: ${String(e?.message ?? e).split('\n')[0].slice(0, 240)}`);
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

// ---------------------------------------------------------------- fixtures
const dir = mkdtempSync(join(tmpdir(), 'mgl-board-agents-'));
const boardFile = join(dir, 'video.board.json');
const readBoard = (f = boardFile) => JSON.parse(readFileSync(f, 'utf8'));
const historyOf = (d) => { const f = join(d, '.mgl', 'board-history.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const servers = [];
const httpServers = [];
let browser;

function serve(cwd, extra = []) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--import', TSX, CLI, 'board', 'serve', 'video.mgl.json', '--port', '0', '--json', ...extra], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(p);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; const m = out.match(/\{.*"url".*\}/); if (m) res(JSON.parse(m[0])); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (c) => rej(new Error(`board serve exited ${c}: ${err || out}`)));
    setTimeout(() => rej(new Error(`board serve printed no URL in 20 s: ${out}${err}`)), 20000);
  });
}
/** a tiny static server on another port (the "other site": a framing page, an Artifact-like host) */
function hostServer(routes) {
  return new Promise((res) => {
    const s = createServer((req, rsp) => {
      const r = routes[new URL(req.url, 'http://x').pathname];
      if (!r) { rsp.writeHead(404); return rsp.end('not found'); }
      rsp.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(r.headers ?? {}) });
      rsp.end(typeof r.body === 'function' ? r.body() : r.body);
    });
    httpServers.push(s);
    s.listen(0, '127.0.0.1', () => res(s.address().port));
  });
}
/** a raw request with any Host header (fetch() does not allow setting it) */
const rawGet = (port, path, host) => new Promise((res, rej) => {
  const q = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b, headers: r.headers })); });
  q.on('error', rej);
  q.end();
});

async function main() {
  console.log(`board agent-browser checks in ${dir}`);
  writeFileSync(join(dir, 'script.txt'), 'Put your phone in a drawer.\nSet a two minute timer.\nStart the smallest step you can.\nThat is the whole trick.\n');
  mgl(dir, ['new', 'shorts', '--script', 'script.txt', '-o', 'video.mgl.json']);
  // a board with something of everything an agent must be able to read
  mgl(dir, ['board', 'edit', 'video.mgl.json', 'storyboard.make', 'every=2s']);
  const stills = readBoard().shapes.filter((s) => s.type === 'still');
  assert(stills.length >= 2, 'storyboard made fewer than 2 stills');
  const [s1, s2] = stills;
  const seed = [
    { op: 'brief.set', goal: 'Short that makes people try the 2-minute focus trick', audience: 'students 16-24', success: ['a viewer can do the trick after one watch'], tone: ['calm', 'warm'], questions: ['calm or punchy music?'], budget: { cpuMin: 5 } },
    { op: 'shape.add', shape: { id: 'n-hook', type: 'note', x: -400, y: 0, text: 'Hook: phone goes into the drawer', color: 'yellow' } },
    { op: 'shape.add', shape: { id: 'cta', type: 'rect', x: -400, y: 300, w: 220, h: 100, text: 'CTA card', fill: 'tint', color: 'blue' } },
    { op: 'shape.add', shape: { id: 'a-hook', type: 'arrow', from: 'n-hook', to: s1.id, text: 'becomes' } },
    { op: 'round.open', goal: 'pick the opening', fidelity: 1 },
    { op: 'round.option', round: 'r1', option: { title: 'Bold hook', tradeoffs: 'loud and fast; may feel generic', cost: '0 s', taste: 'type-led and confident', shapes: [s1.id] } },
    { op: 'round.option', round: 'r1', option: { title: 'Quiet open', tradeoffs: 'matches the calm tone; a weaker hook', cost: '0 s', taste: 'lets the habit speak', shapes: [s2.id] } },
    { op: 'say', text: 'Two openings in round r1: bold or quiet?' },
  ];
  writeFileSync(join(dir, 'seed.jsonl'), seed.map((o) => JSON.stringify(o)).join('\n') + '\n');
  mgl(dir, ['board', 'edit', 'video.mgl.json', '--batch', 'seed.jsonl']);
  mgl(dir, ['board', 'edit', 'video.mgl.json', 'pin.add', s1.id, 'u=0.5', 'v=0.2', 'text=title too small here', '--by', 'human']);
  const pin = readBoard().shapes.find((s) => s.type === 'pin');

  const srv = await serve(dir);
  const url = srv.url, origin = new URL(url).origin;
  R.url = url;
  console.log(`server ${url}`);

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: !argv.has('--headed'), args: ['--host-resolver-rules=MAP myhost.test 127.0.0.1, MAP evil.test 127.0.0.1'] });

  /** a page with every listener an agent-browser check needs; `allowed` origins may be requested */
  const open = async (who, { viewport = { width: 1280, height: 800 }, allowed = [origin], init, colorScheme = 'light', offline = false } = {}) => {
    const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
    if (init) await ctx.addInitScript(init);
    // CSP violations become visible to the eval (they are console errors too)
    await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
    if (offline) await ctx.route('**/*', (r) => { if (r.request().url().startsWith('file:')) return r.continue(); R.external.push({ who, step: current, url: r.request().url(), aborted: true }); return r.abort(); });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') R.consoleErrors.push({ who, step: current, text: m.text().slice(0, 300) }); });
    page.on('pageerror', (e) => R.consoleErrors.push({ who, step: current, text: `pageerror: ${String(e.message).slice(0, 300)}` }));
    page.on('dialog', (d) => { R.dialogs.push({ who, step: current, type: d.type(), message: d.message() }); void d.dismiss(); });
    page.on('request', (q) => {
      const u = q.url();
      if (/^(data|blob|about|chrome-error):/.test(u)) return;
      if (u.startsWith('file:') && offline) return;
      if (!allowed.some((o) => u.startsWith(o + '/') || u === o)) R.external.push({ who, step: current, url: u.slice(0, 200) });
    });
    return { ctx, page };
  };
  const live = (p) => p.waitForFunction(() => window.mgl && document.querySelector('[data-mgl=connection]')?.dataset.state === 'live', null, { timeout: 10000 });
  const shot = async (p, name) => { const f = join(OUT, `agent-${name}.png`); await p.screenshot({ path: f }); R.screenshots.push(f); return f; };

  // ============================================================ text + a11y (desktop)
  current = 'text';
  console.log('text and accessibility tree');
  const { page: P } = await open('desktop');
  await P.goto(url);
  await live(P);
  await sleep(300);
  const board0 = readBoard();
  await check('text', 'innerText (get_page_text) has every shape id and its text', async () => {
    const text = await P.evaluate(() => document.body.innerText);
    const miss = [];
    for (const s of board0.shapes) {
      if (!text.includes(s.id)) miss.push(s.id);
      const t = s.text ?? s.label;
      if (t && !text.includes(t)) miss.push(`${s.id}: "${t}"`);
    }
    assert(!miss.length, `missing: ${miss.join(', ')}`);
    return { shapes: board0.shapes.length, chars: text.length };
  });
  await check('text', 'innerText has the brief, every round and option with tradeoffs, cost and taste', async () => {
    const text = await P.evaluate(() => document.body.innerText);
    const want = [board0.brief.goal, board0.brief.audience, ...board0.brief.success, ...board0.brief.tone, ...board0.brief.questions];
    for (const r of board0.rounds) { want.push(r.id, r.goal); for (const o of r.options) want.push(o.id, o.title, o.tradeoffs, o.cost, o.taste); }
    const miss = want.filter((w) => !text.includes(w));
    assert(!miss.length, `missing: ${miss.join(' | ')}`);
  });
  await check('text', 'innerText has each open pin with its time (and clips) and the next advice', async () => {
    const text = await P.evaluate(() => document.body.innerText);
    const line = text.split('\n').find((l) => l.startsWith(`${pin.id} on ${pin.target}`));
    assert(line, `no outline line for pin ${pin.id}`);
    assert(/ at \d/.test(line) && /clips:/.test(line) && line.includes(pin.text), `pin line lacks time/clips/text: ${line}`);
    const st = await (await fetch(`${url}/api/state`)).json();
    const miss = st.advice.map((a) => a.text).filter((t) => !text.includes(t));
    assert(st.advice.length && !miss.length, `advice missing: ${miss.join(' | ')}`);
    return { pin: line, advice: st.advice.length };
  });
  await check('text', 'document.title names the board and its open items', async () => {
    const t = await P.title();
    assert(/^Board · video · 1 open pin · 1 to choose$/.test(t), `title "${t}"`);
    return t;
  });
  await check('a11y', 'aria snapshot exposes the tool buttons, tabs, brief fields and the outline', async () => {
    const snap = await P.locator('body').ariaSnapshot();
    const want = ['button "Select (V)"', 'button "Note (N)"', 'button "Pin feedback (P)"', 'button "Still at playhead (S)"', 'tab "Brief"', 'tab "Rounds"', 'tab "Chat"', 'tab "Next"', 'textbox "Goal', 'textbox "Audience"', 'region "Board outline"'];
    const miss = want.filter((w) => !snap.includes(w));
    assert(!miss.length, `missing in aria snapshot: ${miss.join(', ')}`);
    writeFileSync(join(OUT, 'agent-aria.yaml'), snap);
    return { lines: snap.split('\n').length };
  });
  await check('a11y', 'getByLabel("Audience").fill lands in the board file, by human', async () => {
    await P.getByRole('tab', { name: 'Brief' }).click();
    await P.getByLabel('Audience').fill('students and young workers');
    await P.getByLabel('Audience').blur();
    await until(() => readBoard().brief?.audience === 'students and young workers', 3000, 'brief.audience on disk');
    const h = historyOf(dir).at(-1);
    assert(h?.by === 'human', `history by ${h?.by}: ${h?.summary}`);
  });
  await check('a11y', 'getByRole("button", {name: /choose/i}) decides the round (by human)', async () => {
    await P.getByRole('tab', { name: /Rounds/ }).click();
    const buttons = P.getByRole('button', { name: /choose/i });
    assert((await buttons.count()) === 2, `${await buttons.count()} Choose buttons`);
    await P.getByRole('button', { name: /choose quiet open/i }).click();
    const { v } = await until(() => readBoard().rounds.find((r) => r.id === 'r1' && r.status === 'decided'), 3000, 'r1 decided on disk');
    assert(v.chosen === 'r1b', `chosen ${v.chosen}`);
    assert(historyOf(dir).at(-1)?.by === 'human', 'decision not by human');
    await until(async () => !(await P.title()).includes('to choose'), 2000, 'title drops "to choose"');
    return { chosen: v.chosen, title: await P.title() };
  });
  await shot(P, 'desktop');

  // ============================================================ small panes
  current = 'small';
  console.log('small viewports');
  for (const vp of [{ width: 360, height: 640 }, { width: 375, height: 700 }]) {
    const tag = `${vp.width}x${vp.height}`;
    const { page: S, ctx } = await open(`small-${tag}`, { viewport: vp });
    await S.goto(url);
    await live(S);
    await sleep(400);
    await check('small', `${tag}: no horizontal page overflow`, async () => {
      const m = await S.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, w: window.innerWidth, x: window.scrollX }));
      assert(m.doc <= m.w && m.body <= m.w, JSON.stringify(m));
      await S.mouse.move(vp.width / 2, vp.height - 40); // over the panel: a wheel over the canvas pans the board, not the page
      await S.mouse.wheel(300, 0);
      const x = await S.evaluate(() => window.scrollX);
      assert(x === 0, `page scrolled sideways to ${x}`);
      return m;
    });
    await check('small', `${tag}: the panel is a bottom sheet with usable tabs and fields`, async () => {
      const r = await S.evaluate(() => { const p = document.querySelector('#panel').getBoundingClientRect(); const st = document.querySelector('#stage').getBoundingClientRect(); return { top: p.top, bottom: p.bottom, left: p.left, width: p.width, h: p.height, stageH: st.height, vh: innerHeight, vw: innerWidth }; });
      assert(r.left === 0 && Math.abs(r.width - r.vw) < 1, `panel not full width: ${JSON.stringify(r)}`);
      assert(r.bottom <= r.vh + 0.5 && r.top > r.vh * 0.35, `panel not at the bottom: ${JSON.stringify(r)}`);
      assert(r.h >= 150, `panel too short to use: ${r.h}px`);
      assert(r.stageH >= 220, `canvas too short: ${r.stageH}px`);
      await S.getByRole('tab', { name: 'Brief' }).click();
      const goal = S.getByLabel('Goal');
      await goal.scrollIntoViewIfNeeded();
      assert(await goal.isVisible(), 'Goal field not visible');
      await S.getByRole('tab', { name: 'Next' }).click();
      return r;
    });
    await check('small', `${tag}: every tool is reachable, uncovered, and selects`, async () => {
      const tools = await S.$$eval('[data-mgl^=tool-]', (els) => els.map((e) => e.dataset.mgl.slice(5)));
      assert(tools.length === 11, `${tools.length} tools`);
      const bad = [];
      for (const t of tools) {
        const b = S.locator(`[data-mgl=tool-${t}]`);
        await b.scrollIntoViewIfNeeded();
        const ok = await b.evaluate((el) => { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; return r.width >= 24 && r.height >= 24 && x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && el.contains(document.elementFromPoint(x, y)); });
        if (!ok) { bad.push(`${t} covered or off screen`); continue; }
        await b.click();
        const now = await S.evaluate(async () => (await mgl.state()).tool);
        if (now !== t) bad.push(`${t} → tool ${now}`);
      }
      await S.locator('[data-mgl=tool-select]').click();
      const on = await S.$$eval('#tools .tool.on', (els) => els.map((e) => e.dataset.mgl));
      if (on.join() !== 'tool-select') bad.push(`after Select, highlighted: ${on.join(', ')}`);
      assert(!bad.length, bad.join('; '));
      const sx = await S.evaluate(() => window.scrollX);
      assert(sx === 0, `page scrolled sideways (${sx}) to reach a tool`);
    });
    await check('small', `${tag}: top bar controls fit beside each other`, async () => {
      const r = await S.evaluate(() => { const a = document.querySelector('#status').getBoundingClientRect(), b = document.querySelector('#zoombar').getBoundingClientRect(); return { statusRight: a.right, zoomLeft: b.left, zoomRight: b.right, vw: innerWidth }; });
      assert(r.statusRight <= r.zoomLeft + 0.5 && r.zoomRight <= r.vw, JSON.stringify(r));
      return r;
    });
    await sleep(400); // let the tool highlight transition finish
    await shot(S, `small-${tag}`);
    await S.getByRole('tab', { name: /Rounds/ }).click();
    await shot(S, `small-${tag}-rounds`);
    await ctx.close();
  }

  // ============================================================ polling fallback
  current = 'poll';
  console.log('no EventSource');
  await check('poll', 'EventSource deleted: the page polls and shows a CLI edit within 2 s', async () => {
    const { page: Q, ctx } = await open('poll', { init: () => { delete window.EventSource; } });
    try {
      await Q.goto(url);
      await Q.waitForFunction(() => window.mgl && document.querySelector('[data-mgl=connection]')?.dataset.state === 'polling', null, { timeout: 10000 });
      const t0 = Date.now();
      mgl(dir, ['board', 'edit', 'video.mgl.json', 'shape.add', 'note', 'id=n-polled', 'x=-400', 'y=600', 'text=seen by polling']);
      const cliMs = Date.now() - t0;
      const { ms } = await until(() => Q.evaluate(() => document.body.innerText.includes('seen by polling')), 2000, 'CLI note in the page text');
      return { cliMs, pageMsAfterCli: ms, conn: await Q.evaluate(() => document.querySelector('[data-mgl=connection]').dataset.state) };
    } finally { await ctx.close(); }
  });

  // ============================================================ network, CSP, frames
  current = 'csp';
  console.log('csp, network, frames');
  let csp = '';
  await check('csp', 'the page is served with a strict Content-Security-Policy', async () => {
    const r = await fetch(url + '/');
    csp = r.headers.get('content-security-policy') ?? '';
    const d = Object.fromEntries(csp.split(';').map((x) => x.trim().split(/\s+/)).filter((x) => x[0]).map(([k, ...v]) => [k, v]));
    assert(d['script-src']?.join(' ') === "'self'", `script-src ${d['script-src']}`);
    assert(!/unsafe-eval|unsafe-inline/.test(d['script-src']?.join(' ') ?? ''), 'script-src allows unsafe-*');
    assert(d['connect-src']?.join(' ') === "'self'", `connect-src ${d['connect-src']}`);
    assert(d['default-src']?.join(' ') === "'none'" || d['default-src']?.join(' ') === "'self'", `default-src ${d['default-src']}`);
    assert(d['object-src']?.join(' ') === "'none'" && d['base-uri']?.join(' ') === "'none'", 'object-src / base-uri not none');
    assert(d['frame-ancestors'], 'no frame-ancestors');
    return csp;
  });
  await check('csp', 'no CSP violations on the served page (it ran a full session above)', async () => {
    const v = await P.evaluate(() => window.__csp);
    assert(!v.length, v.join(' | '));
    const r = await P.evaluate(async () => (await mgl.note('csp still fine', { x: -700, y: 0 })).ok);
    assert(r, 'mgl.note failed under the CSP');
  });

  current = 'frame';
  const framePort = await hostServer({ '/': { body: () => `<!doctype html><title>host</title><h1>a dev tool</h1><iframe id=f src="${url}/" style="width:1200px;height:760px;border:0"></iframe>` } });
  for (const [label, hostOrigin] of [['loopback page on another port (127.0.0.1)', `http://127.0.0.1:${framePort}`], ['loopback page under another name (localhost)', `http://localhost:${framePort}`]]) {
    await check('frame', `works inside an iframe of a ${label}`, async () => {
      const { page: F, ctx } = await open(`frame-${label}`, { viewport: { width: 1280, height: 820 }, allowed: [origin, hostOrigin] });
      try {
        await F.goto(hostOrigin + '/');
        const fr = await until(() => F.frames().find((f) => f.url().startsWith(url)), 5000, 'board frame');
        const frame = fr.v;
        await frame.waitForFunction(() => window.mgl && document.querySelector('[data-mgl=connection]')?.dataset.state === 'live', null, { timeout: 10000 });
        const id = `framed-${label.includes('localhost') ? 'b' : 'a'}`;
        await frame.evaluate((id) => mgl.as('human') && mgl.note('from a frame', { id, x: -700, y: 300 }), id);
        await until(() => readBoard().shapes.some((s) => s.id === id), 3000, 'framed note on disk');
        await frame.getByRole('tab', { name: 'Chat' }).click();
        await frame.getByLabel('Message to the agent').fill('typed in a frame');
        await frame.getByLabel('Message to the agent').press('Enter');
        await until(() => readBoard().log.some((m) => m.text === 'typed in a frame' && m.by === 'human'), 3000, 'framed chat on disk');
        const v = await frame.evaluate(() => window.__csp);
        assert(!v.length, v.join(' | '));
        if (!label.includes('localhost')) await shot(F, 'framed');
      } finally { await ctx.close(); }
    });
  }
  await check('frame', 'a page of another site cannot frame the board (frame-ancestors)', async () => {
    current = 'expected-frame-refusal';
    const evil = `http://evil.test:${framePort}`;
    const { page: F, ctx } = await open('evil-frame', { allowed: [origin, evil] });
    try {
      await F.goto(evil + '/');
      await sleep(1500);
      const fr = F.frames().find((f) => f !== F.mainFrame());
      const ran = fr ? await fr.evaluate(() => !!window.mgl).catch(() => false) : false;
      assert(!ran, 'the board ran inside a frame of evil.test');
    } finally { await ctx.close(); current = 'frame'; }
  });

  // ============================================================ export
  current = 'export';
  console.log('exported page');
  const exportPath = join(dir, 'board.html');
  const exp = JSON.parse(mgl(dir, ['board', 'export', 'video.mgl.json', '-o', exportPath, '--json']));
  const exportedBoard = readBoard();
  const html = readFileSync(exportPath, 'utf8');
  await check('export', 'one classic inline script, no import map, no data:/blob: scripts, no external URLs', async () => {
    assert(!/type="importmap"|type="module"/.test(html), 'module scripts or an import map');
    assert(!/<script[^>]+src=/i.test(html), 'a script with src');
    assert(!/(src|href)=["']?(https?:|\/\/)/i.test(html), 'an external src/href');
    return { kb: Math.round(html.length / 1024), stills: exp.stills };
  });

  /** the checks an exported page must pass wherever it runs; `frameOf` gives the frame that runs the board */
  const exportedChecks = async (label, F, frameOf, allowFile) => {
    const B = await frameOf();
    await B.waitForFunction(() => window.mgl && document.querySelector('[data-mgl=connection]')?.dataset.state === 'detached', null, { timeout: 10000 });
    await sleep(500);
    await check('export', `${label}: renders shapes, the outline mirror and the embedded stills`, async () => {
      const text = await B.evaluate(() => document.body.innerText);
      const miss = exportedBoard.shapes.filter((s) => !text.includes(s.id)).map((s) => s.id);
      assert(!miss.length, `outline lacks ${miss.join(', ')}`);
      // a still drawn on the canvas has the colours of its embedded PNG (not the grey placeholder)
      const r = await B.evaluate(async (id) => {
        await mgl.focus([id]);
        await new Promise((res) => setTimeout(res, 900));
        const st = await mgl.state(), s = st.board.shapes.find((x) => x.id === id);
        const files = window.MGL_EMBED_FILES, key = Object.keys(files).find((k) => k.startsWith(`still:${s.t}|`));
        if (!key) return { error: `no embedded file for ${s.t}` };
        const img = new Image(); img.src = files[key]; await img.decode();
        const mean = (ctx, x, y, w, h) => { const d = ctx.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data; const m = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; } return m.map((v) => Math.round(v / (d.length / 4))); };
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
        const want = mean(cx, img.naturalWidth * 0.3, img.naturalHeight * 0.55, img.naturalWidth * 0.4, img.naturalHeight * 0.1);
        const board = document.querySelector('#board'), dpr = board.width / board.getBoundingClientRect().width;
        const w = s.w ?? 270, h = Math.round(w * img.naturalHeight / img.naturalWidth), z = st.camera.zoom;
        const sx = ((s.x + w * 0.3) - st.camera.x) * z * dpr, sy = ((s.y + h * 0.55) - st.camera.y) * z * dpr;
        const got = mean(board.getContext('2d'), sx, sy, w * 0.4 * z * dpr, h * 0.1 * z * dpr);
        return { want, got, key };
      }, exportedBoard.shapes.find((s) => s.type === 'still' && !exportedBoard.shapes.some((p) => p.type === 'pin' && p.target === s.id)).id);
      assert(!r.error, r.error);
      const diff = Math.max(...r.want.map((v, i) => Math.abs(v - r.got[i])));
      assert(diff <= 40, `still pixels ${JSON.stringify(r.got)} vs PNG ${JSON.stringify(r.want)}`);
      return { diff };
    });
    let ops = [];
    await check('export', `${label}: detached human edits queue (Undo drops one); mgl.pending() returns them; "Copy changes" shows them`, async () => {
      await B.evaluate(() => mgl.camera({ x: -800, y: -200, zoom: 1 }));
      await B.getByRole('tab', { name: 'Brief' }).click();
      await B.getByLabel('Platform').fill(`shorts (${label})`);
      await B.getByLabel('Platform').blur();
      await B.evaluate((t) => mgl.as('human') && mgl.note(t, { x: -800, y: 900 }), `note from ${label}`);
      await B.evaluate(() => mgl.note('to be undone', { x: -500, y: 900 }));
      await B.getByRole('button', { name: 'Undo', exact: true }).click();
      await until(async () => !(await B.evaluate(() => mgl.pending())).some((p) => p.op.shape?.text === 'to be undone'), 2000, 'Undo to drop the queued note');
      await B.getByRole('tab', { name: /Rounds/ }).click();
      const pending = await until(async () => { const p = await B.evaluate(() => mgl.pending()); return p.length >= 2 && p; }, 3000, 'two pending ops');
      ops = pending.v.map((p) => p.op);
      assert(pending.v.every((p) => p.by === 'human'), `pending by ${pending.v.map((p) => p.by)}`);
      const copy = B.getByRole('button', { name: 'Copy changes' });
      assert(await copy.isVisible(), 'no visible Copy changes button');
      await copy.click();
      await sleep(300);
      const box = await B.getByLabel('Changes as JSONL').inputValue();
      const jsonl = ops.map((o) => JSON.stringify(o)).join('\n');
      assert(box === jsonl, `the Changes box holds ${JSON.stringify(box).slice(0, 200)}`);
      await B.getByRole('button', { name: 'Close' }).click();
      // an agent reading the page as text gets the same JSONL from the outline
      const text = await B.evaluate(() => document.body.innerText);
      assert(ops.every((o) => text.includes(JSON.stringify(o))), 'the outline lacks the pending JSONL');
      return { pending: ops.map((o) => o.op) };
    });
    await check('export', `${label}: no requests, no CSP violations, no dialogs`, async () => {
      const v = await B.evaluate(() => window.__csp ?? []);
      assert(!v.length, v.join(' | '));
      const ext = R.external.filter((e) => e.step === current);
      assert(!ext.length, JSON.stringify(ext.slice(0, 4)));
    });
    return ops;
  };

  let fileOps = [];
  current = 'export-file';
  {
    const { page: F, ctx } = await open('export-file', { offline: true, allowed: [] });
    try {
      await F.goto(pathToFileURL(exportPath).href);
      fileOps = await exportedChecks('file:// offline', F, async () => F.mainFrame(), true);
      await shot(F, 'export-file');
    } catch (e) { await check('export', 'file:// offline: page boots', async () => { throw e; }); }
    finally { await ctx.close(); }
  }
  current = 'export-artifact';
  const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:";
  const artPort = await hostServer({
    '/': { body: '<!doctype html><title>artifact host</title><style>body{margin:0}</style><iframe sandbox="allow-scripts allow-downloads" src="/board.html" style="width:100vw;height:100vh;border:0"></iframe>', headers: { 'content-security-policy': "default-src 'self'; frame-src 'self'; style-src 'unsafe-inline'" } },
    '/board.html': { body: () => readFileSync(exportPath, 'utf8'), headers: { 'content-security-policy': ARTIFACT_CSP } },
  });
  let artOps = [];
  {
    const art = `http://127.0.0.1:${artPort}`;
    const { page: F, ctx } = await open('export-artifact', { allowed: [art] });
    try {
      await F.goto(art + '/');
      artOps = await exportedChecks('Artifact-like CSP, sandboxed frame', F, async () => (await until(() => F.frames().find((f) => f.url().endsWith('/board.html')), 5000, 'artifact frame')).v, false);
      await shot(F, 'export-artifact');
    } catch (e) { await check('export', 'Artifact-like: page boots', async () => { throw e; }); }
    finally { await ctx.close(); }
  }
  await check('export', 'the pending ops apply to the real board with mgl board edit --batch --by human', async () => {
    const ops = [...fileOps, ...artOps];
    assert(ops.length >= 4, `${ops.length} ops`);
    writeFileSync(join(dir, 'changes.jsonl'), ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
    const before = historyOf(dir).length;
    mgl(dir, ['board', 'edit', 'video.mgl.json', '--batch', 'changes.jsonl', '--by', 'human']);
    const b = readBoard();
    assert(b.shapes.some((s) => s.text === 'note from file:// offline' && s.by === 'human'), 'file:// note missing');
    assert(b.shapes.some((s) => s.text === 'note from Artifact-like CSP, sandboxed frame' && s.by === 'human'), 'artifact note missing');
    assert(b.brief.platform === 'shorts (Artifact-like CSP, sandboxed frame)', `platform ${b.brief.platform}`);
    const h = historyOf(dir).slice(before);
    assert(h.length && h.every((x) => x.by === 'human'), `history ${JSON.stringify(h.map((x) => x.by))}`);
    return { ops: ops.length };
  });

  // ============================================================ allow-host
  current = 'host';
  console.log('--host 0.0.0.0 --allow-host');
  const dir2 = mkdtempSync(join(tmpdir(), 'mgl-board-agents-host-'));
  cpSync(dir, dir2, { recursive: true, filter: (s) => !s.includes(join('.mgl', 'board', 'server.json')) });
  const srv2 = await serve(dir2, ['--host', '0.0.0.0', '--allow-host', 'myhost.test']);
  const port2 = srv2.port;
  await check('host', 'Host myhost.test:PORT is answered; other Host names are refused', async () => {
    const ok = await rawGet(port2, '/api/state', `myhost.test:${port2}`);
    assert(ok.status === 200, `myhost.test → ${ok.status}`);
    const page = await rawGet(port2, '/', `myhost.test:${port2}`);
    assert(page.status === 200 && /frame-ancestors[^;]*myhost\.test/.test(page.headers['content-security-policy']), 'page or its frame-ancestors');
    const bad = await rawGet(port2, '/api/state', `evil.test:${port2}`);
    assert(bad.status === 403 && JSON.parse(bad.body).error.code === 'E_HOST', `evil.test → ${bad.status}`);
    const rebind = await rawGet(port2, '/', `myhost.test.evil.test:${port2}`);
    assert(rebind.status === 403, `myhost.test.evil.test → ${rebind.status}`);
    return { allowed: ok.status, refused: bad.status };
  });
  await check('host', 'the page works at http://myhost.test:PORT (live, edits land)', async () => {
    const o2 = `http://myhost.test:${port2}`;
    const { page: M, ctx } = await open('myhost', { allowed: [o2] });
    try {
      await M.goto(o2 + '/');
      await live(M);
      await M.getByRole('tab', { name: 'Chat' }).click();
      await M.getByLabel('Message to the agent').fill('hello through the tunnel name');
      await M.getByLabel('Message to the agent').press('Enter');
      await until(() => readBoard(join(dir2, 'video.board.json')).log.some((m) => m.text === 'hello through the tunnel name' && m.by === 'human'), 3000, 'chat on disk');
    } finally { await ctx.close(); }
  });
  await check('host', 'show / view / say find their own server', async () => {
    const show = JSON.parse(mgl(dir2, ['board', 'show', 'video.mgl.json', '--json']));
    assert(show.server === srv2.url, `show server ${show.server} (want ${srv2.url})`);
    const view = JSON.parse(mgl(dir2, ['board', 'view', 'video.mgl.json', '--json']));
    assert(view.server === srv2.url, `view server ${view.server}`);
    const say = JSON.parse(mgl(dir2, ['board', 'say', 'video.mgl.json', 'from the CLI', '--json']));
    assert(say.server === srv2.url, `say server ${say.server}`);
    return { url: srv2.url };
  });
  rmSync(dir2, { recursive: true, force: true, maxRetries: 3 });

  // ============================================================ totals
  current = 'end';
  await check('net', 'no request left the page\'s own origin (served, framed, exported)', async () => {
    assert(!R.external.length, `${R.external.length}: ${JSON.stringify(R.external.slice(0, 5))}`);
  });
  await check('net', 'no dialogs (alert / confirm / prompt) on any page', async () => {
    assert(!R.dialogs.length, JSON.stringify(R.dialogs));
  });
  await check('net', 'no console errors or page errors on any page', async () => {
    R.expectedErrors = R.consoleErrors.filter((e) => e.step === 'expected-frame-refusal');
    R.consoleErrors = R.consoleErrors.filter((e) => e.step !== 'expected-frame-refusal');
    assert(!R.consoleErrors.length, `${R.consoleErrors.length}: ${R.consoleErrors.slice(0, 5).map((e) => `[${e.who}/${e.step}] ${e.text}`).join(' | ')}`);
  });
}

let code = 0;
try { await main(); }
catch (e) { console.error(`setup error: ${e?.stack ?? e}`); R.setupError = String(e?.message ?? e); code = 2; }
finally {
  await browser?.close().catch(() => {});
  for (const s of httpServers) s.close();
  for (const s of servers) if (s.exitCode === null) { s.kill('SIGTERM'); }
  await sleep(400);
  for (const s of servers) if (s.exitCode === null) s.kill('SIGKILL');
  R.finishedAt = new Date().toISOString();
  R.summary = { passed: R.checks.filter((c) => c.ok).length, failed: R.checks.filter((c) => !c.ok).length, total: R.checks.length };
  writeFileSync(join(OUT, 'agent-browsers.json'), JSON.stringify(R, null, 2) + '\n');
  if (!argv.has('--keep')) rmSync(dir, { recursive: true, force: true }); else console.log(`kept ${dir}`);
  console.log(`\n${R.summary.passed}/${R.summary.total} passed${R.summary.failed ? `, ${R.summary.failed} failed` : ''} -> evals/board/results/agent-browsers.json`);
  if (!code && R.summary.failed) code = 1;
  process.exit(code);
}
