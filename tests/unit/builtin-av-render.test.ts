/** End to end: the waveform generator follows a real asset's sound, letterbox works on an adjustment layer. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { render } from '../../src/render/pipeline.js';
import { ff, tempDir } from './media-fixtures.js';

let dir: string, cleanup: () => void;
beforeAll(() => {
  ({ dir, cleanup } = tempDir('mgl-av-render-'));
  // 1 s of silence then 1 s of a loud tone
  ff(['-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=2', '-af', "volume='if(lt(t,1),0,4)':eval=frame", join(dir, 'vo.wav')]);
});
afterAll(() => cleanup());

async function still(p: ProjectFile, frame: number, name: string) {
  const out = join(dir, name);
  await render(p, out, { baseDir: dir, registry: builtinRegistry(), still: frame });
  const img = await loadImage(readFileSync(out));
  const c = createCanvas(img.width, img.height).getContext('2d');
  c.drawImage(img, 0, 0);
  return c.getImageData(0, 0, img.width, img.height);
}
const litCount = (d: { data: Uint8ClampedArray }) => { let n = 0; for (let i = 0; i < d.data.length; i += 4) if (d.data[i]! > 128) n++; return n; };

describe('waveform follows the sound of gen.asset', () => {
  it('draws taller bars where the asset is loud', async () => {
    const p = {
      michelangelo: 1,
      assets: [{ id: 'vo', src: 'vo.wav' }],
      comps: [{ id: 'main', size: [160, 90], fps: 30, bg: '#000000' }],
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true }],
      clips: [
        { id: 'w', track: 'V1', at: 0, len: 60, gen: { type: 'waveform', asset: 'vo', style: 'mirror', window: 0.4, width: 160, height: 90 } },
        { id: 'a', track: 'A1', at: 0, len: 60, asset: 'vo' },
      ],
    } as unknown as ProjectFile;
    const quiet = await still(p, 10, 'q.png'), loud = await still(p, 50, 'l.png');
    expect(litCount(loud)).toBeGreaterThan(litCount(quiet) * 5);
  });
});

describe('letterbox on an adjustment layer', () => {
  it('mattes everything below it', async () => {
    const p = {
      michelangelo: 1,
      comps: [{ id: 'main', size: [192, 108], fps: 30 }],
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }],
      clips: [
        { id: 'bg', track: 'V1', at: 0, len: 30, color: '#ffffff' },
        { id: 'adj', track: 'V2', at: 0, len: 30, adjustment: true, fx: [{ type: 'letterbox', ratio: 2.39 }] },
      ],
    } as unknown as ProjectFile;
    const d = await still(p, 5, 'lb.png');
    const at = (x: number, y: number) => d.data[(y * 192 + x) * 4]!;
    expect(at(96, 3)).toBeLessThan(10);
    expect(at(96, 104)).toBeLessThan(10);
    expect(at(96, 54)).toBeGreaterThan(245);
  });
});
