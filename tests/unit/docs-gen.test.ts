/** Generated docs and schema are in sync with the code; the skill stays small. */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGES, scanErrors } from '../../scripts/gen-docs.js';
import { SCHEMA_PATH, schemaText } from '../../scripts/gen-schema.js';
import { listCommands } from '../../src/core/commands/index.js';

const ROOT = resolve(import.meta.dirname, '../..');

describe('generated docs', () => {
  for (const [name, gen] of Object.entries(PAGES)) {
    it(`docs/reference/${name} is up to date (fix: npm run docs)`, () => {
      expect(readFileSync(join(ROOT, 'docs/reference', name), 'utf8')).toBe(gen());
    });
  }

  it('gen-docs --check exits 0', () => {
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gen-docs.ts', '--check'], { cwd: ROOT, stdio: 'pipe' });
  });

  it('commands.md documents every command; errors.md every code with a fix', () => {
    const page = readFileSync(join(ROOT, 'docs/reference/commands.md'), 'utf8');
    for (const c of listCommands()) expect(page).toContain(`### ${c.op}\n`);
    const errs = scanErrors();
    expect(errs.length).toBeGreaterThan(40);
    for (const code of ['E_REF', 'E_UNKNOWN_KEY', 'E_FFMPEG', 'E_OVERLAP', 'W_TRAILING_COMMA']) expect(errs.map((e) => e.code)).toContain(code);
    expect(errs.find((e) => e.code === 'E_FFMPEG')!.exit).toBe(2);
    const missingFix = errs.filter((e) => !e.fix || e.fix === '…');
    expect(missingFix.map((e) => e.code)).toEqual([]);
  });
});

describe('schema', () => {
  it('schema/v1.json is in sync with the zod schemas (fix: npm run schema)', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(schemaText());
    const s = JSON.parse(schemaText());
    expect(s.$id).toBe('https://michelangelo.dev/schema/v1.json');
    expect(s.properties.clips.items.properties.opacity.default).toBe(1);
  });
});

describe('agent docs', () => {
  it('SKILL.md has front matter and stays under ~3k tokens', () => {
    const text = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: michelangelo\ndescription: .+\n---\n/);
    expect(text.split(/\s+/).length).toBeLessThan(2200);
  });

  it('every topic SKILL.md names exists', () => {
    const text = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('`mgl docs <topic>`'))!;
    const more = text.slice(text.indexOf(line)).split('\n').slice(0, 2).join(' ');
    const topics = more.replace(/\([^)]*\)/g, '').replace(/^.*?:/, '').split(/[,.]/).map((s) => s.trim()).filter((s) => /^[a-z-]+$/.test(s));
    expect(topics.length).toBeGreaterThan(8);
    for (const t of topics) expect(existsSync(join(ROOT, 'docs/reference', `${t}.md`)), t).toBe(true);
  });
});
