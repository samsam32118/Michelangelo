/** mgl board export: one offline HTML file with the modules (import map of data: URLs), the state and the stills. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyProject, formatProject } from '../../src/sdk/index.js';
import { BoardSession } from '../../src/board/model/index.js';
import { exportBoard } from '../../src/board/server/export.js';
import { main } from '../../src/cli/main.js';

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mgl-board-export-'));
  const p = emptyProject({ size: [180, 320], fps: 30 });
  (p as any).clips = [{ id: 'bg', track: 'V1', at: 0, len: 60, color: '#2040a0' }];
  writeFileSync(join(dir, 'v.mgl.json'), formatProject(p));
  const s = await BoardSession.open(join(dir, 'v.board.json'));
  await s.apply([{ op: 'shape.add', shape: { id: 'n1', type: 'note', x: 0, y: 0, text: 'a </script> in text' } }, { op: 'shape.add', shape: { id: 's1', type: 'still', x: 300, y: 0, t: '0.5s' } }], 'ai');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('export', () => {
  it('writes one self-contained page: import map, embedded state and stills, no server URLs', async () => {
    const r = await exportBoard(join(dir, 'v.mgl.json'));
    expect(r.path).toBe(join(dir, 'v.board.html'));
    expect(r.stills).toBe(1);
    const html = readFileSync(r.path, 'utf8');
    expect(html).toContain('<script type="importmap">');
    expect(html).not.toContain('src="/app/client/main.js"');
    expect(html).not.toContain('a </script> in text'); // escaped inside the embedded JSON
    const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(html)![1]!) as { imports: Record<string, string> };
    expect(Object.keys(map.imports)).toContain('mgl:/app/client/main.js');
    expect(Object.keys(map.imports)).toContain('mgl:/app/shared/shapes.js');
    expect(Object.keys(map.imports)).not.toContain('mgl:/app/client/page.js');
    // every relative import was rewritten to a mapped bare specifier
    for (const [k, url] of Object.entries(map.imports)) {
      const code = Buffer.from(url.replace(/^data:text\/javascript;base64,/, ''), 'base64').toString('utf8');
      expect(code, k).not.toMatch(/from\s*["']\.{1,2}\//);
      for (const m of code.matchAll(/from\s*["'](mgl:[^"']+)["']/g)) expect(map.imports[m[1]!], `${k} → ${m[1]}`).toBeDefined();
    }
    const files = JSON.parse(/window\.MGL_EMBED_FILES=(.*?);<\/script>/s.exec(html)![1]!) as Record<string, string>;
    expect(Object.keys(files)).toEqual(['still:0.5s||thumb']);
    expect(files['still:0.5s||thumb']).toMatch(/^data:image\/png;base64,iVBOR/);
  });
  it('mgl board with no subcommand prints the guide; export is a subcommand', async () => {
    let out = '';
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
    try {
      expect(await main(['board'])).toBe(0);
      expect(await main(['board', '--help'])).toBe(0);
      expect(await main(['board', 'export', join(dir, 'v.board.json'), '-o', join(dir, 'b.html')])).toBe(0);
    } finally { w.mockRestore(); }
    expect(out.match(/^mgl board: a shared canvas/gm)?.length).toBe(2);
    expect(out).toContain('mgl board export <file>');
    expect(out).toContain(`${join(dir, 'b.html')} (`);
  });
});
