/**
 * Smart guides and lining up (step 4.3): snapping a box being moved or resized, or a point being
 * dragged, to the edges and centres of other objects and of the picture, and to equal spacing;
 * plus aligning and distributing several boxes. Plain maths, so it can be tested.
 */

import type { Rect } from '../engine/shapes';
import type { Point } from './box';

/** A guide line, or a marker showing a gap, in picture pixels. */
export interface Guide {
  kind: 'line' | 'gap';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SnapTargets {
  /** The other objects' boxes. */
  rects: Rect[];
  /** The picture, whose edges and centre lines snap too. Null on a whiteboard, which has no edges. */
  canvas: Rect | null;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

type Axis = 'x' | 'y';

const other = (a: Axis): Axis => (a === 'x' ? 'y' : 'x');
const start = (r: Rect, a: Axis) => (a === 'x' ? r.x : r.y);
const size = (r: Rect, a: Axis) => (a === 'x' ? r.w : r.h);
const end = (r: Rect, a: Axis) => start(r, a) + size(r, a);
const linesOf = (r: Rect, a: Axis) => [start(r, a), start(r, a) + size(r, a) / 2, end(r, a)];

/** True when the two boxes share some of their extent along `a`. */
function overlaps(p: Rect, q: Rect, a: Axis): boolean {
  return start(p, a) < end(q, a) && start(q, a) < end(p, a);
}

/** A segment running along `a` from `from` to `to`, at `at` on the other axis. */
function seg(a: Axis, from: number, to: number, at: number, kind: Guide['kind']): Guide {
  return a === 'x' ? { kind, x1: from, y1: at, x2: to, y2: at } : { kind, x1: at, y1: from, x2: at, y2: to };
}

/** A marker across the gap between p and q along `a`, halfway down the part they share. */
function gapMark(p: Rect, q: Rect, a: Axis): Guide {
  const b = other(a);
  const lo = Math.max(start(p, b), start(q, b));
  const hi = Math.min(end(p, b), end(q, b));
  const at = lo < hi ? (lo + hi) / 2 : (start(p, b) + size(p, b) / 2 + start(q, b) + size(q, b) / 2) / 2;
  return seg(a, end(p, a), start(q, a), at, 'gap');
}

interface Candidate {
  delta: number;
  /** Gap markers to show; edge snaps work theirs out once the box has moved. */
  gaps?: (final: Rect) => Guide[];
}

/** Places along `a` where the box would sit evenly between two others, or at a gap already used in its row. */
function spacingCandidates(r: Rect, rects: Rect[], a: Axis): Candidate[] {
  const b = other(a);
  const row = rects.filter((q) => overlaps(q, r, b));
  const out: Candidate[] = [];
  const w = size(r, a);
  for (const p of row) {
    for (const q of row) {
      if (end(p, a) >= start(q, a)) continue;
      const at = (end(p, a) + start(q, a) - w) / 2;
      if (at < end(p, a) || at + w > start(q, a)) continue;
      out.push({ delta: at - start(r, a), gaps: (f) => [gapMark(p, f, a), gapMark(f, q, a)] });
    }
  }
  const sorted = [...row].sort((p, q) => start(p, a) - start(q, a));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const p = sorted[i];
    const q = sorted[i + 1];
    const g = start(q, a) - end(p, a);
    if (g <= 0) continue;
    for (const t of row) {
      out.push({ delta: end(t, a) + g - start(r, a), gaps: (f) => [gapMark(p, q, a), gapMark(t, f, a)] });
      out.push({ delta: start(t, a) - g - w - start(r, a), gaps: (f) => [gapMark(p, q, a), gapMark(f, t, a)] });
    }
  }
  return out;
}

const withCanvas = (t: SnapTargets): Rect[] => (t.canvas ? [...t.rects, t.canvas] : t.rects);

/** Guide lines through `v` on axis `a`, joining the box to every target with an edge or centre there. */
function lineGuides(a: Axis, v: number, r: Rect, t: SnapTargets): Guide[] {
  const b = other(a);
  const on = withCanvas(t).filter((q) => linesOf(q, a).some((l) => Math.abs(l - v) < 0.5));
  if (!on.length) return [];
  const span = [r, ...on];
  return [seg(b, Math.min(...span.map((q) => start(q, b))), Math.max(...span.map((q) => end(q, b))), v, 'line')];
}

export interface SnapOptions {
  /** The box's lines that snap on each axis (edges being dragged). Leaving one out snaps its edges and centre. */
  xs?: number[];
  ys?: number[];
  /** Also snap to equal spacing (for moves). */
  spacing?: boolean;
}

/** How far to move the box (or the given edges of it) so it lines up with something within `tol` pixels. */
export function snapRect(r: Rect, t: SnapTargets, tol: number, opts: SnapOptions = {}): SnapResult {
  const out: SnapResult = { dx: 0, dy: 0, guides: [] };
  const finals: { a: Axis; best: Candidate; lines: number[] }[] = [];
  for (const a of ['x', 'y'] as Axis[]) {
    const lines = (a === 'x' ? opts.xs : opts.ys) ?? linesOf(r, a);
    const cands: Candidate[] = [];
    const targets = withCanvas(t).flatMap((q) => linesOf(q, a));
    for (const m of lines) for (const v of targets) cands.push({ delta: v - m });
    if (opts.spacing) cands.push(...spacingCandidates(r, t.rects, a));
    let best: Candidate | null = null;
    for (const c of cands) if (Math.abs(c.delta) <= tol && (!best || Math.abs(c.delta) < Math.abs(best.delta) - 1e-9)) best = c;
    if (!best) continue;
    if (a === 'x') out.dx = best.delta;
    else out.dy = best.delta;
    finals.push({ a, best, lines });
  }
  const final = { ...r, x: r.x + out.dx, y: r.y + out.dy };
  for (const { a, best, lines } of finals) {
    if (best.gaps) out.guides.push(...best.gaps(final));
    else for (const m of lines) out.guides.push(...lineGuides(a, m + best.delta, final, t));
  }
  return dedupe(out);
}

/** A point snapped to the edges and centres of the targets. */
export function snapPoint(p: Point, t: SnapTargets, tol: number): SnapResult {
  return snapRect({ x: p.x, y: p.y, w: 0, h: 0 }, t, tol, { xs: [p.x], ys: [p.y] });
}

function dedupe(r: SnapResult): SnapResult {
  const seen = new Set<string>();
  r.guides = r.guides.filter((g) => {
    const k = `${g.kind}${g.x1},${g.y1},${g.x2},${g.y2}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return r;
}

/** Shift: the end of a line turned to the nearest 15° from its start. */
export function snapAngle(from: Point, to: Point): Point {
  const step = Math.PI / 12;
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const a = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
  return { x: from.x + Math.round(Math.cos(a) * len * 1e6) / 1e6, y: from.y + Math.round(Math.sin(a) * len * 1e6) / 1e6 };
}

// ---------- Lining up ----------

export type AlignMode = 'left' | 'hcentre' | 'right' | 'top' | 'vcentre' | 'bottom';

/** How far each box moves to line up with the others: their outer edges, or the middle of all of them. */
export function alignMoves(rects: Rect[], mode: AlignMode): Point[] {
  const x0 = Math.min(...rects.map((r) => r.x));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y0 = Math.min(...rects.map((r) => r.y));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return rects.map((r) => {
    switch (mode) {
      case 'left':
        return { x: x0 - r.x, y: 0 };
      case 'hcentre':
        return { x: (x0 + x1) / 2 - (r.x + r.w / 2), y: 0 };
      case 'right':
        return { x: x1 - (r.x + r.w), y: 0 };
      case 'top':
        return { x: 0, y: y0 - r.y };
      case 'vcentre':
        return { x: 0, y: (y0 + y1) / 2 - (r.y + r.h / 2) };
      case 'bottom':
        return { x: 0, y: y1 - (r.y + r.h) };
    }
  });
}

/** How far each box moves so the gaps between them are equal. The first and last stay where they are. */
export function distributeMoves(rects: Rect[], a: Axis): Point[] {
  const order = rects.map((_, i) => i).sort((i, j) => start(rects[i], a) + size(rects[i], a) / 2 - (start(rects[j], a) + size(rects[j], a) / 2));
  const first = rects[order[0]];
  const last = rects[order[order.length - 1]];
  const total = order.reduce((n, i) => n + size(rects[i], a), 0);
  const gap = (end(last, a) - start(first, a) - total) / Math.max(1, order.length - 1);
  const out: Point[] = rects.map(() => ({ x: 0, y: 0 }));
  let at = start(first, a);
  for (const i of order) {
    const d = at - start(rects[i], a);
    out[i] = a === 'x' ? { x: d, y: 0 } : { x: 0, y: d };
    at += size(rects[i], a) + gap;
  }
  return out;
}
