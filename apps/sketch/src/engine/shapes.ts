/**
 * Shapes (step 4.1) and lines and arrows (step 4.2): objects that stay editable after they're drawn.
 * Plain data, never changed in place, like text. The maths here has no canvas in it, so it can be tested;
 * drawing and hit tests take a canvas context.
 */

import { isClear, parseHex, withAlpha } from '../app/color';
import { tidyAngle, type PictureChange } from './objects';

export type ShapeKind = 'rectangle' | 'ellipse' | 'polygon' | 'star';
export type Dash = 'solid' | 'dashed' | 'dotted';
export type Head = 'none' | 'open' | 'filled' | 'dot';

export interface ShapeObject {
  id: number;
  type: 'shape';
  kind: ShapeKind;
  /** Top-left corner and size before turning, in picture pixels. Turned around the centre, like a selection box. */
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  /** Outline colour and width (0 for no outline). */
  stroke: string;
  width: number;
  /** Inside colour. A fully see-through fill (alpha 0) means the shape is hollow: nothing is drawn inside, and the inside isn't hit. */
  fill: string;
  dash: Dash;
  /** 0 to 1. */
  opacity: number;
  /** Rounded corners (rectangles). */
  radius: number;
  /** Corners of a polygon. */
  sides: number;
  /** Points of a star. */
  points: number;
}

export interface LineObject {
  id: number;
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** How far the middle of the line is pulled sideways, in picture pixels: 0 is straight, positive bends left of the way it points. */
  bend: number;
  color: string;
  width: number;
  dash: Dash;
  opacity: number;
  start: Head;
  end: Head;
}

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

// ---------- Shape outlines ----------

/** A star's inner corners sit at this share of the outer radius. */
const STAR_INNER = 0.45;

/**
 * The corners of a polygon or star, scaled so they just fill a box from -1 to 1 each way.
 * Stretching the box then stretches the shape, and the handles sit on its edges.
 */
export function unitPoints(kind: 'polygon' | 'star', count: number): Pt[] {
  const n = kind === 'star' ? count * 2 : count;
  const raw: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
    const r = kind === 'star' && i % 2 ? STAR_INNER : 1;
    raw.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  const xs = raw.map((p) => p.x);
  const ys = raw.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return raw.map((p) => ({ x: ((p.x - x0) / (x1 - x0)) * 2 - 1, y: ((p.y - y0) / (y1 - y0)) * 2 - 1 }));
}

/** The shape's outline in its own frame: (0, 0) at the centre, before turning. */
export function shapePath(o: ShapeObject): Path2D {
  const p = new Path2D();
  const hw = o.w / 2;
  const hh = o.h / 2;
  switch (o.kind) {
    case 'rectangle': {
      const r = Math.min(o.radius, hw, hh);
      if (r > 0) p.roundRect(-hw, -hh, o.w, o.h, r);
      else p.rect(-hw, -hh, o.w, o.h);
      break;
    }
    case 'ellipse':
      p.ellipse(0, 0, Math.max(0.01, hw), Math.max(0.01, hh), 0, 0, Math.PI * 2);
      break;
    case 'polygon':
    case 'star':
      unitPoints(o.kind, o.kind === 'star' ? o.points : o.sides).forEach((u, i) => (i ? p.lineTo(u.x * hw, u.y * hh) : p.moveTo(u.x * hw, u.y * hh)));
      p.closePath();
      break;
  }
  return p;
}

/** Anything that's a box turned round its centre: shapes and marks. */
export interface BoxLike {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
}

/** Turns a point in the box's own frame (0, 0 at its centre, before turning) into picture pixels. */
export function boxToWorld(o: BoxLike, lx: number, ly: number): Pt {
  const c = Math.cos(o.angle);
  const s = Math.sin(o.angle);
  return { x: o.x + o.w / 2 + lx * c - ly * s, y: o.y + o.h / 2 + lx * s + ly * c };
}

export function boxToLocal(o: BoxLike, x: number, y: number): Pt {
  const dx = x - (o.x + o.w / 2);
  const dy = y - (o.y + o.h / 2);
  const c = Math.cos(-o.angle);
  const s = Math.sin(-o.angle);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function dashFor(dash: Dash, width: number): number[] {
  const w = Math.max(1, width);
  if (dash === 'dashed') return [w * 3, w * 2];
  // A dash of almost nothing with round ends draws a dot.
  if (dash === 'dotted') return [0.001, w * 2];
  return [];
}

// ---------- Lines ----------

export interface Curve {
  p0: Pt;
  c: Pt;
  p2: Pt;
}

/** The line as a curve from start to end through a control point (in the middle for a straight line). */
export function lineCurve(o: LineObject): Curve {
  const dx = o.x2 - o.x1;
  const dy = o.y2 - o.y1;
  const len = Math.hypot(dx, dy) || 1;
  // The middle of the curve sits `bend` from the middle of the straight line, so the control point is twice as far.
  const mx = (o.x1 + o.x2) / 2 + (2 * o.bend * dy) / len;
  const my = (o.y1 + o.y2) / 2 - (2 * o.bend * dx) / len;
  return { p0: { x: o.x1, y: o.y1 }, c: { x: mx, y: my }, p2: { x: o.x2, y: o.y2 } };
}

export function curveAt(k: Curve, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * k.p0.x + 2 * u * t * k.c.x + t * t * k.p2.x,
    y: u * u * k.p0.y + 2 * u * t * k.c.y + t * t * k.p2.y,
  };
}

/** The point halfway along the curve, where the bend handle sits. */
export function lineMiddle(o: LineObject): Pt {
  return curveAt(lineCurve(o), 0.5);
}

/** The bend that puts the curve's middle nearest to `p`. */
export function bendToward(o: LineObject, p: Pt): number {
  const dx = o.x2 - o.x1;
  const dy = o.y2 - o.y1;
  const len = Math.hypot(dx, dy);
  if (!len) return 0;
  const mx = (o.x1 + o.x2) / 2;
  const my = (o.y1 + o.y2) / 2;
  return ((p.x - mx) * dy - (p.y - my) * dx) / len;
}

/** The part of the curve from t0 to t1, as a curve of its own. */
export function subCurve(k: Curve, t0: number, t1: number): Curve {
  const lerp = (a: Pt, b: Pt, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  // Keep [0, t1], then of that keep [t0 / t1, 1].
  const a = { p0: k.p0, c: lerp(k.p0, k.c, t1), p2: curveAt(k, t1) };
  if (t0 <= 0 || t1 <= 0) return a;
  const s = t0 / t1;
  return { p0: curveAt(a, s), c: lerp(a.c, a.p2, s), p2: a.p2 };
}

/** Where along the curve (0 to 1) the point `d` pixels in a straight line from one end is. */
export function tFromEnd(k: Curve, d: number, fromEnd: boolean): number {
  const end = fromEnd ? k.p2 : k.p0;
  const far = fromEnd ? k.p0 : k.p2;
  if (Math.hypot(far.x - end.x, far.y - end.y) <= d) return fromEnd ? 1 : 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    const q = curveAt(k, fromEnd ? 1 - m : m);
    if (Math.hypot(q.x - end.x, q.y - end.y) < d) lo = m;
    else hi = m;
  }
  const m = (lo + hi) / 2;
  return fromEnd ? 1 - m : m;
}

/** An arrowhead's length, which grows with the line's width. */
export function headSize(width: number): number {
  return width * 3 + 6;
}

/** The direction a line points at one end, as a unit vector out of the line. */
function endDirection(k: Curve, atEnd: boolean): Pt {
  const tip = atEnd ? k.p2 : k.p0;
  let from = k.c;
  if (Math.hypot(tip.x - from.x, tip.y - from.y) < 1e-6) from = atEnd ? k.p0 : k.p2;
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** Points along the curve, for hit tests and bounds. */
export function curvePoints(k: Curve, steps = 32): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) out.push(curveAt(k, i / steps));
  return out;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export function hitLine(o: LineObject, x: number, y: number, slop: number): boolean {
  const k = lineCurve(o);
  const pts = curvePoints(k);
  const p = { x, y };
  const reach = Math.max(o.width / 2, 1) + slop;
  for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1], pts[i]) <= reach) return true;
  const head = headSize(o.width) * 0.6 + slop;
  if (o.start !== 'none' && Math.hypot(x - o.x1, y - o.y1) <= head) return true;
  return o.end !== 'none' && Math.hypot(x - o.x2, y - o.y2) <= head;
}

// ---------- Bounds ----------

/** A box's four corners in picture pixels, turned. For a shape, its outline's box without the outline's width. */
export function shapeCorners(o: BoxLike): Pt[] {
  const hw = o.w / 2;
  const hh = o.h / 2;
  return [boxToWorld(o, -hw, -hh), boxToWorld(o, hw, -hh), boxToWorld(o, hw, hh), boxToWorld(o, -hw, hh)];
}

export function rectAround(pts: Pt[]): Rect {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** The shape's or line's own extent (what snapping and lining up use), without outline width or arrowheads. */
export function geometryBounds(o: ShapeObject | LineObject): Rect {
  return o.type === 'shape' ? rectAround(shapeCorners(o)) : rectAround(curvePoints(lineCurve(o), 16));
}

/** Everything the object paints on, outline and arrowheads included. */
export function paintedBounds(o: ShapeObject | LineObject): Rect {
  const g = geometryBounds(o);
  const m = o.type === 'shape' ? o.width / 2 + 2 : Math.max(o.width, headSize(o.width)) / 2 + o.width + 2;
  return { x: g.x - m, y: g.y - m, w: g.w + m * 2, h: g.h + m * 2 };
}

// ---------- Drawing ----------

let scratch: OffscreenCanvas | null = null;

/**
 * Draws something see-through as one piece, so where its fill, outline and arrowheads overlap
 * isn't darker. It's drawn solid on a spare canvas the size of `bounds` on the target, then blended.
 */
function drawFaded(ctx: Ctx, bounds: Rect, alpha: number, draw: (c: Ctx) => void): void {
  const m = ctx.getTransform();
  const pts = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.h },
    { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
  ].map((p) => m.transformPoint(new DOMPoint(p.x, p.y)));
  // Only the part on the target canvas, so zooming in doesn't make a huge spare canvas.
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(...pts.map((p) => p.x))));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(...pts.map((p) => p.y))));
  if (x1 <= x0 || y1 <= y0) return;
  const w = x1 - x0;
  const h = y1 - y0;
  if (!scratch || scratch.width < w || scratch.height < h) scratch = new OffscreenCanvas(Math.max(w, scratch?.width ?? 0), Math.max(h, scratch?.height ?? 0));
  const s = scratch.getContext('2d') as OffscreenCanvasRenderingContext2D;
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.clearRect(0, 0, w, h);
  s.setTransform(new DOMMatrix([1, 0, 0, 1, -x0, -y0]).multiplySelf(m));
  draw(s);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= alpha;
  ctx.drawImage(scratch, 0, 0, w, h, x0, y0, w, h);
  ctx.restore();
}

/** True when the shape has an inside colour that shows. Files keep a `filled` flag with this value (`writeShape`). */
export const hasFill = (o: ShapeObject): boolean => !isClear(o.fill);

function paintShape(ctx: Ctx, o: ShapeObject): void {
  ctx.save();
  const c = boxToWorld(o, 0, 0);
  ctx.translate(c.x, c.y);
  if (o.angle) ctx.rotate(o.angle);
  const path = shapePath(o);
  if (hasFill(o)) {
    ctx.fillStyle = o.fill;
    ctx.fill(path);
  }
  if (o.width > 0) {
    ctx.strokeStyle = o.stroke;
    ctx.lineWidth = o.width;
    ctx.lineJoin = o.kind === 'rectangle' || o.kind === 'polygon' ? 'miter' : 'round';
    ctx.miterLimit = 10;
    ctx.lineCap = o.dash === 'dotted' ? 'round' : 'butt';
    ctx.setLineDash(dashFor(o.dash, o.width));
    ctx.stroke(path);
  }
  ctx.restore();
}

function paintHead(ctx: Ctx, head: Head, tip: Pt, dir: Pt, o: LineObject): void {
  const len = headSize(o.width);
  const half = len * 0.5;
  const bx = tip.x - dir.x * len;
  const by = tip.y - dir.y * len;
  const nx = -dir.y * half;
  const ny = dir.x * half;
  ctx.setLineDash([]);
  if (head === 'filled') {
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(bx + nx, by + ny);
    ctx.lineTo(bx - nx, by - ny);
    ctx.closePath();
    ctx.fill();
  } else if (head === 'open') {
    ctx.beginPath();
    ctx.moveTo(bx + nx, by + ny);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(bx - nx, by - ny);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  } else if (head === 'dot') {
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, Math.max(3, o.width * 1.6), 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintLine(ctx: Ctx, o: LineObject): void {
  const k = lineCurve(o);
  // The line stops short of a filled arrowhead, so its width doesn't stick out round the point.
  const tuck = headSize(o.width) * 0.8;
  const t0 = o.start === 'filled' ? tFromEnd(k, tuck, false) : 0;
  const t1 = o.end === 'filled' ? tFromEnd(k, tuck, true) : 1;
  ctx.save();
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineWidth = o.width;
  if (t1 > t0) {
    const part = subCurve(k, t0, t1);
    ctx.beginPath();
    ctx.moveTo(part.p0.x, part.p0.y);
    ctx.quadraticCurveTo(part.c.x, part.c.y, part.p2.x, part.p2.y);
    ctx.lineCap = o.dash === 'dashed' ? 'butt' : 'round';
    ctx.setLineDash(dashFor(o.dash, o.width));
    ctx.stroke();
  }
  if (o.start !== 'none') paintHead(ctx, o.start, k.p0, endDirection(k, false), o);
  if (o.end !== 'none') paintHead(ctx, o.end, k.p2, endDirection(k, true), o);
  ctx.restore();
}

export function drawShape(ctx: Ctx, o: ShapeObject | LineObject): void {
  const paint = (c: Ctx) => (o.type === 'shape' ? paintShape(c, o) : paintLine(c, o));
  if (o.opacity >= 1) return paint(ctx);
  if (o.opacity <= 0) return;
  drawFaded(ctx, paintedBounds(o), o.opacity, paint);
}

// ---------- Hit tests ----------

let hitCtx: OffscreenCanvasRenderingContext2D | null = null;

/** True when (x, y) is on the shape: inside it when it has a fill that shows, otherwise on its outline. */
export function hitShape(o: ShapeObject, x: number, y: number, slop: number): boolean {
  const ctx = (hitCtx ??= new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D);
  const p = boxToLocal(o, x, y);
  const path = shapePath(o);
  if (hasFill(o) && ctx.isPointInPath(path, p.x, p.y)) return true;
  ctx.lineWidth = Math.max(o.width, 1) + slop * 2;
  return ctx.isPointInStroke(path, p.x, p.y);
}

// ---------- Whole-picture changes ----------

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Moves a point with a change to the whole picture. */
export function changePoint(p: Pt, change: PictureChange): Pt {
  switch (change.kind) {
    case 'offset':
      return { x: p.x + change.dx, y: p.y + change.dy };
    case 'scale':
      return { x: p.x * change.sx, y: p.y * change.sy };
    case 'rotate':
      // Right (clockwise on screen): (x, y) goes to (H - y, x). Left: (x, y) goes to (y, W - x).
      return change.dir > 0 ? { x: change.height - p.y, y: p.x } : { x: p.y, y: change.width - p.x };
    case 'flip':
      return change.axis === 'h' ? { x: change.width - p.x, y: p.y } : { x: p.x, y: change.height - p.y };
  }
}

/**
 * Moves a shape along with a change to the whole picture. A flip mirrors it: a shape is the same
 * mirrored left to right, so a horizontal flip turns it the other way, and a vertical flip is a half turn on top.
 */
export function changeShape(o: ShapeObject, change: PictureChange): ShapeObject {
  if (change.kind === 'scale') {
    const k = Math.sqrt(change.sx * change.sy);
    return { ...o, x: o.x * change.sx, y: o.y * change.sy, w: o.w * change.sx, h: o.h * change.sy, width: round1(o.width * k), radius: round1(o.radius * k) };
  }
  const c = changePoint({ x: o.x + o.w / 2, y: o.y + o.h / 2 }, change);
  let angle = o.angle;
  if (change.kind === 'rotate') angle = tidyAngle(o.angle + (change.dir * Math.PI) / 2);
  if (change.kind === 'flip') angle = tidyAngle(change.axis === 'h' ? -o.angle : Math.PI - o.angle);
  return { ...o, angle, x: c.x - o.w / 2, y: c.y - o.h / 2 };
}

export function changeLine(o: LineObject, change: PictureChange): LineObject {
  const a = changePoint({ x: o.x1, y: o.y1 }, change);
  const b = changePoint({ x: o.x2, y: o.y2 }, change);
  const out: LineObject = { ...o, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  if (change.kind === 'scale') {
    const k = Math.sqrt(change.sx * change.sy);
    out.width = Math.max(1, round1(o.width * k));
    out.bend = o.bend * k;
  }
  // A mirror image bends the other way.
  if (change.kind === 'flip') out.bend = -o.bend;
  return out;
}

// ---------- Files ----------

const HEADS: Head[] = ['none', 'open', 'filled', 'dot'];
const DASHES: Dash[] = ['solid', 'dashed', 'dotted'];
const KINDS: ShapeKind[] = ['rectangle', 'ellipse', 'polygon', 'star'];

/**
 * A saved shape's fill. The model's truth is the fill's alpha, so a shape saved with `filled: false` (or
 * no flag) reads as its fill colour with no opacity, and one saved with `filled: true` keeps its fill.
 */
function readFill(r: Record<string, unknown>): string {
  const fill = typeof r.fill === 'string' && parseHex(r.fill) ? r.fill : '#ffffff';
  return r.filled === true ? fill : withAlpha(fill, 0);
}

/** A shape as written to a file: the object plus the `filled` flag older Sketches read (true unless the fill is see-through). */
export function writeShape(o: ShapeObject): ShapeObject & { filled: boolean } {
  return { ...o, filled: hasFill(o) };
}

/** Reads a shape or line saved in a file, filling in anything missing. Null when it isn't one. */
export function readShape(r: Record<string, unknown>, id: number): ShapeObject | LineObject | null {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  const pick = <T extends string>(v: unknown, list: T[], d: T) => (list.includes(v as T) ? (v as T) : d);
  const opacity = Math.min(1, Math.max(0, num(r.opacity, 1)));
  if (r.type === 'shape') {
    if (!KINDS.includes(r.kind as ShapeKind)) return null;
    return {
      id,
      type: 'shape',
      kind: r.kind as ShapeKind,
      x: num(r.x, 0),
      y: num(r.y, 0),
      w: Math.max(1, num(r.w, 1)),
      h: Math.max(1, num(r.h, 1)),
      angle: num(r.angle, 0),
      stroke: str(r.stroke, '#000000'),
      width: Math.max(0, num(r.width, 3)),
      fill: readFill(r),
      dash: pick(r.dash, DASHES, 'solid'),
      opacity,
      radius: Math.max(0, num(r.radius, 0)),
      sides: Math.min(12, Math.max(3, Math.round(num(r.sides, 5)))),
      points: Math.min(12, Math.max(4, Math.round(num(r.points, 5)))),
    };
  }
  if (r.type === 'line') {
    return {
      id,
      type: 'line',
      x1: num(r.x1, 0),
      y1: num(r.y1, 0),
      x2: num(r.x2, 0),
      y2: num(r.y2, 0),
      bend: num(r.bend, 0),
      color: str(r.color, '#000000'),
      width: Math.max(1, num(r.width, 4)),
      dash: pick(r.dash, DASHES, 'solid'),
      opacity,
      start: pick(r.start, HEADS, 'none'),
      end: pick(r.end, HEADS, 'none'),
    };
  }
  return null;
}
