/**
 * storyboard: a script linked to the timeline.
 *
 * A storyboard is a Markdown file of scenes (`## hook`) and beats. A beat is one voice line (`> ...`) plus what is
 * seen and shown while it is heard (`shot:`, `text:`, `sfx:`, `dur:`, `cut-on:`, `transition:`). `storyboard.apply`
 * times the beats (to a voice made from each line, a recorded voice-over, or reading speed), lays the clips out on
 * tracks of their own, tags each clip with its beat (`sb:<beat>`, `sb-role:<role>`) and marks each beat and scene with
 * a range marker (`sb-<beat>`, `sbs-<scene>`). Running it again re-times everything after the script or the voice
 * changes and keeps hand edits of the clips' other properties. The `storyboard-sync` check finds clips that were
 * moved out of their beat by hand.
 */
import { CUE_TIMING, alignWords, defineCheck, definePlugin, fail, textWords, z, type CommandContext, type CommandDef, type Finding } from 'michelangelo/plugin';

type Project = CommandContext['project'];
type Clip = NonNullable<Project['clips']>[number];
type Comp = Project['comps'][number];

// ------------------------------------------------------------------------------------------- the storyboard format

interface Shot { src: string; in?: string; fit?: string; sound?: string; line: number }
interface Beat {
  id: string;
  scene: string;
  line: number;
  /** the voice line; a beat without one is silent and needs dur: */
  vo?: string;
  shots: Shot[];
  text?: { text: string; style?: string; x?: string; y?: string; at?: string; len?: string; line: number };
  sfx: { src: string; at?: string; gain?: string; len?: string; line: number }[];
  dur?: { fixed?: string; min?: string; max?: string; line: number };
  cutOn?: { words: string[]; line: number };
  transition?: { type: string; len?: string };
}
interface Scene { id: string; title: string }

const ID = /^[a-z0-9][a-z0-9_-]*$/;
const DIRECTIVES = ['shot', 'text', 'sfx', 'dur', 'cut-on', 'transition', 'note'];
const OPTIONS: Record<string, string[]> = { shot: ['in', 'fit', 'sound'], text: ['style', 'x', 'y', 'at', 'len'], sfx: ['at', 'gain', 'len'] };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
const short = (s: string) => (s.length > 40 ? s.slice(0, 39) + '…' : s);

/** Parse a storyboard; every error names the file and line. */
function parseStoryboard(src: string, file = 'storyboard'): { scenes: Scene[]; beats: Beat[] } {
  const scenes: Scene[] = [], beats: Beat[] = [];
  let scene: Scene | undefined, beat: Beat | undefined;
  const err = (line: number, msg: string, fix: string): never => fail('E_STORYBOARD', `${file} line ${line}: ${msg}`, fix);
  const newScene = (id: string, title: string, line: number) => {
    if (scenes.some((s) => s.id === id)) err(line, `scene "${id}" is used twice.`, 'give each "## " heading its own name.');
    scenes.push((scene = { id, title }));
    beat = undefined;
  };
  const newBeat = (line: number, vo?: string, pin?: string) => {
    if (!scene) newScene(`s${scenes.length + 1}`, '', line);
    const id = pin ?? `${scene!.id}-${beats.filter((b) => b.scene === scene!.id).length + 1}`;
    if (beats.some((b) => b.id === id)) err(line, `beat id "${id}" is used twice.`, 'give the beat its own id: > the line {#my-id}');
    beats.push((beat = { id, scene: scene!.id, line, ...(vo ? { vo } : {}), shots: [], sfx: [] }));
  };
  const once = (b: Beat, key: string, has: unknown, line: number) => { if (has) err(line, `beat "${b.id}" has a second "${key}:".`, `keep one "${key}:" per beat, or start a new beat with ">".`); };
  /** `value | k=v k=v` */
  const split = (key: string, val: string, line: number): [string, Record<string, string>] => {
    const bar = val.indexOf('|');
    const main = (bar < 0 ? val : val.slice(0, bar)).trim();
    if (!main) err(line, `"${key}:" is empty.`, `write it as ${key}: <value>${OPTIONS[key] ? ` | ${OPTIONS[key]![0]}=...` : ''}`);
    const opts: Record<string, string> = {};
    for (const tok of bar < 0 ? [] : val.slice(bar + 1).trim().split(/\s+/).filter(Boolean)) {
      const m = /^([a-z]+)=(\S+)$/.exec(tok);
      const allowed = OPTIONS[key] ?? [];
      if (!m || !allowed.includes(m[1]!)) err(line, `"${tok}" is not an option of "${key}:".`, allowed.length ? `options: ${allowed.map((k) => `${k}=...`).join(' ')}` : `"${key}:" takes no options.`);
      opts[m![1]!] = m![2]!;
    }
    return [main, opts];
  };

  src.replace(/\r/g, '').split('\n').forEach((raw, i) => {
    const line = i + 1, l = raw.trim();
    if (!l || l.startsWith('<!--')) return;
    let m: RegExpExecArray | null;
    if ((m = /^##\s+(.+)$/.exec(l))) {
      const id = slug(m[1]!);
      if (!id || !ID.test(id)) err(line, `"${m[1]}" does not make a scene id.`, 'start the heading with a letter or digit: ## hook');
      return newScene(id, m[1]!.trim(), line);
    }
    if (/^#\s/.test(l)) return; // the title
    if (l.startsWith('>')) {
      let t = l.slice(1).trim(), pin: string | undefined;
      const pm = /\{#([^}]*)\}$/.exec(t);
      if (pm) {
        pin = pm[1]!;
        if (!ID.test(pin)) err(line, `"{#${pin}}" is not a beat id.`, 'use lower-case letters, digits, "-" and "_": {#hook-intro}');
        t = t.slice(0, pm.index).trim();
      }
      return newBeat(line, t || undefined, pin);
    }
    if ((m = /^([a-z][a-z-]*):\s*(.*)$/i.exec(l))) {
      const key = m[1]!.toLowerCase(), val = m[2]!.trim();
      if (!DIRECTIVES.includes(key)) err(line, `"${key}:" is not a directive.`, `use one of: ${DIRECTIVES.map((d) => d + ':').join(' ')} (voice lines start with ">").`);
      if (!beat) newBeat(line);
      const b = beat!;
      if (key === 'shot') { const [src, o] = split(key, val, line); b.shots.push({ src, ...o, line }); }
      else if (key === 'text') { once(b, key, b.text, line); const [text, o] = split(key, val, line); b.text = { text, ...o, line }; }
      else if (key === 'sfx') { const [src, o] = split(key, val, line); b.sfx.push({ src, ...o, line }); }
      else if (key === 'dur') {
        once(b, key, b.dur, line);
        const t = val.split(/\s+/).filter(Boolean);
        const d: NonNullable<Beat['dur']> = { line };
        if (t.length === 1 && !/^(min|max)$/.test(t[0]!)) d.fixed = t[0]!;
        else for (let k = 0; k < t.length; k += 2) {
          if (!/^(min|max)$/.test(t[k]!) || !t[k + 1]) err(line, `"dur: ${val}" is not a duration.`, 'write dur: 3s, dur: min 2s, dur: max 4s or dur: min 2s max 4s');
          d[t[k] as 'min' | 'max'] = t[k + 1]!;
        }
        b.dur = d;
      } else if (key === 'cut-on') {
        once(b, key, b.cutOn, line);
        const words = val.split(/[,\s]+/).map(bare).filter(Boolean);
        if (!words.length) err(line, '"cut-on:" names no word.', 'cut-on: three');
        b.cutOn = { words, line };
      } else if (key === 'transition') {
        once(b, key, b.transition, line);
        const [type, len] = val.split(/\s+/);
        if (!type) err(line, '"transition:" names no transition.', 'transition: crossfade 0.3s');
        b.transition = { type: type!, ...(len ? { len } : {}) };
      }
      return;
    }
    err(line, `"${short(l)}" is not a voice line, a directive or a heading.`, 'voice lines start with ">", directives with "shot:", "text:", "sfx:", "dur:", "cut-on:", "transition:" or "note:", scenes with "## ".');
  });
  if (!beats.length) fail('E_STORYBOARD', `${file} has no beats.`, 'write one voice line per beat: > Most people waste their mornings.');
  return { scenes, beats };
}

// ------------------------------------------------------------------------------------------- storyboard.apply

const TRACKS = { shot: 'SB', text: 'SBT', captions: 'SBC', vo: 'SBV', sfx: 'SBX' } as const;
/** Clip fields the storyboard decides; every other field of a clip it made before (x, y, fx, ...) is kept, and a hand-set
 * style or fit wins over the defaults (the storyboard's own style= / fit= win over both). */
const OWNED = new Set(['id', 'track', 'at', 'len', 'in', 'asset', 'text', 'gen', 'tags', 'captions']);
const VIDEO = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;
const SETTINGS = 'storyboard';
/** The markers storyboard.apply makes: its settings, one per scene (sbs-) and one per beat (sb-). */
const ownMarker = (m: { id: string; comp: string }, comp: string) => m.comp === comp && (m.id === SETTINGS || /^sbs?-/.test(m.id));

const Settings = z.strictObject({
  file: z.string().min(1).optional(),
  voice: z.union([z.literal(true), z.string().min(1)]).optional(),
  vo: z.string().min(1).optional(),
  captions: z.union([z.boolean(), z.string().min(1)]).optional(),
  lead: z.union([z.number().int(), z.string()]).optional(),
  pause: z.union([z.number().int(), z.string()]).optional(),
  minShot: z.union([z.number().int(), z.string()]).optional(),
  wps: z.number().min(0.5).max(8).optional(),
});
type Settings = z.infer<typeof Settings>;

interface Placed { beat: Beat; at: number; len: number; voice?: string; words?: number[] }

/** Word start times (s) spread over `seconds` by word length, when nothing better is known. */
function estimate(words: string[], seconds: number): number[] {
  const w = words.map((x) => x.length + 1), total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  return w.map((x) => { const s = (seconds * acc) / total; acc += x; return s; });
}

/** A plugin command; the plugin loader registers it when a project names this plugin. */
const command = <S extends z.ZodObject>(def: CommandDef<S>) => def;

const apply = command({
  op: 'storyboard.apply', group: 'storyboard',
  doc: 'Lay out a storyboard (a Markdown file of "## scene" headings and beats: "> voice line", then shot:, text:, sfx:, dur:, cut-on:, transition:) on the timeline: beats timed to a voice made from each line (voice=, needs a speak plugin), a recorded voice-over (vo=), or reading speed; shots, text, voice and sound effects on tracks SB, SBT, SBV, SBX; a range marker per beat (sb-<beat>) and scene (sbs-<scene>); optional captions. Run it again after editing the storyboard or the voice: clips are re-timed and hand edits of their other properties (x, y, fx, ...) are kept. The file and options are remembered.',
  schema: Settings.extend({ text: z.string().min(1).optional(), comp: z.string().optional() }),
  primary: 'file',
  example: { file: 'video.storyboard.md', voice: true, captions: 'karaoke' },
  async apply(ctx, a) {
    const p = ctx.project;
    const comp = ctx.comp(a.comp ?? p.project?.main ?? (p.comps.find((c) => c.id === 'main') ?? p.comps[0]!).id);
    const compTracks = new Set((p.tracks ?? []).filter((t) => t.comp === comp.id).map((t) => t.id));
    const marker = (p.markers ?? []).find((m) => m.comp === comp.id && m.id === SETTINGS);

    // settings: the ones given, over the ones remembered from the last run
    const { text: inline, comp: _c, ...given } = a;
    let saved: Settings = {};
    try { saved = Settings.parse(JSON.parse(marker?.note?.replace(/^storyboard /, '') ?? '{}')); } catch { saved = {}; }
    const s: Settings = { ...saved, ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) };
    if (inline !== undefined) delete s.file;
    if (a.voice !== undefined) delete s.vo;
    if (a.vo !== undefined) delete s.voice;
    if (s.voice === 'default') s.voice = true;
    if (s.voice !== undefined && s.vo !== undefined) fail('E_ARG', 'storyboard.apply takes voice= (speech made from each line) or vo= (a recording), not both.', 'drop one of them.');

    let source = inline;
    if (source === undefined) {
      if (!s.file) fail('E_ARG', 'storyboard.apply needs the storyboard: file=<path> or text="...".', 'mgl edit <file> storyboard.apply video.storyboard.md');
      if (!ctx.services.readText) fail('E_NO_SERVICE', 'reading files is not available here.', 'pass the storyboard itself as text="...".');
      try { source = await ctx.services.readText(s.file); } catch { fail('E_NO_FILE', `${s.file} could not be read.`, 'give the path relative to the project file.'); }
    }
    const { scenes, beats } = parseStoryboard(source!, s.file ?? 'storyboard');

    const rate = ctx.rate(comp);
    const T = (v: string | number, what: string) => {
      if (typeof v === 'number') return v;
      const neg = v.startsWith('-');
      return (neg ? -1 : 1) * ctx.time(v.replace(/^[+-]/, ''), comp, what);
    };
    const fr = (sec: number) => Math.round((sec * rate.num) / rate.den);
    // defaults are whole frames at this rate (no rounding notes); only given values are converted with a note
    const lead = T(s.lead ?? 3, 'lead'), pause = s.pause === undefined ? fr(0.25) : T(s.pause, 'pause'), minShot = Math.max(1, s.minShot === undefined ? fr(0.6) : T(s.minShot, 'minShot'));
    const wps = s.wps ?? 2.6;
    const notes: string[] = [];
    const note = (m: string) => notes.push(m);
    const run = (cmd: { op: string; [k: string]: unknown }) => ctx.run(cmd, { note });
    const tags = (b: Beat | string, role: string) => [`sb:${typeof b === 'string' ? b : b.id}`, `sb-role:${role}`];

    // 1. take out what the last run made (kept aside, to carry hand edits over)
    const mine = (c: Clip) => compTracks.has(c.track) && !!c.tags?.some((t) => t.startsWith('sb-role:'));
    const old = new Map((p.clips ?? []).filter(mine).map((c) => [c.id, c]));
    const oldAssets = new Set([...old.values()].map((c) => c.asset).filter((x): x is string => x !== undefined));
    if (p.clips) p.clips = p.clips.filter((c) => !old.has(c.id));
    if (p.cues) p.cues = p.cues.filter((q) => !old.has(q.clip));
    if (p.markers) p.markers = p.markers.filter((m) => !ownMarker(m, comp.id));

    // 2. tracks (made once, kept between runs)
    const voiced = beats.some((b) => b.vo) && (s.voice !== undefined || s.vo !== undefined);
    const want: [string, boolean, string?][] = [[TRACKS.shot, false], [TRACKS.text, false]];
    if (voiced && s.captions) want.push([TRACKS.captions, false]);
    if (voiced) want.push([TRACKS.vo, true, 'dialogue']);
    if (beats.some((b) => b.sfx.length)) want.push([TRACKS.sfx, true, 'sfx']);
    for (const [id, audio, bus] of want) {
      const t = (p.tracks ?? []).find((x) => x.id === id);
      if (!t) await run({ op: 'track.add', id, comp: comp.id, ...(audio ? { audio, bus } : {}) });
      else if (t.comp !== comp.id || !!t.audio !== audio) fail('E_TRACK_KIND', `track "${id}" is not ${audio ? 'an audio' : 'a visual'} track of comp "${comp.id}"; the storyboard keeps its clips on tracks ${Object.values(TRACKS).join(', ')}.`, `rename that track: mgl edit <file> track.set ${id} id=<other>`);
    }

    // 3. time the beats
    const placed: Placed[] = [];
    const lengthOf = (b: Beat, natural: number | undefined, floor = 0) => {
      const d = b.dur;
      if (natural === undefined && !d?.fixed && !d?.min) fail('E_STORYBOARD', `beat "${b.id}" (line ${b.line}) has no voice line, so it needs a length.`, 'add dur: 2s (or dur: min 2s) under it.');
      let len = d?.fixed ? T(d.fixed, 'dur') : natural ?? 0;
      if (!d?.fixed && d?.min) len = Math.max(len, T(d.min, 'dur'));
      if (!d?.fixed && d?.max) len = Math.min(len, T(d.max, 'dur'));
      if (len < floor) { note(`beat "${b.id}": dur is shorter than its voice line; kept the voice's ${floor} frames.`); len = floor; }
      return Math.max(len, minShot);
    };
    let cursor = 0;
    let mode: 'voice' | 'recording' | 'reading';
    if (s.vo !== undefined) {
      mode = 'recording';
      const first = beats.findIndex((b) => b.vo), last = beats.length - 1 - [...beats].reverse().findIndex((b) => b.vo);
      if (first < 0) fail('E_STORYBOARD', 'vo= is a recording of the voice lines, and the storyboard has none.', 'write the voice lines as "> ..." beats, or drop vo=.');
      const gap = beats.slice(first, last + 1).find((b) => !b.vo);
      if (gap) fail('E_STORYBOARD', `beat "${gap.id}" (line ${gap.line}) is silent but sits between voice lines; a recording cannot stop for it.`, 'move silent beats before the first or after the last voice line, or use voice= (speech per line) instead of vo=.');
      for (const b of beats.slice(0, first)) { placed.push({ beat: b, at: cursor, len: lengthOf(b, undefined) }); cursor += placed[placed.length - 1]!.len; }
      if (!ctx.services.probe) fail('E_NO_SERVICE', 'vo= needs to know the recording\'s length, and probing media is not available here.', 'run it through the CLI (mgl edit) or the SDK (open(file)).');
      await run({ op: 'clip.add', id: 'sb-vo', track: TRACKS.vo, at: cursor, src: s.vo, tags: tags('vo', 'vo') });
      const vo = ctx.clip('sb-vo');
      const src = (p.assets ?? []).find((x) => x.id === vo.asset)!.src;
      const spoken = beats.slice(first, last + 1);
      const all = spoken.flatMap((b) => textWords(b.vo!));
      let env: number[] | undefined;
      try { env = (await ctx.services.analyzeAudio?.(src, { envelope: true }))?.envelope; } catch { env = undefined; }
      const starts = env?.length ? alignWords(all, env).map((w) => w.start) : estimate(all, vo.len * rate.den / rate.num);
      if (!env?.length) note('the recording could not be analysed here; beats are timed by reading speed across it.');
      if (spoken.some((b) => b.dur)) note('dur: is ignored on voice lines when timing to a recording (the recording sets their length).');
      let k = 0;
      const wordFrames = spoken.map((b) => { const n = textWords(b.vo!).length; const f = starts.slice(k, k + n).map((x) => vo.at + fr(x)); k += n; return f; });
      spoken.forEach((b, i) => {
        const at = i === 0 ? cursor : Math.max(placed[placed.length - 1]!.at + 1, wordFrames[i]![0]! - lead);
        if (i > 0) placed[placed.length - 1]!.len = at - placed[placed.length - 1]!.at;
        placed.push({ beat: b, at, len: Math.max(1, vo.at + vo.len - at), voice: vo.id, words: wordFrames[i] });
      });
      cursor = vo.at + vo.len;
      for (const b of beats.slice(last + 1)) { placed.push({ beat: b, at: cursor, len: lengthOf(b, undefined) }); cursor += placed[placed.length - 1]!.len; }
    } else {
      mode = s.voice !== undefined ? 'voice' : 'reading';
      for (const b of beats) {
        const at = cursor;
        if (!b.vo) placed.push({ beat: b, at, len: lengthOf(b, undefined) });
        else if (mode === 'voice') {
          const r = await run({ op: 'audio.speak', text: b.vo, id: `${b.id}-vo`, track: TRACKS.vo, at: at + lead, comp: comp.id, ...(s.voice !== true ? { voice: s.voice } : {}) });
          ctx.clip(r.id as string).tags = tags(b, 'vo');
          const voLen = (r.end as number) - (r.at as number);
          const words = textWords(b.vo);
          const ws = (r.words as { start: number }[] | undefined)?.map((w) => w.start);
          const starts = ws && ws.length === words.length ? ws : estimate(words, voLen * rate.den / rate.num);
          placed.push({ beat: b, at, len: lengthOf(b, lead + voLen + pause, lead + voLen), voice: r.id as string, words: starts.map((x) => at + lead + fr(x)) });
        } else {
          const words = textWords(b.vo);
          const speech = Math.max(1, fr(words.length / wps));
          placed.push({ beat: b, at, len: lengthOf(b, speech + pause), words: estimate(words, speech * rate.den / rate.num).map((x) => at + fr(x)) });
        }
        cursor += placed[placed.length - 1]!.len;
      }
    }
    const total = cursor;

    // 4. shots: split each beat between its shots (on cut-on: words, else evenly); a beat with none holds the last shot
    const segs: { beat: Beat; shot: Shot; id: string; at: number; end: number }[] = [];
    for (const pb of placed) {
      const b = pb.beat, end = pb.at + pb.len;
      if (!b.shots.length) {
        if (segs.length && segs[segs.length - 1]!.end === pb.at) segs[segs.length - 1]!.end = end;
        else note(`beat "${b.id}" has no shot, and no shot before it to hold.`);
        continue;
      }
      let shots = b.shots, cuts: number[];
      if (b.cutOn) {
        if (b.cutOn.words.length !== shots.length - 1) fail('E_STORYBOARD', `beat "${b.id}" (line ${b.cutOn.line}) has ${shots.length} shot(s) and ${b.cutOn.words.length} cut-on word(s).`, `name ${shots.length - 1} word(s) to cut on, one per cut between shots.`);
        if (!b.vo) fail('E_STORYBOARD', `beat "${b.id}" (line ${b.cutOn.line}) is silent; cut-on: needs a voice line.`, 'drop cut-on: (the shots then split evenly).');
        const words = textWords(b.vo).map(bare);
        let from = 0;
        cuts = b.cutOn.words.map((w) => {
          const j = words.indexOf(w, from);
          if (j < 0) fail('E_STORYBOARD', `beat "${b.id}" (line ${b.cutOn!.line}): "${w}" is not in its line${from ? ' after the previous cut-on word' : ''} ("${short(b.vo!)}").`, 'name words of the voice line, in order.');
          from = j + 1;
          return Math.min(end - minShot, Math.max(pb.at + minShot, pb.words![j]! - lead));
        });
      } else {
        const fit = Math.max(1, Math.min(shots.length, Math.floor(pb.len / minShot)));
        if (fit < shots.length) { note(`beat "${b.id}" is too short for ${shots.length} shots of at least ${minShot} frames; kept ${fit}.`); shots = shots.slice(0, fit); }
        cuts = shots.slice(1).map((_, i) => pb.at + Math.round((pb.len * (i + 1)) / shots.length));
      }
      const bounds = [pb.at, ...cuts, end];
      shots.forEach((shot, i) => segs.push({ beat: b, shot, id: `${b.id}-shot${i ? i + 1 : ''}`, at: bounds[i]!, end: bounds[i + 1]! }));
    }
    for (const g of segs) {
      const sh = g.shot;
      const asset = (p.assets ?? []).find((x) => x.id === sh.src);
      let source: Record<string, unknown>;
      if (sh.src.startsWith('gen:')) {
        const [type, ...rest] = sh.src.slice(4).split(/\s+/);
        const colors = rest.filter((t) => /^#[0-9a-f]{3,8}$/i.test(t));
        const params = Object.fromEntries(rest.filter((t) => t.includes('=')).map((t) => { const [k, v] = t.split('='); return [k, Number.isFinite(Number(v)) ? Number(v) : v]; }));
        source = { gen: { type, ...(colors.length ? { colors } : {}), ...params } };
      } else source = asset ? { asset: asset.id } : { src: sh.src };
      const video = asset ? asset.kind === 'video' || VIDEO.test(asset.src) : VIDEO.test(sh.src);
      await run({ op: 'clip.add', id: g.id, track: TRACKS.shot, at: g.at, len: g.end - g.at, ...source, ...(source.gen ? {} : { fit: sh.fit ?? old.get(g.id)?.fit ?? 'cover' }),
        ...(sh.in ? { in: sh.in } : {}), ...(video && sh.sound !== 'on' ? { muted: true } : {}), tags: tags(g.beat, 'shot') });
    }
    for (const pb of placed) {
      const t = pb.beat.transition;
      if (!t) continue;
      const first = segs.find((g) => g.beat === pb.beat);
      if (!first || !segs.some((g) => g.end === first.at)) { note(`beat "${pb.beat.id}": transition: needs a shot before it to blend from; skipped.`); continue; }
      await run({ op: 'transition.set', id: first.id, type: t.type, ...(t.len ? { len: t.len } : {}) });
    }

    // 5. text cards and sound effects
    const [W] = comp.size;
    for (const pb of placed) {
      const b = pb.beat, end = pb.at + pb.len;
      if (b.text) {
        const at = Math.min(end - 1, pb.at + T(b.text.at ?? 0, 'text at'));
        const len = Math.max(1, Math.min(end - at, b.text.len ? T(b.text.len, 'text len') : end - at));
        const num = (v?: string) => (v === undefined ? undefined : Number.isFinite(Number(v)) ? Number(v) : fail('E_STORYBOARD', `beat "${b.id}" (line ${b.text!.line}): "${v}" is not a number of pixels.`, 'text: Hello | y=400'));
        const x = num(b.text.x), y = num(b.text.y);
        await run({ op: 'clip.add', id: `${b.id}-text`, track: TRACKS.text, at, len, text: b.text.text, style: b.text.style ?? old.get(`${b.id}-text`)?.style ?? { base: 'title', maxWidth: Math.round(W * 0.8) },
          ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), tags: tags(b, 'text') });
      }
    }
    const sfx = placed.flatMap((pb) => pb.beat.sfx.map((x, i) => ({ beat: pb.beat, x, id: `${pb.beat.id}-sfx${i ? i + 1 : ''}`, at: Math.max(0, pb.at + T(x.at ?? 0, 'sfx at')) }))).sort((u, v) => u.at - v.at);
    for (const [i, e] of sfx.entries()) {
      const room = (sfx[i + 1]?.at ?? total) - e.at;
      if (room < 1) fail('E_STORYBOARD', `beat "${e.beat.id}" (line ${e.x.line}): the sound effect starts where the next one does, or after the end.`, 'move it with at=, e.g. sfx: whoosh.wav | at=-0.2s');
      let len = e.x.len ? T(e.x.len, 'sfx len') : undefined;
      if (len === undefined) {
        const asset = (p.assets ?? []).find((x) => x.id === e.x.src);
        const d = ctx.services.probe ? (await ctx.services.probe(asset?.src ?? e.x.src)).duration : undefined;
        len = d ? Math.max(1, fr(d)) : fr(1);
      }
      const gain = e.x.gain === undefined ? undefined : Number(e.x.gain);
      if (gain !== undefined && !Number.isFinite(gain)) fail('E_STORYBOARD', `beat "${e.beat.id}" (line ${e.x.line}): gain=${e.x.gain} is not a number of dB.`, 'sfx: whoosh.wav | gain=-6');
      const asset = (p.assets ?? []).find((x) => x.id === e.x.src);
      await run({ op: 'clip.add', id: e.id, track: TRACKS.sfx, at: e.at, len: Math.min(len, room), ...(asset ? { asset: asset.id } : { src: e.x.src }), ...(gain !== undefined ? { gain } : {}), tags: tags(e.beat, 'sfx') });
    }

    // 6. captions, from the voice
    const voices = [...new Set(placed.map((x) => x.voice).filter((x): x is string => !!x))];
    if (s.captions && !voices.length) note('captions= needs a voice (voice= or vo=); skipped.');
    else if (s.captions) {
      const style = typeof s.captions === 'string' ? { style: s.captions } : {};
      if (mode === 'recording') await run({ op: 'captions.from-text', text: beats.filter((b) => b.vo).map((b) => b.vo).join('\n'), voice: voices[0], id: 'sb-captions', track: TRACKS.captions, ...style });
      else await run({ op: 'captions.from-speech', clips: voices, id: 'sb-captions', track: TRACKS.captions, ...style });
      ctx.clip('sb-captions').tags = tags('captions', 'captions');
    }

    // 7. carry hand edits over, drop assets only the old clips used, mark beats and scenes, fit the comp
    let moved = 0;
    for (const c of p.clips ?? []) {
      const o = old.get(c.id);
      if (!o) continue;
      for (const [k, v] of Object.entries(o)) if (!OWNED.has(k) && !(k in c)) (c as Record<string, unknown>)[k] = v;
      if (o.at !== c.at || o.len !== c.len) moved++;
    }
    const used = new Set((p.clips ?? []).map((c) => c.asset));
    if (p.assets) p.assets = p.assets.filter((x) => !(oldAssets.has(x.id) && !used.has(x.id)));
    const markers = (p.markers ??= []);
    const settings = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
    markers.push({ id: SETTINGS, comp: comp.id, at: 0, len: total, note: `storyboard ${JSON.stringify(settings)}` });
    for (const sc of scenes) {
      const own = placed.filter((x) => x.beat.scene === sc.id);
      if (own.length) markers.push({ id: `sbs-${sc.id}`, comp: comp.id, at: own[0]!.at, len: own[own.length - 1]!.at + own[own.length - 1]!.len - own[0]!.at, note: sc.title || sc.id });
    }
    for (const x of placed) markers.push({ id: `sb-${x.beat.id}`, comp: comp.id, at: x.at, len: x.len, note: x.beat.vo ?? '(silent)' });
    if (typeof comp.length === 'number' && comp.length < total) { note(`extended comp "${comp.id}" to ${total} frames to fit the storyboard.`); comp.length = total; }

    const byBeat = (b: Beat) => (p.clips ?? []).filter((c) => c.tags?.includes(`sb:${b.id}`)).map((c) => c.id);
    const sec = (f: number) => Math.round((f * rate.den * 100) / rate.num) / 100;
    ctx.out.timing = mode;
    ctx.out.length = total;
    ctx.out.beats = placed.map((x) => ({ id: x.beat.id, scene: x.beat.scene, at: x.at, len: x.len, seconds: [sec(x.at), sec(x.at + x.len)], clips: byBeat(x.beat), ...(x.beat.vo ? { line: x.beat.vo } : {}) }));
    for (const n of [...new Set(notes.filter((n) => !/^(created track|added asset|put the clip)/.test(n)))].slice(0, 6)) ctx.note(n);
    for (const x of placed.slice(0, 24)) ctx.note(`${x.beat.id.padEnd(12)} ${String(x.at).padStart(5)}–${String(x.at + x.len).padEnd(5)} ${x.beat.vo ? `"${short(x.beat.vo)}"` : '(silent)'}`);
    const count = (role: string) => (p.clips ?? []).filter((c) => c.tags?.includes(`sb-role:${role}`)).length;
    ctx.summary(`storyboard: ${placed.length} beats in ${scenes.length} scene(s), 0–${total} (${sec(total)}s), timed by ${mode === 'voice' ? 'speech made from each line' : mode === 'recording' ? 'the recording' : `reading speed (${wps} words/s)`}; ${count('shot')} shots, ${count('text')} text cards, ${count('vo')} voice clip(s), ${count('sfx')} sound effects${count('captions') ? ', captions' : ''}${old.size ? `; ${moved} clip(s) re-timed` : ''}.`);
  },
});

const detach = command({
  op: 'storyboard.detach', group: 'storyboard',
  doc: 'Unlink the timeline from its storyboard: removes the sb: tags and the storyboard markers, so the clips become ordinary clips that storyboard.apply no longer touches.',
  schema: z.strictObject({ comp: z.string().optional() }),
  example: {},
  apply(ctx, a) {
    const p = ctx.project;
    const comp = ctx.comp(a.comp ?? p.project?.main ?? (p.comps.find((c) => c.id === 'main') ?? p.comps[0]!).id);
    const tracks = new Set((p.tracks ?? []).filter((t) => t.comp === comp.id).map((t) => t.id));
    let n = 0;
    for (const c of p.clips ?? []) {
      if (!tracks.has(c.track) || !c.tags?.some((t) => t.startsWith('sb-role:'))) continue;
      const rest = c.tags.filter((t) => !t.startsWith('sb:') && !t.startsWith('sb-role:'));
      if (rest.length) c.tags = rest; else delete c.tags;
      n++;
    }
    const before = (p.markers ?? []).length;
    if (p.markers) p.markers = p.markers.filter((m) => !ownMarker(m, comp.id));
    ctx.summary(`detached ${n} clip(s) and ${before - (p.markers ?? []).length} marker(s) from the storyboard.`);
  },
});

// ------------------------------------------------------------------------------------------- storyboard-sync check

const syncCheck = defineCheck({
  id: 'storyboard-sync',
  describe: 'Clips made by storyboard.apply that were moved out of their beat by hand, gaps between storyboard shots, and storyboard text cards shown too briefly to read.',
  stage: 'project',
  run(ctx) {
    const p = ctx.project;
    const comp = p.comps.find((c) => c.id === ctx.compId);
    if (!comp) return [];
    const [num, den] = typeof comp.fps === 'number' ? [comp.fps, 1] : comp.fps.split('/').map(Number) as [number, number];
    const fps = num / (den || 1);
    const tracks = new Set((p.tracks ?? []).filter((t) => t.comp === comp.id).map((t) => t.id));
    const beats = new Map((p.markers ?? []).filter((m) => m.comp === comp.id && m.id.startsWith('sb-') && typeof m.len === 'number').map((m) => [m.id.slice(3), m as { at: number; len: number }]));
    if (!beats.size) return [];
    const out: Finding[] = [];
    const fix = 'mgl edit <file> storyboard.apply';
    const mine = (p.clips ?? []).filter((c) => tracks.has(c.track) && c.tags?.some((t) => t.startsWith('sb-role:')));
    for (const c of mine) {
      const beat = c.tags!.find((t) => t.startsWith('sb:'))!.slice(3);
      const m = beats.get(beat);
      if (!m) continue;
      const role = c.tags!.find((t) => t.startsWith('sb-role:'))!.slice(8);
      const end = m.at + m.len;
      if (role === 'shot' && c.id === `${beat}-shot` && c.at !== m.at) out.push({ rule: 'storyboard-sync', severity: 'error', clip: c.id, frame: c.at, message: `shot "${c.id}" starts at frame ${c.at}, but its beat "${beat}" starts at ${m.at}: the cut no longer lands on the line.`, fix });
      // a sound effect may lead into its beat (at=-0.2s), so only its end side is checked
      else if (c.at >= end || (role !== 'sfx' && c.at < m.at)) out.push({ rule: 'storyboard-sync', severity: 'error', clip: c.id, frame: c.at, message: `${role} "${c.id}" starts at frame ${c.at}, outside its beat "${beat}" (${m.at}–${end}).`, fix });
      if (role === 'text' && typeof c.text === 'string') {
        const need = Math.max(CUE_TIMING.minLen, c.text.length / CUE_TIMING.maxCps);
        if (c.len / fps < need - 1e-6) out.push({ rule: 'storyboard-sync', severity: 'warning', clip: c.id, frame: c.at, message: `text "${short(c.text)}" is on screen ${(c.len / fps).toFixed(2)}s; it needs ${need.toFixed(2)}s to be read.`, fix: `give beat "${beat}" more time in the storyboard (dur: min ${Math.ceil(need * 10) / 10}s), then ${fix}` });
      }
    }
    const shots = mine.filter((c) => c.tags!.includes('sb-role:shot')).sort((a, b) => a.at - b.at);
    for (let i = 1; i < shots.length; i++) {
      const a = shots[i - 1]!, b = shots[i]!;
      if (a.at + a.len < b.at) out.push({ rule: 'storyboard-sync', severity: 'warning', clip: b.id, frame: a.at + a.len, message: `a gap of ${b.at - a.at - a.len} frame(s) between storyboard shots "${a.id}" and "${b.id}".`, fix });
    }
    return out;
  },
});

export default definePlugin({ name: 'storyboard', version: '1.0.0', commands: [apply, detach], checks: [syncCheck] });
