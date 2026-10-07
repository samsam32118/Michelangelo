/** `mgl show`: the outline of a project in ≤ 40 lines, the storyboard as text, one clip, what is on screen at a time, or a media probe. */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fail, suggest } from '../core/errors.js';
import { formatProject } from '../core/format.js';
import { isKeyframes } from '../core/load.js';
import { clipKind, type Clip, type Comp, type ProjectFile, type Track } from '../core/schema/index.js';
import { kindFromExtension } from '../core/commands/structure.js';
import { parseRate, parseTime, formatSeconds, parseSpeed, type Rate } from '../core/time.js';
import { Project, workDir } from '../sdk/project.js';
import { MAX_LINES, bool, bytesText, clip as cut, str, type Args, type Out } from './io.js';

const MEDIA_RE = /\.(mp4|mov|m4v|mkv|webm|avi|mxf|gif|wav|mp3|aac|m4a|flac|ogg|opus|aif|aiff|png|jpe?g|webp|bmp|avif)$/i;

export async function show(a: Args, o: Out) {
  const file = a.pos[0];
  if (!file) fail('E_USAGE', 'show needs a file.', 'mgl show video.mgl.json (or a media file: mgl show clip.mp4)');
  if (a.pos.length > 1) fail('E_USAGE', `show takes one file; got extra "${a.pos[1]}".`, 'options go after the file: mgl show video.mgl.json --at 2s');
  if (MEDIA_RE.test(file)) return showMedia(file, o);
  const p = await Project.open(file);
  const v = new View(p.data, p, a);
  if (str(a, 'clip')) return v.clipDetail(str(a, 'clip')!, o);
  if (str(a, 'scene') !== undefined) return v.scene(str(a, 'scene')!, o, file);
  if (bool(a, 'scenes')) return v.scenes(o, file);
  if (bool(a, 'assets')) return v.assets(o);
  if (str(a, 'at')) return v.at(str(a, 'at')!, o);
  return v.outline(o, file);
}

async function showMedia(file: string, o: Out) {
  if (!existsSync(file)) fail('E_NO_FILE', `${file} does not exist.`, 'check the path (relative to the current directory).');
  const { getMediaBackend } = await import('../media/index.js');
  const info = await getMediaBackend().probe(resolve(file));
  const parts: string[] = [info.kind];
  if (info.hasVideo) parts.push(`${info.videoCodec ?? '?'} ${info.width}x${info.height}${info.fps ? ` ${fpsText(info.fps)}fps${info.vfr ? ' (VFR)' : ''}` : ''}${info.rotation ? ` rotated ${info.rotation}°` : ''}${info.colorTransfer && /smpte2084|arib-std-b67/.test(info.colorTransfer) ? ' HDR' : ''}`);
  if (info.duration) parts.push(`${info.duration.toFixed(2)}s`);
  if (info.hasAudio) parts.push(`audio ${info.audioCodec ?? '?'}${info.sampleRate ? ` ${info.sampleRate} Hz` : ''}${info.channels ? ` ${info.channels} ch` : ''}`);
  parts.push(bytesText(info.size));
  o.line(`${file}: ${parts.join(' · ')}`);
  o.hint(`use it: mgl edit <project> clip.add src=${file}`);
  o.set({ file, media: info });
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function fpsText(r: Rate): string {
  const v = r.num / r.den;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '');
}

/** "counter from=3 to=1 decimals=0": a generator's type and its first params (keyframed ones as name~Nkeys). */
export function genSummary(g: Record<string, unknown>): string {
  const ps = Object.entries(g).filter(([k]) => k !== 'type').map(([k, v]) => {
    if (isKeyframes(v)) return `${k}~${(v as unknown[]).length}keys`;
    if (v !== null && typeof v === 'object') return `${k}=${cut(JSON.stringify(v), 24)}`;
    return `${k}=${typeof v === 'string' ? cut(v.includes(' ') ? JSON.stringify(v) : v, 24) : String(v)}`;
  });
  return cut([String(g.type), ...ps].join(' '), 90);
}

/** "dialogue fx highpass,deesser → master" */
export function busText(b: { id: string; to?: string; gain?: number; muted?: boolean; duck?: { by: string; db: number }; loudness?: { lufs: number; peak?: number }; fx?: { type: string }[] }): string {
  const bits = [b.id];
  if (b.gain !== undefined) bits.push(`${b.gain}dB`);
  if (b.muted) bits.push('muted');
  if (b.fx?.length) bits.push(`fx ${b.fx.map((f) => f.type).join(',')}`);
  if (b.duck) bits.push(`ducked ${b.duck.db}dB by ${b.duck.by}`);
  if (b.loudness) bits.push(`${b.loudness.lufs} LUFS${b.loudness.peak !== undefined ? ` / ${b.loudness.peak} dBTP` : ''}`);
  if (b.id !== 'master') bits.push(`→ ${b.to ?? 'master'}`);
  return bits.join(' ');
}

/** Marker entries packed into lines of at most ~160 characters ("markers: a 0.00 \"Intro\", b 12.00 ..."). */
function markerLines(items: string[]): string[] {
  const out: string[] = [];
  let cur = 'markers:';
  for (const it of items) {
    if (cur.length + it.length + 2 > 160 && cur !== 'markers:') { out.push(cur.replace(/,$/, '')); cur = ' '; }
    cur += ` ${it},`;
  }
  out.push(cur.replace(/,$/, ''));
  return out;
}

const KIND_LABEL: Record<string, string> = { text: 'text', shape: 'shape', solid: 'solid', comp: 'comp', captions: 'caps', adjustment: 'adjust', gen: 'gen' };

class View {
  private comps: Map<string, Comp>;
  private tracks: Track[];
  constructor(private d: ProjectFile, private p: Project, private a: Args) {
    this.comps = new Map(d.comps.map((c) => [c.id, c]));
    this.tracks = d.tracks ?? [];
  }

  private comp(): Comp {
    const id = str(this.a, 'comp');
    if (id) {
      const c = this.comps.get(id);
      if (!c) fail('E_REF', `comp "${id}" does not exist.`, `comps: ${[...this.comps.keys()].join(', ')}`);
      return c;
    }
    return this.p.mainComp();
  }
  private rateOf(c: Comp): Rate { return parseRate(c.fps); }
  private compOfTrack(t: string): Comp { return this.comps.get(this.tracks.find((x) => x.id === t)?.comp ?? '') ?? this.d.comps[0]!; }
  private t(f: number, r: Rate): string { return bool(this.a, 'frames') ? `f${f}` : formatSeconds(f, r); }
  private span(c: Clip, r: Rate): string { return `${this.t(c.at, r)}–${this.t(c.at + c.len, r)}`; }
  private compLen(c: Comp): number {
    if (typeof c.length === 'number') return c.length;
    const ids = new Set(this.tracks.filter((t) => t.comp === c.id).map((t) => t.id));
    return (this.d.clips ?? []).filter((x) => ids.has(x.track)).reduce((m, x) => Math.max(m, x.at + x.len), 0);
  }

  kindOf(c: Clip): string {
    const k = clipKind(c);
    if (k !== 'media') return KIND_LABEL[k] ?? k;
    const a = (this.d.assets ?? []).find((x) => x.id === c.asset);
    return (a?.kind ?? (a ? kindFromExtension(a.src) : undefined) ?? 'media').slice(0, 5);
  }

  /** The short description of a clip (§6.1). */
  describe(c: Clip, r: Rate): string {
    const parts: string[] = [];
    const k = clipKind(c);
    const num = (key: string, v: unknown) => (v === undefined ? undefined : isKeyframes(v) ? `${key}~${(v as unknown[]).length}keys` : `${key}=${Array.isArray(v) ? v.join(',') : String(v)}`);
    if (k === 'text') {
      parts.push(JSON.stringify(cut(c.text!.replace(/\s+/g, ' '), 32)));
      if (typeof c.style === 'string') parts.push(c.style);
      else if (c.style) parts.push('style{…}');
      if (c.animate) parts.push([c.animate.in, c.animate.by].filter(Boolean).join('/') + (c.animate.out ? ` out ${c.animate.out}` : ''));
    } else if (k === 'captions') {
      const n = (this.d.cues ?? []).filter((q) => q.clip === c.id).length;
      parts.push(`${n} cues${typeof c.style === 'string' ? `, style ${c.style}` : c.style ? ', style{…}' : ''}`);
    } else if (k === 'media') {
      const a = (this.d.assets ?? []).find((x) => x.id === c.asset);
      const kind = this.kindOf(c);
      let s = a ? basename(a.src) : String(c.asset);
      if (kind === 'video' || kind === 'audio') {
        const sp = c.speed === undefined ? { num: 1, den: 1 } : parseSpeed(c.speed);
        const src0 = c.in ?? 0, src1 = src0 + Math.floor((c.len * sp.num) / sp.den);
        s += sp.num === 0 ? ` [freeze ${this.t(src0, r)}]` : ` [${this.t(src0, r)}–${this.t(src1, r)}]`;
        if (c.speed !== undefined && sp.num !== 0) s += ` x${c.speed}`;
      }
      parts.push(s);
    } else if (k === 'shape') parts.push(`${c.shape!.type}${c.shape!.fill ? ' ' + c.shape!.fill : ''}`);
    else if (k === 'solid') parts.push(c.color!);
    else if (k === 'comp') parts.push(`comp ${c.comp}${c.in ? ` from ${this.t(c.in, r)}` : ''}${c.loop ? ' loop' : ''}`);
    else if (k === 'gen') parts.push(genSummary(c.gen as Record<string, unknown>));
    else if (k === 'adjustment') parts.push('adjustment');
    const tf = [num('x', c.x), num('y', c.y), num('scale', c.scale), num('rotate', c.rotate), num('opacity', c.opacity)].filter(Boolean);
    if (tf.length) parts.push(tf.join(' '));
    if (c.blend) parts.push(`blend ${c.blend}`);
    if (c.fx?.length) parts.push(`fx ${c.fx.map((f) => f.type).join(',')}`);
    if (c.masks?.length) parts.push(`${c.masks.length} mask${c.masks.length > 1 ? 's' : ''}`);
    if (c.matte) parts.push(`matte ${c.matte.clip}`);
    if (c.transition?.in) parts.push(`⟵${c.transition.in.type} ${formatSeconds(c.transition.in.len, r)}`);
    if (c.transition?.out) parts.push(`${c.transition.out.type} ${formatSeconds(c.transition.out.len, r)}⟶`);
    if (c.gain !== undefined) parts.push(isKeyframes(c.gain) ? `gain~${(c.gain as unknown[]).length}keys` : `${c.gain}dB`);
    if (c.fade) parts.push(`fade ${formatSeconds(c.fade[0], r)}/${formatSeconds(c.fade[1], r)}`);
    if (c.muted) parts.push('muted');
    if (c.remap) parts.push('remap');
    if (c.link) parts.push(`link ${c.link}`);
    if (c.parent) parts.push(`parent ${c.parent}`);
    if (c.hidden) parts.push('hidden');
    if (c.locked) parts.push('locked');
    const t = this.tracks.find((x) => x.id === c.track);
    if (t?.audio || (k === 'media' && this.kindOf(c) === 'audio')) {
      const bus = t?.bus ?? 'master';
      const b = (this.d.buses ?? []).find((x) => x.id === bus);
      parts.push(`bus ${bus}${b?.duck ? ` (ducked ${b.duck.db}dB by ${b.duck.by})` : ''}${b?.fx?.length ? ` (bus fx ${b.fx.map((f) => f.type).join(',')})` : ''}`);
    }
    return parts.join('  ');
  }

  private clipLines(clips: Clip[], r: Rate): string[] {
    const idW = Math.min(14, Math.max(4, ...clips.map((c) => c.id.length)));
    const tW = Math.max(2, ...clips.map((c) => c.track.length));
    const kW = Math.max(5, ...clips.map((c) => this.kindOf(c).length));
    return clips.map((c) => cut(`${c.track.padEnd(tW)}  ${c.id.padEnd(idW)}  ${this.kindOf(c).padEnd(kW)}  ${this.span(c, r).padEnd(12)} ${this.describe(c, r)}`, 200));
  }

  /** Tracks of a comp top → bottom: visual tracks in reverse table order, then audio tracks. */
  private orderedTracks(comp: Comp): Track[] {
    const ts = this.tracks.filter((t) => t.comp === comp.id);
    return [...ts.filter((t) => !t.audio).reverse(), ...ts.filter((t) => t.audio)];
  }

  private header(comp: Comp): string {
    const r = this.rateOf(comp);
    const ts = this.tracks.filter((t) => t.comp === comp.id);
    const ids = new Set(ts.map((t) => t.id));
    const clips = (this.d.clips ?? []).filter((c) => ids.has(c.track));
    const capIds = new Set(clips.filter((c) => c.captions).map((c) => c.id));
    const cues = (this.d.cues ?? []).filter((q) => capIds.has(q.clip)).length;
    const plugins = Object.keys(this.d.project?.plugins ?? {});
    const len = this.compLen(comp);
    return `${comp.id} ${comp.size[0]}x${comp.size[1]} ${fpsText(r)}fps ${this.t(len, r)}${bool(this.a, 'frames') ? '' : 's'}${comp.length === 'auto' || comp.length === undefined ? ' (auto)' : ''} · ${plural(ts.length, 'track')} · ${plural(clips.length, 'clip')} · ${plural(cues, 'cue')}${plugins.length ? ` · plugins: ${plugins.join(', ')}` : ''}`;
  }

  outline(o: Out, file: string) {
    const comp = this.comp();
    const r = this.rateOf(comp);
    const from = str(this.a, 'from') !== undefined ? parseTime(str(this.a, 'from')!, r, '--from') : -Infinity;
    const to = str(this.a, 'to') !== undefined ? parseTime(str(this.a, 'to')!, r, '--to') : Infinity;
    const onlyTrack = str(this.a, 'track');
    if (onlyTrack && !this.tracks.some((t) => t.id === onlyTrack && t.comp === comp.id)) fail('E_REF', `track "${onlyTrack}" is not a track of comp "${comp.id}".`, `tracks: ${this.tracks.filter((t) => t.comp === comp.id).map((t) => t.id).join(', ')}`);
    const head = [this.header(comp)];
    if (this.d.comps.length > 1) head.push(`other comps: ${this.d.comps.filter((c) => c.id !== comp.id).map((c) => `${c.id} ${c.size[0]}x${c.size[1]}`).join(', ')} (--comp <id>)`);
    const body: string[] = [];
    const perTrack: string[] = [];
    const shown: Clip[] = [];
    for (const t of this.orderedTracks(comp)) {
      if (onlyTrack && t.id !== onlyTrack) continue;
      const clips = (this.d.clips ?? []).filter((c) => c.track === t.id && c.at + c.len > from && c.at < to).sort((x, y) => x.at - y.at);
      if (!clips.length) continue;
      shown.push(...clips);
      const kinds = new Map<string, number>();
      for (const c of clips) kinds.set(this.kindOf(c), (kinds.get(this.kindOf(c)) ?? 0) + 1);
      const end = Math.max(...clips.map((c) => c.at + c.len));
      perTrack.push(`${t.id}  ${clips.length} clip${clips.length > 1 ? 's' : ''} ${this.t(clips[0]!.at, r)}–${this.t(end, r)} (${[...kinds].map(([k, n]) => `${k} ×${n}`).join(', ')})${t.audio ? `  bus ${t.bus ?? 'master'}` : ''}${t.hidden ? ' hidden' : ''}${t.muted ? ' muted' : ''}${t.locked ? ' locked' : ''}`);
    }
    body.push(...this.clipLines(shown, r));
    const markers = (this.d.markers ?? []).filter((m) => m.comp === comp.id).sort((a, b) => a.at - b.at);
    const foot: string[] = [];
    if (markers.length) foot.push(...markerLines(markers.map((m) => `${m.id} ${this.t(m.at, r)}${m.len ? `–${this.t(m.at + m.len, r)}` : ''}${m.note ? ` ${JSON.stringify(cut(m.note, 40))}` : ''}`)));
    const buses = (this.d.buses ?? []).filter((b) => b.fx?.length || b.duck || b.loudness || b.gain !== undefined || b.muted || (b.to && b.to !== 'master'));
    if (buses.length) foot.push(cut(`buses: ${buses.map((b) => busText(b)).join(' · ')}`, 200));
    const issues = this.p.problems.filter((x) => x.severity === 'error').length, warns = this.p.problems.filter((x) => x.severity === 'warning').length;
    if (issues || warns) foot.push(`${issues ? `${issues} render-blocking issue${issues > 1 ? 's' : ''}` : ''}${issues && warns ? ', ' : ''}${warns ? `${warns} warning${warns > 1 ? 's' : ''}` : ''} (mgl check ${file})`);
    if (!shown.length) body.push(onlyTrack || from > -Infinity ? '(no clips in that range)' : '(no clips yet; add one: mgl edit ' + file + ' clip.add text="Hello" len=2s)');
    const all = [...head, ...body, ...foot];
    o.set({ comp: comp.id, header: head[0], markers: markers.map((m) => ({ id: m.id, at: m.at, ...(m.len ? { len: m.len } : {}), ...(m.note ? { note: m.note } : {}) })), clips: shown.map((c) => ({ id: c.id, track: c.track, kind: this.kindOf(c), at: c.at, len: c.len, line: this.p.line('clips', c.id), desc: this.describe(c, r) })) });
    if (o.unbounded || all.length <= MAX_LINES) { o.line(...all); return; }
    // over budget: per-track summary plus the full outline in a file
    const dir = workDir(this.p.file);
    mkdirSync(dir, { recursive: true });
    const outFile = join(dir, 'show.txt');
    writeFileSync(outFile, all.join('\n') + '\n');
    const rel = relative(process.cwd(), outFile) || outFile;
    o.line(...head, ...perTrack.slice(0, MAX_LINES - head.length - foot.length - 2), ...foot);
    o.line(`full outline (${shown.length} clips): ${rel}  · narrow it: --track V1, --from 10s --to 20s, --clip <id>`);
    o.set({ outline: outFile });
  }

  /** The storyboard with ● against the previous one (`look` / `render` save it; show never writes it). No QA: show stays fast. */
  private async storyboard() {
    let sbm: typeof import('../qa/storyboard.js');
    try { sbm = await import('../qa/storyboard.js'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw e;
      return fail('E_NOT_AVAILABLE', 'the storyboard is not available in this build (src/qa is missing).', 'read the outline instead: mgl show <file>');
    }
    const comp = this.comp();
    const prev = sbm.readPrevious(this.p.file);
    const sb = sbm.diffStoryboard(prev?.project, this.d, comp.id, this.p.historyTrace(), prev?.at);
    // ⚠ is what the last look (or render) found; show runs no QA itself
    if (prev?.findings && prev.comp === comp.id) sbm.assignFindings(sb, prev.findings);
    return { sbm, sb, comp, prev };
  }

  /** Level 1: one line per scene with its six lanes in words. */
  async scenes(o: Out, file: string) {
    const { sbm, sb, comp, prev } = await this.storyboard();
    const r = this.rateOf(comp);
    const changed = sb.scenes.filter((s) => s.changed).length;
    const when = prev?.at.slice(0, 16).replace('T', ' ');
    const since = prev ? `● ${changed} changed since the storyboard of ${when}` : 'no earlier storyboard (mgl look saves one)';
    const warned = sb.scenes.filter((s) => s.findings.length).length, whole = sb.unplaced.length;
    const qa = prev?.findings && prev.comp === comp.id ? `⚠ ${warned ? plural(warned, 'scene') : 'no scene'}${whole ? ` + ${whole} for the whole video` : ''} at the look of ${when}` : '⚠ comes from mgl look';
    const head = `${file} ${comp.id}: ${plural(sb.scenes.length, 'scene')}, ${formatSeconds(sb.length, r, 1)}s · ${since} · ${qa}`;
    const lines = sbm.sceneLines(sb, r), room = MAX_LINES - 2;
    o.line(head, ...(o.unbounded || lines.length <= room ? lines : [...lines.slice(0, room - 1), `… ${lines.length - room + 1} more lines (--json)`]));
    o.hint(`dig in: mgl show ${file} --scene <n> · see it: mgl look ${file}`);
    o.set({ comp: comp.id, header: head, previous: prev?.at ?? null, length: sb.length, scenes: sb.scenes, points: sb.points, notes: sb.notes });
  }

  /** Level 2: one scene, its lanes item by item with file lines, what changed. `ref` is the number or the scene id. */
  async scene(ref: string, o: Out, file: string) {
    const { sbm, sb, comp } = await this.storyboard();
    const s = /^\d+$/.test(ref) ? sb.scenes.find((x) => x.n === Number(ref)) : sb.scenes.find((x) => x.id === ref);
    if (!s) {
      const dym = /^\d+$/.test(ref) ? [] : suggest(ref, sb.scenes.map((x) => x.id));
      fail('E_REF', `scene "${ref}" does not exist (scenes 1–${sb.scenes.length}).`, dym.length ? `did you mean "${dym[0]}"? (or a number: --scene 1)` : `list them: mgl show ${file} --scenes`);
    }
    o.line(...sbm.sceneDetail(sb, s.n, this.rateOf(comp), (id) => this.p.line('clips', id)));
    o.hint(`see it: mgl look ${file} --scene ${s.n} · one clip: mgl show ${file} --clip <id>`);
    o.set({ comp: comp.id, scene: s, lines: Object.fromEntries(s.items.map((i) => [i.clip, this.p.line('clips', i.clip) ?? null])) });
  }

  clipDetail(id: string, o: Out) {
    const c = (this.d.clips ?? []).find((x) => x.id === id);
    if (!c) {
      const dym = suggest(id, (this.d.clips ?? []).map((x) => x.id));
      fail('E_REF', `clip "${id}" does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : 'list clips with: mgl show <file>');
    }
    const comp = this.compOfTrack(c.track), r = this.rateOf(comp);
    const line = this.p.line('clips', c.id);
    o.line(`clip "${c.id}" line ${line ?? '?'} · track ${c.track} · ${this.kindOf(c)} · ${formatSeconds(c.at, r)}–${formatSeconds(c.at + c.len, r)}s (f${c.at}–f${c.at + c.len}, ${c.len} frames)`);
    const entries = Object.entries(c as Record<string, unknown>).filter(([k]) => k !== 'id');
    for (const [k, v] of entries) o.line(`  ${k}: ${cut(JSON.stringify(v), 150)}`);
    const cues = (this.d.cues ?? []).filter((q) => q.clip === c.id);
    if (cues.length) {
      o.line(`  cues: ${cues.length} (first line ${this.p.line('cues', cues[0]!.id) ?? '?'})`);
      for (const q of cues.slice(0, Math.max(0, MAX_LINES - entries.length - 4))) o.line(`    ${q.id} ${formatSeconds(q.at, r)}–${formatSeconds(q.at + q.len, r)} ${JSON.stringify(cut(q.text, 60))}`);
    }
    o.set({ clip: c, line, kind: this.kindOf(c), cues: cues.length });
  }

  assets(o: Out) {
    const list = this.d.assets ?? [];
    if (!list.length) o.line('(no assets; add one: mgl edit <file> asset.add src=media/clip.mp4)');
    const used = new Map<string, number>();
    for (const c of this.d.clips ?? []) if (c.asset) used.set(c.asset, (used.get(c.asset) ?? 0) + 1);
    const out = list.map((a) => {
      const abs = resolve(this.p.dir, a.src);
      const exists = a.src.startsWith('lavfi:') || existsSync(abs);
      const size = exists && !a.src.startsWith('lavfi:') ? bytesText(statSync(abs).size) : '';
      return { id: a.id, src: a.src, kind: a.kind ?? kindFromExtension(a.src) ?? '?', exists, uses: used.get(a.id) ?? 0, line: this.p.line('assets', a.id), size };
    });
    for (const a of out) o.line(`${a.id.padEnd(14)} ${a.kind.padEnd(9)} ${a.src}${a.size ? `  ${a.size}` : ''}  used ${a.uses}×${a.exists ? '' : '  MISSING'}  line ${a.line ?? '?'}`);
    o.set({ assets: out });
  }

  at(t: string, o: Out) {
    const comp = this.comp(), r = this.rateOf(comp);
    const f = parseTime(t, r, '--at');
    const lines: string[] = [`${comp.id} at ${formatSeconds(f, r)}s (frame ${f}):`];
    const items: Record<string, unknown>[] = [];
    for (const tr of this.orderedTracks(comp)) {
      for (const c of (this.d.clips ?? []).filter((x) => x.track === tr.id && x.at <= f && f < x.at + x.len)) {
        let extra = '';
        if (c.captions) {
          const local = f - c.at;
          const q = (this.d.cues ?? []).find((x) => x.clip === c.id && x.at <= local && local < x.at + x.len);
          extra = q ? `  cue ${q.id} ${JSON.stringify(cut(q.text, 50))}` : '  (no cue)';
        }
        const hidden = c.hidden || tr.hidden ? ' (hidden)' : '';
        lines.push(cut(`  ${tr.id.padEnd(4)} ${c.id.padEnd(12)} ${this.kindOf(c).padEnd(6)} local f${f - c.at}  ${this.describe(c, r)}${extra}${hidden}`, 200));
        items.push({ id: c.id, track: tr.id, local: f - c.at });
      }
    }
    if (lines.length === 1) lines.push('  (nothing: the background shows)');
    o.line(...lines);
    o.set({ comp: comp.id, frame: f, visible: items });
  }
}

/** For tests: the formatted text of a project (used to count lines). */
export function projectLines(p: ProjectFile): number { return formatProject(p).split('\n').length - 1; }
