/** Helpers for the board model and CLI tests: a sample board, a temp project with clips. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyProject } from '../../src/sdk/project.js';
import { formatProject } from '../../src/core/format.js';
import type { Outline } from '../../src/board/shared/types.js';

export const SAMPLE = `{"michelangeloBoard": 1, "project": "video.mgl.json",
"brief": {"goal": "30 s Short that makes people try the 2-minute focus trick", "audience": "students, 16-24", "platform": "shorts", "length": "30s", "tone": ["calm", "warm"], "mustHave": ["the trick in the first 3 s"], "avoid": ["stock-photo look"], "success": ["a viewer could do the trick after one watch"], "budget": {"cpuMin": 10}},
"shapes": [
{"id": "f-brief", "type": "frame", "x": 0, "y": 0, "w": 900, "h": 600, "label": "Brief"},
{"id": "n1", "type": "note", "x": 40, "y": 60, "text": "Open on the phone going into a drawer", "color": "yellow", "by": "human", "parent": "f-brief"},
{"id": "s1", "type": "still", "x": 1000, "y": 60, "w": 270, "t": "0s", "by": "ai"},
{"id": "a1", "type": "arrow", "from": "n1", "to": "s1", "label": "becomes"},
{"id": "p1", "type": "pin", "target": "s1", "v": 0.2, "text": "title too small", "by": "human"}
],
"rounds": [
{"id": "r1", "goal": "pick the opening", "fidelity": 1, "status": "decided", "options": [{"id": "r1a", "title": "Drawer close-up", "shapes": ["s1"], "tradeoffs": "strong hook; needs a new shot", "cost": "0.2 s"}], "chosen": "r1a", "why": "the hook is the trick itself"}
],
"log": [
{"id": "m1", "by": "ai", "text": "Brief drafted; two questions on tone in the Brief frame.", "at": "2026-10-09T10:00:00Z"}
],
"spend": [
{"id": "c1", "level": 1, "what": "still s1 thumb", "ms": 180, "round": "r1"}
]
}
`;

/** 1080x1920 at 30 fps, 6 s: V1 bg 0-6 s, T1 titles at 0, 2 s, 4 s; an audio track. */
export const OUTLINE: Outline = {
  file: 'video.mgl.json', main: 'main', hash: 'x',
  comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 180 }],
  tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true }],
  clips: [
    { id: 'bg', track: 'V1', at: 0, len: 180, kind: 'text', label: ' ' },
    { id: 't1', track: 'T1', at: 0, len: 60, kind: 'text', label: 'One' },
    { id: 't2', track: 'T1', at: 60, len: 60, kind: 'text', label: 'Two' },
    { id: 't3', track: 'T1', at: 120, len: 60, kind: 'text', label: 'Three' },
    { id: 'vo', track: 'A1', at: 0, len: 180, kind: 'media', label: 'vo' },
  ],
};

/** A temp folder with video.mgl.json (text clips at 0, 2 s and 4 s). */
export function tempProject(): { dir: string; project: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mgl-board-'));
  const p = emptyProject({ length: 180 });
  p.clips = [
    { id: 't1', track: 'T1', at: 0, len: 60, text: 'One' },
    { id: 't2', track: 'T1', at: 60, len: 60, text: 'Two' },
    { id: 't3', track: 'T1', at: 120, len: 60, text: 'Three' },
  ] as never;
  const project = path.join(dir, 'video.mgl.json');
  writeFileSync(project, formatProject(p));
  return { dir, project };
}
