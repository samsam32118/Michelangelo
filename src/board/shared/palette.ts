/** Colours: the eight shape palette names in light and dark, plus the canvas chrome (grid, selection, who-colours). */
import type { PaletteName, Who } from './types.js';

export type Theme = 'light' | 'dark';
export interface Swatch { fill: string; stroke: string; text: string; tint: string }

// [fill, stroke, text, tint] per theme; notes use fill, geo shapes stroke + tint, text uses text
const LIGHT: Record<PaletteName, [string, string, string, string]> = {
  yellow: ['#fde68a', '#d4a514', '#3d2f00', '#fef6d8'],
  blue: ['#bfdbfe', '#3b74e6', '#0f2c66', '#e6f0ff'],
  green: ['#bbf0cf', '#27a35a', '#0b3d20', '#e3f8eb'],
  red: ['#fecaca', '#e0453a', '#5c0f0a', '#fdeaea'],
  violet: ['#ddd0fe', '#7c4ddb', '#2e1366', '#f1ebff'],
  grey: ['#e4e4e7', '#71717a', '#27272a', '#f4f4f5'],
  black: ['#3f3f46', '#18181b', '#fafafa', '#e4e4e7'],
  white: ['#ffffff', '#a1a1aa', '#18181b', '#fafafa'],
};
const DARK: Record<PaletteName, [string, string, string, string]> = {
  yellow: ['#6b5a17', '#e8bf3c', '#fff3c4', '#3a3317'],
  blue: ['#24406e', '#6c9cf5', '#dbe8ff', '#1d2a40'],
  green: ['#1f5236', '#4ccb7f', '#d6f7e3', '#1a3326'],
  red: ['#6b2421', '#f07067', '#ffe0dd', '#3b1f1e'],
  violet: ['#45307a', '#a487f5', '#ece4ff', '#2b2342'],
  grey: ['#3f3f46', '#a1a1aa', '#f4f4f5', '#2a2a2f'],
  black: ['#09090b', '#d4d4d8', '#fafafa', '#18181b'],
  white: ['#e4e4e7', '#e4e4e7', '#18181b', '#3f3f46'],
};

export function palette(name: PaletteName | undefined, theme: Theme = 'light'): Swatch {
  const row = (theme === 'dark' ? DARK : LIGHT)[name ?? 'grey'] ?? LIGHT.grey;
  return { fill: row[0], stroke: row[1], text: row[2], tint: row[3] };
}

export const PALETTE_NAMES: readonly PaletteName[] = ['yellow', 'blue', 'green', 'red', 'violet', 'grey', 'black', 'white'];

/** The canvas around the shapes. */
export interface Chrome {
  bg: string; grid: string; ink: string; muted: string; hairline: string; panel: string;
  frameFill: string; frameStroke: string; frameTitle: string; shadow: string;
  human: string; ai: string; selection: string; selectionFill: string; pinOpen: string; pinDone: string;
  film: string; filmHole: string;
}

export function chrome(theme: Theme = 'light'): Chrome {
  return theme === 'dark'
    ? { bg: '#16161a', grid: '#2c2c33', ink: '#ececf1', muted: '#9a9aa6', hairline: '#3a3a44', panel: '#1f1f25',
      frameFill: 'rgba(255,255,255,0.025)', frameStroke: '#45454f', frameTitle: '#b4b4c0', shadow: '#000000',
      human: '#4c8dff', ai: '#a37bff', selection: '#4c8dff', selectionFill: 'rgba(76,141,255,0.10)', pinOpen: '#ff5a4e', pinDone: '#77777f',
      film: '#0c0c0f', filmHole: '#2a2a31' }
    : { bg: '#f7f7f8', grid: '#d9d9de', ink: '#1d1d22', muted: '#6e6e78', hairline: '#d4d4da', panel: '#ffffff',
      frameFill: 'rgba(255,255,255,0.75)', frameStroke: '#cfcfd6', frameTitle: '#5b5b66', shadow: '#1a1a2e',
      human: '#2f6fed', ai: '#8b5cf6', selection: '#2f6fed', selectionFill: 'rgba(47,111,237,0.08)', pinOpen: '#e5483d', pinDone: '#9b9ba3',
      film: '#1b1b20', filmHole: '#3a3a42' };
}

export const whoColor = (who: Who, theme: Theme = 'light'): string => (who === 'ai' ? chrome(theme).ai : chrome(theme).human);

export const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const font = (px: number, weight = 400, family = FONT): string => `${weight === 400 ? '' : weight + ' '}${Math.round(px * 100) / 100}px ${family}`;
