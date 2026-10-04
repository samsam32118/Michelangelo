// Project files read as RAW JSON (never through Michelangelo): parsing, time conversion, queries, validation.
import { readFileSync } from 'node:fs';

/** Walk text, copying strings verbatim; `other(i)` handles the rest and returns [emitted, next index]. */
function scan(text, other) {
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    const [s, n] = other(i);
    out += s; i = n;
  }
  return out;
}

/** Remove comments, then trailing commas (outside strings), then JSON.parse. Throws on invalid JSON. */
export function parseLoose(text) {
  const noComments = scan(text, (i) => {
    if (text[i] === '/' && text[i + 1] === '/') { let j = i; while (j < text.length && text[j] !== '\n') j++; return ['', j]; }
    if (text[i] === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); return ['', e < 0 ? text.length : e + 2]; }
    return [text[i], i + 1];
  });
  const t = noComments;
  return JSON.parse(scan(t, (i) => {
    if (t[i] === ',') { let j = i + 1; while (j < t.length && /\s/.test(t[j])) j++; if (t[j] === ']' || t[j] === '}') return ['', i + 1]; }
    return [t[i], i + 1];
  }));
}

/** Read a project file; returns undefined if missing or not JSON (use readProjectResult for the error). */
export function readProject(file) {
  try { return parseLoose(readFileSync(file, 'utf8')); } catch { return undefined; }
}
export function readProjectResult(file) {
  try { return { project: parseLoose(readFileSync(file, 'utf8')) }; } catch (e) { return { error: String(e.message ?? e) }; }
}

/** Frames per second (number) of a comp's fps field (30, 29.97, "30000/1001"). */
export function compRate(comp) {
  const f = comp?.fps ?? 30;
  if (typeof f === 'number') return f;
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(String(f).trim());
  return m ? Number(m[1]) / Number(m[2] ?? 1) : 30;
}

/** A time value as written in the file (frames, "2.5s", "1:02.5", "00:01:02:15") → frames (rounded). */
export function toFrames(v, rate) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  let m;
  if ((m = /^(-?\d+(?:\.\d+)?)s$/.exec(s))) return Math.round(Number(m[1]) * rate);
  if ((m = /^(-?\d+(?:\.\d+)?)f?$/.exec(s))) return Math.round(Number(m[1]));
  if ((m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(s))) return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * rate) + Number(m[4]);
  if ((m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s))) return Math.round((Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * rate);
  return NaN;
}
export const framesToSeconds = (f, rate) => f / rate;
export const secondsToFrames = (s, rate) => Math.round(s * rate);

export const clipsById = (p) => new Map((p.clips ?? []).map((c) => [c.id, c]));
export const tracksById = (p) => new Map((p.tracks ?? []).map((t) => [t.id, t]));
export const compById = (p, id) => (p.comps ?? []).find((c) => c.id === id);
export function mainComp(p) {
  const id = p.project?.main ?? 'main';
  return compById(p, id) ?? (p.comps ?? [])[0];
}
export const compOfTrack = (p, trackId) => compById(p, tracksById(p).get(trackId)?.comp);
export const compOfClip = (p, c) => compOfTrack(p, c.track);
export const tracksOf = (p, compId) => (p.tracks ?? []).filter((t) => t.comp === compId);
export const clipsOn = (p, trackId) => (p.clips ?? []).filter((c) => c.track === trackId).sort((a, b) => toFrames(a.at, 30) - toFrames(b.at, 30));
export const clipsInComp = (p, compId) => { const ts = new Set(tracksOf(p, compId).map((t) => t.id)); return (p.clips ?? []).filter((c) => ts.has(c.track)); };
export const findClip = (p, pred) => (p.clips ?? []).find(pred);
export const textClips = (p) => (p.clips ?? []).filter((c) => typeof c.text === 'string');

/** A clip's span in seconds in its own comp: {start, end, rate}. */
export function span(p, c) {
  const rate = compRate(compOfClip(p, c));
  const at = toFrames(c.at, rate), len = toFrames(c.len, rate);
  return { start: at / rate, end: (at + len) / rate, at, len, rate };
}

/**
 * Absolute spans (seconds in the main comp) of a clip, following nested comp clips upwards.
 * A clip inside comp X used by N comp clips in main has N spans (clipped to the parent clip's span).
 */
export function absoluteSpans(p, c, depth = 0) {
  const comp = compOfClip(p, c);
  if (!comp || depth > 8) return [];
  const s = span(p, c);
  const main = mainComp(p);
  if (comp.id === main?.id) return [{ start: s.start, end: s.end }];
  const res = [];
  for (const parent of (p.clips ?? []).filter((x) => x.comp === comp.id)) {
    const pr = compRate(comp);
    const inOff = toFrames(parent.in ?? 0, pr) / pr;
    for (const ps of absoluteSpans(p, parent, depth + 1)) {
      const st = ps.start + s.start - inOff, en = ps.start + s.end - inOff;
      const a = Math.max(st, ps.start), b = Math.min(en, ps.end);
      if (b > a) res.push({ start: a, end: b });
    }
  }
  return res;
}

/** The resolved text style of a clip: styles-table chain (base) + inline overrides. Built-in bases are not expanded. */
export function resolveStyle(p, c) {
  const table = new Map((p.styles ?? []).map((s) => [s.id, s]));
  const chain = (id, depth = 0) => {
    const s = table.get(id);
    if (!s || depth > 8) return { ...(id ? { builtin: id } : {}) };
    const { id: _i, base, ...rest } = s;
    return { ...(base ? chain(base, depth + 1) : {}), ...rest };
  };
  if (typeof c.style === 'string') return chain(c.style);
  if (c.style && typeof c.style === 'object') { const { base, ...rest } = c.style; return { ...(base ? chain(base) : {}), ...rest }; }
  return {};
}

/** Value of a constant-or-keyframed property at clip-local frame f (linear between keys; easing ignored). */
export function valueAt(v, f, dflt) {
  if (v === undefined) return dflt;
  if (!isKeyframes(v)) return v;
  const keys = v.map((k) => [toFrames(k[0], 30), k[1], k[2]]);
  if (f <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (f <= keys[i][0]) {
      const [f0, v0, e] = keys[i - 1], [f1, v1] = keys[i];
      if (e === 'hold') return v0;
      const t = (f - f0) / (f1 - f0 || 1);
      return Array.isArray(v0) ? v0.map((x, j) => x + (v1[j] - x) * t) : v0 + (v1 - v0) * t;
    }
  }
  return keys[keys.length - 1][1];
}
export const isKeyframes = (v) => Array.isArray(v) && v.length > 0 && v.every((k) => Array.isArray(k) && (k.length === 2 || k.length === 3) && (typeof k[0] === 'number' || typeof k[0] === 'string'));

/** Easing names used in a keyframed property (third element of each key). */
export const easingsOf = (v) => (isKeyframes(v) ? v.map((k) => k[2]).filter((e) => e !== undefined) : []);

// ---------------------------------------------------------------------------------------------
// Independent validation of the file format (DESIGN §4): keys, references, overlaps, cues.
// ---------------------------------------------------------------------------------------------
const KEYS = {
  root: ['michelangelo', '$schema', 'project', 'assets', 'comps', 'tracks', 'clips', 'cues', 'styles', 'buses', 'markers'],
  project: ['name', 'plugins', 'platform', 'main'],
  assets: ['id', 'src', 'kind', 'note'],
  comps: ['id', 'size', 'fps', 'length', 'bg', 'note'],
  tracks: ['id', 'comp', 'audio', 'bus', 'hidden', 'muted', 'locked', 'note'],
  clips: ['id', 'track', 'at', 'len', 'asset', 'text', 'shape', 'color', 'comp', 'captions', 'adjustment', 'gen', 'in', 'speed', 'gain', 'fade', 'muted', 'loop', 'fit', 'crop',
    'style', 'animate', 'x', 'y', 'anchor', 'scale', 'rotate', 'opacity', 'blend', 'parent', 'matte', 'remap', 'link', 'fx', 'masks', 'transition', 'clock', 'hidden', 'locked', 'tags', 'note'],
  cues: ['id', 'clip', 'at', 'len', 'text', 'words', 'speaker'],
  styles: ['id', 'font', 'size', 'weight', 'italic', 'color', 'align', 'lineHeight', 'letterSpacing', 'stroke', 'strokeWidth', 'shadow', 'shadowBlur', 'shadowOffset', 'bg', 'bgPadding',
    'bgRadius', 'maxWidth', 'uppercase', 'highlight', 'maxWords', 'maxLines', 'box', 'base'],
  buses: ['id', 'gain', 'muted', 'duck', 'loudness', 'to'],
  markers: ['id', 'comp', 'at', 'len', 'note'],
};
const SOURCES = ['asset', 'text', 'shape', 'color', 'comp', 'captions', 'adjustment', 'gen'];

/** Validate a raw project: returns a list of error strings (empty = valid). */
export function validateRaw(p) {
  const errs = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['not a JSON object'];
  if (p.michelangelo !== 1) errs.push('"michelangelo" must be 1');
  for (const k of Object.keys(p)) if (!KEYS.root.includes(k)) errs.push(`unknown top-level key "${k}"`);
  if (p.project) for (const k of Object.keys(p.project)) if (!KEYS.project.includes(k)) errs.push(`unknown project key "${k}"`);
  if (!Array.isArray(p.comps) || !p.comps.length) errs.push('no comps');
  const ids = new Set();
  for (const t of ['assets', 'styles', 'comps', 'tracks', 'clips', 'cues', 'buses', 'markers']) {
    if (p[t] === undefined) continue;
    if (!Array.isArray(p[t])) { errs.push(`"${t}" must be an array`); continue; }
    for (const e of p[t]) {
      if (!e || typeof e !== 'object') { errs.push(`${t}: entry is not an object`); continue; }
      if (typeof e.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(e.id)) errs.push(`${t}: bad id ${JSON.stringify(e.id)}`);
      else if (ids.has(e.id)) errs.push(`duplicate id "${e.id}"`);
      else ids.add(e.id);
      for (const k of Object.keys(e)) if (!KEYS[t].includes(k)) errs.push(`${t} "${e.id}": unknown key "${k}"`);
    }
  }
  if (errs.length) return errs;
  const comps = new Map(p.comps.map((c) => [c.id, c]));
  for (const c of p.comps) {
    if (!Array.isArray(c.size) || c.size.length !== 2 || !c.size.every((v) => Number.isInteger(v) && v >= 2)) errs.push(`comp "${c.id}": bad size`);
    if (!(compRate(c) > 0)) errs.push(`comp "${c.id}": bad fps`);
  }
  const tracks = new Map((p.tracks ?? []).map((t) => [t.id, t]));
  const assets = new Set((p.assets ?? []).map((a) => a.id));
  const styles = new Set((p.styles ?? []).map((s) => s.id));
  for (const t of tracks.values()) if (!comps.has(t.comp)) errs.push(`track "${t.id}": comp "${t.comp}" does not exist`);
  const clips = clipsById(p);
  const byTrack = new Map();
  for (const c of p.clips ?? []) {
    const t = tracks.get(c.track);
    if (!t) { errs.push(`clip "${c.id}": track "${c.track}" does not exist`); continue; }
    const rate = compRate(comps.get(t.comp));
    const at = toFrames(c.at, rate), len = toFrames(c.len, rate);
    if (!Number.isInteger(at) || at < 0) errs.push(`clip "${c.id}": bad at`);
    if (!Number.isInteger(len) || len <= 0) errs.push(`clip "${c.id}": bad len`);
    const src = SOURCES.filter((k) => c[k] !== undefined);
    if (src.length !== 1) errs.push(`clip "${c.id}": ${src.length} sources`);
    if (c.asset !== undefined && !assets.has(c.asset)) errs.push(`clip "${c.id}": asset "${c.asset}" does not exist`);
    if (c.comp !== undefined && (!comps.has(c.comp) || c.comp === t.comp)) errs.push(`clip "${c.id}": bad nested comp "${c.comp}"`);
    if (typeof c.style === 'string' && !styles.has(c.style) && !['title', 'subtitle', 'caption', 'karaoke', 'pop', 'boxed', 'lower-third', 'cta', 'label', 'body'].includes(c.style)) errs.push(`clip "${c.id}": style "${c.style}" does not exist`);
    if (t.audio && c.asset === undefined) errs.push(`clip "${c.id}": visual clip on audio track`);
    if (c.parent !== undefined && !clips.has(c.parent)) errs.push(`clip "${c.id}": parent does not exist`);
    if (c.matte && !clips.has(c.matte.clip)) errs.push(`clip "${c.id}": matte clip does not exist`);
    if (!byTrack.has(c.track)) byTrack.set(c.track, []);
    byTrack.get(c.track).push({ id: c.id, at, len });
  }
  for (const [tid, list] of byTrack) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 1; i < list.length; i++) if (list[i].at < list[i - 1].at + list[i - 1].len) errs.push(`clips "${list[i - 1].id}" and "${list[i].id}" overlap on ${tid}`);
  }
  for (const q of p.cues ?? []) {
    const c = clips.get(q.clip);
    if (!c || !c.captions) { errs.push(`cue "${q.id}": clip "${q.clip}" is not a captions clip`); continue; }
    if (typeof q.text !== 'string') errs.push(`cue "${q.id}": no text`);
    if (Array.isArray(q.words) && q.words.length !== String(q.text).split(/\s+/).filter(Boolean).length) errs.push(`cue "${q.id}": words count mismatch`);
  }
  for (const m of p.markers ?? []) if (!comps.has(m.comp)) errs.push(`marker "${m.id}": comp does not exist`);
  return errs;
}

/** Gaps between consecutive clips on a track (frames): [{after, before, gap}]. */
export function trackGaps(p, trackId) {
  const rate = compRate(compOfTrack(p, trackId));
  const list = clipsOn(p, trackId).map((c) => ({ id: c.id, at: toFrames(c.at, rate), len: toFrames(c.len, rate) })).sort((a, b) => a.at - b.at);
  const gaps = [];
  for (let i = 1; i < list.length; i++) { const g = list[i].at - (list[i - 1].at + list[i - 1].len); if (g !== 0) gaps.push({ after: list[i - 1].id, before: list[i].id, gap: g }); }
  return gaps;
}

/** Write a project in the Michelangelo layout: one entity per line, tables in file order (for fixtures). */
export function formatProject(p) {
  const head = ['michelangelo', '$schema', 'project'].filter((k) => p[k] !== undefined).map((k) => `${JSON.stringify(k)}: ${inline(p[k])}`);
  const tables = ['assets', 'styles', 'comps', 'tracks', 'clips', 'cues', 'buses', 'markers'].filter((t) => Array.isArray(p[t]) && p[t].length)
    .map((t) => `${JSON.stringify(t)}: [\n${p[t].map(inline).join(',\n')}\n]`);
  return `{${[...head, ...tables].join(',\n')}\n}\n`;
}
function inline(v) {
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')}}`;
  return JSON.stringify(v);
}
