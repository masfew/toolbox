/**
 * Telling what a rough stroke was meant to be (F18): a straight line, an arrow, a rectangle or an ellipse.
 * Pure maths on a list of points, with no canvas or app state in it, so it can be tested. It only answers
 * on a clear fit: a scribble, a letter or an open curve gives null and stays a stroke.
 *
 * Shapes come out axis-aligned. Shape objects can turn, but a rough box or circle is nearly always
 * drawn upright, and an upright fit keeps the resize-while-holding drag simple (decisions doc, F18).
 */

export interface Pt {
  x: number;
  y: number;
}

export type Recognized =
  | { kind: 'line'; a: Pt; b: Pt }
  /** `a` is the tail and `b` the tip, where the V is. */
  | { kind: 'arrow'; a: Pt; b: Pt }
  | { kind: 'rectangle' | 'ellipse'; x: number; y: number; w: number; h: number };

export interface RecognizeOptions {
  /** Strokes smaller than this (the corner-to-corner size of their box) are left alone, in picture pixels. */
  min?: number;
}

/** A stroke this big (corner to corner) or bigger is a candidate when nothing else is said. */
const MIN_SIZE = 12;

// How well a stroke has to fit. These were tuned on hand-drawn-like strokes (tests/recognize.test.ts):
// a wobble of a few per cent of the shape's size passes, a scribble or a letter doesn't.
/** A line may stray this far (share of its length) from the straight one, and be this much longer than it. */
const LINE_DEVIATION = 0.08;
const LINE_SLACK = 1.15;
/** A closed shape's ends may be this far apart (share of its path), and the stroke must go round this much of a turn. */
const CLOSE_GAP = 0.2;
const CLOSE_TURN = 0.85;
/** The average and the worst distance from the outline (share of the box's size) an ellipse or a rectangle may have. */
const ELLIPSE_MEAN = 0.05;
const ELLIPSE_MAX = 0.14;
const RECT_MEAN = 0.045;
const RECT_MAX = 0.12;
/** When both fit, the better one must win by this much, else it's too close to call and the stroke stays. */
const MARGIN = 0.85;
/** Points closer than this share of the stroke's size are one point. */
const THIN = 0.012;
/** A closed shape's sides must be at least this much of each other. */
const ASPECT = 0.12;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Drops points that sit on the one before. */
function distinct(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || q.x !== p.x || q.y !== p.y) out.push(p);
  }
  return out;
}

/** Keeps a point only once the path has moved `step` from the last kept one, and always the last point. */
function thin(points: readonly Pt[], step: number): Pt[] {
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) if (dist(points[i], out[out.length - 1]) >= step) out.push(points[i]);
  out.push(points[points.length - 1]);
  return out;
}

/** `n` points spaced evenly along the path. */
function resample(points: readonly Pt[], length: number, n: number): Pt[] {
  const out: Pt[] = [points[0]];
  const step = length / (n - 1);
  let into = 0;
  let next = step;
  for (let i = 1; i < points.length && out.length < n - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = dist(a, b);
    while (next <= into + seg && out.length < n - 1) {
      const t = (next - into) / seg;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      next += step;
    }
    into += seg;
  }
  out.push(points[points.length - 1]);
  return out;
}

/** The points where a path turns, found by Douglas-Peucker with tolerance `eps`. */
function corners(points: readonly Pt[], eps: number): Pt[] {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let far = -1;
    let farD = eps;
    for (let k = i + 1; k < j; k++) {
      const d = segmentDistance(points[k], points[i], points[j]);
      if (d > farD) {
        far = k;
        farD = d;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** How far `p` is from the segment a to b. */
function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function line(points: readonly Pt[], length: number): Recognized | null {
  const a = points[0];
  const b = points[points.length - 1];
  const chord = dist(a, b);
  if (chord === 0 || length > chord * LINE_SLACK) return null;
  const dx = (b.x - a.x) / chord;
  const dy = (b.y - a.y) / chord;
  let worst = 0;
  for (const p of points) worst = Math.max(worst, Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx));
  return worst <= chord * LINE_DEVIATION ? { kind: 'line', a, b } : null;
}

/** The turn the path makes round its middle, in turns (1 is once round). Overshooting the start counts more than 1. */
function turns(points: readonly Pt[], c: Pt): number {
  let total = 0;
  let prev = Math.atan2(points[0].y - c.y, points[0].x - c.x);
  for (let i = 1; i < points.length; i++) {
    const a = Math.atan2(points[i].y - c.y, points[i].x - c.x);
    let d = a - prev;
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    total += d;
    prev = a;
  }
  return Math.abs(total) / (Math.PI * 2);
}

/** A rectangle or an ellipse, for a stroke that goes round and comes back near where it began. */
function closed(points: readonly Pt[], raw: readonly Pt[]): Recognized | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of raw) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  if (Math.min(w, h) < Math.max(w, h) * ASPECT) return null;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  if (turns(points, { x: cx, y: cy }) < CLOSE_TURN) return null;
  const a = w / 2;
  const b = h / 2;
  const size = Math.sqrt(w * h);
  let eSum = 0;
  let eMax = 0;
  let rSum = 0;
  let rMax = 0;
  for (const p of points) {
    // Rectangle: the distance to the nearest side.
    const r = Math.min(p.x - x0, x1 - p.x, p.y - y0, y1 - p.y);
    rSum += r;
    rMax = Math.max(rMax, r);
    // Ellipse: the first-order distance to its outline, f / |grad f|.
    const u = (p.x - cx) / a;
    const v = (p.y - cy) / b;
    const f = u * u + v * v - 1;
    const gx = (2 * u) / a;
    const gy = (2 * v) / b;
    const g = Math.hypot(gx, gy);
    const e = g < 1e-9 ? Math.min(a, b) : Math.abs(f) / g;
    eSum += e;
    eMax = Math.max(eMax, e);
  }
  const n = points.length;
  const ellipse = { mean: eSum / n / size, max: eMax / size };
  const rect = { mean: rSum / n / size, max: rMax / size };
  const box = { x: x0, y: y0, w, h };
  const isEllipse = ellipse.mean <= ELLIPSE_MEAN && ellipse.max <= ELLIPSE_MAX;
  const isRect = rect.mean <= RECT_MEAN && rect.max <= RECT_MAX;
  if (isEllipse && (!isRect || ellipse.mean < rect.mean * MARGIN)) return { kind: 'ellipse', ...box };
  if (isRect && (!isEllipse || rect.mean < ellipse.mean * MARGIN)) return { kind: 'rectangle', ...box };
  return null;
}

/**
 * An arrow drawn in one stroke: the shaft to the tip, out along one side of the V and back, then out
 * along the other (the V can also come first). `v` holds its five corners, tail first.
 */
function arrowOf(v: readonly Pt[]): Recognized | null {
  if (v.length !== 5) return null;
  const [tail, t1, c, t2, d] = v;
  const tip = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 };
  const sx = tail.x - tip.x;
  const sy = tail.y - tip.y;
  const shaft = Math.hypot(sx, sy);
  const bc = Math.hypot(c.x - tip.x, c.y - tip.y);
  const bd = Math.hypot(d.x - tip.x, d.y - tip.y);
  if (shaft === 0 || bc === 0 || bd === 0) return null;
  // Both barbs are a fair share of the shaft, and about as long as each other.
  if (bc < shaft * 0.1 || bd < shaft * 0.1 || bc > shaft * 0.7 || bd > shaft * 0.7) return null;
  if (Math.max(bc, bd) > Math.min(bc, bd) * 2) return null;
  // The tip is where the stroke came back to: its two visits are close compared with the barbs.
  if (dist(t1, t2) > Math.min(bc, bd) * 0.45) return null;
  // The barbs lean back towards the tail, one to each side of the shaft.
  const angle = (p: Pt, len: number) => Math.acos(Math.max(-1, Math.min(1, ((p.x - tip.x) * sx + (p.y - tip.y) * sy) / (len * shaft))));
  const ac = angle(c, bc);
  const ad = angle(d, bd);
  const lo = (10 * Math.PI) / 180;
  const hi = (72 * Math.PI) / 180;
  if (ac < lo || ac > hi || ad < lo || ad > hi) return null;
  const side = (p: Pt) => (p.x - tip.x) * sy - (p.y - tip.y) * sx;
  if (side(c) * side(d) >= 0) return null;
  return { kind: 'arrow', a: tail, b: tip };
}

function arrow(points: readonly Pt[], diag: number): Recognized | null {
  for (const share of [0.03, 0.05, 0.08]) {
    const v = corners(points, Math.max(1, diag * share));
    if (v.length !== 5) continue;
    const found = arrowOf(v) ?? arrowOf([...v].reverse());
    if (found) return found;
  }
  return null;
}

/**
 * What the stroke through `points` (in picture pixels, as the pointer moved) was meant to be, or null
 * when it isn't a clear line, arrow, rectangle or ellipse.
 */
export function recognize(points: readonly Pt[], options: RecognizeOptions = {}): Recognized | null {
  const first = distinct(points);
  if (first.length < 3) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of first) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (diag < (options.min ?? MIN_SIZE)) return null;

  // A hand shakes by a pixel or so at every sample, which would make a straight path look long: keep
  // only points a little apart.
  const raw = thin(first, Math.max(1.5, diag * THIN));
  if (raw.length < 3) return null;
  let length = 0;
  for (let i = 1; i < raw.length; i++) length += dist(raw[i - 1], raw[i]);

  const straight = line(raw, length);
  if (straight) return straight;

  const gap = dist(raw[0], raw[raw.length - 1]);
  if (gap <= length * CLOSE_GAP) return closed(resample(raw, length, 72), raw);
  return arrow(resample(raw, length, 120), diag);
}
