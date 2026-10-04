import { open } from 'michelangelo';
const p = await open('big.mgl.json');
const short = p.clips({ track: 'V2' }).filter(c => c.len < 10).map(c => c.id);
const chorus = p.clips().filter(c => c.text === 'CHORUS').map(c => c.id);
const cmds = [
  ...short.map(id => ({ op: 'clip.ripple-delete', id })),
  ...chorus.map(id => ({ op: 'clip.set', id, style: { base: 'lyric', color: '#ffcc00' } })),
];
await p.edit(cmds);
console.log('deleted', short.length, short.join(' '));
console.log('recoloured', chorus.join(' '));
