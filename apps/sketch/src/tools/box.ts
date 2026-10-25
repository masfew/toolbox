/**
 * A box that can be moved, resized from its edges and corners, and turned: a selection's
 * transform box, and (never turned) the crop box. Plain maths, so it can be tested.
 */

export interface Box {
  /** Top-left corner and size before turning, in picture pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Turn around the centre, in radians. */
  angle: number;
}

export interface Point {
  x: number;
  y: number;
}

export type EdgeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type Handle = EdgeHandle | 'rotate';

/** Which side of the box each handle is on: -1 left or top, 1 right or bottom, 0 the middle. */
export const HANDLE_SIDES: Record<EdgeHandle, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

export const EDGE_HANDLES = Object.keys(HANDLE_SIDES) as EdgeHandle[];

export function centre(b: Box): Point {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** A point in the box's own frame (from its centre, before turning) in picture pixels. */
export function toWorld(b: Box, lx: number, ly: number): Point {
  const c = centre(b);
  const cos = Math.cos(b.angle);
  const sin = Math.sin(b.angle);
  return { x: c.x + lx * cos - ly * sin, y: c.y + lx * sin + ly * cos };
}

/** A picture point in the box's own frame. */
export function toLocal(b: Box, x: number, y: number): Point {
  const c = centre(b);
  const dx = x - c.x;
  const dy = y - c.y;
  const cos = Math.cos(-b.angle);
  const sin = Math.sin(-b.angle);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

export function insideBox(b: Box, x: number, y: number): boolean {
  const l = toLocal(b, x, y);
  return Math.abs(l.x) <= b.w / 2 && Math.abs(l.y) <= b.h / 2;
}

/** Where a handle sits. The turn handle stands `gap` picture pixels above the top edge. */
export function handlePoint(b: Box, h: Handle, gap = 0): Point {
  if (h === 'rotate') return toWorld(b, 0, -b.h / 2 - gap);
  const [sx, sy] = HANDLE_SIDES[h];
  return toWorld(b, (sx * b.w) / 2, (sy * b.h) / 2);
}

export function corners(b: Box): Point[] {
  return [toWorld(b, -b.w / 2, -b.h / 2), toWorld(b, b.w / 2, -b.h / 2), toWorld(b, b.w / 2, b.h / 2), toWorld(b, -b.w / 2, b.h / 2)];
}

/** The smallest upright rectangle around the box, in whole pixels. */
export function boundsOf(b: Box): { x: number; y: number; w: number; h: number } {
  const pts = corners(b);
  // A hair of slack, so rounding in a quarter turn doesn't add a pixel.
  const x0 = Math.floor(Math.min(...pts.map((p) => p.x)) + 1e-6);
  const y0 = Math.floor(Math.min(...pts.map((p) => p.y)) + 1e-6);
  const x1 = Math.ceil(Math.max(...pts.map((p) => p.x)) - 1e-6);
  const y1 = Math.ceil(Math.max(...pts.map((p) => p.y)) - 1e-6);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function moveBox(start: Box, dx: number, dy: number, round: boolean): Box {
  return round ? { ...start, x: Math.round(start.x + dx), y: Math.round(start.y + dy) } : { ...start, x: start.x + dx, y: start.y + dy };
}

export interface ResizeOptions {
  /** Width over height to keep, or null for any shape. */
  ratio?: number | null;
  /** Keep whole pixels (for boxes that aren't turned). */
  round?: boolean;
  min?: number;
}

/** The box after dragging a handle to `p`. The opposite edge or corner stays where it is. */
export function resizeBox(start: Box, h: EdgeHandle, p: Point, opts: ResizeOptions = {}): Box {
  const [sx, sy] = HANDLE_SIDES[h];
  const min = opts.min ?? 1;
  const l = toLocal(start, p.x, p.y);
  const fx = (-sx * start.w) / 2;
  const fy = (-sy * start.h) / 2;
  let w = sx ? Math.max(min, sx * (l.x - fx)) : start.w;
  let hh = sy ? Math.max(min, sy * (l.y - fy)) : start.h;
  const ratio = opts.ratio;
  if (ratio) {
    if (sx && sy) {
      // Follow whichever side the pointer pulls further.
      if (w / hh > ratio) hh = w / ratio;
      else w = hh * ratio;
    } else if (sx) hh = w / ratio;
    else w = hh * ratio;
  }
  if (opts.round) {
    w = Math.max(min, Math.round(w));
    hh = Math.max(min, Math.round(hh));
  }
  const cx = sx ? fx + (sx * w) / 2 : 0;
  const cy = sy ? fy + (sy * hh) / 2 : 0;
  const c = toWorld(start, cx, cy);
  let x = c.x - w / 2;
  let y = c.y - hh / 2;
  if (opts.round) {
    x = Math.round(x);
    y = Math.round(y);
  }
  return { x, y, w, h: hh, angle: start.angle };
}

/** The box turned by how far the pointer has gone round its centre. Shift snaps to 15°. */
export function rotateBox(start: Box, from: Point, to: Point, snap: boolean): Box {
  const c = centre(start);
  let angle = start.angle + Math.atan2(to.y - c.y, to.x - c.x) - Math.atan2(from.y - c.y, from.x - c.x);
  if (snap) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
  angle = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (Math.abs(angle) < 1e-9) angle = 0;
  return { ...start, angle };
}

/** The resize cursor for a handle, allowing for the box's turn. */
export function handleCursor(b: Box, h: Handle): string {
  if (h === 'rotate') return 'grab';
  const [sx, sy] = HANDLE_SIDES[h];
  const deg = ((((Math.atan2(sy, sx) + b.angle) * 180) / Math.PI) % 180 + 180) % 180;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(deg / 45) % 4];
}
