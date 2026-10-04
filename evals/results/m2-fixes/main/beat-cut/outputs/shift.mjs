import { open } from 'michelangelo';
const p = await open('beat.mgl.json');
const cmds = p.data.clips.map((c) => ({ op: 'clip.move', id: c.id, at: c.at - 15 }));
cmds.sort((a, b) => a.at - b.at);
await p.edit(cmds);
await p.edit({ op: 'marker.beats', clip: 'music' });
