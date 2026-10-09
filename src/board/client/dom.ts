/** Tiny DOM helpers (no framework) and the tool icons, authored as 24×24 stroke paths. */

type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
type Child = Node | string | null | undefined | false;

/** h('button', {class: 'x', onclick: fn, 'aria-label': 'Note'}, 'text', child) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;

const NS = 'http://www.w3.org/2000/svg';
/** an inline SVG icon from path data ("d" strings; a leading "F" fills instead of stroking) */
export function icon(name: keyof typeof ICONS, size = 20): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const p = document.createElementNS(NS, 'path');
    if (d.startsWith('F')) { p.setAttribute('d', d.slice(1)); p.setAttribute('fill', 'currentColor'); }
    else { p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.75'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); }
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  select: ['M5 3.5l13 7.2-5.6 1.5 3.4 5.9-2.4 1.4-3.4-5.9L5.8 17.7z'],
  hand: ['M8 12.5V6.2a1.5 1.5 0 013 0V11', 'M11 10.5V4.7a1.5 1.5 0 013 0v5.8', 'M14 10.5V6.2a1.5 1.5 0 013 0v7.3c0 3.9-2.6 6.7-6.2 6.7-2.4 0-3.9-1-5.3-3l-2.4-3.6a1.5 1.5 0 012.4-1.8L8 13.5'],
  note: ['M5 4h14a1 1 0 011 1v9l-6 6H5a1 1 0 01-1-1V5a1 1 0 011-1z', 'M20 14h-5a1 1 0 00-1 1v5'],
  text: ['M5 6V4.5h14V6', 'M12 4.5v15', 'M9 19.5h6'],
  rect: ['M4.5 6.5a2 2 0 012-2h11a2 2 0 012 2v11a2 2 0 01-2 2h-11a2 2 0 01-2-2z'],
  ellipse: ['M12 5c4.7 0 8.5 3.1 8.5 7s-3.8 7-8.5 7-8.5-3.1-8.5-7 3.8-7 8.5-7z'],
  arrow: ['M5 19L19 5', 'M10 5h9v9'],
  draw: ['M3.5 17c2.5-6 5-9 7-7.5s-2 6 .5 7 4.5-6.5 9.5-9'],
  still: ['M3.5 6.5a2 2 0 012-2h13a2 2 0 012 2v11a2 2 0 01-2 2h-13a2 2 0 01-2-2z', 'M7.5 4.5v15M16.5 4.5v15', 'M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4'],
  pin: ['M12 21s-6.5-6-6.5-11a6.5 6.5 0 0113 0c0 5-6.5 11-6.5 11z', 'M12 12.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z'],
  frame: ['M7 3.5v17M17 3.5v17M3.5 7h17M3.5 17h17'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 010 11H11'],
  redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 000 11H13'],
  fit: ['M4 9V5a1 1 0 011-1h4M15 4h4a1 1 0 011 1v4M20 15v4a1 1 0 01-1 1h-4M9 20H5a1 1 0 01-1-1v-4'],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  panel: ['M4.5 5.5a1 1 0 011-1h13a1 1 0 011 1v13a1 1 0 01-1 1h-13a1 1 0 01-1-1z', 'M14.5 4.5v15'],
  play: ['FM8 5.5v13l10.5-6.5z'],
  outline: ['M8 6h12M8 12h12M8 18h12', 'FM4 5h2v2H4zM4 11h2v2H4zM4 17h2v2H4z'],
  keys: ['M3.5 7.5a2 2 0 012-2h13a2 2 0 012 2v9a2 2 0 01-2 2h-13a2 2 0 01-2-2z', 'M7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8'],
  theme: ['M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17z', 'FM12 3.5a8.5 8.5 0 010 17z'],
  send: ['M4 12l16-7.5-6 15-2.5-6.5z', 'M11.5 13L20 4.5'],
} satisfies Record<string, string[]>;

/** wrap localStorage: private windows, sandboxed iframes and blocked storage throw */
export const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};

export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = (): string => (isMac() ? '⌘' : 'Ctrl+');
