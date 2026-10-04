import { describe, it, expect } from 'vitest';
import { parseRate, parseTime, parseTimeDetailed, frameToSample, parseSpeed } from '../../src/core/time.js';

describe('time', () => {
  const r30 = parseRate(30), ntsc = parseRate('30000/1001');
  it('parses edge forms', () => {
    expect(parseTime(75, r30)).toBe(75);
    expect(parseTime('2.5s', r30)).toBe(75);
    expect(parseTime('1:02.5', r30)).toBe(1875);
    expect(parseTime('00:01:02:15', r30)).toBe(1875);
    expect(parseTime('10f', r30)).toBe(10);
  });
  it('rounds off-frame seconds and says so', () => {
    const t = parseTimeDetailed('2.51s', r30);
    expect(t.frames).toBe(75);
    expect(t.rounded).toBe(true);
  });
  it('handles NTSC rates exactly', () => {
    expect(parseRate(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(parseTime('1001s', ntsc)).toBe(30000);
  });
  it('1000 one-frame clips at 30000/1001 sum exactly in samples', () => {
    let total = 0;
    for (let f = 0; f < 1000; f++) total += frameToSample(f + 1, ntsc) - frameToSample(f, ntsc);
    expect(total).toBe(frameToSample(1000, ntsc));
  });
  it('rejects fractional bare numbers', () => {
    expect(() => parseTime(2.5, r30)).toThrow(/whole number of frames/);
  });
  it('parses speeds as rationals', () => {
    expect(parseSpeed('3/2')).toEqual({ num: 3, den: 2 });
    expect(parseSpeed(0.5)).toEqual({ num: 1, den: 2 });
  });
});
