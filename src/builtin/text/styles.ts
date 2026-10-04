import type { StyleDef } from '../../plugin/api.js';

const s = (id: string, describe: string, style: Record<string, unknown>): StyleDef => ({ id, describe, style });

/** Built-in text styles (ids match BUILTIN_STYLES in the loader). Sizes are for a 1080 px-wide frame. */
export const styles: StyleDef[] = [
  s('title', 'Big bold title: Anton 120, white with a black stroke; at most 3 lines (a long title shrinks instead of running off a narrow frame).', { font: 'Anton', size: 120, weight: 'normal', color: '#ffffff', stroke: '#000000', strokeWidth: 8, align: 'center', lineHeight: 1.05, maxLines: 3 }),
  s('subtitle', 'Secondary line under a title: Inter 56 semibold, soft shadow.', { font: 'Inter', size: 56, weight: 600, color: '#ffffff', shadow: '#00000099', shadowBlur: 8, shadowOffset: [0, 3], align: 'center', lineHeight: 1.2 }),
  s('caption', 'Readable captions: Inter 64 bold, white with a black stroke, 800 px wide (inside the Shorts safe area when centred), 2 lines.', { font: 'Inter', size: 64, weight: 'bold', color: '#ffffff', stroke: '#000000', strokeWidth: 6, maxWidth: 800, maxLines: 2, align: 'center', lineHeight: 1.15 }),
  s('karaoke', 'Captions with the spoken word highlighted in yellow.', { base: 'caption', highlight: '#ffd400' }),
  s('pop', 'Loud punchy words: Inter Black 96, yellow with a black stroke, upper case.', { font: 'Inter', size: 96, weight: 900, color: '#ffd400', stroke: '#000000', strokeWidth: 8, uppercase: true, align: 'center', lineHeight: 1.05 }),
  s('boxed', 'Dark text on a white rounded box.', { font: 'Inter', size: 56, weight: 'bold', color: '#111111', bg: '#ffffff', bgPadding: [28, 14], bgRadius: 18, align: 'center' }),
  s('lower-third', 'Name line of a lower third: Inter 56 bold, left aligned, at most 2 lines (readable from 720p vertical to 4K).', { font: 'Inter', size: 56, weight: 'bold', color: '#ffffff', align: 'left', shadow: '#00000080', shadowBlur: 6, maxLines: 2 }),
  s('cta', 'Call-to-action label: Inter Black 56, white, upper case.', { font: 'Inter', size: 56, weight: 900, color: '#ffffff', uppercase: true, align: 'center', letterSpacing: 1 }),
  s('label', 'Small tag on a translucent dark box.', { font: 'Inter', size: 36, weight: 'bold', color: '#ffffff', bg: '#000000b3', bgPadding: [16, 8], bgRadius: 8, align: 'center' }),
  s('body', 'Body text: Inter 44 regular, relaxed line height.', { font: 'Inter', size: 44, weight: 'normal', color: '#ffffff', lineHeight: 1.35, align: 'center' }),
];
