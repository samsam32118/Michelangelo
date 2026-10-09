/**
 * Boot: build the chrome (tool bar, zoom, panel, timeline, toasts, help), load GET /api/state, follow GET /api/events
 * (falling back to polling GET /api/state every second when SSE is blocked), and wire the modules. An exported page
 * (window.MGL_EMBED = a BoardState) runs detached: edits apply locally and queue for mgl.pending() / Copy changes.
 */
import type { BoardFile, BoardState, Outline, Presence } from '../shared/types.js';
import { App, type ToolName } from './app.js';
import { Renderer } from './renderer.js';
import { Tools } from './tools.js';
import { installKeys, shortcuts, undo } from './keys.js';
import { installPanel } from './panel.js';
import { installTimeline } from './timeline.js';
import { installEditor } from './text-edit.js';
import { installPresence } from './presence.js';
import { installConsole } from './console.js';
import { installMirror, boardName } from './mirror.js';
import { $, h, icon, modKey, store as ls, type ICONS } from './dom.js';

const TOOLS: [ToolName, string, string, keyof typeof ICONS][] = [
  ['select', 'Select', 'V', 'select'], ['hand', 'Hand', 'H', 'hand'], ['note', 'Note', 'N', 'note'], ['text', 'Text', 'T', 'text'],
  ['rect', 'Rectangle', 'R', 'rect'], ['ellipse', 'Ellipse', 'O', 'ellipse'], ['arrow', 'Arrow', 'A', 'arrow'], ['draw', 'Draw', 'D', 'draw'],
  ['frame', 'Frame', 'F', 'frame'], ['still', 'Still at playhead', 'S', 'still'], ['pin', 'Pin feedback', 'P', 'pin'],
];

function boot(): void {
  const canvas = $<HTMLCanvasElement>('#board');
  const app = new App(canvas);
  const embed = (window as unknown as { MGL_EMBED?: BoardState }).MGL_EMBED;

  // theme: system, or the person's choice
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const applyTheme = () => {
    const pick = ls.get('mgl.theme');
    app.theme = pick === 'dark' || pick === 'light' ? pick : media?.matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = app.theme;
    app.emit('theme');
    app.invalidate();
  };
  media?.addEventListener?.('change', applyTheme);
  applyTheme();

  const renderer = new Renderer(app, canvas, $('#grid'));
  const tools = new Tools(app, canvas, renderer);
  installEditor(app, $('#stage'));

  // toasts
  const toasts = $('#toasts');
  app.setToaster((text, kind) => {
    const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, kind === 'ai' || kind === 'human' ? h('b', {}, kind === 'ai' ? 'AI' : 'You') : null, h('span', {}, text));
    toasts.append(t);
    while (toasts.children.length > 4) toasts.firstElementChild!.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 7000 : 5000);
  });

  // tool bar
  const bar = $('#tools');
  const toolBtns = new Map<ToolName, HTMLButtonElement>();
  for (const [t, label, key, ic] of TOOLS) {
    const b = h('button', { class: 'tool', 'aria-label': `${label} (${key})`, title: `${label} · ${key}`, 'data-mgl': `tool-${t}`, 'aria-pressed': 'false', onclick: () => app.setTool(t) }, icon(ic), h('kbd', {}, key));
    toolBtns.set(t, b);
    if (t === 'frame' || t === 'still') bar.append(h('span', { class: 'sep', 'aria-hidden': 'true' }));
    bar.append(b);
  }
  const syncTools = () => { for (const [t, b] of toolBtns) { b.setAttribute('aria-pressed', String(t === app.tool)); b.classList.toggle('on', t === app.tool); } };
  app.on('tool', syncTools);
  syncTools();

  // top right: undo / redo, zoom, theme, outline, help, panel
  const zoomLabel = h('button', { class: 'zoom', 'aria-label': 'Zoom to 100%', title: 'Zoom 100% · Shift 0', 'data-mgl': 'zoom-reset', onclick: () => app.camera.zoomAt([app.camera.w / 2, app.camera.h / 2], 1 / app.camera.cam.zoom) }, '100%');
  app.on('camera', () => { zoomLabel.textContent = `${Math.round(app.camera.cam.zoom * 100)}%`; });
  const outline = $('#mgl-outline');
  const help = $('#help');
  const toggleHelp = () => { help.hidden = !help.hidden; if (!help.hidden) (help.querySelector('button') as HTMLElement | null)?.focus(); };
  help.append(h('div', { class: 'sheet', role: 'document' },
    h('header', {}, h('h2', {}, 'Shortcuts'), h('button', { 'aria-label': 'Close', 'data-mgl': 'help-close', onclick: toggleHelp }, '×')),
    h('dl', {}, ...shortcuts().flatMap(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)])),
    h('h3', {}, 'Agents'),
    h('p', {}, 'Open the browser console and type ', h('code', {}, 'mgl.help()'), '. The same ops work from the CLI: ', h('code', {}, 'mgl board edit'), '.')));
  help.addEventListener('click', (e) => { if (e.target === help) toggleHelp(); });
  help.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); toggleHelp(); } });
  const themeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Switch light / dark', title: 'Light / dark', 'data-mgl': 'theme', onclick: () => { ls.set('mgl.theme', app.theme === 'dark' ? 'light' : 'dark'); applyTheme(); } }, icon('theme', 18));
  const panelEl = $('#panel');
  const panelBtn = h('button', { class: 'icon-btn', 'aria-label': 'Show or hide the panel', title: 'Panel', 'aria-expanded': 'true', 'data-mgl': 'panel-toggle', onclick: () => setPanel(panelEl.hidden === true) }, icon('panel', 18));
  const setPanel = (open: boolean) => { panelEl.hidden = !open; panelBtn.setAttribute('aria-expanded', String(open)); ls.set('mgl.panel', open ? 'open' : 'closed'); app.emit('layout'); };
  $('#zoombar').append(
    h('button', { class: 'icon-btn', 'aria-label': 'Undo', title: `Undo · ${modKey()}Z`, 'data-mgl': 'undo', onclick: () => void undo(app, 'undo') }, icon('undo', 18)),
    h('button', { class: 'icon-btn', 'aria-label': 'Redo', title: `Redo · ${modKey()}Shift Z`, 'data-mgl': 'redo', onclick: () => void undo(app, 'redo') }, icon('redo', 18)),
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    h('button', { class: 'icon-btn', 'aria-label': 'Zoom out', title: 'Zoom out', 'data-mgl': 'zoom-out', onclick: () => app.camera.zoomAt([app.camera.w / 2, app.camera.h / 2], 0.8) }, icon('minus', 18)),
    zoomLabel,
    h('button', { class: 'icon-btn', 'aria-label': 'Zoom in', title: 'Zoom in', 'data-mgl': 'zoom-in', onclick: () => app.camera.zoomAt([app.camera.w / 2, app.camera.h / 2], 1.25) }, icon('plus', 18)),
    h('button', { class: 'icon-btn', 'aria-label': 'Zoom to fit', title: `Fit · ${modKey()}0`, 'data-mgl': 'zoom-fit', onclick: () => app.fit() }, icon('fit', 18)),
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    h('button', { class: 'icon-btn', 'aria-label': 'Show the text outline', title: 'Outline (text view of the board)', 'aria-pressed': 'false', 'data-mgl': 'outline-toggle', onclick: (e) => { const on = outline.classList.toggle('shown'); (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on)); } }, icon('outline', 18)),
    themeBtn,
    h('button', { class: 'icon-btn', 'aria-label': 'Keyboard shortcuts', title: 'Shortcuts · ?', 'data-mgl': 'help', onclick: toggleHelp }, icon('keys', 18)),
    panelBtn);
  if (ls.get('mgl.panel') === 'closed') setPanel(false);

  const status = $('#status');
  const name = h('strong', {}, 'board');
  const conn = h('span', { class: 'conn', role: 'status', 'data-mgl': 'connection' });
  status.append(h('span', { class: 'logo', 'aria-hidden': 'true' }), name, conn);
  const syncConn = () => { conn.dataset.state = app.store.conn; conn.textContent = { live: 'live', polling: 'polling', offline: 'offline', detached: 'detached' }[app.store.conn] ?? app.store.conn; };
  app.store.on((c) => { if (c === 'conn') syncConn(); if (c === 'board' || c === 'project') name.textContent = boardName(app); });

  installPanel(app, panelEl);
  installTimeline(app, $('#timeline'));
  installPresence(app, $('#stage'), status);
  installMirror(app, outline);
  installKeys(app, tools, toggleHelp);
  installConsole(app, renderer);

  // camera memory per board
  const camKey = () => `mgl.cam.${boardName(app)}`;
  let saveTimer = 0;
  app.on('camera', () => { clearTimeout(saveTimer); saveTimer = window.setTimeout(() => ls.set(camKey(), JSON.stringify(app.camera.cam)), 400); });
  const firstView = () => {
    try { const c = JSON.parse(ls.get(camKey()) ?? 'null'); if (c && typeof c.zoom === 'number') { app.camera.set(c); return; } } catch { /* fall through */ }
    if (app.store.shapes().length) { app.fit(); }
  };

  if (embed) {
    app.store.detached = true;
    app.store.load(embed);
    app.store.setConn('detached');
    const copy = h('button', { class: 'copy-changes', 'data-mgl': 'copy-changes', title: 'Copy the edits made on this page as JSONL for mgl board edit --batch' }, 'Copy changes');
    copy.addEventListener('click', async () => {
      const text = app.store.pending.map((p) => JSON.stringify(p.op)).join('\n');
      try { await navigator.clipboard.writeText(text); app.toast(`${app.store.pending.length} change(s) copied. Apply with: mgl board edit <file> --batch changes.jsonl --by human`, 'info'); }
      catch { const ta = h('textarea', { class: 'copy-box', readonly: true, 'aria-label': 'Changes as JSONL' }); ta.value = text; document.body.append(ta); ta.select(); }
    });
    status.append(copy);
    firstView();
    return;
  }

  let advised = false, adviceTimer = 0;
  const refreshAdvice = () => { if (!advised) return; clearTimeout(adviceTimer); adviceTimer = window.setTimeout(() => void app.store.refresh(), 250); };
  void (async () => {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch('/api/state', { cache: 'no-store' });
        const st = (await r.json()) as BoardState;
        advised = Array.isArray(st.advice);
        app.store.load(st);
        break;
      } catch {
        app.store.setConn('offline');
        await new Promise((res) => setTimeout(res, Math.min(5000, 500 * (i + 1))));
      }
    }
    firstView();
    connect();
  })();

  let poll = 0;
  const startPolling = () => {
    if (poll) return;
    app.store.setConn('polling');
    poll = window.setInterval(async () => { const ok = await app.store.refresh(); app.store.setConn(ok ? 'polling' : 'offline'); }, 1000);
  };
  function connect(): void {
    if (typeof EventSource === 'undefined') return startPolling();
    let opened = false;
    const es = new EventSource('/api/events');
    const giveUp = setTimeout(() => { if (!opened) { es.close(); startPolling(); } }, 4000);
    es.addEventListener('open', () => { opened = true; clearTimeout(giveUp); if (poll) { clearInterval(poll); poll = 0; } app.store.setConn('live'); });
    es.addEventListener('error', () => { if (opened) app.store.setConn(es.readyState === EventSource.CLOSED ? 'offline' : 'polling'); if (es.readyState === EventSource.CLOSED) startPolling(); });
    const data = <T>(e: Event): T | undefined => { try { return JSON.parse((e as MessageEvent).data) as T; } catch { return undefined; } };
    es.addEventListener('state', (e) => { const d = data<{ board: BoardFile; version: number }>(e); if (d) { app.store.serverState(d.board, d.version); refreshAdvice(); } });
    es.addEventListener('project', (e) => {
      const d = data<Outline & { error?: { code: string; message: string; fix?: string } }>(e);
      if (!d) return;
      const { error, ...o } = d;
      app.store.projectError = error;
      if (error) app.toast(`Project: ${error.message}`, 'error');
      app.store.setProject((o as Outline).comps ? (o as Outline) : null);
    });
    es.addEventListener('view', (e) => { const p = data<Presence>(e); if (p && p.by) { app.store.view = { ...app.store.view, [p.by]: p }; app.store.emit('view'); } });
    es.addEventListener('focus', (e) => { const d = data<{ ids: string[] }>(e); if (d?.ids) { app.focus(d.ids); } });
    es.addEventListener('toast', (e) => { const d = data<{ by?: 'human' | 'ai'; text: string }>(e); if (d?.text) app.toast(d.text, d.by ?? 'ai'); });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
