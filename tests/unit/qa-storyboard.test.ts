import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Clip, ProjectFile } from '../../src/core/schema/index.js';
import {
  LANES, assignFindings, buildStoryboard, deriveScenes, diffStoryboard, laneOf, readPrevious, sceneDetail, sceneFrames, sceneLines,
  sceneMoments, storyboardDir, touchedLine, touchedScenes, writeSnapshot,
} from '../../src/qa/storyboard.js';

const clone = <T>(v: T): T => structuredClone(v);

/** 11 s at 30 fps: hook title, two backgrounds, captions with three sentences, voice, music, a whoosh. */
function story(): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'b1', src: 'media/broll.mp4' }, { id: 'voa', src: 'vo.wav' }, { id: 'mus', src: 'audio/bed.mp3' }, { id: 'wh', src: 'whoosh.wav' }],
    comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 330 }],
    tracks: [
      { id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'C1', comp: 'main' },
      { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }, { id: 'A3', comp: 'main', audio: true },
    ],
    clips: [
      { id: 'bg1', track: 'V1', at: 0, len: 150, asset: 'b1', fx: [{ type: 'ken-burns' }] },
      { id: 'bg2', track: 'V1', at: 150, len: 180, gen: { type: 'aurora' }, transition: { in: { type: 'crossfade', len: 10 } } },
      { id: 'hook', track: 'T1', at: 0, len: 60, text: 'Three tips to focus', animate: { in: 'pop' }, scale: [[0, 0.7], [10, 1]] },
      { id: 'caps', track: 'C1', at: 60, len: 270, captions: true },
      { id: 'vo', track: 'A1', at: 0, len: 330, asset: 'voa' },
      { id: 'bed', track: 'A2', at: 0, len: 330, asset: 'mus', gain: -9 },
      { id: 'whoosh', track: 'A3', at: 150, len: 15, asset: 'wh' },
    ],
    cues: [
      { id: 'q1', clip: 'caps', at: 0, len: 30, text: 'Put your phone' },
      { id: 'q2', clip: 'caps', at: 30, len: 60, text: '*away*.' },
      { id: 'q3', clip: 'caps', at: 90, len: 30, text: 'Work in 25-minute' },
      { id: 'q4', clip: 'caps', at: 120, len: 60, text: 'blocks!' },
      { id: 'q5', clip: 'caps', at: 180, len: 60, text: 'Follow for more' },
    ],
  } as ProjectFile;
}
const clip = (p: ProjectFile, id: string) => p.clips!.find((c) => c.id === id)!;
const brief = (p: ProjectFile) => deriveScenes(p, 'main').map((s) => [s.n, s.id, s.at, s.len, s.label]);

describe('scenes', () => {
  it('come from sentences, with the hook before the first sentence as its own scene', () => {
    expect(brief(story())).toEqual([
      [1, 'hook', 0, 60, 'Three tips to focus'],
      [2, 'q1', 60, 90, 'Put your phone away.'],
      [3, 'q3', 150, 90, 'Work in 25-minute blocks!'],
      [4, 'q5', 240, 90, 'Follow for more'],
    ]);
  });

  it('fold a lead under 0.5 s into the first sentence; ellipsis ends a sentence', () => {
    const p = story();
    clip(p, 'caps').at = 10;
    p.cues![0]!.text = 'Put your phone…';
    const s = brief(p);
    expect(s[0]).toEqual([1, 'q1', 0, 40, 'Put your phone…']);
    expect(s[1]).toEqual([2, 'q2', 40, 60, 'away.']);
  });

  it('come from shots on the bottom visible track when there are no cues', () => {
    const p = story();
    p.cues = [];
    p.clips = p.clips!.filter((c) => c.id !== 'hook');
    p.tracks!.unshift({ id: 'V0', comp: 'main', hidden: true });
    p.clips.push({ id: 'ghost', track: 'V0', at: 0, len: 330, color: '#000' } as Clip);
    expect(brief(p)).toEqual([[1, 'bg1', 0, 150, 'bg1'], [2, 'bg2', 150, 180, 'bg2']]);
  });

  it('label a shot with a title that sits in it', () => {
    const p = story();
    p.cues = [];
    expect(deriveScenes(p, 'main')[0]!.label).toBe('Three tips to focus');
  });

  it('fall back to 5-second chunks', () => {
    const p = story();
    p.cues = [];
    p.clips = p.clips!.filter((c) => clip(p, c.id).track.startsWith('A'));
    const s = deriveScenes(p, 'main');
    expect(s.map((x) => [x.id, x.at, x.len, x.label])).toEqual([['0-5s', 0, 150, '0.0–5.0s'], ['5-10s', 150, 150, '5.0–10.0s'], ['10-15s', 300, 30, '10.0–11.0s']]);
    expect(s.every((x) => x.idea)).toBe(true);
  });

  it('take scene markers over the base, merge small pieces, keep ideas past the end', () => {
    const p = story();
    p.markers = [
      { id: 'timer', comp: 'main', at: 150, len: 60, note: 'show a timer', scene: true },
      { id: 'later', comp: 'main', at: 400, len: 30, note: 'outro idea', scene: true },
      { id: 'beat', comp: 'main', at: 90, len: 30, note: 'a range, not a scene' },
    ];
    const s = deriveScenes(p, 'main');
    expect(s.map((x) => [x.id, x.at, x.len, x.label, x.idea])).toEqual([
      ['hook', 0, 60, 'Three tips to focus', false],
      ['q1', 60, 90, 'Put your phone away.', false],
      ['timer', 150, 60, 'show a timer', false],
      ['q3', 210, 30, 'Work in 25-minute blocks!', false],
      ['q5', 240, 90, 'Follow for more', false],
      ['later', 400, 30, 'outro idea', true],
    ]);
    p.markers[0]!.len = 80; // leaves 10 frames of q3: merged into the marker that cut it, no gap
    expect(deriveScenes(p, 'main').map((x) => [x.id, x.at, x.len])).toEqual([['hook', 0, 60], ['q1', 60, 90], ['timer', 150, 90], ['q5', 240, 90], ['later', 400, 30]]);
    // slivers on both sides of a marker inside a sentence go to the marker; the next sentence keeps its start
    p.markers = [{ id: 'mid', comp: 'main', at: 155, len: 75, scene: true }];
    expect(deriveScenes(p, 'main').map((x) => [x.id, x.at, x.len])).toEqual([['hook', 0, 60], ['q1', 60, 90], ['mid', 150, 90], ['q5', 240, 90]]);
    // a scene marker in the middle of a base scene splits it in two
    p.markers = [{ id: 'mid', comp: 'main', at: 90, len: 30, scene: true }];
    expect(deriveScenes(p, 'main').map((x) => [x.id, x.at, x.len, x.label])).toEqual([
      ['hook', 0, 60, 'Three tips to focus'], ['q1', 60, 30, 'Put your phone away.'], ['mid', 90, 30, 'mid'], ['q1.2', 120, 30, 'Put your phone away.'],
      ['q3', 150, 90, 'Work in 25-minute blocks!'], ['q5', 240, 90, 'Follow for more'],
    ]);
  });

  it('marks an empty marked range as an idea', () => {
    const p = story();
    p.comps[0]!.length = 450;
    p.markers = [{ id: 'gap', comp: 'main', at: 330, len: 120, note: 'b-roll here', scene: true }];
    const s = deriveScenes(p, 'main');
    expect(s.at(-1)).toMatchObject({ id: 'gap', idea: true, label: 'b-roll here' });
  });

  it('group more than 24 scenes evenly into 24', () => {
    const p = story();
    p.comps[0]!.length = 30 * 5 * 30; // 30 chunks
    p.cues = [];
    p.clips = [];
    const s = deriveScenes(p, 'main');
    expect(s).toHaveLength(24);
    expect(s.filter((x) => x.label.endsWith(' (+1)'))).toHaveLength(6);
    expect(s[0]!.at).toBe(0);
    s.forEach((x, i) => { if (i) expect(x.at).toBe(s[i - 1]!.at + s[i - 1]!.len); });
    expect(s.at(-1)!.at + s.at(-1)!.len).toBe(4500);
    expect(s.map((x) => x.n)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });
});

describe('lanes', () => {
  it('classify every clip kind and bus', () => {
    const p = story();
    p.buses = [{ id: 'vox', to: 'dialogue' }, { id: 'fx' }];
    p.tracks!.push({ id: 'A4', comp: 'main', audio: true, bus: 'vox' }, { id: 'A5', comp: 'main', audio: true, bus: 'fx' });
    const add: Partial<Clip>[] = [
      { id: 'shape', track: 'T1', shape: { type: 'rect' } }, { id: 'solid', track: 'V1', color: '#000' }, { id: 'nest', track: 'V1', comp: 'other' },
      { id: 'adj', track: 'T1', adjustment: true }, { id: 'pip', track: 'T1', asset: 'b1', scale: 0.5 }, { id: 'pipk', track: 'T1', asset: 'b1', scale: [[0, [0.4, 0.4]], [10, [0.6, 0.6]]] },
      { id: 'big', track: 'T1', asset: 'b1', scale: [1, 1] }, { id: 'mark', track: 'T1', asset: 'b1', scale: 0.2, tags: ['role:watermark'] },
      { id: 'glow', track: 'T1', shape: { type: 'ellipse' }, tags: ['role:watermark'] }, { id: 'vox1', track: 'A4', asset: 'voa' }, { id: 'fx1', track: 'A5', asset: 'wh' },
    ];
    p.clips!.push(...add.map((c) => ({ at: 0, len: 10, ...c }) as Clip));
    const lane = (id: string) => laneOf(p, clip(p, id));
    expect(Object.fromEntries(p.clips!.map((c) => [c.id, lane(c.id)]))).toEqual({
      bg1: 'picture', bg2: 'picture', hook: 'graphics', caps: 'captions', vo: 'voice', bed: 'music', whoosh: 'sfx',
      shape: 'graphics', solid: 'picture', nest: 'picture', adj: 'picture', pip: 'graphics', pipk: 'graphics', big: 'picture', mark: 'picture', glow: 'picture',
      vox1: 'voice', fx1: 'sfx',
    });
  });

  it('give each scene its items, labels and marks, and the whole video merged lane spans', () => {
    const p = story();
    p.markers = [{ id: 'beat', comp: 'main', at: 90, note: 'drop' }];
    const sb = buildStoryboard(p, 'main');
    const s3 = sb.scenes[2]!;
    expect(s3.items.map((i) => [i.clip, i.lane, i.label, i.marks])).toEqual([
      ['bg2', 'picture', 'aurora', ['in crossfade']], ['caps', 'captions', '2 cues', []], ['vo', 'voice', 'vo.wav', []], ['bed', 'music', 'bed.mp3', []], ['whoosh', 'sfx', 'whoosh.wav', []],
    ]);
    expect(s3.cues).toEqual(['q3', 'q4']);
    expect(sb.scenes[0]!.items.find((i) => i.clip === 'hook')).toMatchObject({ label: '"Three tips to focus"', marks: ['text pop', 'keys scale'] });
    expect(sb.scenes[0]!.items.find((i) => i.clip === 'bg1')!.marks).toEqual(['ken-burns']);
    // one block per clip (split at element boundaries, transitions as edges), one per cue on captions
    expect(sb.lanes.picture).toEqual([{ at: 0, len: 150, clips: ['bg1'], row: 0 }, { at: 150, len: 180, clips: ['bg2'], row: 0, tin: 10 }]);
    expect(sb.lanes.sfx).toEqual([{ at: 150, len: 15, clips: ['whoosh'], row: 0 }]);
    expect(sb.lanes.captions.map((b) => [b.cue, b.at, b.text])).toEqual([['q1', 60, 'Put your phone'], ['q2', 90, 'away.'], ['q3', 150, 'Work in 25-minute'], ['q4', 180, 'blocks!'], ['q5', 240, 'Follow for more']]);
    expect(s3.words).toBe('Work in 25-minute blocks!');
    expect(Object.keys(sb.lanes)).toEqual([...LANES]);
    expect(sb.points).toEqual([{ id: 'beat', at: 90, note: 'drop' }]);
    expect(sceneFrames(sb)).toEqual([30, 105, 195, 285]);
  });

  it('truncate long text labels to 30 characters and mark hidden clips faded', () => {
    const p = story();
    clip(p, 'hook').text = 'A very long hook title that keeps going and going';
    clip(p, 'bg1').hidden = true;
    const items = buildStoryboard(p, 'main').scenes[0]!.items;
    const hook = items.find((i) => i.clip === 'hook')!;
    expect(hook.label.length).toBeLessThanOrEqual(30);
    expect(hook.label).toMatch(/^"A very long.*…"$/);
    expect(items.find((i) => i.clip === 'bg1')!.faded).toBe(true);
  });
});

describe('diff', () => {
  it('without a previous version marks nothing', () => {
    expect(diffStoryboard(undefined, story(), 'main').scenes.some((s) => s.changed)).toBe(false);
  });

  it('marks the scenes an edit touched, by command or by hand', () => {
    const prev = story(), cur = clone(prev);
    clip(cur, 'hook').text = 'Two tips to focus';
    clip(cur, 'bg2').fx = [{ type: 'blur' }];
    const history = [{ at: '2026-10-07T10:00:00.000Z', patch: [{ table: 'clips', id: 'bg2' }] }, { at: '2026-10-07T12:00:00.000Z', patch: [{ table: 'clips', id: 'hook' }] }];
    const sb = diffStoryboard(prev, cur, 'main', history, '2026-10-07T11:00:00.000Z');
    expect(sb.scenes.map((s) => s.changed)).toEqual([true, false, true, true]);
    expect(sb.scenes[0]!.changes).toEqual(['hook now says "Two tips to focus"']);
    expect(sb.scenes[2]!.changes).toEqual(['bg2 effects (by hand)']);
    const gen = clone(prev);
    clip(prev, 'bg2').gen = { type: 'noise', colors: ['#000', '#fff'] } as never;
    clip(gen, 'bg2').gen = { type: 'noise', colors: ['#300', '#f80'] } as never;
    expect(diffStoryboard(prev, gen, 'main').scenes[2]!.changes).toEqual(['bg2 noise colors changed']);
    expect(sb.scenes[0]!.label).toBe('Two tips to focus');
  });

  it('does not count ripples (movedBy), marks explicit moves where they left and landed, and notes global changes', () => {
    const prev = story(), cur = clone(prev);
    cur.buses = [{ id: 'music', gain: -3 }];
    cur.project = { platform: 'tiktok' };
    let sb = diffStoryboard(prev, cur, 'main');
    expect(sb.scenes.some((s) => s.changed)).toBe(false);
    expect(sb.notes).toEqual(['project: platform', 'new bus music']);
    // an explicit move into another scene marks both; a cue retimed alone too
    const mv = clone(prev);
    clip(mv, 'whoosh').at = 260;
    mv.cues!.find((q) => q.id === 'q4')!.len = 40;
    sb = diffStoryboard(prev, mv, 'main');
    expect(sb.scenes.map((s) => s.changed)).toEqual([false, false, true, true]);
    expect(sb.scenes[3]!.changes).toEqual(['whoosh moved (5.0s→8.7s)']);
    expect(touchedScenes(prev, mv, 'main').map((s) => s.n)).toEqual([3, 4]);
    const mh = clone(prev);
    clip(mh, 'hook').at = 200;
    expect(diffStoryboard(prev, mh, 'main').scenes.find((s) => s.changes.includes('hook moved (0.0s→6.7s)'))).toBeDefined();

    // insert a sentence after the first: later cues ripple by 60 frames
    const ins = clone(prev);
    ins.comps[0]!.length = 390;
    clip(ins, 'caps').len = 330;
    clip(ins, 'bg2').len = 240;
    for (const id of ['vo', 'bed']) clip(ins, id).len = 390;
    clip(ins, 'whoosh').at = 210;
    for (const q of ins.cues!) if (q.at >= 90) q.at += 60;
    ins.cues!.splice(2, 0, { id: 'n1', clip: 'caps', at: 90, len: 60, text: 'Then close the door.' });
    sb = diffStoryboard(prev, ins, 'main');
    expect(sb.scenes.map((s) => [s.id, s.changed, s.movedBy])).toEqual([['hook', false, undefined], ['q1', false, undefined], ['n1', true, undefined], ['q3', false, 60], ['q5', false, 60]]);
    expect(sb.scenes[2]!.changes[0]).toBe('new caption');
    expect(sb.notes).toEqual(['comp main: length 330→390']);
    expect(sceneLines(sb).find((l) => l.startsWith('4 '))).toContain('(moved +2.0s)');
  });

  it('marks a removed clip on the scene it was in, a new scene marker, and restyled clips', () => {
    const prev = story();
    prev.styles = [{ id: 'big', size: 100 }];
    clip(prev, 'hook').style = 'big';
    const cur = clone(prev);
    cur.clips = cur.clips!.filter((c) => c.id !== 'whoosh');
    cur.styles = [{ id: 'big', size: 120 }];
    cur.markers = [{ id: 'timer', comp: 'main', at: 270, len: 30, note: 'show a timer', scene: true }];
    const sb = diffStoryboard(prev, cur, 'main');
    const by = (id: string) => sb.scenes.find((s) => s.id === id)!;
    expect(by('q3').changes).toEqual(['removed whoosh.wav']);
    expect(by('hook').changes).toEqual(['hook restyled']);
    expect(by('timer').changes).toEqual(['new scene']);
    expect(by('q5').changed).toBe(false);
  });

  it('reports a removal past the current scenes as a note, and tiles overlapping scene markers', () => {
    // comp length auto: removing the last shot leaves no scene where it was
    const prev = story();
    prev.comps[0]!.length = 'auto' as never;
    prev.cues = []; prev.clips = prev.clips!.filter((c) => c.track === 'V1');
    const cur = clone(prev);
    cur.clips = cur.clips!.filter((c) => c.id !== 'bg2');
    const sb = diffStoryboard(prev, cur, 'main');
    expect(sb.notes).toEqual(['removed aurora (5.0–11.0s, no scene there now)']);
    // an idea scene past the end, removed
    const ip = story();
    ip.markers = [{ id: 'later', comp: 'main', at: 400, len: 60, scene: true }];
    expect(diffStoryboard(ip, story(), 'main').notes).toEqual(['scene later removed (13.3–15.3s, no scene there now)']);
    // markers that overlap: the later one starts where the earlier ends; one inside another gets no scene
    const ov = story();
    ov.markers = [{ id: 'm1', comp: 'main', at: 30, len: 100, scene: true }, { id: 'm2', comp: 'main', at: 80, len: 100, scene: true }, { id: 'm3', comp: 'main', at: 40, len: 20, scene: true }];
    const sc = deriveScenes(ov, 'main');
    expect(sc.filter((x) => x.source === 'marker').map((x) => [x.id, x.at, x.len])).toEqual([['m1', 30, 100], ['m2', 130, 50]]);
    sc.forEach((x, i) => { if (i) expect(x.at).toBe(sc[i - 1]!.at + sc[i - 1]!.len); }); // no overlaps, no gaps
  });

  it('marks the clips that show a nested comp when a track inside it changes', () => {
    const prev = story();
    prev.comps.push({ id: 'sub', size: [1080, 1920], fps: 30, length: 60 });
    prev.tracks!.push({ id: 'S1', comp: 'sub' }, { id: 'V2', comp: 'main' });
    prev.clips!.push({ id: 'inner', track: 'S1', at: 0, len: 60, color: '#fff' } as Clip, { id: 'nest', track: 'V2', at: 200, len: 60, comp: 'sub' } as Clip);
    const cur = clone(prev);
    cur.tracks!.find((t) => t.id === 'S1')!.hidden = true;
    const sb = diffStoryboard(prev, cur, 'main');
    expect(sb.scenes.filter((x) => x.changed).map((x) => [x.n, x.changes])).toEqual([[3, ['nest: contents changed']], [4, ['nest: contents changed']]]);
  });

  it('counts undo and redo as recorded commands, not hand edits', () => {
    const prev = story(), cur = clone(prev);
    clip(cur, 'hook').y = 300;
    const since = '2026-10-07T10:00:00.000Z';
    // the edit came before the storyboard; the undo after it (its entry keeps its old `at`, `stepped` says when it ran)
    const entry = { at: '2026-10-07T09:00:00.000Z', patch: [{ table: 'clips', id: 'hook' }] };
    expect(diffStoryboard(prev, cur, 'main', [entry], since).scenes[0]!.changes[0]).toMatch(/\(by hand\)$/);
    expect(diffStoryboard(prev, cur, 'main', [{ ...entry, stepped: '2026-10-07T11:00:00.000Z' }], since).scenes[0]!.changes[0]).not.toMatch(/by hand/);
  });

  it('describes positions in words first, at most three changes a scene', () => {
    const prev = story();
    clip(prev, 'hook').y = 420;
    const cur = clone(prev);
    Object.assign(clip(cur, 'hook'), { y: 380, x: 300, note: 'n', len: 50 });
    clip(cur, 'bg1').transition = { out: { type: 'wipe', len: 10 } };
    const s = diffStoryboard(prev, cur, 'main').scenes[0]!;
    expect(s.changes).toHaveLength(3);
    expect(s.changes).toContain('hook higher (y 420→380)');
    expect(s.changes.every((w) => !w.includes(': note'))).toBe(true);
  });

  it('touchedScenes names the scenes an edit touched', () => {
    const prev = story(), cur = clone(prev);
    cur.cues![4]!.text = 'Follow for more!';
    const t = touchedScenes(prev, cur, 'main');
    expect(t).toEqual([{ n: 4, label: 'Follow for more!' }]);
    expect(touchedLine(t)).toBe('scenes: 4 "Follow for more!"');
    expect(touchedLine([])).toBe('');
  });
});

describe('findings, snapshots and text', () => {
  it('assigns findings by frame, by clip, or leaves them unplaced', () => {
    const sb = assignFindings(buildStoryboard(story(), 'main'), [
      { rule: 'safe-zone', severity: 'warning', message: 'caption under the buttons', frame: 200, fix: 'mgl edit <file> clip.set caps y=1300' },
      { rule: 'covered', severity: 'warning', message: 'hook covered', clip: 'hook' },
      { rule: 'loudness', severity: 'info', message: 'too quiet' },
    ]);
    expect(sb.scenes.map((s) => s.findings.length)).toEqual([1, 0, 1, 0]);
    expect(sb.unplaced).toHaveLength(1);
    expect(sceneLines(sb)[2]).toMatch(/^3 "Work in 25-minute blocks!" 5\.0–8\.0s ⚠ \| picture bg2 aurora in crossfade \| graphics — \| captions q3–q4 \| voice vo \| music bed \| sfx whoosh$/);
    expect(sceneDetail(sb, 3).join('\n')).toContain('issue: caption under the buttons · fix: mgl edit <file> clip.set caps y=1300');
  });

  it('keeps level 1 and level 2 text within 40 lines, with file lines', () => {
    const p = story();
    p.comps[0]!.length = 4500;
    p.cues = [];
    p.clips = p.clips!.filter((c) => c.track !== 'V1');
    p.markers = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, comp: 'main', at: i * 100 }));
    for (let i = 0; i < 60; i++) p.clips!.push({ id: `t${i}`, track: 'T1', at: i < 30 ? i * 150 : 0, len: i < 30 ? 150 : 20, text: `t${i}` } as Clip);
    const sb = assignFindings(buildStoryboard(p, 'main'), Array.from({ length: 50 }, (_, i) => ({ rule: 'x', severity: 'info' as const, message: `m${i}` })));
    const l1 = sceneLines(sb);
    expect(l1.length).toBeLessThanOrEqual(40);
    expect(l1.filter((l) => /^\d+ "/.test(l))).toHaveLength(24);
    const l2 = sceneDetail(sb, 1, 30, (id) => (id === 't0' ? 18 : undefined));
    expect(l2.length).toBeLessThanOrEqual(40);
    expect(l2.join('\n')).toContain('t0 "t0" 0.0–5.0s · line 18');
    expect(sceneDetail(sb, 99, 30)).toEqual(['no scene 99 (scenes 1–24)']);
  });

  it('steps the three moments out of a picture transition', () => {
    const sb = buildStoryboard(story(), 'main'); // bg2 crossfades in over 145–155 (centred on the cut at 150)
    expect(sceneMoments(sb, sb.scenes[1]!)).toEqual({ start: 60, middle: 105, end: 144 });
    expect(sceneMoments(sb, sb.scenes[2]!)).toEqual({ start: 155, middle: 195, end: 239 });
  });

  it('level 2 shows an idea scene past the end', () => {
    const p = story();
    p.markers = [{ id: 'later', comp: 'main', at: 400, len: 30, note: 'outro', scene: true }];
    const d = sceneDetail(buildStoryboard(p, 'main'), 5);
    expect(d[0]).toBe('scene 5 note "outro" 13.3–14.3s (marker later) idea');
    expect(d[1]).toBe('note: "outro" (scene marker later)');
    expect(d[2]).toMatch(/^idea: nothing visual here yet; it starts after the end of the video/);
    expect(d).toContain('moments: — (past the end of the comp)');
  });

  it('writes and reads the snapshot next to the project', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mgl-sb-')), 'video.mgl.json');
    expect(storyboardDir(file)).toBe(path.join(path.dirname(file), '.mgl', 'video', 'storyboard'));
    expect(readPrevious(file)).toBeUndefined();
    writeSnapshot(file, story(), new Date('2026-10-07T00:00:00Z'));
    expect(readPrevious(file)).toEqual({ at: '2026-10-07T00:00:00.000Z', project: story() });
  });
});
