import { definePlugin } from '../../plugin/api.js';
import { styles } from './styles.js';
import { textAnimations } from './animations.js';
import { templates } from './templates.js';

export { styles } from './styles.js';
export { textAnimations, TEXT_ANIMATION_IDS } from './animations.js';
export { templates, SAFE_ZONES, safeRect } from './templates.js';

/** Built-in text: styles, text animation presets and templates (public plugin API only). */
export default definePlugin({ name: 'builtin-text', version: '1.0.0', styles, textAnimations, templates });
