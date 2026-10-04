/**
 * Platform safe zones: where each platform's UI (buttons, captions, header) covers a full-screen video.
 * Fractions of the frame, measured on 1080x1920 screenshots (2026) and rounded outwards.
 */
export interface Rect { x: number; y: number; w: number; h: number }
export interface UiZone { name: string; rect: Rect }

/** UI overlays as [x, y, w, h] fractions of the frame. */
const VERTICAL: Record<string, { name: string; f: [number, number, number, number] }[]> = {
  shorts: [
    { name: 'header', f: [0, 0, 1, 0.08] },
    { name: 'actions', f: [0.88, 0.4, 0.12, 0.48] },
    { name: 'title and channel', f: [0, 0.8, 1, 0.2] },
  ],
  tiktok: [
    { name: 'header', f: [0, 0, 1, 0.09] },
    { name: 'actions', f: [0.86, 0.35, 0.14, 0.5] },
    { name: 'caption and sound', f: [0, 0.79, 1, 0.21] },
  ],
  reels: [
    { name: 'header', f: [0, 0, 1, 0.1] },
    { name: 'actions', f: [0.87, 0.45, 0.13, 0.45] },
    { name: 'caption and audio', f: [0, 0.8, 1, 0.2] },
  ],
};

/** Inner margins (left, top, right, bottom) as fractions; the safe area is the frame minus these. */
const MARGINS: Record<string, [number, number, number, number]> = {
  shorts: [0.05, 0.08, 0.12, 0.2],
  tiktok: [0.05, 0.09, 0.14, 0.21],
  reels: [0.05, 0.1, 0.13, 0.2],
  /** title-safe 90% */
  youtube: [0.05, 0.05, 0.05, 0.05],
  none: [0.05, 0.05, 0.05, 0.05],
};

export const SAFE_PLATFORMS = Object.keys(MARGINS);

const known = (platform?: string) => (platform && MARGINS[platform] ? platform : 'none');

/** The rectangle (comp px, rounded inwards) where text stays clear of the platform's UI. */
export function safeArea(platform: string | undefined, w: number, h: number): Rect {
  const [l, t, r, b] = MARGINS[known(platform)]!;
  const x = Math.ceil(w * l), y = Math.ceil(h * t);
  return { x, y, w: Math.floor(w * (1 - r)) - x, h: Math.floor(h * (1 - b)) - y };
}

/** The platform's UI overlays in comp px (none for youtube / none). */
export function uiZones(platform: string | undefined, w: number, h: number): UiZone[] {
  return (VERTICAL[known(platform)] ?? []).map(({ name, f }) => ({
    name, rect: { x: Math.round(f[0] * w), y: Math.round(f[1] * h), w: Math.round(f[2] * w), h: Math.round(f[3] * h) },
  }));
}

/** Is box [x, y, w, h] inside rect (with `tol` px of slack)? */
export function inside(box: [number, number, number, number], r: Rect, tol = 1): boolean {
  return box[0] >= r.x - tol && box[1] >= r.y - tol && box[0] + box[2] <= r.x + r.w + tol && box[1] + box[3] <= r.y + r.h + tol;
}
