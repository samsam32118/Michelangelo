/** Keyboard shortcuts (BOARD.md §8). Ignored while typing in a field. `SHORTCUTS` feeds the tooltips and the ? sheet. */
import type { BoardOp, Shape, Who } from '../shared/types.js';
import type { App, ToolName } from './app.js';
import type { Tools } from './tools.js';
import { shift } from './tools.js';
import { ID_PREFIX } from './local-ops.js';
import { modKey } from './dom.js';

export const TOOL_KEYS: Record<string, ToolName> = { v: 'select', h: 'hand', n: 'note', t: 'text', r: 'rect', o: 'ellipse', a: 'arrow', d: 'draw', s: 'still', p: 'pin', f: 'frame' };

export function shortcuts(): [string, string][] {
  const m = modKey();
  return [
    ['V', 'Select'], ['H / hold Space', 'Hand (pan)'], ['N', 'Note'], ['T', 'Text'], ['R', 'Rectangle'], ['O', 'Ellipse'], ['A', 'Arrow'],
    ['D', 'Draw'], ['S', 'Still at the playhead'], ['P', 'Pin feedback'], ['F', 'Frame'],
    ['Delete / Backspace', 'Delete selection'], [`${m}Z`, 'Undo'], [`${m}Shift Z`, 'Redo'], [`${m}D`, 'Duplicate'], [`${m}A`, 'Select all'],
    ['Arrow keys', 'Nudge 1 px (Shift: 10 px)'], ['Enter / double-click', 'Edit text'], ['Esc', 'Deselect / back to Select'],
    [`${m}0`, 'Zoom to fit'], [`${m}+ / ${m}−`, 'Zoom in / out'], ['Shift 0', 'Zoom 100%'], [']  /  [', 'Bring forward / send backward'],
    ['Shift ]  /  Shift [', 'Bring to front / send to back'], [',  /  .', 'Playhead back / forward one frame'], ['?', 'This sheet'],
  ];
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function installKeys(app: App, tools: Tools, toggleHelp: () => void): void {
  let nudge: { dx: number; dy: number; timer: number; ids: string[] } | undefined;
  const flushNudge = () => {
    if (!nudge) return;
    const { dx, dy, ids } = nudge;
    nudge = undefined;
    if (dx || dy) void app.send([{ op: 'shape.move', ids, dx, dy }]);
    app.store.clearOverrides();
  };

  window.addEventListener('keydown', (e) => {
    if (typing(e.target)) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    const sel = app.selection;
    const editable = () => sel.filter((id) => !app.store.get(id)?.locked);
    if (e.key === ' ' && !mod) { if (!tools.space) tools.setSpace(true); e.preventDefault(); return; }
    if (mod && k === 'z') { e.preventDefault(); void undo(app, e.shiftKey ? 'redo' : 'undo'); return; }
    if (mod && k === 'y') { e.preventDefault(); void undo(app, 'redo'); return; }
    if (mod && k === 'a') { e.preventDefault(); app.select(app.store.shapes().map((s) => s.id)); return; }
    if (mod && k === 'd') { e.preventDefault(); duplicate(app); return; }
    if (mod && (k === '0')) { e.preventDefault(); app.fit(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); app.camera.zoomAt([app.camera.w / 2, app.camera.h / 2], 1.25); return; }
    if (mod && (k === '-' || k === '_')) { e.preventDefault(); app.camera.zoomAt([app.camera.w / 2, app.camera.h / 2], 0.8); return; }
    if (mod) return;
    if (e.shiftKey && (k === ')' || e.code === 'Digit0')) { app.camera.zoomAt([app.camera.w / 2, app.camera.h / 2], 1 / app.camera.cam.zoom); return; }
    if (e.key === '?') { toggleHelp(); return; }
    if (e.key === 'Escape') { if (app.tool !== 'select') app.setTool('select'); else app.select([]); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const ids = editable();
      if (ids.length) { e.preventDefault(); void app.send([{ op: 'shape.remove', ids }]); app.select([]); }
      return;
    }
    if (e.key === 'Enter' && sel.length === 1) { e.preventDefault(); app.editText(sel[0]!); return; }
    if (e.key.startsWith('Arrow') && sel.length) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] ?? [0, 0];
      const ids = editable().filter((id) => app.store.get(id)?.type !== 'pin');
      if (!ids.length) return;
      if (nudge && nudge.ids.join() !== ids.join()) flushNudge();
      nudge ??= { dx: 0, dy: 0, timer: 0, ids };
      nudge.dx += d[0]!; nudge.dy += d[1]!;
      clearTimeout(nudge.timer);
      const all = withChildren(app, ids), m = new Map<string, Shape>();
      for (const id of all) m.set(id, shift(app.store.get(id)!, d[0]!, d[1]!)); // get() already includes earlier nudges
      app.store.setOverrides(m);
      nudge.timer = window.setTimeout(flushNudge, 400);
      return;
    }
    if (e.key === ']' || e.key === '}') { if (sel.length) void app.send([{ op: 'shape.order', ids: sel, to: e.shiftKey ? 'front' : 'forward' }]); return; }
    if (e.key === '[' || e.key === '{') { if (sel.length) void app.send([{ op: 'shape.order', ids: sel, to: e.shiftKey ? 'back' : 'backward' }]); return; }
    if (e.key === ',' || e.key === '.') { app.setPlayhead(app.playhead + (e.key === ',' ? -1 : 1) * (e.shiftKey ? 10 : 1)); return; }
    const tool = TOOL_KEYS[k];
    if (tool && !e.altKey) { app.setTool(tool); return; }
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') tools.setSpace(false); });
  window.addEventListener('blur', () => tools.setSpace(false));
}

function withChildren(app: App, ids: string[]): Set<string> {
  const out = new Set(ids);
  for (let grew = true; grew;) { grew = false; for (const s of app.store.shapes()) if (s.parent && out.has(s.parent) && !out.has(s.id)) { out.add(s.id); grew = true; } }
  return out;
}

/** Undo / redo through the shared history. `by`: who is asking; undo refuses the other party's step unless `force`. */
export async function undo(app: App, which: 'undo' | 'redo', by: Who = 'human', force = false): Promise<Record<string, unknown>> {
  const r = await app.store.post(`/api/${which}`, { by, ...(force ? { force: true } : {}) });
  if (r.ok === false) app.toast(String((r.error as { message?: string })?.message ?? `${which} failed`), 'error');
  else if (app.store.conn !== 'live') void app.store.refresh();
  return r;
}

/** duplicate the selection (+ frame children) 24 px down-right; arrows between copies are rebound to the copies */
export function duplicate(app: App): void {
  const ids = [...withChildren(app, app.selection)].filter((id) => app.store.get(id)?.type !== 'pin');
  if (!ids.length) return;
  const map = new Map<string, string>(), taken: string[] = [];
  for (const id of ids) { const s = app.store.get(id)!; const n = app.store.newId(ID_PREFIX[s.type], taken); taken.push(n); map.set(id, n); }
  const ops: BoardOp[] = [];
  for (const id of app.store.shapes().map((s) => s.id).filter((x) => map.has(x))) {
    const s = structuredClone(app.store.get(id)!) as Shape & Record<string, unknown>;
    const c = shift(s, 24, 24) as Shape & Record<string, unknown>;
    c.id = map.get(id)!;
    delete c.by;
    if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent);
    if (c.type === 'arrow') for (const k of ['from', 'to'] as const) { const v = c[k]; if (typeof v === 'string' && map.has(v)) c[k] = map.get(v); }
    ops.push({ op: 'shape.add', shape: c as never });
  }
  const top = app.selection.map((id) => map.get(id)).filter((x): x is string => !!x);
  void app.send(ops).then((r) => { if (r.ok) app.select(top); });
  app.select(top);
}
