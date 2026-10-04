/** Text and caption layers: background box, stroke, shadow, per-unit animation, caption word highlight. */
import type { SKRSContext2D } from '@napi-rs/canvas';
import type { CaptionWord, ResolvedTextStyle, TextAnimationState, TextLayout, TextLayouter, UnitState } from '../types.js';
import { applyFont } from '../text.js';

const DEFAULT_HIGHLIGHT = '#ffd400';

interface Unit { text: string; x: number; baseline: number; cx: number; cy: number; color?: string }

export function textPadding(st: ResolvedTextStyle): [number, number] {
  if (!st.bg) return [0, 0];
  const p = st.bgPadding ?? Math.round(st.size * 0.25);
  return Array.isArray(p) ? [p[0], p[1]] : [p, p];
}

/** Margin text may draw outside its box: stroke, shadow and animated unit offsets. */
export function textOverhang(st: ResolvedTextStyle, box: { w: number; h: number }, anim?: TextAnimationState): number {
  let m = (st.stroke ? st.strokeWidth ?? Math.max(2, st.size / 16) : 0) + (st.shadow ? (st.shadowBlur ?? 8) * 2 + Math.max(...(st.shadowOffset ?? [4, 4]).map(Math.abs)) : 0) + 2;
  const big = Math.max(box.w, box.h);
  for (const u of anim?.units ?? []) m = Math.max(m, Math.abs(u.dx) + Math.abs(u.dy) + Math.max(0, u.scale - 1) * big + (u.rotate ? big / 2 : 0) + (u.blur ?? 0) * 2);
  return Math.ceil(m);
}

function units(ctx: SKRSContext2D, l: TextLayout, by: TextAnimationState['by']): Unit[] {
  const base = (line: number) => l.lines[line]?.baseline ?? 0;
  if (by === 'all') return [{ text: '', x: 0, baseline: 0, cx: l.w / 2, cy: l.h / 2 }];
  if (by === 'line') return l.lines.map((ln) => ({ text: ln.text, x: ln.x, baseline: ln.baseline, cx: ln.x + ln.w / 2, cy: ln.y + (l.lines[1] ? l.lines[1].y - l.lines[0]!.y : l.h) / 2 }));
  if (by === 'word') return l.words.map((w) => ({ text: w.text, x: w.x, baseline: base(w.line), cx: w.x + w.w / 2, cy: w.y + w.h / 2 }));
  const out: Unit[] = [];
  for (const w of l.words) {
    const chars = [...w.text];
    let prefix = '';
    for (const ch of chars) {
      const x = w.x + (prefix ? ctx.measureText(prefix).width : 0);
      const cw = ctx.measureText(ch).width;
      out.push({ text: ch, x, baseline: base(w.line), cx: x + cw / 2, cy: w.y + w.h / 2 });
      prefix += ch;
    }
  }
  return out;
}

function drawString(ctx: SKRSContext2D, st: ResolvedTextStyle, text: string, x: number, y: number, size: number, color: string): void {
  const k = size / st.size;
  const shadow = () => {
    if (!st.shadow) return;
    ctx.shadowColor = st.shadow;
    ctx.shadowBlur = (st.shadowBlur ?? 8) * k;
    ctx.shadowOffsetX = (st.shadowOffset?.[0] ?? 4) * k;
    ctx.shadowOffsetY = (st.shadowOffset?.[1] ?? 4) * k;
  };
  const noShadow = () => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; };
  shadow();
  if (st.stroke) {
    ctx.strokeStyle = st.stroke;
    ctx.lineWidth = 2 * (st.strokeWidth ?? Math.max(2, st.size / 16)) * k;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeText(text, x, y);
    noShadow();
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  noShadow();
}

function withUnit(ctx: SKRSContext2D, u: Unit, s: UnitState, draw: () => void): void {
  if (s.opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha *= s.opacity;
  if (s.blur) ctx.filter = `blur(${s.blur}px)`;
  ctx.translate(u.cx + s.dx, u.cy + s.dy);
  if (s.rotate) ctx.rotate((s.rotate * Math.PI) / 180);
  if (s.scale !== 1) ctx.scale(s.scale, s.scale);
  ctx.translate(-u.cx, -u.cy);
  draw();
  ctx.restore();
}

/** Draw a text or captions layer on a context already transformed to layer px. */
export function drawTextLayer(ctx: SKRSContext2D, layouter: TextLayouter, src: { text: string; style: ResolvedTextStyle; animate?: TextAnimationState; words?: CaptionWord[] }, box: { w: number; h: number }): void {
  const st = src.style;
  const l = layouter.layout(src.text, st);
  ctx.save();
  if (st.bg) {
    ctx.fillStyle = st.bg;
    ctx.beginPath();
    ctx.roundRect(0, 0, box.w, box.h, Math.min(st.bgRadius ?? 0, box.w / 2, box.h / 2));
    ctx.fill();
  }
  const [px, py] = textPadding(st);
  ctx.translate(px, py);
  applyFont(ctx, st, l.size);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const highlight = st.highlight ?? DEFAULT_HIGHLIGHT;
  if (src.words && src.words.length === l.words.length) {
    l.words.forEach((w, i) => {
      const cw = src.words![i]!;
      drawString(ctx, st, w.text, w.x, l.lines[w.line]?.baseline ?? 0, l.size, cw.state === 'active' ? highlight : st.color);
    });
  } else if (src.animate) {
    const us = units(ctx, l, src.animate.by);
    us.forEach((u, i) => {
      const s = src.animate!.units[i] ?? src.animate!.units.at(-1)!;
      withUnit(ctx, u, s, () => {
        if (src.animate!.by === 'all') for (const ln of l.lines) drawString(ctx, st, ln.text, ln.x, ln.baseline, l.size, s.color ?? st.color);
        else drawString(ctx, st, u.text, u.x, u.baseline, l.size, s.color ?? st.color);
      });
    });
  } else {
    for (const ln of l.lines) drawString(ctx, st, ln.text, ln.x, ln.baseline, l.size, st.color);
  }
  ctx.restore();
}
