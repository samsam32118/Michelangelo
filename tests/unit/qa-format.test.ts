import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/plugin/api.js';
import { findingLine, formatFindings, formatLook, formatSound } from '../../src/qa/format.js';
import type { LookReport } from '../../src/qa/look.js';

const finding = (i: number): Finding => ({ rule: 'caption-overlap', severity: i % 3 ? 'warning' : 'error', message: `caption "subs" overlaps "logo" at ${i}.00s`, clip: `c${i}`, frame: i * 30, box: [0, 0, 10, 10], fix: 'mgl edit <file> clip.set logo y=120' });

const report = (n: number): LookReport => ({
  sheet: '/w/.mgl/video/look/sheet.png', size: [1536, 1152], grid: [4, 3], frames: [0, 885], fps: 30, scale: 0.3, seconds: 4.12, notes: [],
  findings: Array.from({ length: n }, (_, i) => finding(i)),
  crops: Array.from({ length: n }, (_, i) => ({ finding: i, path: `/w/.mgl/video/look/qa-${i + 1}.png` })),
  sound: { integrated: -15.8, truePeak: -1.2, lra: 6.1, silences: [{ start: 3.1, end: 3.9 }, { start: 19.4, end: 20.2 }], bpm: 112.4, beats: 40, duration: 30 },
});

describe('format', () => {
  it('a look report: header, numbered findings with crop, line and fix, then the sound line', () => {
    const lines = formatLook(report(2), { file: 'video.mgl.json', cwd: '/w', lineOf: (id) => (id === 'c1' ? 21 : undefined) });
    expect(lines[0]).toBe('wrote .mgl/video/look/sheet.png (2 frames 0.00–29.50, 1536x1152) in 4.1 s');
    expect(lines[1]).toBe('QA 2 issues');
    expect(lines[3]).toBe('  2 warn caption "subs" overlaps "logo" at 1.00s   .mgl/video/look/qa-2.png   line 21   fix: mgl edit video.mgl.json clip.set logo y=120');
    expect(lines.at(-1)).toBe('sound -15.8 LUFS, peak -1.2 dBTP, LRA 6.1 · silences 3.10–3.90, 19.40–20.20 · ~112 BPM (40 onsets)');
  });

  it('30 findings stay within 40 lines and the rest are summarised', () => {
    const lines = formatLook(report(60), { file: 'v.json', cwd: '/w' });
    expect(lines.length).toBeLessThanOrEqual(40);
    const more = lines.find((l) => l.includes('more ('))!;
    expect(more).toMatch(/… \d+ more \(\d+ error, \d+ warning\); all of them: mgl look v\.json --json/);
    const l30 = formatLook(report(30), { file: 'v.json', cwd: '/w' });
    expect(l30.length).toBeLessThanOrEqual(40);
    expect(l30.filter((l) => /^ {2}\d+ /.test(l))).toHaveLength(30);
    const check = formatFindings(Array.from({ length: 30 }, (_, i) => finding(i)), { file: 'v.json', max: 20 });
    expect(check).toHaveLength(20);
    expect(check.at(-1)).toContain('12 more');
  });

  it('no findings, silence and missing loudness', () => {
    expect(formatFindings([], { file: 'v.json' })).toEqual(['QA no issues']);
    expect(formatSound({ integrated: -Infinity, truePeak: -Infinity, lra: 0, silences: [], beats: 0, duration: 1 })).toBe('sound: silent (no audible audio in the mix)');
    expect(findingLine({ rule: 'x', severity: 'info', message: 'm' }, 7, { file: 'f' })).toBe('  7 info m');
  });
});
