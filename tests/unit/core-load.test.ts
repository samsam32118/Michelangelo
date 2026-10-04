/** Regression tests for the loader and command-argument messages (review 1, group core). */
import { describe, it, expect } from 'vitest';
import { parseProjectText } from '../../src/core/load.js';
import { MglError } from '../../src/core/errors.js';
import { makeProject } from './commands-fixtures.js';

function problemsOf(doc: Record<string, unknown>) {
  try { parseProjectText(JSON.stringify(doc)); return []; } catch (e) {
    if (!(e instanceof MglError)) throw e;
    return [e, ...(e.problems ?? [])].map((p) => ({ code: p.code, message: p.message, fix: p.fix }));
  }
}
const base = (clips: unknown[]) => ({ michelangelo: 1, comps: [{ id: 'main', size: [1080, 1920], fps: 30 }], tracks: [{ id: 'V1', comp: 'main' }], clips });

describe('loader: wrong types are not "missing"', () => {
  it('reports the expected type and the value found', () => {
    const ps = problemsOf(base([{ id: 'a', track: 'V1', at: 0, len: 30.5, text: 5, hidden: 'yes' }]));
    expect(ps.some((p) => p.code === 'E_MISSING')).toBe(false);
    const by = (k: string) => ps.find((p) => p.message.includes(` ${k}:`))!;
    expect(by('hidden')).toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('true or false, found "yes"') });
    expect(by('len')).toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('found 30.5') });
    expect(by('text')).toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('a string, found 5') });
  });
  it('still reports a truly missing field as missing', () => {
    const ps = problemsOf(base([{ id: 'a', track: 'V1', len: 30, text: 'x' }]));
    expect(ps[0]).toMatchObject({ code: 'E_MISSING', message: expect.stringContaining('at is required') });
  });
  it('a time string on a missing track reports the missing track, not "at is required"', () => {
    const ps = problemsOf(base([{ id: 'a', track: 'V9', at: '1.01s', len: 30, text: 'x' }]));
    expect(ps.some((p) => /required/.test(p.message))).toBe(false);
    expect(ps[0]).toMatchObject({ code: 'E_REF', message: expect.stringContaining('track "V9"') });
  });
});

describe('loader: overlaps with long clips', () => {
  it('reports every clip a long clip covers', () => {
    const r = parseProjectText(JSON.stringify(base([
      { id: 'big', track: 'V1', at: 0, len: 100, text: 'x' },
      { id: 'b', track: 'V1', at: 10, len: 10, text: 'x' },
      { id: 'c', track: 'V1', at: 30, len: 10, text: 'x' },
    ])));
    const ov = r.problems.filter((p) => p.code === 'E_OVERLAP');
    expect(ov).toHaveLength(2);
    expect(ov.map((p) => p.message).join(' ')).toContain('"c"');
  });
  it('an edit moving a clip inside a long clip is refused', async () => {
    const { edit } = makeProject({ edit: (p) => {
      p.clips = [
        { id: 'big', track: 'V1', at: 0, len: 100, color: '#000000' },
        { id: 'b', track: 'V1', at: 10, len: 10, color: '#000000' },
        { id: 'c', track: 'T1', at: 30, len: 10, color: '#000000' },
      ];
    } });
    await expect(edit({ op: 'clip.set', id: 'c', track: 'V1' }, true)).rejects.toMatchObject({ code: 'E_OVERLAP' });
  });
  it('does not suggest a zero length in the overlap fix', () => {
    const r = parseProjectText(JSON.stringify(base([
      { id: 'a', track: 'V1', at: 10, len: 30, text: 'x' },
      { id: 'h', track: 'V1', at: 10, len: 5, text: 'x' },
    ])));
    const ov = r.problems.find((p) => p.code === 'E_OVERLAP')!;
    expect(ov.fix).not.toContain('"len": 0');
  });
});

describe('command arguments: wrong types are not "required"', () => {
  const setup = () => makeProject({ edit: (p) => { p.clips = [{ id: 'a', track: 'V1', at: 0, len: 60, color: '#000000' }]; } });
  it('names the expected type and the value found', async () => {
    const { edit } = setup();
    await expect(edit({ op: 'clip.trim', id: 'a', len: 30, ripple: 'yes' }, true)).rejects.toMatchObject({ code: 'E_ARG', message: expect.stringContaining('"ripple" must be true or false, found "yes"') });
    await expect(edit({ op: 'clip.split', id: 'a', at: true }, true)).rejects.toMatchObject({ code: 'E_ARG', message: expect.stringContaining('"at" must be frames (an integer) or a time like "2s", found true') });
    await expect(edit({ op: 'clip.split', id: 'a', at: 1.5 }, true)).rejects.toMatchObject({ message: expect.stringContaining('found 1.5') });
  });
  it('keeps "required" for absent fields', async () => {
    const { edit } = setup();
    await expect(edit({ op: 'clip.split', id: 'a' }, true)).rejects.toMatchObject({ code: 'E_ARG', message: expect.stringContaining('"at" is required') });
  });
});
