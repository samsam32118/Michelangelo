/**
 * In-place text editing: a textarea laid over the shape (note, text, rect/ellipse label, frame title, arrow label,
 * pin comment), styled to match at the current zoom. Commit on blur, Escape or ⌘/Ctrl-Enter (Enter for one-line
 * fields); an emptied new text shape is removed. Also a small floating prompt (pin feedback, comments).
 */
import type { Point, Shape } from '../shared/types.js';
import { palette, chrome, FONT } from '../shared/palette.js';
import type { App } from './app.js';
import { h } from './dom.js';

const field = (s: Shape): 'text' | 'label' => (s.type === 'frame' ? 'label' : 'text');

export function installEditor(app: App, stage: HTMLElement): void {
  let ta: HTMLTextAreaElement | undefined;
  let place: (() => void) | undefined;
  app.on('camera', () => place?.());
  app.setEditor((id) => {
    const s0 = app.store.get(id);
    if (!s0 || s0.locked) return;
    ta?.blur();
    const key = field(s0);
    const before = String((s0 as unknown as Record<string, unknown>)[key] ?? '');
    const oneLine = s0.type === 'frame' || s0.type === 'arrow';
    const el = h('textarea', { class: 'editor', 'aria-label': `Edit ${s0.type} ${id}`, 'data-mgl': `edit-${id}`, spellcheck: 'true' });
    el.value = before;
    ta = el;
    app.editing = id;
    app.invalidate();
    place = () => {
      const s = app.store.get(id), b = app.store.bounds(id);
      if (!s || !b) return;
      const z = app.camera.cam.zoom, c = chrome(app.theme);
      const [x, y] = app.camera.toScreen([b.x, b.y]);
      const st = el.style;
      st.left = `${x}px`; st.top = `${y}px`; st.width = `${Math.max(60, b.w * z)}px`; st.height = `${Math.max(24, b.h * z)}px`;
      st.font = `${s.type === 'text' ? 500 : 400} ${((s.type === 'text' ? s.size ?? 24 : s.type === 'note' ? 20 : s.type === 'frame' ? 14 : 16) * z).toFixed(2)}px ${FONT}`;
      st.lineHeight = '1.3';
      st.padding = s.type === 'note' ? `${16 * z}px` : '0';
      st.textAlign = s.type === 'rect' || s.type === 'ellipse' || s.type === 'arrow' ? 'center' : 'left';
      st.background = s.type === 'note' ? palette(s.color ?? 'yellow', app.theme).fill : 'transparent';
      st.color = s.type === 'note' ? palette(s.color ?? 'yellow', app.theme).text : c.ink;
      st.borderRadius = s.type === 'note' ? `${6 * z}px` : '4px';
      if (s.type === 'rect' || s.type === 'ellipse') { st.paddingTop = `${Math.max(0, b.h * z / 2 - 12 * z)}px`; }
      if (s.type === 'frame') { st.top = `${y - 30}px`; st.height = '26px'; st.width = `${Math.max(160, Math.min(400, b.w * z))}px`; st.background = c.panel; st.padding = '2px 8px'; st.font = `600 14px ${FONT}`; }
      if (s.type === 'arrow' || s.type === 'pin') { const [cx, cy] = app.camera.toScreen([b.x + b.w / 2, b.y + b.h / 2]); st.left = `${cx - 130}px`; st.top = `${cy - 16}px`; st.width = '260px'; st.height = s.type === 'pin' ? '72px' : '30px'; st.background = c.panel; st.padding = '4px 8px'; st.font = `500 14px ${FONT}`; }
    };
    place();
    stage.append(el);
    el.focus();
    el.select();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const s = app.store.get(id), v = oneLine ? el.value.replace(/\s*\n\s*/g, ' ').trim() : el.value.replace(/\s+$/, '');
      el.remove();
      if (ta === el) { ta = undefined; place = undefined; }
      app.editing = undefined;
      app.invalidate();
      if (!s) return;
      if (s.type === 'text' && !v.trim()) { void app.send([{ op: 'shape.remove', id }]); app.select([]); return; }
      if (v !== before) void app.send([{ op: 'shape.set', id, props: { [key]: v === '' ? null : v } }]);
    };
    el.addEventListener('blur', finish);
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter') || (oneLine && e.key === 'Enter')) { e.preventDefault(); el.blur(); }
    });
  });
}

/** a floating one-off input at a screen point; cb gets the text on Enter / blur (empty when cancelled with Escape) */
export function openPrompt(app: App, at: Point, placeholder: string, cb: (text: string) => void): void {
  const stage = app.canvas.parentElement!;
  const box = h('div', { class: 'prompt', role: 'dialog', 'aria-label': placeholder });
  const ta = h('textarea', { placeholder, 'aria-label': placeholder, 'data-mgl': 'prompt-input', rows: 3 });
  const hint = h('div', { class: 'hint' }, 'Enter to save · Shift-Enter new line · Esc to cancel');
  box.append(ta, hint);
  box.style.left = `${Math.min(at[0] + 12, stage.clientWidth - 300)}px`;
  box.style.top = `${Math.min(at[1] - 10, stage.clientHeight - 120)}px`;
  stage.append(box);
  ta.focus();
  let done = false;
  const end = (text: string) => { if (done) return; done = true; box.remove(); cb(text); };
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); end(''); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); end(ta.value); }
  });
  ta.addEventListener('blur', () => end(ta.value));
}
