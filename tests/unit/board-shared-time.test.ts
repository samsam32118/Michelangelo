import { describe, expect, it } from 'vitest';
import { formatMs, formatSeconds, formatTime, parseTimeLike, TimeError, tryTime } from '../../src/board/shared/time.js';

describe('board shared time', () => {
  it('parses every edge form of DESIGN §3', () => {
    expect(parseTimeLike(75, 30)).toBe(75);
    expect(parseTimeLike('75', 30)).toBe(75);
    expect(parseTimeLike('75f', 30)).toBe(75);
    expect(parseTimeLike('2.5s', 30)).toBe(75);
    expect(parseTimeLike('2.51s', 30)).toBe(75); // rounds to the nearest frame
    expect(parseTimeLike('0s', 24)).toBe(0);
    expect(parseTimeLike('1:02.5', 30)).toBe(1875);
    expect(parseTimeLike('1:02:03.5', 30)).toBe((3723.5 * 30));
    expect(parseTimeLike('00:00:02:15', 30)).toBe(75);
    expect(parseTimeLike('00:01:00:00', 29.97)).toBe(1800);
    expect(parseTimeLike(' 3s ', 25)).toBe(75);
    expect(parseTimeLike('1s', 29.97)).toBe(30);
  });
  it('rejects what is not a time, with a fix', () => {
    for (const bad of ['abc', '2.5', '1:2:3:4:5', '', 'xs']) expect(() => parseTimeLike(bad, 30), bad).toThrow(TimeError);
    expect(() => parseTimeLike(2.5, 30)).toThrow(/whole number of frames/);
    expect(() => parseTimeLike('00:00:01:30', 30)).toThrow(/not below the rate/);
    try { parseTimeLike('soon', 30); } catch (e) { expect((e as TimeError).code).toBe('E_TIME'); expect((e as TimeError).fix).toMatch(/2\.5s/); }
    expect(tryTime('soon', 30)).toBeUndefined();
    expect(tryTime(undefined, 30)).toBeUndefined();
    expect(tryTime('1s', 30)).toBe(30);
  });
  it('formats', () => {
    expect(formatTime(75, 30)).toBe('0:02.50');
    expect(formatTime(1875, 30)).toBe('1:02.50');
    expect(formatSeconds(75, 30)).toBe('2.5s');
    expect(formatMs(180)).toBe('180 ms');
    expect(formatMs(2400)).toBe('2.40 s');
    expect(formatMs(186000)).toBe('3.1 min');
  });
});
