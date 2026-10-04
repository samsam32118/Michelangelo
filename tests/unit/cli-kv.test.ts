import { describe, expect, it } from 'vitest';
import { MglError } from '../../src/core/errors.js';
import '../../src/core/commands/index.js';
import { jsonCommands, kvCommand, parseValue } from '../../src/cli/kv.js';
import { MAX_LINES, Out, parseArgs } from '../../src/cli/io.js';

describe('parseValue', () => {
  it('parses JSON when it parses, else keeps the string', () => {
    expect(parseValue('2')).toBe(2);
    expect(parseValue('-6')).toBe(-6);
    expect(parseValue('2.5')).toBe(2.5);
    expect(parseValue('true')).toBe(true);
    expect(parseValue('null')).toBe(null);
    expect(parseValue('[1,2]')).toEqual([1, 2]);
    expect(parseValue('{"a": 1}')).toEqual({ a: 1 });
    expect(parseValue('"quoted"')).toBe('quoted');
    expect(parseValue('2.5s')).toBe('2.5s');
    expect(parseValue('#ffcc00')).toBe('#ffcc00');
    expect(parseValue('007')).toBe('007');
    expect(parseValue('Hello there')).toBe('Hello there');
    expect(parseValue('{not json')).toBe('{not json');
    expect(parseValue('')).toBe('');
  });
});

describe('kvCommand', () => {
  it('fills the primary field from the bare word and types values', () => {
    expect(kvCommand('clip.split', ['title', 'at=2.5s'])).toEqual({ op: 'clip.split', id: 'title', at: '2.5s' });
    expect(kvCommand('clip.slide', ['b', 'by=-6'])).toEqual({ op: 'clip.slide', id: 'b', by: -6 });
    expect(kvCommand('asset.add', ['media/a.mp4'])).toEqual({ op: 'asset.add', src: 'media/a.mp4' });
  });
  it('keeps dotted keys as keys (clip.set handles paths)', () => {
    expect(kvCommand('clip.set', ['title', 'y=380', 'style.color=#ffcc00', 'fx.blur.radius=8'])).toEqual({ op: 'clip.set', id: 'title', y: 380, 'style.color': '#ffcc00', 'fx.blur.radius': 8 });
  });
  it('keeps a string when the schema wants one (text=123)', () => {
    expect(kvCommand('clip.add', ['text=123', 'len=60'])).toEqual({ op: 'clip.add', text: '123', len: 60 });
    expect(kvCommand('project.set', ['name=2024'])).toEqual({ op: 'project.set', name: '2024' });
  });
  it('parses JSON objects and arrays', () => {
    expect(kvCommand('template.apply', ['lower-third', 'params={"name": "Ada"}'])).toEqual({ op: 'template.apply', template: 'lower-third', params: { name: 'Ada' } });
    expect(kvCommand('clip.link', ['ids=["a","b"]'])).toEqual({ op: 'clip.link', ids: ['a', 'b'] });
  });
  it('refuses with a fix', () => {
    const codes = (f: () => unknown) => { try { f(); } catch (e) { expect(e).toBeInstanceOf(MglError); expect((e as MglError).fix).toBeTruthy(); return (e as MglError).code; } return 'none'; };
    expect(codes(() => kvCommand('clip.split', ['a', 'b']))).toBe('E_ARG');
    expect(codes(() => kvCommand('clip.link', ['a']))).toBe('E_ARG');
    expect(codes(() => kvCommand('clip.split', ['a', 'id=b']))).toBe('E_ARG');
    expect(codes(() => kvCommand('clip.splt', []))).toBe('E_UNKNOWN_OP');
    expect(codes(() => kvCommand('clip.set', ['a', 'y=1', 'y=2']))).toBe('E_ARG');
  });
});

describe('jsonCommands', () => {
  it('reads an object, an array, or JSONL', () => {
    expect(jsonCommands('{"op": "a"}')).toEqual([{ op: 'a' }]);
    expect(jsonCommands('[{"op": "a"}, {"op": "b"}]')).toHaveLength(2);
    expect(jsonCommands('{"op": "a"}\n\n{"op": "b"}\n')).toEqual([{ op: 'a' }, { op: 'b' }]);
  });
  it('names the bad line', () => {
    try { jsonCommands('{"op": "a"}\n{op: b}'); expect.unreachable(); } catch (e) {
      expect((e as MglError).code).toBe('E_JSON');
      expect((e as MglError).line).toBe(2);
    }
  });
});

describe('parseArgs', () => {
  it('separates flags, values, aliases and k=v words', () => {
    const a = parseArgs(['f.json', '-o', 'x.json', '--fps=25', 'by=-6', '-6', '--force', '--json'], { values: ['out', 'fps'], bools: ['force'], alias: { o: 'out' } });
    expect(a.pos).toEqual(['f.json', 'by=-6', '-6']);
    expect(a.flags).toEqual({ out: 'x.json', fps: '25', force: true, json: true });
  });
  it('suggests the closest flag', () => {
    try { parseArgs(['--dryrun'], { bools: ['dry-run'] }); expect.unreachable(); } catch (e) {
      expect((e as MglError).code).toBe('E_ARG');
      expect((e as MglError).fix).toContain('--dry-run');
    }
  });
});

describe('Out', () => {
  it('caps text at 40 lines with a pointer to --all/--json', () => {
    const o = new Out(false, false);
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (s: string) => { writes.push(s); return true; };
    try {
      for (let i = 0; i < 100; i++) o.line(`line ${i}`);
      o.end();
    } finally { (process.stdout as { write: unknown }).write = orig; }
    const lines = writes.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines.at(-1)).toBe('… 61 more (use --all or --json)');
  });
});
