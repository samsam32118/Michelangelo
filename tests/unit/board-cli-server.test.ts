/** The CLI against a running board server: mutations go through POST /api/ops; view / focus read and steer the pages. */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { tempProject } from './board-model-fixtures.js';

let mod: typeof import('../../src/board/server/index.js') | undefined;
try { mod = await import('../../src/board/server/index.js'); } catch { mod = undefined; } // the server is built in parallel

async function cli(args: string[]) {
  let out = '', err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
  const e = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err += s; return true; }) as never);
  let code: number;
  try { code = await main(args); } finally { o.mockRestore(); e.mockRestore(); }
  return { code, out, err };
}

describe.skipIf(!mod)('mgl board with a server', () => {
  it('say / edit go through the server; view and focus work', async () => {
    const { dir, project } = tempProject();
    const s = await mod!.startBoardServer({ file: project, port: 0, quiet: true });
    try {
      let r = await cli(['board', 'say', project, 'hello from the CLI']);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`via ${s.url}`);
      expect(readFileSync(path.join(dir, 'video.board.json'), 'utf8')).toContain('"text": "hello from the CLI"');
      r = await cli(['board', 'edit', project, 'shape.add', 'note', 'text=hi']);
      expect(r.out).toContain('+ {"id": "n1"');
      await fetch(`${s.url}/api/view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'human', camera: { x: 0, y: 0, zoom: 1 }, selection: ['n1'], inView: ['n1'] }) });
      r = await cli(['board', 'view', project]);
      expect(r.code).toBe(0);
      expect(r.out).toContain('person: camera 0,0 zoom 1.00');
      expect(r.out).toContain('selected n1');
      expect(r.out).toContain('in view: 1 shape');
      r = await cli(['board', 'focus', project, 'n1']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('on n1');
      r = await cli(['board', 'edit', project, 'undo']);
      expect(r.code).toBe(0);
      expect(readFileSync(path.join(dir, 'video.board.json'), 'utf8')).not.toContain('"n1"');
      r = await cli(['board', 'show', project]);
      expect(r.out).toContain(`server ${s.url}`);
      expect(r.out).toContain('person: camera 0,0');
    } finally { await s.close(); }
  });
});
