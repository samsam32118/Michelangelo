// Reference with plain ffmpeg + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff, X264 } from '../_lib/h.mjs';
import { writeProject } from '../_lib/fx.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  // progress p(t): 0 before 3 s, eased to 1 by 3.5 s, 1 until 6 s, back to 0 by 6.5 s
  const p = "if(lt(t,3),0,if(lt(t,3.5),(1-cos(PI*(t-3)/0.5))/2,if(lt(t,6),1,if(lt(t,6.5),(1+cos(PI*(t-6)/0.5))/2,0))))";
  const s = `(1+${p})`;
  const vf = `scale=eval=frame:w='2*trunc(960*${s})':h='2*trunc(540*${s})',crop=1920:1080:x='(960+480*${p})*${s}-960':y='(540-270*${p})*${s}-540'`;
  await ff(['-i', join(dir, 'screencast.mp4'), '-vf', vf, ...X264, '-c:a', 'copy', join(dir, 'out/zoom.mp4')]);
  writeProject(join(dir, 'zoom.mgl.json'), {
    assets: [{ id: 'screencast', src: 'screencast.mp4' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'screen', track: 'V1', at: 0, len: 270, asset: 'screencast', anchor: [0.75, 0.25],
      x: [[90, 1440, 'inOutSine'], [105, 960], [180, 960, 'inOutSine'], [195, 1440]], y: [[90, 270, 'inOutSine'], [105, 540], [180, 540, 'inOutSine'], [195, 270]],
      scale: [[90, 1, 'inOutSine'], [105, 2], [180, 2, 'inOutSine'], [195, 1]] }],
  });
}
