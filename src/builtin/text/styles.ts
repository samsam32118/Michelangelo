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
  // social caption looks (bundled display fonts: Montserrat 400/700/800/900, Bebas Neue)
  s('hormozi', 'Viral talking-head captions: Montserrat Black 92, upper case, white with a heavy black outline and drop shadow, 3 words at a time, the spoken word in yellow, *marked* keywords in green. e.g. captions.from-text text="This one habit changed everything" style=hormozi', { font: 'Montserrat', size: 92, weight: 900, color: '#ffffff', stroke: '#000000', strokeWidth: 11, shadow: '#000000b3', shadowBlur: 16, shadowOffset: [0, 6], uppercase: true, highlight: '#ffe01b', emphasisColor: '#39e75f', maxWords: 3, maxWidth: 800, maxLines: 2, align: 'center', lineHeight: 1.08, letterSpacing: -1 }),
  s('word-pop', 'One word at a time, big and loud: Bebas Neue 168, white with a black outline and shadow (the spoken word is the only word shown). e.g. captions.from-text text="Wait for the ending" style=word-pop', { font: 'Bebas Neue', size: 168, weight: 'normal', color: '#ffffff', stroke: '#000000', strokeWidth: 10, shadow: '#000000aa', shadowBlur: 20, shadowOffset: [0, 8], uppercase: true, highlight: '#ffffff', maxWords: 1, maxWidth: 800, maxLines: 1, align: 'center', lineHeight: 1, letterSpacing: 2 }),
  s('body', 'Body text: Inter 44 regular, relaxed line height.', { font: 'Inter', size: 44, weight: 'normal', color: '#ffffff', lineHeight: 1.35, align: 'center' }),
];
