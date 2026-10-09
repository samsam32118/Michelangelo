/**
 * The bottom strip: the main comp's tracks and clips (labelled), a ruler, and a playhead to drag. Scrubbing shows a
 * live still of the playhead (GET /api/still at thumb width, debounced: stills are cheap, not free) and the time; the
 * still tool places stills at the playhead. The spend meter shows measured render time against the budget.
 */
import { formatMs, formatSeconds, formatTime } from '../shared/time.js';
import { compOf } from '../shared/outline.js';
import type { App } from './app.js';
import { h, icon, store as ls } from './dom.js';
import { spentMs } from './advice.js';

const PREVIEW_W = 270;

export function installTimeline(app: App, root: HTMLElement): void {
  const title = h('span', { class: 'tl-title' });
  const time = h('span', { class: 'tl-time', 'aria-live': 'off', 'data-mgl': 'playhead-time' });
  const spend = h('span', { class: 'tl-spend', 'data-mgl': 'spend-meter' });
  const stillBtn = h('button', { class: 'tl-btn', 'data-mgl': 'still-at-playhead', title: 'Add a still of the playhead to the board (S, then click, to place it yourself)', onclick: () => addStill() }, icon('still', 16), 'Still here');
  const collapse = h('button', { class: 'tl-btn icon-only', 'aria-label': 'Collapse timeline', 'aria-expanded': 'true', 'data-mgl': 'timeline-toggle', onclick: () => toggle() }, icon('minus', 16));
  const ruler = h('div', { class: 'tl-ruler', 'aria-hidden': 'true' });
  const tracks = h('div', { class: 'tl-tracks' });
  const head = h('div', { class: 'tl-playhead', role: 'slider', tabindex: 0, 'aria-label': 'Playhead', 'data-mgl': 'playhead', 'aria-valuemin': 0 });
  const body = h('div', { class: 'tl-body' }, ruler, tracks, head);
  const img = h('img', { alt: '', width: PREVIEW_W });
  const cap = h('span', { class: 'cap' });
  const preview = h('div', { class: 'tl-preview', hidden: true, 'aria-hidden': 'true' }, img, cap);
  const empty = h('p', { class: 'tl-empty' }, 'No linked project: sketch freely. Stills and the timeline appear when the board is opened through its project (mgl board serve video.mgl.json).');
  root.append(h('div', { class: 'tl-head' }, title, time, h('span', { class: 'grow' }), spend, stillBtn, collapse), body, empty, preview);
  if (ls.get('mgl.tl') === 'closed') root.classList.add('collapsed');

  const comp = () => compOf(app.store.project);
  const len = () => Math.max(1, comp()?.length || (comp()?.fps ?? 30) * 10);
  const xOf = (f: number) => `${(f / len()) * 100}%`;

  function toggle(): void {
    const closed = root.classList.toggle('collapsed');
    collapse.setAttribute('aria-expanded', String(!closed));
    ls.set('mgl.tl', closed ? 'closed' : 'open');
    app.emit('layout');
  }

  function renderStrip(): void {
    const o = app.store.project, c = comp();
    root.classList.toggle('no-project', !o || !c);
    if (!o || !c) { title.textContent = 'Timeline'; tracks.replaceChildren(); ruler.replaceChildren(); renderHead(); return; }
    title.textContent = `${c.id} ${c.size[0]}×${c.size[1]}`;
    title.title = `${c.id} · ${c.size[0]}×${c.size[1]} · ${Math.round(c.fps * 100) / 100} fps`;
    const secs = len() / c.fps, step = [1, 2, 5, 10, 15, 30, 60, 120].find((x) => secs / x <= 12) ?? 300;
    const ticks: HTMLElement[] = [];
    for (let t = 0; t * c.fps <= len(); t += step) { const el = h('span', {}, `${t}s`); el.style.left = xOf(t * c.fps); ticks.push(el); }
    ruler.replaceChildren(...ticks);
    const rows = o.tracks.filter((t) => t.comp === c.id).map((t) => {
      const row = h('div', { class: `tl-track${t.audio ? ' audio' : ''}`, 'aria-label': `Track ${t.id}` }, h('span', { class: 'tl-tname' }, t.id));
      for (const cl of o.clips.filter((x) => x.track === t.id)) {
        const el = h('button', { class: `tl-clip k-${cl.kind.replace(/[^a-z]/g, '')}`, title: `${cl.id} · ${cl.label} · ${formatTime(cl.at, c.fps)}–${formatTime(cl.at + cl.len, c.fps)}`, 'data-mgl': `clip-${cl.id}`, onclick: () => app.setPlayhead(cl.at) }, cl.label || cl.id);
        el.style.left = xOf(cl.at);
        el.style.width = `calc(${(cl.len / len()) * 100}% - 1px)`;
        row.append(el);
      }
      return row;
    });
    tracks.replaceChildren(...rows);
    renderHead();
  }

  function renderHead(): void {
    const c = comp(), fps = c?.fps ?? 30;
    head.style.left = xOf(Math.min(app.playhead, len()));
    head.setAttribute('aria-valuemax', String(len()));
    head.setAttribute('aria-valuenow', String(app.playhead));
    head.setAttribute('aria-valuetext', formatTime(app.playhead, fps));
    time.textContent = `${formatTime(app.playhead, fps)} / ${formatTime(len(), fps)} · f${app.playhead}`;
  }

  function renderSpend(): void {
    const b = app.store.board, ms = spentMs(b), budget = b.brief?.budget?.cpuMin;
    const pct = budget ? Math.min(100, (ms / 60000 / budget) * 100) : 0;
    const bar = h('i', { class: pct > 80 ? 'hot' : '' }); bar.style.width = `${pct}%`;
    spend.replaceChildren(h('span', {}, `${formatMs(ms)}${budget ? ` / ${budget} min` : ''}`), budget ? h('span', { class: 'meter', title: `${Math.round(pct)} % of the render budget` }, bar) : '');
    spend.title = `Measured render time so far (${(b.spend ?? []).length} renders)${budget ? `, budget ${budget} render min (wall clock)` : ''}`;
  }

  // scrubbing + debounced still preview
  let timer = 0, dragging = false;
  const frameAt = (clientX: number) => { const r = body.getBoundingClientRect(); return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * len()); };
  const showPreview = () => {
    if (!app.store.project || app.store.detached) return; // an exported page has no server to render previews
    const c = comp()!;
    preview.hidden = false;
    const r = body.getBoundingClientRect(), x = (app.playhead / len()) * r.width;
    preview.style.left = `${Math.max(0, Math.min(r.width - PREVIEW_W, x - PREVIEW_W / 2))}px`;
    cap.textContent = formatTime(app.playhead, c.fps);
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const q = new URLSearchParams({ t: String(app.playhead), w: String(PREVIEW_W), by: 'human' });
      img.src = `/api/still?${q}`;
    }, 140);
  };
  body.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).closest('.tl-clip') && e.detail > 1) return; dragging = true; body.setPointerCapture(e.pointerId); app.setPlayhead(frameAt(e.clientX)); showPreview(); });
  body.addEventListener('pointermove', (e) => { if (dragging) { app.setPlayhead(frameAt(e.clientX)); showPreview(); } });
  const stop = () => { if (dragging) { dragging = false; window.setTimeout(() => { if (!dragging) preview.hidden = true; }, 1600); } };
  body.addEventListener('pointerup', stop);
  body.addEventListener('pointercancel', stop);
  head.addEventListener('keydown', (e) => {
    const fps = comp()?.fps ?? 30, d = { ArrowLeft: -1, ArrowRight: 1, PageDown: -fps, PageUp: fps }[e.key];
    if (d) { e.preventDefault(); e.stopPropagation(); app.setPlayhead(Math.min(len(), app.playhead + d * (e.shiftKey ? 10 : 1))); showPreview(); }
  });

  function addStill(): void {
    if (!app.store.project) { app.toast('Stills need a linked project.', 'error'); return; }
    void app.send([{ op: 'still.add', t: formatSeconds(app.playhead, comp()!.fps), fidelity: 'thumb' }]);
  }

  app.on('playhead', renderHead);
  app.store.on((c) => { if (c === 'project') renderStrip(); if (c === 'board') renderSpend(); });
  renderStrip();
  renderSpend();
}
