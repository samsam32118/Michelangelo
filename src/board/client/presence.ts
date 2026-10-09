/**
 * Presence: tell the server what the person sees (POST /api/view, throttled to 200 ms: camera, selection, cursor and
 * the shapes in view, so `mgl board view` can answer "what are they looking at?"), and show the agent's presence:
 * a labelled violet cursor and a "follow" chip that jumps to the agent's camera.
 */
import type { Point, Presence } from '../shared/types.js';
import { boxesIntersect } from '../shared/geometry.js';
import type { App } from './app.js';
import { h } from './dom.js';

const STALE_MS = 60_000;

export function installPresence(app: App, stage: HTMLElement, chipHost: HTMLElement): void {
  let cursor: Point | undefined, last = 0, timer = 0;
  const post = () => {
    timer = 0; last = performance.now();
    if (app.store.detached || app.store.conn === 'offline') return;
    const vb = app.camera.viewBox();
    const inView = app.store.shapes().filter((s) => { const b = app.store.bounds(s.id); return b && boxesIntersect(b, vb); }).slice(0, 200).map((s) => s.id);
    const c = app.camera.cam;
    const body: Presence = { by: 'human', camera: { x: Math.round(c.x), y: Math.round(c.y), zoom: Math.round(c.zoom * 1000) / 1000 }, selection: app.selection, inView, ...(cursor ? { cursor: [Math.round(cursor[0]), Math.round(cursor[1])] as Point } : {}) };
    void fetch('/api/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  };
  const schedule = () => { if (timer) return; const wait = Math.max(0, 200 - (performance.now() - last)); timer = window.setTimeout(post, wait); };
  app.on('camera', schedule);
  app.on('selection', schedule);
  app.canvas.addEventListener('pointermove', (e) => { const r = app.canvas.getBoundingClientRect(); cursor = app.camera.toBoard([e.clientX - r.left, e.clientY - r.top]); schedule(); });

  // the agent's cursor
  const el = h('div', { class: 'ai-cursor', hidden: true, 'aria-hidden': 'true' });
  el.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M5 3.5l13 7.2-5.6 1.5 3.4 5.9-2.4 1.4-3.4-5.9L5.8 17.7z" fill="currentColor" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><span>AI</span>';
  stage.append(el);
  const chip = h('button', { class: 'follow', hidden: true, 'data-mgl': 'follow-ai', title: 'Jump to what the agent is looking at' }, h('span', { class: 'pulse' }), 'AI is here · follow');
  chip.addEventListener('click', () => { const c = app.store.view.ai?.camera; if (c) app.camera.animateTo(c); });
  chipHost.append(chip);
  const place = () => {
    const ai = app.store.view.ai;
    const fresh = !!ai && (ai.at === undefined || Date.now() - ai.at < STALE_MS);
    chip.hidden = !(fresh && ai?.camera);
    if (!fresh || !ai?.cursor) { el.hidden = true; return; }
    const [x, y] = app.camera.toScreen(ai.cursor);
    el.hidden = x < -20 || y < -20 || x > app.camera.w + 20 || y > app.camera.h + 20;
    el.style.transform = `translate(${x}px, ${y}px)`;
  };
  app.on('camera', place);
  app.store.on((c) => { if (c === 'view') { place(); app.invalidate(); } });
  setInterval(place, 5000);
}
