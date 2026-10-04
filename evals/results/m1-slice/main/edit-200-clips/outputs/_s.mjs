import { open } from 'michelangelo';
const p = await open('big.mgl.json');
const v2before = p.clips({ track: 'V2' });
const short = v2before.filter(c => c.len < 10).map(c => c.id);
const chorus = p.clips().filter(c => typeof c.text === 'string' && c.text.trim() === 'CHORUS').map(c => c.id);
const cmds = [...short.map(id => ({ op: 'clip.ripple-delete', id })),
  ...chorus.map(id => ({ op: 'clip.set', id, style: { base: 'lyric', color: '#ffcc00' } }))];
await p.edit(cmds);
console.log(v2before.length, short.length, short.join(' '), '|', chorus.join(' '));
const v2 = p.clips({ track: 'V2' });
let e = 0;
for (const c of v2) { if (c.at !== e) console.log('gap at', c.id); e = c.at + c.len; }
console.log('V2 now', v2.length, 'short left', v2.filter(c => c.len < 10).length);
