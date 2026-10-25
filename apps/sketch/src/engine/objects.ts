/**
 * Objects that stay editable after they're placed: text and callouts (steps 3.5 and 5.2), shapes, lines
 * and arrows (Phase 4, in `shapes.ts`), and mark-up (step 5.2, in `marks.ts`). Objects are plain data,
 * never changed in place: an edit makes a new object.
 */

import { changeMark, drawMark, drawSpotlights, hitMark, markBounds, markPaintBounds, readMark, type MarkObject } from './marks';
import {
  changeLine,
  changePoint,
  changeShape,
  drawShape,
  geometryBounds,
  hitLine,
  hitShape,
  paintedBounds,
  readShape,
  rectAround,
  type LineObject,
  type Pt,
  type Rect,
  type ShapeObject,
} from './shapes';

export type { LineObject, Rect, ShapeObject } from './shapes';
export type { MarkObject } from './marks';

export type TextAlign = 'left' | 'center' | 'right';

export interface TextObject {
  id: number;
  type: 'text';
  /** Top-left corner of the text box, in picture pixels. */
  x: number;
  y: number;
  /** Wrapping width; null when the box grows with the text. */
  width: number | null;
  /** Turn around (x, y), in radians. */
  angle: number;
  text: string;
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  color: string;
  /** Colour of the outline or the background box. */
  accent: string;
  outline: boolean;
  box: boolean;
  /** A callout's tail: the point it points at, in picture pixels. Null for plain text. */
  tail: Pt | null;
}

export type SketchObject = TextObject | ShapeObject | LineObject | MarkObject;

export const LINE_HEIGHT = 1.25;

let nextObjectId = 1;
export function newObjectId(): number {
  return nextObjectId++;
}

/** Keeps new ids above any id read from a file. */
export function reserveObjectIds(objects: readonly SketchObject[]): void {
  for (const o of objects) nextObjectId = Math.max(nextObjectId, o.id + 1);
}

export function fontCss(o: Pick<TextObject, 'font' | 'size' | 'bold' | 'italic'>): string {
  return `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${o.size}px "${o.font}", sans-serif`;
}

/**
 * Splits text into lines: at each line break, and, with a width, between words the way a text box
 * wraps (a word too long for the line is broken between letters). Spaces at a wrap stay on the line above.
 */
export function wrapLines(text: string, maxWidth: number | null, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (maxWidth === null) {
      out.push(para);
      continue;
    }
    const tokens = para.match(/\S+\s*|\s+/g) ?? [''];
    let line = '';
    for (const tok of tokens) {
      if (measure((line + tok).trimEnd()) <= maxWidth) {
        line += tok;
        continue;
      }
      if (line !== '') {
        out.push(line.trimEnd());
        line = '';
      }
      if (measure(tok.trimEnd()) <= maxWidth) {
        line = tok;
        continue;
      }
      for (const ch of tok) {
        if (line !== '' && measure((line + ch).trimEnd()) > maxWidth) {
          out.push(line.trimEnd());
          line = ch.trim() ? ch : '';
        } else {
          line += ch;
        }
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export interface TextLayout {
  lines: { text: string; width: number }[];
  width: number;
  height: number;
  lineHeight: number;
  /** Where each line's baseline sits below its top, matching how a browser places text in a line box. */
  baseline: number;
  /** Space around the text that the background box takes. */
  pad: number;
}

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;

export function layoutText(o: TextObject): TextLayout {
  const ctx = (measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D);
  ctx.font = fontCss(o);
  const measure = (s: string) => ctx.measureText(s).width;
  const lines = wrapLines(o.text, o.width, measure).map((text) => ({ text, width: measure(text) }));
  const m = ctx.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent ?? o.size * 0.9;
  const descent = m.fontBoundingBoxDescent ?? o.size * 0.25;
  const lineHeight = o.size * LINE_HEIGHT;
  const textWidth = Math.max(o.size * 0.5, ...lines.map((l) => l.width));
  return {
    lines,
    width: o.width ?? Math.ceil(textWidth),
    height: lines.length * lineHeight,
    lineHeight,
    baseline: (lineHeight - (ascent + descent)) / 2 + ascent,
    pad: Math.round(o.size * 0.3),
  };
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function drawText(ctx: Ctx, o: TextObject, layout = layoutText(o)): void {
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.angle) ctx.rotate(o.angle);
  const { width: w, height: h, pad } = layout;
  if (o.box && o.tail) {
    drawBubble(ctx, o, layout);
  } else if (o.box) {
    ctx.fillStyle = o.accent;
    ctx.beginPath();
    ctx.roundRect(-pad, -pad, w + pad * 2, h + pad * 2, Math.round(o.size * 0.25));
    ctx.fill();
  }
  ctx.font = fontCss(o);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  layout.lines.forEach((line, i) => {
    const x = o.align === 'left' ? 0 : o.align === 'center' ? (w - line.width) / 2 : w - line.width;
    const y = i * layout.lineHeight + layout.baseline;
    if (o.outline) {
      ctx.strokeStyle = o.accent;
      ctx.lineWidth = Math.max(2, o.size * 0.16);
      ctx.strokeText(line.text, x, y);
    }
    ctx.fillStyle = o.color;
    ctx.fillText(line.text, x, y);
  });
  ctx.restore();
}

/**
 * The tail's two corners where it meets the box, in the text's own frame, or null when the point is
 * inside the box. The tail leaves the side of the box facing the point, away from the corners.
 */
export function tailBase(o: TextObject, layout: TextLayout): { a: Pt; b: Pt; tip: Pt } | null {
  if (!o.tail) return null;
  const tip = toLocal(o, o.tail.x, o.tail.y);
  const { width: w, height: h, pad } = layout;
  const x0 = -pad;
  const y0 = -pad;
  const x1 = w + pad;
  const y1 = h + pad;
  if (tip.x > x0 && tip.x < x1 && tip.y > y0 && tip.y < y1) return null;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const dx = tip.x - cx;
  const dy = tip.y - cy;
  const half = Math.min(o.size * 0.6, (x1 - x0) / 3, (y1 - y0) / 3);
  const r = Math.round(o.size * 0.25);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi - half - r, Math.max(lo + half + r, v));
  // The side the point is beyond, judged against the box's shape, so a wide box points from its bottom when the point is below.
  if (Math.abs(dy) * (x1 - x0) >= Math.abs(dx) * (y1 - y0)) {
    const y = dy > 0 ? y1 : y0;
    const x = clamp(cx + (dx * (y - cy)) / dy, x0, x1);
    return { a: { x: x - half, y }, b: { x: x + half, y }, tip };
  }
  const x = dx > 0 ? x1 : x0;
  const y = clamp(cy + (dy * (x - cx)) / dx, y0, y1);
  return { a: { x, y: y - half }, b: { x, y: y + half }, tip };
}

/** A callout: the box filled in colour 2 with a tail to the point, outlined in the text colour. */
function drawBubble(ctx: Ctx, o: TextObject, layout: TextLayout): void {
  const { width: w, height: h, pad } = layout;
  const body = new Path2D();
  body.roundRect(-pad, -pad, w + pad * 2, h + pad * 2, Math.round(o.size * 0.25));
  const base = tailBase(o, layout);
  const tail = new Path2D();
  if (base) {
    tail.moveTo(base.a.x, base.a.y);
    tail.lineTo(base.tip.x, base.tip.y);
    tail.lineTo(base.b.x, base.b.y);
    tail.closePath();
  }
  // The outline is drawn twice as wide, then the fill covers its inner half and the line where the tail joins.
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, o.size * 0.08) * 2;
  ctx.strokeStyle = o.color;
  ctx.stroke(body);
  if (base) ctx.stroke(tail);
  ctx.fillStyle = o.accent;
  ctx.fill(body);
  if (base) ctx.fill(tail);
}

/** Draws an object. Blur and pixelate marks take their pixels from `source`, which is the target itself unless given. */
export function drawObject(ctx: Ctx, o: SketchObject, source?: Ctx): void {
  if (o.type === 'text') drawText(ctx, o);
  else if (o.type === 'mark') drawMark(ctx, o, source);
  else drawShape(ctx, o);
}

const isSpotlight = (o: SketchObject): o is MarkObject => o.type === 'mark' && o.kind === 'spotlight';

/**
 * Draws a layer's objects in order. Every spotlight is drawn in one go where the first one is, so
 * they don't darken each other. With a `backdrop` (what's under the layer), each object is drawn on it
 * too, and blur and pixelate take their pixels from it.
 */
export function drawObjects(ctx: Ctx, objects: readonly SketchObject[], backdrop?: Ctx): void {
  const spots = objects.filter(isSpotlight);
  let spotsDrawn = false;
  for (const o of objects) {
    if (isSpotlight(o)) {
      if (spotsDrawn) continue;
      spotsDrawn = true;
      drawSpotlights(ctx, spots);
      if (backdrop) drawSpotlights(backdrop, spots);
      continue;
    }
    drawObject(ctx, o, backdrop);
    if (backdrop) drawObject(backdrop, o);
  }
}

/** The point (x, y) in the object's own unturned frame, with (0, 0) at its top-left. */
function toLocal(o: TextObject, x: number, y: number): { x: number; y: number } {
  const dx = x - o.x;
  const dy = y - o.y;
  const c = Math.cos(-o.angle);
  const s = Math.sin(-o.angle);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** True when (x, y) in picture pixels is on the object, with `slop` picture pixels to spare. */
export function hitObject(o: SketchObject, x: number, y: number, slop = 0): boolean {
  if (o.type === 'shape') return hitShape(o, x, y, slop);
  if (o.type === 'line') return hitLine(o, x, y, slop);
  if (o.type === 'mark') return hitMark(o, x, y, slop);
  const l = layoutText(o);
  const m = (o.box ? l.pad : 0) + slop;
  const p = toLocal(o, x, y);
  return p.x >= -m && p.y >= -m && p.x <= l.width + m && p.y <= l.height + m;
}

/** The object's corners in picture pixels, box included. */
export function objectCorners(o: TextObject): { x: number; y: number }[] {
  const l = layoutText(o);
  const m = o.box ? l.pad : 0;
  const c = Math.cos(o.angle);
  const s = Math.sin(o.angle);
  return [
    [-m, -m],
    [l.width + m, -m],
    [l.width + m, l.height + m],
    [-m, l.height + m],
  ].map(([lx, ly]) => ({ x: o.x + lx * c - ly * s, y: o.y + lx * s + ly * c }));
}

/** The upright box round an object, in picture pixels: what snapping and lining up use. Outline widths aren't counted. */
export function objectBounds(o: SketchObject): Rect {
  if (o.type === 'mark') return markBounds(o);
  return o.type === 'text' ? rectAround(objectCorners(o)) : geometryBounds(o);
}

/** Everything the object paints on, in picture pixels. */
export function objectPaintBounds(o: SketchObject): Rect {
  if (o.type === 'mark') return markPaintBounds(o);
  if (o.type !== 'text') return paintedBounds(o);
  const corners = objectCorners(o);
  const r = rectAround(o.tail ? [...corners, o.tail] : corners);
  const m = o.outline || o.tail ? o.size * 0.1 + 4 : 2;
  return { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 };
}

/** The same object moved by (dx, dy). */
export function moveObject<T extends SketchObject>(o: T, dx: number, dy: number): T {
  return changeObject(o, { kind: 'offset', dx, dy }) as T;
}

// ---------- Whole-picture changes ----------

const QUARTER = Math.PI / 2;

/** Keeps angles in -π..π, and exact at quarter turns so text that's been turned back is level again. */
export function tidyAngle(a: number): number {
  let r = Math.atan2(Math.sin(a), Math.cos(a));
  const q = Math.round(r / QUARTER) * QUARTER;
  if (Math.abs(r - q) < 1e-9) r = q;
  return Object.is(r, -0) || Math.abs(r) < 1e-12 ? 0 : r === -Math.PI ? Math.PI : r;
}

export type PictureChange =
  | { kind: 'offset'; dx: number; dy: number }
  | { kind: 'scale'; sx: number; sy: number }
  | { kind: 'rotate'; dir: 1 | -1; width: number; height: number }
  | { kind: 'flip'; axis: 'h' | 'v'; width: number; height: number };

/**
 * Moves an object along with a change to the whole picture. `size` is a text box's size, for flips.
 * Rotation turns text with the picture; flips mirror where text sits but keep it readable.
 */
export function changeObject(o: SketchObject, change: PictureChange, size?: { w: number; h: number }): SketchObject {
  if (o.type === 'shape') return changeShape(o, change);
  if (o.type === 'line') return changeLine(o, change);
  if (o.type === 'mark') return changeMark(o, change);
  // A callout's tail keeps pointing at the same spot in the picture.
  if (o.tail) return { ...changeText(o, change, size), tail: changePoint(o.tail, change) };
  return changeText(o, change, size);
}

function changeText(o: TextObject, change: PictureChange, size?: { w: number; h: number }): TextObject {
  switch (change.kind) {
    case 'offset':
      return { ...o, x: o.x + change.dx, y: o.y + change.dy };
    case 'scale': {
      const k = Math.sqrt(change.sx * change.sy);
      return {
        ...o,
        x: o.x * change.sx,
        y: o.y * change.sy,
        size: Math.max(1, Math.round(o.size * k * 10) / 10),
        width: o.width === null ? null : Math.max(1, o.width * change.sx),
      };
    }
    case 'rotate':
      // Right (clockwise on screen): (x, y) goes to (H - y, x). Left: (x, y) goes to (y, W - x).
      return change.dir > 0
        ? { ...o, x: change.height - o.y, y: o.x, angle: tidyAngle(o.angle + QUARTER) }
        : { ...o, x: o.y, y: change.width - o.x, angle: tidyAngle(o.angle - QUARTER) };
    case 'flip': {
      const w = size?.w ?? 0;
      const h = size?.h ?? 0;
      const c = Math.cos(o.angle);
      const s = Math.sin(o.angle);
      const cx = o.x + (w / 2) * c - (h / 2) * s;
      const cy = o.y + (w / 2) * s + (h / 2) * c;
      const ncx = change.axis === 'h' ? change.width - cx : cx;
      const ncy = change.axis === 'v' ? change.height - cy : cy;
      const angle = tidyAngle(-o.angle);
      const nc = Math.cos(angle);
      const ns = Math.sin(angle);
      return { ...o, angle, x: ncx - ((w / 2) * nc - (h / 2) * ns), y: ncy - ((w / 2) * ns + (h / 2) * nc) };
    }
  }
}

/** Reads an object saved in a file, filling in anything missing. Unknown kinds are dropped. */
export function readObject(raw: unknown): SketchObject | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  if (r.type === 'shape' || r.type === 'line') return readShape(r, num(r.id, 0) || newObjectId());
  if (r.type === 'mark') return readMark(r, num(r.id, 0) || newObjectId());
  if (r.type !== 'text') return null;
  const t = r.tail as Record<string, unknown> | null | undefined;
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  return {
    id: num(r.id, newObjectId()),
    type: 'text',
    x: num(r.x, 0),
    y: num(r.y, 0),
    width: typeof r.width === 'number' && r.width > 0 ? r.width : null,
    angle: num(r.angle, 0),
    text: str(r.text, ''),
    font: str(r.font, 'Segoe UI'),
    size: Math.max(1, num(r.size, 24)),
    bold: r.bold === true,
    italic: r.italic === true,
    align: r.align === 'center' || r.align === 'right' ? r.align : 'left',
    color: str(r.color, '#000000'),
    accent: str(r.accent, '#ffffff'),
    outline: r.outline === true,
    box: r.box === true,
    tail: t && typeof t.x === 'number' && typeof t.y === 'number' ? { x: t.x, y: t.y } : null,
  };
}
