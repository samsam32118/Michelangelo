import { describe, expect, it } from 'vitest';
import { satisfies, validRange, parseVersion, compareVersions } from '../../src/plugin/semver.js';

describe('semver', () => {
  it('parses and compares versions', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3, '']);
    expect(parseVersion('v2.0.0-beta.1+build')).toEqual([2, 0, 0, 'beta.1']);
    expect(parseVersion('1.2')).toBeUndefined();
    expect(compareVersions(parseVersion('1.0.0-rc.1')!, parseVersion('1.0.0')!)).toBeLessThan(0);
    expect(compareVersions(parseVersion('1.10.0')!, parseVersion('1.9.9')!)).toBeGreaterThan(0);
  });

  const cases: [string, string, boolean][] = [
    ['1.0.0', '^1.0.0', true], ['1.9.3', '^1.0.0', true], ['2.0.0', '^1.0.0', false], ['0.9.0', '^1.0.0', false],
    ['0.2.5', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
    ['1.4.0', '^1', true], ['0.5.0', '^0', true], ['1.0.0', '^0', false],
    ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['1.9.0', '~1', true], ['2.0.0', '~1', false],
    ['1.2.7', '1.2.x', true], ['1.3.0', '1.2.x', false], ['1.5.0', '1.x', true], ['3.1.4', '*', true], ['3.1.4', '', true],
    ['1.5.0', '1', true], ['1.2.3', '1.2.3', true], ['1.2.4', '=1.2.3', false],
    ['1.0.0', '>=1.0.0', true], ['0.9.9', '>=1.0.0', false], ['1.9.9', '>=1.0.0 <2.0.0', true], ['2.0.0', '>=1.0.0 <2', false],
    ['1.3.0', '>1.2', true], ['1.2.9', '>1.2', false], ['1.2.9', '<=1.2', true], ['1.3.0', '<=1.2', false],
    ['1.0.0', '^2.0.0 || ^1.0.0', true], ['3.0.0', '^2.0.0 || ^1.0.0', false],
    ['1.5.0', '1.0.0 - 2.0.0', true], ['2.0.1', '1.0.0 - 2.0.0', false], ['1.2.0', '>= 1.0.0', true],
    ['2.0.0-beta.1', '^1.0.0', false], ['1.0.0-beta.1', '^1.0.0', false], ['1.0.0-beta.2', '^1.0.0-beta.1', true],
  ];
  it.each(cases)('%s satisfies %s → %s', (v, r, want) => {
    expect(satisfies(v, r)).toBe(want);
  });

  it('rejects invalid ranges and versions', () => {
    expect(validRange('^1.0.0')).toBe(true);
    expect(validRange('hello')).toBe(false);
    expect(validRange('^1.a')).toBe(false);
    expect(satisfies('one', '^1.0.0')).toBe(false);
    expect(satisfies('1.0.0', 'nope')).toBe(false);
  });
});
