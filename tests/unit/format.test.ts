import { describe, it, expect } from 'vitest';
import { parseProjectText } from '../../src/core/load.js';
import { formatProject } from '../../src/core/format.js';
import { MglError } from '../../src/core/errors.js';

const base = (clips: string) => `{"michelangelo": 1,
"comps": [
{"id": "main", "size": [1080, 1920], "fps": 30}
],
"tracks": [
{"id": "V1", "comp": "main"},
{"id": "T1", "comp": "main"}
],
"clips": [
${clips}
]
}
`;

describe('file format', () => {
  it('round-trips byte for byte', () => {
    const text = base('{"id": "bg", "track": "V1", "at": 0, "len": 90, "color": "#202020"},\n{"id": "title", "track": "T1", "at": 0, "len": 60, "text": "Hello", "style": "title", "y": 400}');
    const r = parseProjectText(text);
    expect(formatProject(r.project)).toBe(text);
  });
  it('keeps every project field on save (commercial, credits)', () => {
    const text = base('{"id": "bg", "track": "V1", "at": 0, "len": 90, "color": "#202020"}').replace('{"michelangelo": 1,\n', '{"michelangelo": 1,\n"project": {"platform": "shorts", "commercial": true, "credits": {"file": "credits.txt", "assets": ["a"]}},\n');
    const r = parseProjectText(text);
    expect(r.problems.filter((x) => x.severity === 'error')).toEqual([]);
    expect(formatProject(r.project)).toBe(text);
  });
  it('normalises time strings and drops defaults', () => {
    const r = parseProjectText(base('{"id": "t", "track": "T1", "at": "1s", "len": "2.5s", "text": "Hi", "opacity": 1, "scale": [[0, 0.5], ["0.5s", 1, "outBack"]]}'));
    const out = formatProject(r.project);
    expect(out).toContain('{"id": "t", "track": "T1", "at": 30, "len": 75, "text": "Hi", "scale": [[0, 0.5], [15, 1, "outBack"]]}');
  });
  it('names the line and suggests the fix for an unknown key', () => {
    try {
      parseProjectText(base('{"id": "t", "track": "T1", "at": 0, "len": 30, "text": "Hi", "opactiy": 0.5}'));
      throw new Error('should fail');
    } catch (e) {
      expect(e).toBeInstanceOf(MglError);
      const m = e as MglError;
      expect(m.code).toBe('E_UNKNOWN_KEY');
      expect(m.line).toBe(10);
      expect(m.fix).toContain('opacity');
    }
  });
  it('reports a missing track with the tracks that exist', () => {
    try { parseProjectText(base('{"id": "t", "track": "V3", "at": 0, "len": 30, "text": "Hi"}')); throw new Error('x'); } catch (e) {
      const m = e as MglError;
      expect(m.code).toBe('E_REF');
      expect(m.fix).toContain('V1');
    }
  });
  it('accepts trailing commas with a warning', () => {
    const r = parseProjectText(base('{"id": "t", "track": "T1", "at": 0, "len": 30, "text": "Hi"},'));
    expect(r.problems.some((p) => p.code === 'W_TRAILING_COMMA')).toBe(true);
  });
  it('treats overlaps as render issues, not load errors', () => {
    const r = parseProjectText(base('{"id": "a", "track": "V1", "at": 0, "len": 30, "color": "#fff"},\n{"id": "b", "track": "V1", "at": 20, "len": 30, "color": "#000"}'));
    expect(r.problems.find((p) => p.code === 'E_OVERLAP')?.renderOnly).toBe(true);
  });
  it('a 60-clip Short with 40 cues stays under 150 lines', () => {
    const clips: string[] = [];
    for (let i = 0; i < 60; i++) clips.push(`{"id": "c${i}", "track": "${i % 2 ? 'T1' : 'V1'}", "at": ${Math.floor(i / 2) * 30}, "len": 30, "color": "#123456"}`);
    clips.push('{"id": "subs", "track": "T1", "at": 900, "len": 900, "captions": true, "style": "karaoke"}');
    let t = base(clips.join(',\n'));
    const cues = Array.from({ length: 40 }, (_, i) => `{"id": "q${i}", "clip": "subs", "at": ${i * 20}, "len": 20, "text": "word ${i}"}`).join(',\n');
    t = t.replace(/\n\]\n\}\n$/, `\n],\n"cues": [\n${cues}\n]\n}\n`);
    const r = parseProjectText(t);
    expect(formatProject(r.project).split('\n').length).toBeLessThan(150);
  });
});
