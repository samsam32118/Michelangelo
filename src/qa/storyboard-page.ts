/**
 * storyboard.html: one self-contained page (inline CSS and script, images as data: URLs, no server, no network).
 * Level 1 (scene cards and the lane strip) is plain HTML, readable without the script; a scene opens level 2
 * (moments, layer toggles, issues, changes, what is in it); an element opens level 3 (times, settings, file line,
 * the command that changes it). The page reads the project; it never writes it.
 */
import type { Clip, ProjectFile } from '../core/schema/index.js';
import { isKeyframes } from '../core/load.js';
import { clipLabel, LANES, sceneDetail, sceneLines, type Lane, type Storyboard, type StoryScene } from './storyboard.js';
import { LANE_COLOURS, marksOf, rangeOf } from './storyboard-draw.js';

export interface PageProp { k: string; v: string; swatches?: string[] }
export interface PageItem {
  clip: string; lane: Lane; kind: string; label: string; marks: string[];
  /** its part of the scene, and how far it reaches outside it ("starts 0.4s before") */
  range: string; rel?: string;
  /** covers this scene and at least half the video: listed under "runs across the video" */
  across?: boolean;
  faded?: boolean; line?: number;
  /** "4.23s (f127) – 6.16s · 1.93s long (58 frames)" */
  time: string;
  props: PageProp[]; json: string; cmd: string; docs: string;
}
export interface PageScene {
  n: number; id: string; label: string; note?: string; pastEnd?: boolean; range: string; marks: string[]; changes: string[]; moved?: string;
  /** left and width on the lane strip, % */
  l: number; w: number;
  issues: { severity: string; message: string; fix?: string }[];
  tile?: string;
  moments: { label: string; src?: string }[];
  solos: { lane: Lane; src?: string }[];
  items: PageItem[];
  /** its caption words */
  words?: string;
  /** elements per lane (faded ones not counted) */
  layers: Record<Lane, number>;
  /** level 2 as text (what "copy scene" copies) */
  text: string[];
}
export interface PageBlock { l: number; w: number; row: number; id: string; what: string; faded?: boolean; tin?: number; tout?: number }
export interface PageData {
  title: string; file: string; comp: string; size: [number, number]; seconds: number; made: string;
  /** when the storyboard ● compares against was made */
  since?: string;
  /** where the video ends on the strip, % (idea scenes can run past it) */
  end: number;
  scenes: PageScene[];
  lanes: { lane: Lane; colour: string; rows: number; spans: PageBlock[] }[];
  points: { x: number; what: string }[];
  notes: string[];
  unplaced: { message: string; fix?: string }[];
  /** level 1 as text */
  lines: string[];
}
export interface SceneImages { tile?: string; moments: { label: string; src?: string }[]; solos: { lane: Lane; src?: string }[] }

const SETTINGS_SKIP = new Set(['id', 'track']);
const TIME_KEYS = new Set(['at', 'len', 'in']);
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const short = (v: unknown, n = 60) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const AUDIO = new Set<Lane>(['voice', 'music', 'sfx']);

/** Settings as readable rows: times in seconds, objects one level down, keyframes counted, colours with swatches. */
function props(c: Clip, fps: number): PageProp[] {
  const out: PageProp[] = [];
  const val = (k: string, v: unknown): PageProp => {
    if (TIME_KEYS.has(k) && typeof v === 'number') return { k, v: `${(v / fps).toFixed(2)}s (f${v})` };
    if (isKeyframes(v)) { const ks = v as [number, unknown][]; return { k, v: `${ks.length} keys: ${short(ks[0]![1], 16)} at f${ks[0]![0]} → ${short(ks.at(-1)![1], 16)} at f${ks.at(-1)![0]}` }; }
    const sw = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && HEX.test(x));
    const text = Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join(', ') : short(v);
    return { k, v: text, ...(sw.length ? { swatches: sw } : {}) };
  };
  for (const [k, v] of Object.entries(c)) {
    if (SETTINGS_SKIP.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) out.push(val(`${k}.${k2}`, v2));
    else out.push(val(k, v));
  }
  return out;
}

/** The edit that fits the element: text for titles, gen params for generators, colour for solids, gain for sound. */
function editHint(c: Clip | undefined, lane: Lane, kind: string): string {
  if (AUDIO.has(lane)) return 'gain=-6';
  if (kind === 'text') return 'text="…" y=…';
  if (kind === 'captions') return 'y=… style.size=…';
  if (kind === 'gen') { const ks = Object.keys(c?.gen ?? {}).filter((k) => k !== 'type').slice(0, 2); return ks.length ? ks.map((k) => `gen.${k}=…`).join(' ') : 'gen.type=…'; }
  if (kind === 'solid') return 'color=#…';
  return lane === 'picture' ? 'opacity=… fx.0.amount=…' : 'x=… y=… scale=…';
}

/** The page's data from a storyboard (diffed and with findings assigned), the project and the rendered images. */
export function pageData(sb: Storyboard, project: ProjectFile, o: { file: string; images: Map<number, SceneImages>; lineOf?: (clipId: string) => { line: number; text: string } | undefined; made?: Date; since?: string }): PageData {
  const clips = new Map((project.clips ?? []).map((c) => [c.id, c]));
  const fps = sb.fps, secs = (f: number) => `${(f / fps).toFixed(1)}s`;
  const L = Math.max(1, sb.length, ...sb.scenes.map((s) => s.at + s.len)); // idea scenes past the end keep their column
  const pct = (f: number) => Math.round((Math.min(L, Math.max(0, f)) / L) * 10000) / 100;
  const item = (s: StoryScene, i: StoryScene['items'][number]): PageItem => {
    const c = clips.get(i.clip) as Clip | undefined, at = o.lineOf?.(i.clip), end = i.at + i.len, se = s.at + s.len;
    const a = Math.max(i.at, s.at), b = Math.min(end, se);
    const rel = [i.at < s.at ? `starts ${secs(s.at - i.at)} before` : '', end > se ? `runs on ${secs(end - se)} after` : ''].filter(Boolean).join(' · ');
    return {
      clip: i.clip, lane: i.lane, kind: i.kind, label: i.label, marks: i.marks, range: rangeOf(a, Math.max(0, b - a), fps), ...(rel ? { rel } : {}),
      ...(i.at <= s.at && end >= se && i.len * 2 >= sb.length && i.len > s.len ? { across: true } : {}),
      ...(i.faded ? { faded: true } : {}), ...(at ? { line: at.line } : {}),
      time: `${(i.at / fps).toFixed(2)}s (f${i.at}) – ${(end / fps).toFixed(2)}s · ${(i.len / fps).toFixed(2)}s long (${i.len} frames)`,
      props: c ? props(c, fps) : [], json: at?.text.trim().replace(/,$/, '') ?? JSON.stringify(c ?? {}),
      cmd: `mgl edit ${o.file} clip.set ${i.clip} ${editHint(c, i.lane, i.kind)}`, docs: 'mgl docs clip.set',
    };
  };
  const lineNo = (id: string) => o.lineOf?.(id)?.line;
  const scenes = sb.scenes.map((s): PageScene => {
    const img = o.images.get(s.n);
    return {
      n: s.n, id: s.id, label: s.label, ...(s.note ? { note: s.note } : {}), ...(s.pastEnd ? { pastEnd: true } : {}),
      range: rangeOf(s.at, s.len, fps), marks: marksOf(s), changes: s.changes, l: pct(s.at), w: pct(s.at + s.len) - pct(s.at),
      ...(s.movedBy && !s.changed ? { moved: `moved ${s.movedBy > 0 ? '+' : ''}${(s.movedBy / fps).toFixed(1)}s` } : {}),
      issues: s.findings.map((f) => ({ severity: f.severity, message: f.message, ...(f.fix ? { fix: f.fix } : {}) })),
      ...(img?.tile ? { tile: img.tile } : {}), moments: img?.moments ?? [], solos: img?.solos ?? [],
      items: s.items.map((i) => item(s, i)), ...(s.words ? { words: s.words } : {}),
      layers: Object.fromEntries(LANES.map((l) => [l, s.items.filter((i) => i.lane === l && !i.faded).length])) as Record<Lane, number>,
      text: sceneDetail(sb, s.n, sb.rate, lineNo),
    };
  });
  const lanes = LANES.map((lane) => ({
    lane, colour: LANE_COLOURS[lane], rows: Math.max(1, ...sb.lanes[lane].map((b) => b.row + 1)),
    spans: sb.lanes[lane].map((sp): PageBlock => {
      const c = clips.get(sp.clips[0]!), lb = sp.cue ? `"${sp.text ?? ''}"` : c ? clipLabel(project, c) : '';
      const id = sp.cue ?? sp.clips[0]!, w = Math.max(0.3, pct(sp.at + sp.len) - pct(sp.at)), rel = (x?: number) => (x ? Math.min(50, Math.round((x / Math.max(1, sp.len)) * 1000) / 10) : undefined);
      return {
        l: pct(sp.at), w, row: sp.row, id, what: `${lane}: ${sp.cue ? `${sp.clips[0]} cue ${sp.cue}` : id}${lb && lb !== id ? ` ${lb}` : ''} · ${rangeOf(sp.at, sp.len, fps)}${sp.faded ? ' (off)' : ''}`,
        ...(sp.faded ? { faded: true } : {}), ...(rel(sp.tin) ? { tin: rel(sp.tin) } : {}), ...(rel(sp.tout) ? { tout: rel(sp.tout) } : {}),
      };
    }),
  }));
  return {
    title: project.project?.name ?? sb.scenes.find((s) => s.source === 'lead' || s.source === 'sentence')?.label ?? o.file.replace(/^.*[\\/]/, '').replace(/\.mgl\.json$|\.json$/, ''),
    file: o.file, comp: sb.comp, size: sb.size, seconds: Math.round((sb.length / fps) * 10) / 10,
    made: (o.made ?? new Date()).toISOString().slice(0, 16).replace('T', ' '), ...(o.since ? { since: o.since.slice(0, 16).replace('T', ' ') } : {}),
    end: pct(sb.length), scenes, lanes,
    points: sb.points.map((p) => ({ x: pct(p.at), what: `marker ${p.id} ${(p.at / fps).toFixed(1)}s${p.note ? ` "${p.note}"` : ''}` })),
    notes: sb.notes, unplaced: sb.unplaced.map((f) => ({ message: f.message, ...(f.fix ? { fix: f.fix } : {}) })),
    lines: sceneLines(sb),
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const CHIP: Record<Lane, string> = { picture: 'pic', graphics: 'gfx', captions: 'cap', voice: 'vo', music: 'mus', sfx: 'sfx' };
const MARK: Record<string, string> = { idea: 'idea', issue: '⚠', changed: '●' };

/** pic gfx cap vo mus sfx×2: a missing layer greyed out (also in the panel). */
const chips = (layers: Record<Lane, number>) => `<span class="chips">${LANES.map((l) => `<span class="chip${layers[l] ? '' : ' off'}" style="--c:${LANE_COLOURS[l]}" title="${l}: ${layers[l] || 'none'}">${CHIP[l]}${layers[l] > 1 && AUDIO.has(l) ? `×${layers[l]}` : ''}</span>`).join('')}</span>`;

/** One scene card (static HTML: readable without the script). */
function card(s: PageScene): string {
  const cls = ['tile', ...s.marks].join(' ');
  const pic = s.tile
    ? `<img src="${s.tile}" alt="scene ${s.n}, middle frame">`
    : `<div class="note"><b>idea</b><span>${esc(s.note ?? s.label)}</span><small>${s.pastEnd ? 'after the end: not rendered' : 'nothing visual yet'}</small></div>`;
  const why = [
    ...(s.issues[0] ? [`<div class="why m-issue">⚠ ${esc(s.issues[0].message)}</div>`] : []),
    ...(s.changes[0] ? [`<div class="why m-changed">● ${esc(s.changes[0])}</div>`] : []),
  ].join('');
  return `<button class="${cls}" data-n="${s.n}" data-marks="${s.marks.join(' ')}">${pic}<div class="hd"><b>${s.n}</b>${s.marks.map((m) => ` <span class="m-${m}">${MARK[m]}</span>`).join('')} <small>${s.range}</small></div><div class="lbl">${s.note ? '<i>note</i> ' : ''}${esc(s.label)}</div>${chips(s.layers)}${why}</button>`;
}

const CSS = `
:root{--bg:#f6f6f8;--fg:#18181c;--dim:#5d5d68;--card:#fff;--line:#d6d6de;--band:#0000000a;--warn:#a85f00;--warnbg:#fff3df;--chg:#1565c0;--idea:#8a6400;--chk:#3a3a42;--chk2:#2c2c33;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#e8e8ec;--dim:#9a9aa6;--card:#202026;--line:#34343e;--band:#ffffff0a;--warn:#ffb020;--warnbg:#3a2a0c;--chg:#5cb4ff;--idea:#ffd166}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main{padding:12px 16px;max-width:1400px;margin:auto}h1{font-size:20px;margin:0 0 2px}h2{font-size:17px;margin:0}h3{font-size:14px;margin:14px 0 6px}small,.dim{color:var(--dim)}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 4px}
.pill{border:1px solid var(--line);background:var(--card);color:inherit;border-radius:999px;padding:4px 12px;font:inherit;cursor:pointer}.pill[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.legend{font-size:12px;color:var(--dim)}.banner{border-left:3px solid var(--warn);background:var(--warnbg);padding:6px 10px;border-radius:4px;margin:8px 0}.banner.chg{border-color:var(--chg);background:var(--card)}
#tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.tile{display:flex;flex-direction:column;gap:3px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:5px;cursor:pointer;text-align:left;color:inherit;font:inherit;min-width:0}
.tile.issue{border-color:var(--warn);box-shadow:0 0 0 1px var(--warn)}.tile.hide{display:none}.tile img{width:100%;display:block;border-radius:6px;aspect-ratio:var(--ar);object-fit:cover;background:#000}
.note{aspect-ratio:var(--ar);border:2px dashed var(--idea);border-radius:6px;padding:8px;overflow:hidden;color:var(--idea);display:flex;flex-direction:column;gap:6px}.note span{color:var(--fg);font-size:15px}
.m-issue{color:var(--warn)}.m-changed{color:var(--chg)}.m-idea{color:var(--idea);font-weight:600}
.lbl{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.why{font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.chips{display:flex;gap:3px;flex-wrap:wrap}.chip{font-size:11px;padding:0 5px;border-radius:4px;border-left:3px solid var(--c);background:var(--bg)}.chip.off{opacity:.35;border-left-color:var(--line);text-decoration:line-through}
#strip{margin:14px 0 4px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px}
.lane{display:flex;align-items:stretch;margin:2px 0}.lane>b{width:78px;font-size:12px;font-weight:500;flex:none;display:flex;align-items:center;gap:5px}.dot{width:9px;height:9px;border-radius:50%;flex:none}
.track{position:relative;flex:1;min-height:14px}.band{position:absolute;top:0;bottom:0}.band.alt{background:var(--band)}
.blk{position:absolute;border-radius:2px;overflow:hidden;font-size:10px;line-height:1;color:#000c;white-space:nowrap;padding:0 2px;cursor:pointer;box-shadow:inset -1px 0 0 var(--card)}.blk.off{opacity:.35}.blk:hover,.blk.sel{outline:2px solid var(--fg);z-index:2}
.tw{position:absolute;top:0;bottom:0;background:linear-gradient(to top right,#0000 49%,#0006 51%)}.tw.o{right:0;background:linear-gradient(to top left,#0000 49%,#0006 51%)}
.none{position:absolute;inset:50% 0 auto 0;border-top:1px dashed var(--line)}.none span{position:absolute;left:4px;top:-8px;font-size:11px;color:var(--dim);background:var(--card);padding:0 4px}
.pt{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--warn)}.endl{position:absolute;top:0;bottom:0;border-left:2px solid var(--fg);z-index:3}.endl span{position:absolute;top:-1px;left:3px;font-size:11px;background:var(--card);padding:0 3px;white-space:nowrap}
.past{position:absolute;top:0;bottom:0;right:0;background:repeating-linear-gradient(135deg,#8883 0 4px,#0000 4px 8px)}
.lane.sc .track{height:22px}.scn{position:absolute;top:0;height:22px;border-left:1px solid var(--line);font-size:12px;text-align:center;line-height:22px;cursor:pointer;overflow:hidden;color:var(--dim)}
.scn:hover{background:var(--line);color:var(--fg)}.scn.issue{background:#ffb02040;color:var(--fg)}.scn.changed{background:#3fa9ff30;color:var(--fg)}
#tip{min-height:20px;font-size:12px}
#panel{margin-top:16px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.ph{display:flex;gap:8px;align-items:center;flex-wrap:wrap;position:sticky;top:0;background:var(--card);padding:4px 0;z-index:4}.ph h2{flex:1;min-width:200px}
.row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;max-width:520px}.row.solo{max-width:400px}.row figure{margin:0;position:relative}.row img{width:100%;display:block;border-radius:6px}figcaption{font-size:12px;color:var(--dim)}
.stack{position:relative}.stack img+img{position:absolute;inset:0}
.solo img{background:repeating-conic-gradient(var(--chk) 0 25%,var(--chk2) 0 50%) 0 0/14px 14px}
.box{border-left:3px solid var(--warn);background:var(--warnbg);padding:6px 10px;border-radius:4px;margin:6px 0}
ul.els{list-style:none;padding:0;margin:4px 0}.els li{display:flex;gap:8px;align-items:center;border-left:4px solid var(--c);padding:6px 8px;margin:3px 0;background:var(--bg);border-radius:4px;cursor:pointer;min-height:36px}
.els li:hover{outline:1px solid var(--line)}.els .t{flex:1;min-width:0}.els .t small{display:block}
.ic{border:1px solid var(--line);background:transparent;color:inherit;border-radius:6px;font:inherit;font-size:12px;padding:2px 8px;cursor:pointer}
dl.props{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:6px 0}dl.props dt{color:var(--dim)}dl.props dd{margin:0;word-break:break-word}.sw{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--line);vertical-align:-2px;margin-right:3px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);padding:8px;border-radius:6px;font-size:12px}code{font-size:12px}
details summary{cursor:pointer;color:var(--dim)}
@media (max-width:600px){#tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.lane>b{width:68px;font-size:11px}
#panel{position:fixed;inset:0;margin:0;border-radius:0;overflow:auto;z-index:10}.row{grid-template-columns:repeat(3,minmax(0,1fr))}.els li{min-height:44px}}
`;

// level 1 is static HTML; the script adds the lane strip, filters, level 2 on a card, level 3 on an element, copy
const JS = `
const D=JSON.parse(document.getElementById('data').textContent),$=(s)=>document.querySelector(s),$$=(s)=>[...document.querySelectorAll(s)];
function h(t,a,...k){const e=document.createElement(t);for(const[n,v]of Object.entries(a||{}))n==='on'?e.addEventListener('click',v):n==='style'?e.style.cssText=v:e.setAttribute(n,v);for(const c of k.flat(9))if(c!=null&&c!==false)e.append(c.nodeType?c:String(c));return e}
const MK={idea:'idea',issue:'\\u26a0',changed:'\\u25cf'},COL=Object.fromEntries(D.lanes.map((l)=>[l.lane,l.colour])),TAP=matchMedia('(pointer:coarse)').matches;
const marks=(m)=>m.map((x)=>h('span',{class:'m-'+x},' '+MK[x]));
function copy(t,b){const done=()=>{const o=b.textContent;b.textContent='copied';setTimeout(()=>b.textContent=o,900)};if(navigator.clipboard)navigator.clipboard.writeText(t).then(done,()=>prompt('copy',t));else prompt('copy',t)}
const cbtn=(t,label,title)=>{const b=h('button',{class:'ic',title:title||'copy: '+t},label||'copy');b.onclick=(e)=>{e.stopPropagation();copy(t,b)};return b};
document.documentElement.style.setProperty('--ar',D.size[0]+'/'+D.size[1]);
const F={issue:false,changed:false};
function filt(){let any=0;for(const t of $$('.tile')){const m=t.dataset.marks.split(' '),hide=F.issue&&!m.includes('issue')||F.changed&&!m.includes('changed');t.classList.toggle('hide',hide);any+=!hide}$('#empty').hidden=!!any}
for(const k of['issue','changed'])$('#f-'+k).onclick=(e)=>{F[k]=!F[k];e.currentTarget.setAttribute('aria-pressed',F[k]);filt()};
for(const t of $$('.tile'))t.onclick=()=>scene(D.scenes.find((s)=>s.n===+t.dataset.n));
$('#tip').textContent=(TAP?'tap':'hover or click')+' a block to see what it is; scene numbers open the scene';
function strip(){const el=$('#strip'),tip=$('#tip'),bands=()=>D.scenes.map((s,i)=>h('div',{class:'band'+(i%2?' alt':''),style:'left:'+s.l+'%;width:'+s.w+'%'}));
const end=()=>D.end<100?[h('div',{class:'past',style:'left:'+D.end+'%'}),h('div',{class:'endl',style:'left:'+D.end+'%'})]:[];
el.append(h('div',{class:'lane sc'},h('b',{},'scenes'),h('div',{class:'track'},D.scenes.map((s)=>h('div',{class:'scn '+(s.marks.includes('issue')?'issue':s.marks.includes('changed')?'changed':''),style:'left:'+s.l+'%;width:'+s.w+'%',title:'scene '+s.n+' "'+s.label+'" '+s.range,on:()=>scene(s)},s.n)),D.end<100?h('div',{class:'endl',style:'left:'+D.end+'%'},h('span',{title:'the video ends here: scenes after it are ideas, not rendered'},'end')):null,D.points.map((p)=>h('div',{class:'pt',style:'left:'+p.x+'%',title:p.what})))));
for(const l of D.lanes){const rh=l.rows>1?9:12,tr=h('div',{class:'track',style:'height:'+(l.rows*rh+2)+'px'},bands(),end());
if(!l.spans.length)tr.append(h('div',{class:'none'},h('span',{},'none')));
for(const s of l.spans){const b=h('div',{class:'blk'+(s.faded?' off':''),title:s.what,style:'left:'+s.l+'%;width:'+s.w+'%;top:'+(s.row*rh+1)+'px;height:'+(rh-1)+'px;background:'+l.colour},rh>9&&(innerWidth-140)*s.w/100>40?s.id:'');
if(s.tin)b.append(h('div',{class:'tw',style:'left:0;width:'+s.tin+'%'}));if(s.tout)b.append(h('div',{class:'tw o',style:'width:'+s.tout+'%'}));
const show=()=>{tip.textContent=s.what;$$('.blk.sel').forEach((x)=>x.classList.remove('sel'));b.classList.add('sel')};b.onmouseenter=show;b.onclick=show;tr.append(b)}
el.append(h('div',{class:'lane'},h('b',{},h('span',{class:'dot',style:'background:'+l.colour}),l.lane),tr))}}
const chipsOf=(s)=>h('div',{class:'chips'},D.lanes.map((l)=>{const n=s.layers[l.lane];return h('span',{class:'chip'+(n?'':' off'),style:'--c:'+l.colour,title:l.lane+': '+(n||'none')},l.lane+(n>1?' \\u00d7'+n:''))}));
function els(s,list){return h('ul',{class:'els'},list.map((i)=>h('li',{style:'--c:'+COL[i.lane],on:()=>item(i)},h('div',{class:'t'},h('b',{},i.clip),' '+(i.label!==i.clip?i.label:''),h('small',{},i.lane+' \\u00b7 '+i.range+(i.rel?' \\u00b7 '+i.rel:'')+(i.marks.length?' \\u00b7 '+i.marks.join(' \\u00b7 '):'')+(i.faded?' \\u00b7 off':''))),cbtn(i.clip,'\\u29c9'))))}
function scene(s){const p=$('#panel');p.hidden=false;p.replaceChildren();
p.append(h('div',{class:'ph'},h('h2',{},'scene '+s.n,marks(s.marks),' ',h('small',{},(s.note?'note ':'')+'"'+s.label+'" '+s.range+(s.moved?' \\u00b7 '+s.moved:''))),cbtn(s.text.join('\\n'),'copy scene','copy this scene as text (for chat)'),h('button',{class:'ic',on:()=>{p.hidden=true}},'close')));
if(s.marks.includes('idea'))p.append(h('p',{class:'m-idea'},'idea: nothing visual here yet'+(s.pastEnd?' \\u00b7 after the end of the video, not rendered':'')));
if(s.issues.length)p.append(h('h3',{class:'m-issue'},'\\u26a0 issues in this scene'),...s.issues.map((f)=>h('div',{class:'box'},h('b',{},f.severity+': '),f.message,f.fix?h('div',{},'fix: ',h('code',{},f.fix),' ',cbtn(f.fix)):'')));
if(s.changes.length)p.append(h('h3',{class:'m-changed'},'\\u25cf changed since the storyboard of '+(D.since||'before')),h('ul',{},s.changes.map((c)=>h('li',{},c))));
const solo=s.solos.filter((x)=>x.src),ms=s.moments.filter((m)=>m.src),mid=(s.moments[1]||{}).src;
if(ms.length){const on=new Set(solo.map((x)=>x.lane)),box=h('div',{class:'stack'});
const draw=()=>{box.replaceChildren();if(on.size===solo.length)box.append(h('img',{src:mid,alt:'middle'}));else{const v=solo.filter((x)=>on.has(x.lane));v.forEach((x)=>box.append(h('img',{src:x.src,alt:x.lane})));if(!v.length)box.append(h('img',{src:mid,style:'opacity:.08',alt:''}))}};
const tg=solo.map((x)=>{const b=h('button',{class:'pill','aria-pressed':'true'},x.lane);b.onclick=()=>{on.has(x.lane)?on.delete(x.lane):on.add(x.lane);b.setAttribute('aria-pressed',on.has(x.lane));draw()};return b});
p.append(h('h3',{},'picture'),tg.length?h('div',{class:'bar'},h('small',{},'layers on the middle frame:'),tg):'',h('div',{class:'row'},ms.map((m)=>h('figure',{},m.src===mid?(draw(),box):h('img',{src:m.src,alt:m.label}),h('figcaption',{},m.label)))));
if(solo.length)p.append(h('h3',{},'each layer alone'),h('div',{class:'row solo'},s.solos.map((m)=>h('figure',{},m.src?h('img',{src:m.src,alt:m.lane}):h('div',{class:'dim'},'no '+m.lane+' here'),h('figcaption',{},m.lane)))));
else p.append(h('p',{class:'dim'},'start, end and each layer alone: ',h('code',{},'mgl look '+D.file+' --scene '+s.n)))}
if(s.words)p.append(h('h3',{},'words'),h('p',{},'\\u201c'+s.words+'\\u201d'));
const own=s.items.filter((i)=>!i.across),wide=s.items.filter((i)=>i.across);
p.append(h('h3',{},'in this scene'),chipsOf(s),own.length?els(s,own):h('p',{class:'dim'},'nothing of its own'));
if(wide.length)p.append(h('details',{},h('summary',{},'runs across the whole video ('+wide.length+')'),els(s,wide)));
p.append(h('div',{id:'l3'}));p.scrollIntoView({behavior:'smooth',block:'start'})}
function item(i){const el=$('#l3');el.replaceChildren(h('h3',{},'element '+i.clip+' ',h('small',{},i.kind+' \\u00b7 '+i.lane+(i.line?' \\u00b7 line '+i.line+' of '+D.file:''))),h('p',{},i.time),
h('dl',{class:'props'},i.props.map((x)=>[h('dt',{},x.k),h('dd',{},(x.swatches||[]).map((c)=>h('span',{class:'sw',style:'background:'+c})),x.v)])),
h('p',{},'change it: ',h('code',{},i.cmd),' ',cbtn(i.cmd)),h('p',{class:'dim'},'docs: ',h('code',{},i.docs)),h('details',{},h('summary',{},'json'),h('pre',{},i.json)));el.scrollIntoView({behavior:'smooth',block:'nearest'})}
strip();
`;

/** The page as one HTML string (inline CSS, script and data; no external URLs). */
export function storyboardPage(d: PageData): string {
  const issues = d.scenes.filter((s) => s.marks.includes('issue')).length, changed = d.scenes.filter((s) => s.marks.includes('changed')).length;
  const data = JSON.stringify(d).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const since = d.since ? `● changed since the storyboard of ${esc(d.since)}` : '● nothing yet: there is no earlier storyboard to compare with';
  const banners = [
    ...d.unplaced.map((f) => `<div class="banner">⚠ whole video: ${esc(f.message)}${f.fix ? ` · fix: <code>${esc(f.fix)}</code>` : ''}</div>`),
    ...(d.notes.length ? [`<div class="banner chg">● changed outside the scenes: ${esc(d.notes.join('; '))}</div>`] : []),
  ].join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Storyboard: ${esc(d.title)}</title><style>${CSS}</style></head>
<body><header><h1>${esc(d.title)}</h1><small>${esc(d.file)} · comp ${esc(d.comp)} · ${d.size[0]}x${d.size[1]} · ${d.seconds} s · ${d.scenes.length} scenes · made ${esc(d.made)}</small>
<div class="bar"><button class="pill" id="f-issue" aria-pressed="false">⚠ issues ${issues}</button><button class="pill" id="f-changed" aria-pressed="false">● changed ${changed}</button>
<span class="legend">⚠ QA found a problem in the scene · ${since} · <span class="m-idea">idea</span> a planned scene with nothing visual yet</span></div>${banners}</header>
<main><div id="tiles">${d.scenes.map(card).join('')}</div><p id="empty" class="dim" hidden>no scenes match the filters</p>
<div id="strip"></div><div id="tip" class="dim"></div>
<section id="panel" hidden></section>
<details><summary>the storyboard as text</summary><pre>${esc(d.lines.join('\n'))}</pre></details></main>
<script type="application/json" id="data">${data}</script>
<script>${JS}</script></body></html>
`;
}
