/** mgl board export: one offline HTML file with the page as one classic inline script, the state and the stills. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyProject, formatProject } from '../../src/sdk/index.js';
import { BoardSession } from '../../src/board/model/index.js';
import { exportBoard, inlineScript } from '../../src/board/server/export.js';
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
  it('writes one self-contained page: one classic inline script (no import map, no data: scripts), embedded state and stills', async () => {
    const r = await exportBoard(join(dir, 'v.mgl.json'));
    expect(r.path).toBe(join(dir, 'v.board.html'));
    expect(r.stills).toBe(1);
    expect(r.modules).toBe(1);
    const html = readFileSync(r.path, 'utf8');
    // an Artifact's CSP (script-src 'unsafe-inline', no data:/blob:) runs inline classic scripts only
    expect(html).not.toContain('type="importmap"');
    expect(html).not.toContain('type="module"');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain('data:text/javascript');
    expect(html).not.toContain('a </script> in text'); // escaped inside the embedded JSON
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(2);
    const bundle = scripts[1]!;
    expect(bundle).not.toMatch(/^\s*(import|export)\s/m); // an IIFE, not a module
    expect(bundle).toContain('MGL_EMBED');
    expect(bundle).not.toMatch(/<\/script/i);
    expect(() => new Function(bundle)).not.toThrow(); // parses as a classic script
    const files = JSON.parse(/window\.MGL_EMBED_FILES=(.*?);<\/script>/s.exec(html)![1]!) as Record<string, string>;
    expect(Object.keys(files)).toEqual(['still:0.5s||thumb']);
    expect(files['still:0.5s||thumb']).toMatch(/^data:image\/png;base64,iVBOR/);
  });
  it('inlineScript escapes </script and drops a trailing source map comment', () => {
    expect(inlineScript('var a = "</script>"; var b = `</SCRIPT x`;\n//# sourceMappingURL=x.map\n')).toBe('var a = "<\\/script>"; var b = `<\\/SCRIPT x`;\n');
    expect(() => inlineScript('var a = "<!--";')).toThrow(/<!--/);
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
