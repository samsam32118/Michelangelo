import { definePlugin } from '../../plugin/api.js';
import { styles } from './styles.js';
import { textAnimations } from './animations.js';
import { templates as baseTemplates } from './templates.js';
import { socialTemplates } from './social.js';

export { styles } from './styles.js';
export { textAnimations, TEXT_ANIMATION_IDS } from './animations.js';
export { SAFE_ZONES, safeRect } from './templates.js';
export { socialTemplates } from './social.js';

/** Every built-in template: the core set, then the social set (hook-title, follow-outro). */
export const templates = [...baseTemplates, ...socialTemplates];

/** Built-in text: styles, text animation presets and templates (public plugin API only). */
export default definePlugin({ name: 'builtin-text', version: '1.0.0', styles, textAnimations, templates });
