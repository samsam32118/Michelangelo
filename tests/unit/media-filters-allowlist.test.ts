// @vitest-environment node
/** The source-stage filter allowlist refuses options that write or read files (curves plot, deshake filename, ...). */
import { describe, expect, it } from 'vitest';
import { filterToString } from '../../src/media/filters.js';

describe('filter option allowlist', () => {
  it('refuses curves plot / psfile and deshake filename, keeps normal options', () => {
    expect(() => filterToString({ filter: 'curves', args: { plot: '/tmp/x.txt' } })).toThrow(/plot/);
    expect(() => filterToString({ filter: 'curves', args: { psfile: '/tmp/x.acv' } })).toThrow(/psfile/);
    expect(() => filterToString({ filter: 'deshake', args: { filename: '/tmp/log' } })).toThrow(/filename/);
    expect(() => filterToString({ filter: 'eq', args: { stats_file: '/tmp/s' } })).toThrow(/reads a file/);
    expect(filterToString({ filter: 'curves', args: { preset: 'vintage' } })).toBe('curves=preset=vintage');
    expect(filterToString({ filter: 'hue', args: { s: 0 } })).toBe('hue=s=0');
  });
});
