// Project files read as raw JSON (never through Michelangelo), a small structural validator, and a writer
// for fixtures in the one-entity-per-line layout (DESIGN.md §4.1).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TABLES = ['assets', 'styles', 'comps', 'tracks', 'clips', 'cues', 'buses', 'markers'];
/** Top-level keys allowed: every property of schema/v1.json (falls back to the known list if it cannot be read). */
const TOP = (() => {
  const keys = new Set(['michelangelo', '$schema', 'project', ...TABLES]);
  try {
    const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../schema/v1.json'), 'utf8'));
    for (const k of Object.keys(schema?.properties ?? {})) keys.add(k);
  } catch { /* keep the fallback */ }
  return keys;
})();
const SOURCES = ['asset', 'text', 'shape', 'color', 'comp', 'captions', 'adjustment', 'gen'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** JSON with trailing commas tolerated (the format accepts them with a warning). */
export function parseLoose(text) {
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') { let j = i + 1; while (/\s/.test(text[j] ?? '')) j++; if (text[j] === ']' || text[j] === '}') continue; }
    out += c;
  }
  return JSON.parse(out);
}

/** The project as a plain object, or null when missing / not JSON. */
export function readProject(file) {
  try { return parseLoose(readFileSync(file, 'utf8')); } catch { return null; }
}

export function compFps(comp) {
  const f = comp?.fps;
  if (typeof f === 'number') return f;
  const [n, d] = String(f ?? '30').split('/').map(Number);
  return d ? n / d : n;
}

/** A time value (frames or an edge form: "2.5s", "1:02.5", "00:01:02:15") in frames at fps; NaN if invalid. */
export function toFrames(v, fps) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  let m;
  if (/^-?\d+$/.test(s)) return Number(s);
  if ((m = /^(-?[\d.]+)s$/.exec(s))) return Math.round(Number(m[1]) * fps);
  if ((m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(s))) return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * fps) + Number(m[4]);
  if ((m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s))) return Math.round((Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * fps);
  return NaN;
}

const arr = (p, t) => (Array.isArray(p?.[t]) ? p[t] : []);

/** Structural problems of a raw project (empty list = valid enough to load): references, ids, times. */
export function validateRaw(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['not a JSON object'];
  if (p.michelangelo !== 1) errs.push('"michelangelo": 1 missing');
  for (const k of Object.keys(p)) if (!TOP.has(k)) errs.push(`unknown top-level key "${k}"`);
  for (const t of TABLES) if (p[t] !== undefined && !Array.isArray(p[t])) errs.push(`"${t}" is not an array`);
  if (!arr(p, 'comps').length) errs.push('no comps');
  const ids = new Map();
  for (const t of TABLES) for (const e of arr(p, t)) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID.test(e.id)) { errs.push(`${t}: bad or missing id ${JSON.stringify(e?.id)}`); continue; }
    if (ids.has(e.id) && t !== 'styles') errs.push(`duplicate id "${e.id}"`);
    ids.set(e.id, t);
  }
  const has = (t, id) => arr(p, t).some((e) => e.id === id);
  const comps = new Map(arr(p, 'comps').map((c) => [c.id, c]));
  for (const c of comps.values()) if (!Array.isArray(c.size) || c.size.length !== 2 || !(compFps(c) > 0)) errs.push(`comp "${c.id}": size/fps invalid`);
  const tracks = new Map(arr(p, 'tracks').map((t) => [t.id, t]));
  for (const t of tracks.values()) if (!comps.has(t.comp)) errs.push(`track "${t.id}": comp "${t.comp}" missing`);
  const clips = new Map(arr(p, 'clips').map((c) => [c.id, c]));
  for (const c of clips.values()) {
    const tr = tracks.get(c.track);
    if (!tr) { errs.push(`clip "${c.id}": track "${c.track}" missing`); continue; }
    const fps = compFps(comps.get(tr.comp));
    const srcs = SOURCES.filter((k) => c[k] !== undefined);
    if (srcs.length !== 1) errs.push(`clip "${c.id}": needs exactly one source (has ${srcs.join(', ') || 'none'})`);
    if (c.asset !== undefined && !has('assets', c.asset)) errs.push(`clip "${c.id}": asset "${c.asset}" missing`);
    if (c.comp !== undefined && !comps.has(c.comp)) errs.push(`clip "${c.id}": comp "${c.comp}" missing`);
    const at = toFrames(c.at, fps), len = toFrames(c.len, fps);
    if (!(at >= 0) || !Number.isInteger(at)) errs.push(`clip "${c.id}": at invalid`);
    if (!(len > 0) || !Number.isInteger(len)) errs.push(`clip "${c.id}": len invalid`);
    if (c.in !== undefined && !(toFrames(c.in, fps) >= 0)) errs.push(`clip "${c.id}": in invalid`);
  }
  for (const q of arr(p, 'cues')) {
    if (!clips.has(q.clip)) errs.push(`cue "${q.id}": clip "${q.clip}" missing`);
    if (typeof q.text !== 'string') errs.push(`cue "${q.id}": text missing`);
  }
  for (const m of arr(p, 'markers')) if (!comps.has(m.comp)) errs.push(`marker "${m.id}": comp "${m.comp}" missing`);
  for (const a of arr(p, 'assets')) if (typeof a.src !== 'string' || !a.src) errs.push(`asset "${a.id}": src missing`);
  return errs;
}

/** Clip timing in seconds and frames, resolved through its track's comp. */
export function clipSpan(p, c) {
  const tr = arr(p, 'tracks').find((t) => t.id === c.track);
  const comp = arr(p, 'comps').find((k) => k.id === tr?.comp);
  const fps = compFps(comp), at = toFrames(c.at, fps), len = toFrames(c.len, fps);
  return { fps, at, len, end: at + len, start: at / fps, stop: (at + len) / fps, inF: c.in === undefined ? 0 : toFrames(c.in, fps), audioTrack: !!tr?.audio, comp: comp?.id };
}

/** Assets whose src ends with the given file name. */
export const assetsNamed = (p, name) => arr(p, 'assets').filter((a) => typeof a.src === 'string' && basename(a.src.replace(/\\/g, '/')) === name);
export const tables = arr;

// ---------------------------------------------------------------- writer (fixtures)
const ORDER = {
  assets: ['id', 'src', 'kind', 'note'],
  comps: ['id', 'size', 'fps', 'length', 'bg', 'note'],
  tracks: ['id', 'comp', 'audio', 'bus', 'hidden', 'muted', 'locked', 'note'],
  clips: ['id', 'track', 'at', 'len', ...SOURCES, 'in', 'speed', 'loop', 'fit', 'crop', 'style', 'animate', 'x', 'y', 'anchor', 'scale', 'rotate', 'opacity', 'gain', 'fade', 'muted', 'tags', 'note'],
  cues: ['id', 'clip', 'at', 'len', 'text', 'words', 'speaker'],
  markers: ['id', 'comp', 'at', 'len', 'note'],
};
const ordered = (t, e) => {
  const keys = ORDER[t] ?? [];
  return Object.fromEntries([...keys.filter((k) => k in e), ...Object.keys(e).filter((k) => !keys.includes(k))].map((k) => [k, e[k]]));
};
const inline = (v) => (Array.isArray(v) ? `[${v.map(inline).join(', ')}]`
  : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')}}` : JSON.stringify(v));

export function formatProject(p) {
  const parts = [`{"michelangelo": 1`];
  if (p.project) parts.push(`"project": ${inline(p.project)}`);
  for (const t of TABLES) if (p[t]?.length) parts.push(`"${t}": [\n${p[t].map((e) => inline(ordered(t, e))).join(',\n')}\n]`);
  return `${parts[0]},\n${parts.slice(1).join(',\n')}\n}\n`;
}

export function writeProject(file, p) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatProject(p));
  return file;
}
