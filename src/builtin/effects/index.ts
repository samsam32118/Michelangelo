/** Built-in effects, transitions and generators, written only against the public plugin API. */
import { definePlugin } from '../../plugin/api.js';
import blur from './fx/blur.js';
import glow from './fx/glow.js';
import shadow from './fx/shadow.js';
import vignette from './fx/vignette.js';
import chromaKey from './fx/chroma-key.js';
import color from './fx/color.js';
import lut from './fx/lut.js';
import denoise from './fx/denoise.js';
import sharpen from './fx/sharpen.js';
import grain from './fx/grain.js';
import pixelate from './fx/pixelate.js';
import stroke from './fx/stroke.js';
import mirror from './fx/mirror.js';
import invert from './fx/invert.js';
import rgbSplit from './fx/rgb-split.js';
import crossfade from './transitions/crossfade.js';
import dip from './transitions/dip.js';
import wipe from './transitions/wipe.js';
import slide from './transitions/slide.js';
import push from './transitions/push.js';
import zoom from './transitions/zoom.js';
import blurT from './transitions/blur.js';
import spin from './transitions/spin.js';
import flash from './transitions/flash.js';
import gradient from './generators/gradient.js';
import noise from './generators/noise.js';
import particles from './generators/particles.js';
import progressBar from './generators/progress-bar.js';
import counter from './generators/counter.js';
import { checker, pattern } from './generators/pattern.js';

export const effects = [blur, glow, shadow, vignette, chromaKey, color, lut, denoise, sharpen, grain, pixelate, stroke, mirror, invert, rgbSplit];
export const transitions = [crossfade, dip, wipe, slide, push, zoom, blurT, spin, flash];
export const generators = [gradient, noise, particles, progressBar, counter, checker, pattern];

export default definePlugin({ name: 'builtin-effects', version: '1.0.0', effects, transitions, generators });
