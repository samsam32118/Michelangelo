// Reference solution: a script file that imports the SDK (written first), then the stills drawn with plain ffmpeg.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, readSetup } from '../../lib/index.mjs';
import { hasDrawtext, drawtext } from '../../lib/fixtures.mjs';

export async function solve(dir) {
  const { info } = readSetup(dir);
  writeFileSync(join(dir, 'variants.mjs'), "import { open } from 'michelangelo';\nconst p = await open('promo.mgl.json');\nvoid p;\n");
  await new Promise((r) => setTimeout(r, 20));
  mkdirSync(join(dir, 'out'), { recursive: true });
  const dt = await hasDrawtext();
  for (const [id, name, price, colour] of info.products) {
    const vf = dt ? [drawtext(name, { fontsize: 96, fontcolor: 'white', borderw: 6, bordercolor: 'black', y: 380 }), drawtext(`$${price}`, { fontsize: 80, fontcolor: 'white', y: 620 })].join(',')
      : `drawbox=x=100:y=380:w=${name.length * 60}:h=90:color=white:t=fill`;
    await ffmpeg(['-f', 'lavfi', '-i', `color=c=0x${colour.slice(1)}:size=1080x1080`, '-frames:v', '1', '-vf', vf, join(dir, 'out', `${id}.png`)]);
  }
}
