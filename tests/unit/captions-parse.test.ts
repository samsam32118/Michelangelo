import { describe, it, expect } from 'vitest';
import { parseSrt, parseVtt, parseCaptions, toSrt, toVtt, splitScript, estimateWordTimes, parseTimestamp } from '../../src/core/captions.js';

describe('SRT', () => {
  it('parses BOM, CRLF, tags, multi-line cues and both separators', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> <b>world</b>\r\nsecond line\r\n\r\n2\r\n00:00:03.250 --> 00:00:04,000\r\nTom &amp; Jerry\r\n';
    const r = parseSrt(srt);
    expect(r.cues).toEqual([
      { start: 1, end: 2.5, text: 'Hello world second line' },
      { start: 3.25, end: 4, text: 'Tom & Jerry' },
    ]);
    expect(r.wordTimes).toBe(false);
  });
  it('accepts short timestamps, missing indices and extra blank lines; warns on broken blocks', () => {
    const r = parseSrt('\n\n01:02,5 --> 01:03,000\nA\n\n\n\n7\nnot a timing\nB\n\n3\n00:00:09,000 --> 00:00:08,000\nbackwards\n');
    expect(r.cues).toHaveLength(1);
    expect(r.cues[0]).toMatchObject({ start: 62.5, end: 63, text: 'A' });
    expect(r.warnings).toHaveLength(2);
  });
  it('sorts cues and handles hours', () => {
    const r = parseSrt('2\n01:00:00,000 --> 01:00:01,000\nlate\n\n1\n00:00:00,100 --> 00:00:00,900\nearly\n');
    expect(r.cues.map((c) => c.text)).toEqual(['early', 'late']);
    expect(r.cues[1]!.start).toBe(3600);
  });
});

describe('WebVTT', () => {
  const vtt = [
    'WEBVTT - with a title', '', 'NOTE a comment', 'spanning lines', '', 'STYLE', '::cue { color: red }', '',
    'intro', '00:01.000 --> 00:03.000 align:start position:10%', '<v Ann>Put <00:01.400>your <00:01.800><c.yellow>phone</c> <00:02.300>away', '',
    '00:00:04.000 --> 00:00:05.000', 'plain <c>text</c>&nbsp;here', '',
  ].join('\n');
  it('reads word timestamps, strips <c> and <v>, ignores settings, NOTE and STYLE', () => {
    const r = parseVtt(vtt);
    expect(r.wordTimes).toBe(true);
    expect(r.cues[0]).toEqual({ start: 1, end: 3, text: 'Put your phone away', words: [1, 1.4, 1.8, 2.3], speaker: 'Ann' });
    expect(r.cues[1]).toEqual({ start: 4, end: 5, text: 'plain text here' });
  });
  it('joins a word split by a timestamp', () => {
    const r = parseVtt('WEBVTT\n\n00:00.000 --> 00:01.000\nfan<00:00.500>tastic day\n');
    expect(r.cues[0]!.text).toBe('fantastic day');
    expect(r.cues[0]!.words).toEqual([0, 0.5]);
  });
  it('requires the header and detects the format', () => {
    expect(() => parseVtt('00:00.000 --> 00:01.000\nx')).toThrow(/WEBVTT/);
    expect(parseCaptions('﻿WEBVTT\n\n00:00.000 --> 00:01.000\nx\n').format).toBe('vtt');
    expect(parseCaptions('1\n00:00:00,000 --> 00:00:01,000\nx\n', 'a.srt').format).toBe('srt');
    expect(() => parseCaptions('just a script', 'a.txt')).toThrow(expect.objectContaining({ code: 'E_CAPTIONS', fix: expect.stringMatching(/captions.from-text/) }));
  });
  it('round-trips through SRT and VTT', () => {
    const cues = parseVtt(vtt).cues;
    const back = parseVtt(toVtt(cues)).cues;
    expect(back).toEqual(cues);
    const srt = parseSrt(toSrt(cues)).cues;
    expect(srt.map((c) => [c.start, c.end, c.text])).toEqual(cues.map((c) => [c.start, c.end, c.text]));
    expect(toSrt(cues)).toContain('00:00:01,000 --> 00:00:03,000');
  });
  it('parses timestamps', () => {
    expect(parseTimestamp('1:02:03.5')).toBeCloseTo(3723.5);
    expect(() => parseTimestamp('soon')).toThrow(/timestamp/);
  });
});

describe('script splitting and word estimates', () => {
  it('splits by sentence and line into balanced chunks', () => {
    const chunks = splitScript('Put your phone in another room. It works!\nOne two three four five six seven eight', 4);
    expect(chunks).toEqual(['Put your phone', 'in another room.', 'It works!', 'One two three four', 'five six seven eight']);
    expect(chunks.every((c) => c.split(' ').length <= 4)).toBe(true);
  });
  it('estimates word times proportional to length', () => {
    const t = estimateWordTimes('a extraordinary b', 30);
    expect(t[0]).toBe(0);
    expect(t[2]! - t[1]!).toBeGreaterThan(t[1]! - t[0]! * 3);
    const f = estimateWordTimes('one two three four five', 4, true);
    expect(f).toEqual([...f].sort((a, b) => a - b));
    expect(f.every((x) => Number.isInteger(x) && x < 4)).toBe(true);
  });
});
