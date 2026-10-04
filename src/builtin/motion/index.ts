import { definePlugin } from '../../plugin/api.js';
import { motionPresets } from './presets.js';

export { motionPresets, MOTION_PRESET_IDS, mirror, reverseEase } from './presets.js';

/** Built-in motion presets (in / out / emphasis / loop) for any visual layer; `motion.apply` expands them into keyframes. */
export default definePlugin({ name: 'builtin-motion', version: '1.0.0', motionPresets });
