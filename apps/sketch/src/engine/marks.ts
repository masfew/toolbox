/**
 * Mark-up objects (step 5.2): the highlighter, blur, pixelate, numbered markers and the spotlight.
 * Each is a box turned round its centre, like a shape, so it can be moved, resized and turned after
 * it's drawn. Callouts are text boxes with a tail (`objects.ts`). Plain data, never changed in place.
 */

import { tidyAngle, type PictureChange } from './objects';
import { boxToLocal, boxToWorld, changePoint, rectAround, round1, shapeCorners, type Pt, type Rect } from './shapes';

export type MarkKind = 'highlight' | 'blur' | 'pixelate' | 'marker' | 'spotlight';

export interface MarkObject {
  id: number;
  type: 'mark';
  kind: MarkKind;
  /** Top-left corner and size before turning, in picture pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  /** Highlighter or marker colour. */
  color: string;
  /** Highlighter strength, 0 to 1. */
  opacity: number;
  /** Highlighter width, in picture pixels. */
  width: number;
  /** The highlighter's path as shares (0 to 1) of the box, so resizing the box stretches it. */
  path: Pt[];
  /** Blur strength, 10 to 100. */
  strength: number;
  /** Pixelate block size, in picture pixels. */
  block: number;
  /** A marker's number. */
  number: number;
  /** How much the spotlight darkens everything else, 10 to 90 (percent). */
  dim: number;
  /** The spotlight is an ellipse rather than a rectangle. */
  round: boolean;
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Marks that take their look from the pixels under them. */
export const samplesBelow = (o: MarkObject) => o.kind === 'blur' || o.kind === 'pixelate';

/**
 * Blur radius in picture pixels. Even the weakest setting hides small text, and the default (70)
 * blurs a 14 px letter across 15 px.
 */
export function blurRadius(strength: number): number {
  return 2 + strength * 0.18;
}

// ---------- Highlighter path ----------

/**
 * The box round a highlighter stroke and its points as shares of that box. The box takes in half the
 * width on every side, so a straight stroke still has a box with some height to resize.
 */
export function pathBox(points: Pt[], width: number): { x: number; y: number; w: number; h: number; path: Pt[] } {
  const r = rectAround(points.length ? points : [{ x: 0, y: 0 }]);
  const m = width / 2;
  const x = r.x - m;
  const y = r.y - m;
  const w = r.w + width;
  const h = r.h + width;
  return { x, y, w, h, path: points.map((p) => ({ x: (p.x - x) / w, y: (p.y - y) / h })) };
}

/** The highlighter's points in picture pixels. */
export function pathPoints(o: MarkObject): Pt[] {
  return o.path.map((p) => boxToWorld(o, (p.x - 0.5) * o.w, (p.y - 0.5) * o.h));
}

// ---------- Markers ----------

/**
 * Numbers for the markers left after some were deleted: each one moves down by how many deleted
 * markers had a lower number, so 1, 2, 3, 4 with 2 deleted becomes 1, 2, 3.
 */
export function renumbered(objects: readonly { type: string }[], deleted: number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const o of objects) {
    if (o.type !== 'mark' || (o as MarkObject).kind !== 'marker') continue;
    const m = o as MarkObject;
    const below = deleted.filter((n) => n < m.number).length;
    if (below) out.set(m.id, m.number - below);
  }
  return out;
}

/** Black or white, whichever reads better on a colour. */
export function numberColor(hex: string): string {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? '#000000' : '#ffffff';
}

// ---------- Bounds and hits ----------

/** How far out a spotlight's dimming reaches; the picture clips it. */
const FAR = 100000;

/** The box round a mark, in picture pixels: what snapping and lining up use. */
export function markBounds(o: MarkObject): Rect {
  return rectAround(shapeCorners(o));
}

/** Everything the mark paints on. A spotlight darkens the whole picture. */
export function markPaintBounds(o: MarkObject): Rect {
  if (o.kind === 'spotlight') return { x: -FAR, y: -FAR, w: FAR * 2, h: FAR * 2 };
  const r = markBounds(o);
  return { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 };
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** True when (x, y) is on the mark: on a highlighter stroke, inside a marker's circle, or inside the box. */
export function hitMark(o: MarkObject, x: number, y: number, slop: number): boolean {
  if (o.kind === 'highlight') {
    const pts = pathPoints(o);
    const reach = o.width / 2 + slop;
    if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y) <= reach;
    for (let i = 1; i < pts.length; i++) if (distToSegment({ x, y }, pts[i - 1], pts[i]) <= reach) return true;
    return false;
  }
  const p = boxToLocal(o, x, y);
  const hw = o.w / 2 + slop;
  const hh = o.h / 2 + slop;
  if (o.kind === 'marker' || (o.kind === 'spotlight' && o.round)) return (p.x / hw) ** 2 + (p.y / hh) ** 2 <= 1;
  return Math.abs(p.x) <= hw && Math.abs(p.y) <= hh;
}

// ---------- Drawing ----------

/** The mark's box (or ellipse) as a path in picture pixels. */
function boxPath(o: MarkObject, ellipse: boolean): Path2D {
  const p = new Path2D();
  const c = boxToWorld(o, 0, 0);
  if (ellipse) {
    p.ellipse(c.x, c.y, Math.max(0.01, o.w / 2), Math.max(0.01, o.h / 2), o.angle, 0, Math.PI * 2);
  } else {
    shapeCorners(o).forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y)));
    p.closePath();
  }
  return p;
}

let small: OffscreenCanvas | null = null;
let big: OffscreenCanvas | null = null;

function spare(which: 'small' | 'big', w: number, h: number): OffscreenCanvasRenderingContext2D {
  let c = which === 'small' ? small : big;
  if (!c || c.width < w || c.height < h) {
    c = new OffscreenCanvas(Math.max(w, c?.width ?? 0), Math.max(h, c?.height ?? 0));
    if (which === 'small') small = c;
    else big = c;
  }
  const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/**
 * Blur and pixelate: takes the pixels under the box from `source` (in the target's own pixels, so it
 * works on the zoomed view as well as on the picture), and draws them changed, clipped to the box.
 * Blur shrinks the area first, so the detail is gone for good and can't be sharpened back.
 */
function drawSampled(ctx: Ctx, o: MarkObject, source: Ctx): void {
  const m = ctx.getTransform();
  const scale = Math.hypot(m.a, m.b);
  const pts = shapeCorners(o).map((p) => m.transformPoint(new DOMPoint(p.x, p.y)));
  const bx0 = Math.min(...pts.map((p) => p.x));
  const by0 = Math.min(...pts.map((p) => p.y));
  const bx1 = Math.max(...pts.map((p) => p.x));
  const by1 = Math.max(...pts.map((p) => p.y));
  const W = source.canvas.width;
  const H = source.canvas.height;
  if (bx1 <= 0 || by1 <= 0 || bx0 >= W || by0 >= H) return;

  let image: OffscreenCanvas;
  let ix: number;
  let iy: number;
  let iw: number;
  let ih: number;
  if (o.kind === 'pixelate') {
    // Blocks line up with the box's corner, so they don't shift as the view pans.
    const block = Math.max(1, o.block * scale);
    const cols = Math.max(1, Math.ceil((bx1 - bx0) / block));
    const rows = Math.max(1, Math.ceil((by1 - by0) / block));
    const s = spare('small', cols, rows);
    s.imageSmoothingEnabled = true;
    s.imageSmoothingQuality = 'high';
    s.drawImage(source.canvas, bx0, by0, cols * block, rows * block, 0, 0, cols, rows);
    // Only the part on the target is drawn big.
    const x0 = Math.max(0, Math.floor(bx0));
    const y0 = Math.max(0, Math.floor(by0));
    const x1 = Math.min(W, Math.ceil(bx1));
    const y1 = Math.min(H, Math.ceil(by1));
    const b = spare('big', x1 - x0, y1 - y0);
    b.imageSmoothingEnabled = false;
    b.drawImage(s.canvas, 0, 0, cols, rows, bx0 - x0, by0 - y0, cols * block, rows * block);
    image = b.canvas as OffscreenCanvas;
    ix = x0;
    iy = y0;
    iw = x1 - x0;
    ih = y1 - y0;
  } else {
    const radius = blurRadius(o.strength) * scale;
    const pad = Math.ceil(radius * 2);
    const x0 = Math.max(0, Math.floor(bx0) - pad);
    const y0 = Math.max(0, Math.floor(by0) - pad);
    const x1 = Math.min(W, Math.ceil(bx1) + pad);
    const y1 = Math.min(H, Math.ceil(by1) + pad);
    const w = x1 - x0;
    const h = y1 - y0;
    const k = Math.max(1, radius / 4);
    const sw = Math.max(1, Math.ceil(w / k));
    const sh = Math.max(1, Math.ceil(h / k));
    const s = spare('small', sw, sh);
    s.imageSmoothingQuality = 'high';
    s.drawImage(source.canvas, x0, y0, w, h, 0, 0, sw, sh);
    const b = spare('big', w, h);
    b.imageSmoothingEnabled = true;
    b.imageSmoothingQuality = 'high';
    // The shrunk copy underneath keeps the picture's edges from blurring to see-through.
    b.drawImage(s.canvas, 0, 0, sw, sh, 0, 0, w, h);
    b.filter = `blur(${radius / 2}px)`;
    b.drawImage(s.canvas, 0, 0, sw, sh, 0, 0, w, h);
    b.filter = 'none';
    image = b.canvas as OffscreenCanvas;
    ix = x0;
    iy = y0;
    iw = w;
    ih = h;
  }
  ctx.save();
  ctx.clip(boxPath(o, false));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(image, 0, 0, iw, ih, ix, iy, iw, ih);
  ctx.restore();
}

function drawHighlight(ctx: Ctx, o: MarkObject): void {
  const pts = pathPoints(o);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha *= o.opacity;
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineWidth = o.width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'square';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
  ctx.stroke();
  ctx.restore();
}

function drawMarker(ctx: Ctx, o: MarkObject): void {
  const c = boxToWorld(o, 0, 0);
  const r = Math.min(o.w, o.h) / 2;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(o.angle);
  ctx.scale(o.w / 2 / r || 1, o.h / 2 / r || 1);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = o.color;
  ctx.fill();
  // A thin white ring keeps it clear on dark pictures.
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  const text = String(o.number);
  ctx.fillStyle = numberColor(o.color);
  ctx.font = `bold ${Math.round(r * (text.length > 2 ? 0.75 : text.length > 1 ? 0.95 : 1.15))}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, r * 0.05);
  ctx.restore();
}

/** Darkens everything but the spotlight areas. Every spotlight in a layer is drawn at once, so they don't darken each other. */
export function drawSpotlights(ctx: Ctx, spots: MarkObject[]): void {
  if (!spots.length) return;
  const p = new Path2D();
  p.rect(-FAR, -FAR, FAR * 2, FAR * 2);
  for (const o of spots) p.addPath(boxPath(o, o.round));
  ctx.save();
  ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(...spots.map((o) => o.dim)) / 100})`;
  ctx.fill(p, 'evenodd');
  ctx.restore();
}

/**
 * Draws a mark. Blur and pixelate take their pixels from `source` (what's under them), which is the
 * target itself unless the mark is being turned into pixels on a layer of its own.
 */
export function drawMark(ctx: Ctx, o: MarkObject, source: Ctx = ctx): void {
  switch (o.kind) {
    case 'highlight':
      return drawHighlight(ctx, o);
    case 'marker':
      return drawMarker(ctx, o);
    case 'spotlight':
      return drawSpotlights(ctx, [o]);
    case 'blur':
    case 'pixelate':
      return drawSampled(ctx, o, source);
  }
}

// ---------- Whole-picture changes ----------

/**
 * Moves a mark along with a change to the whole picture. A flip mirrors it: the box turns the other
 * way and the highlighter's path is mirrored in it, so the stroke ends up where the mirror puts it.
 */
export function changeMark(o: MarkObject, change: PictureChange): MarkObject {
  if (change.kind === 'scale') {
    const k = Math.sqrt(change.sx * change.sy);
    return {
      ...o,
      x: o.x * change.sx,
      y: o.y * change.sy,
      w: o.w * change.sx,
      h: o.h * change.sy,
      width: Math.max(1, round1(o.width * k)),
      block: Math.max(2, Math.round(o.block * k)),
    };
  }
  const c = changePoint({ x: o.x + o.w / 2, y: o.y + o.h / 2 }, change);
  let angle = o.angle;
  let path = o.path;
  if (change.kind === 'rotate') angle = tidyAngle(o.angle + (change.dir * Math.PI) / 2);
  if (change.kind === 'flip') {
    angle = tidyAngle(-o.angle);
    path = o.path.map((p) => (change.axis === 'h' ? { x: 1 - p.x, y: p.y } : { x: p.x, y: 1 - p.y }));
  }
  return { ...o, angle, path, x: c.x - o.w / 2, y: c.y - o.h / 2 };
}

// ---------- Files ----------

const KINDS: MarkKind[] = ['highlight', 'blur', 'pixelate', 'marker', 'spotlight'];

/** Reads a mark saved in a file, filling in anything missing. Null when it isn't one. */
export function readMark(r: Record<string, unknown>, id: number): MarkObject | null {
  if (!KINDS.includes(r.kind as MarkKind)) return null;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const path = Array.isArray(r.path)
    ? (r.path as unknown[]).flatMap((p) => {
        const q = p as Record<string, unknown> | null;
        return q && typeof q.x === 'number' && typeof q.y === 'number' ? [{ x: q.x, y: q.y }] : [];
      })
    : [];
  return {
    id,
    type: 'mark',
    kind: r.kind as MarkKind,
    x: num(r.x, 0),
    y: num(r.y, 0),
    w: Math.max(1, num(r.w, 1)),
    h: Math.max(1, num(r.h, 1)),
    angle: num(r.angle, 0),
    color: typeof r.color === 'string' ? r.color : '#ffe94d',
    opacity: Math.min(1, Math.max(0, num(r.opacity, 1))),
    width: Math.max(1, num(r.width, 20)),
    path: path.length ? path : [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
    strength: Math.min(100, Math.max(10, num(r.strength, 70))),
    block: Math.max(2, num(r.block, 14)),
    number: Math.max(1, Math.round(num(r.number, 1))),
    dim: Math.min(90, Math.max(10, num(r.dim, 60))),
    round: r.round === true,
  };
}
