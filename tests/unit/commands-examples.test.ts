import { it, expect } from 'vitest';
import { makeProject } from './commands-fixtures.js';
import { getCommand } from '../../src/core/commands/index.js';

const OPS = ['key.set', 'key.remove', 'key.set', 'key.shift', 'key.clear', 'fx.add', 'fx.set', 'fx.move', 'fx.remove', 'transition.set', 'mask.add', 'mask.set', 'mask.remove', 'matte.set',
  'bus.add', 'bus.set', 'audio.duck', 'audio.normalize', 'audio.fade', 'audio.gain', 'audio.cut-silences', 'comp.reframe'];

it('every command example runs on a typical project', async () => {
  const { edit } = makeProject({
    services: { analyzeAudio: async () => ({ duration: 30, silences: [{ start: 3, end: 5 }] }) },
    edit: (p) => {
      p.assets = [{ id: 'beach', src: 'beach.mp4' }, { id: 'bed-mp3', src: 'bed.mp3' }, { id: 'vo-wav', src: 'vo.wav' }];
      p.clips = [
        { id: 'shot1', track: 'V1', at: 0, len: 120, asset: 'beach', in: 48 },
        { id: 'shot2', track: 'V1', at: 120, len: 90, asset: 'beach', in: 300 },
        { id: 'title', track: 'T1', at: 0, len: 75, text: 'Three tips', y: 400 },
        { id: 'vo', track: 'A1', at: 0, len: 600, asset: 'vo-wav' },
        { id: 'bed', track: 'A2', at: 0, len: 600, asset: 'bed-mp3' },
      ];
    },
  });
  for (const op of OPS) {
    const def = getCommand(op);
    await expect(edit({ op, ...def.example }), op).resolves.toMatchObject({ ok: true });
    if (op === 'fx.move') await edit({ op: 'fx.add', id: 'shot1', type: 'glow' });
  }
});
