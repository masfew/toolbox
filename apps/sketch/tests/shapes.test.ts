import { describe, expect, it } from 'vitest';
import { readObject } from '../src/engine/objects';
import {
  bendToward,
  changeLine,
  changeShape,
  curveAt,
  geometryBounds,
  lineCurve,
  lineMiddle,
  subCurve,
  tFromEnd,
  unitPoints,
  type LineObject,
  type ShapeObject,
} from '../src/engine/shapes';
import { alignMoves, distributeMoves, snapAngle, snapPoint, snapRect, type SnapTargets } from '../src/tools/snap';

const shape: ShapeObject = {
  id: 1,
  type: 'shape',
  kind: 'polygon',
  x: 10,
  y: 20,
  w: 40,
  h: 30,
  angle: 0,
  stroke: '#000000',
  width: 4,
  fill: '#ffffff',
  filled: false,
  dash: 'solid',
  opacity: 1,
  radius: 0,
  sides: 5,
  points: 5,
};

const line: LineObject = {
  id: 2,
  type: 'line',
  x1: 0,
  y1: 0,
  x2: 100,
  y2: 0,
  bend: 0,
  color: '#000000',
  width: 4,
  dash: 'solid',
  opacity: 1,
  start: 'none',
  end: 'filled',
};

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('shapes', () => {
  it('stretches polygon and star corners to fill the box exactly', () => {
    for (const [kind, n] of [['polygon', 5], ['star', 5], ['polygon', 3], ['star', 8]] as const) {
      const pts = unitPoints(kind, n);
      expect(pts).toHaveLength(kind === 'star' ? n * 2 : n);
      close(Math.min(...pts.map((p) => p.x)), -1);
      close(Math.max(...pts.map((p) => p.x)), 1);
      close(Math.min(...pts.map((p) => p.y)), -1);
      close(Math.max(...pts.map((p) => p.y)), 1);
    }
    // The first corner points straight up.
    close(unitPoints('polygon', 5)[0].y, -1);
  });

  it('moves and turns shapes with the picture', () => {
    expect(changeShape(shape, { kind: 'offset', dx: 5, dy: -5 })).toMatchObject({ x: 15, y: 15 });
    expect(changeShape(shape, { kind: 'scale', sx: 2, sy: 2 })).toMatchObject({ x: 20, y: 40, w: 80, h: 60, width: 8 });
    // Centre (30, 35) in a 100 × 60 picture turned right goes to (60 - 35, 30) = (25, 30).
    const r = changeShape(shape, { kind: 'rotate', dir: 1, width: 100, height: 60 });
    close(r.x + r.w / 2, 25);
    close(r.y + r.h / 2, 30);
    close(r.angle, Math.PI / 2);
    const back = changeShape(r, { kind: 'rotate', dir: -1, width: 60, height: 100 });
    close(back.x, 10);
    close(back.y, 20);
    expect(back.angle).toBe(0);
  });

  it('turns a flipped polygon upside down on a vertical flip only', () => {
    const h = changeShape(shape, { kind: 'flip', axis: 'h', width: 100, height: 60 });
    expect(h).toMatchObject({ x: 50, y: 20, angle: 0 });
    const v = changeShape(shape, { kind: 'flip', axis: 'v', width: 100, height: 60 });
    expect(v).toMatchObject({ x: 10, y: 10, angle: Math.PI });
  });

  it('measures a turned shape by its corners', () => {
    const b = geometryBounds({ ...shape, x: 0, y: 0, w: 20, h: 10, angle: Math.PI / 2 });
    close(b.x, 5);
    close(b.y, -5);
    close(b.w, 10);
    close(b.h, 20);
  });
});

describe('lines', () => {
  it('bends through the middle handle', () => {
    const bent = { ...line, bend: 20 };
    const m = lineMiddle(bent);
    close(m.x, 50);
    // Bending left of a line pointing right is up the screen.
    close(m.y, -20);
    close(bendToward(line, m), 20);
    close(bendToward(line, { x: 30, y: 15 }), -15);
  });

  it('cuts a piece out of the curve', () => {
    const k = lineCurve({ ...line, bend: 30 });
    const part = subCurve(k, 0.25, 0.75);
    const a = curveAt(k, 0.25);
    const b = curveAt(k, 0.75);
    close(part.p0.x, a.x);
    close(part.p0.y, a.y);
    close(part.p2.x, b.x);
    close(part.p2.y, b.y);
    const mid = curveAt(part, 0.5);
    close(mid.x, curveAt(k, 0.5).x);
    close(mid.y, curveAt(k, 0.5).y);
  });

  it('finds the point a set distance from an end', () => {
    const k = lineCurve(line);
    close(tFromEnd(k, 10, true), 0.9);
    close(tFromEnd(k, 25, false), 0.25);
    // A line shorter than the distance isn't cut.
    expect(tFromEnd(lineCurve({ ...line, x2: 5 }), 10, true)).toBe(1);
  });

  it('mirrors its bend when the picture flips', () => {
    const f = changeLine({ ...line, bend: 12 }, { kind: 'flip', axis: 'h', width: 200, height: 50 });
    expect(f).toMatchObject({ x1: 200, x2: 100, bend: -12 });
    const r = changeLine({ ...line, bend: 12 }, { kind: 'rotate', dir: 1, width: 200, height: 50 });
    expect(r).toMatchObject({ x1: 50, y1: 0, x2: 50, y2: 100, bend: 12 });
  });

  it('snaps an angle to 15° steps', () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 100, y: 8 });
    close(p.y, 0);
    close(p.x, Math.hypot(100, 8));
    const q = snapAngle({ x: 0, y: 0 }, { x: 50, y: 52 });
    close(q.x, q.y);
  });
});

describe('reading shapes from files', () => {
  it('fills in what is missing and drops what it does not know', () => {
    expect(readObject({ type: 'shape', kind: 'star', id: 7, x: 1 })).toMatchObject({ id: 7, kind: 'star', x: 1, w: 1, points: 5, dash: 'solid' });
    expect(readObject({ type: 'shape', kind: 'blob' })).toBeNull();
    expect(readObject({ type: 'line', id: 3, end: 'filled', start: 'banana', opacity: 4 })).toMatchObject({ start: 'none', end: 'filled', opacity: 1, width: 4 });
  });
});

describe('snapping', () => {
  const canvas = { x: 0, y: 0, w: 400, h: 300 };
  const targets: SnapTargets = { rects: [{ x: 100, y: 100, w: 50, h: 50 }], canvas };

  it('snaps edges and centres to other boxes within the tolerance', () => {
    // Left edge at 102 snaps to the target's left edge at 100.
    const s = snapRect({ x: 102, y: 200, w: 30, h: 20 }, targets, 6);
    expect(s.dx).toBe(-2);
    expect(s.dy).toBe(0);
    expect(s.guides).toContainEqual({ kind: 'line', x1: 100, y1: 100, x2: 100, y2: 220 });
    // Too far: no snap.
    expect(snapRect({ x: 160, y: 200, w: 20, h: 20 }, targets, 6).dx).toBe(0);
  });

  it('snaps to the picture centre', () => {
    const s = snapRect({ x: 188, y: 10, w: 20, h: 20 }, { rects: [], canvas }, 6);
    expect(s.dx).toBe(2);
  });

  it('snaps only the edges being dragged when resizing', () => {
    const s = snapRect({ x: 20, y: 20, w: 82, h: 10 }, targets, 6, { xs: [102], ys: [] });
    expect(s.dx).toBe(-2);
    expect(s.dy).toBe(0);
  });

  it('snaps to sit evenly between two boxes', () => {
    const row: SnapTargets = {
      rects: [
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 100, y: 0, w: 10, h: 10 },
      ],
      canvas: { x: 0, y: 0, w: 1000, h: 1000 },
    };
    const s = snapRect({ x: 47, y: 0, w: 10, h: 10 }, row, 6, { spacing: true });
    // Gaps of 40 on each side puts it at 50.
    expect(s.dx).toBe(3);
    expect(s.guides.filter((g) => g.kind === 'gap')).toHaveLength(2);
  });

  it('snaps to a gap already used in the row', () => {
    const row: SnapTargets = {
      rects: [
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 30, y: 0, w: 10, h: 10 },
      ],
      canvas: { x: 0, y: 0, w: 1000, h: 1000 },
    };
    // The gap is 20, so the next box sits at 60.
    expect(snapRect({ x: 62, y: 0, w: 10, h: 10 }, row, 6, { spacing: true }).dx).toBe(-2);
  });

  it('snaps a point', () => {
    const s = snapPoint({ x: 148, y: 123 }, targets, 6);
    expect(s.dx).toBe(2);
    expect(s.dy).toBe(2);
  });
});

describe('lining up', () => {
  const rects = [
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 50, y: 20, w: 20, h: 40 },
    { x: 200, y: 5, w: 30, h: 10 },
  ];

  it('aligns to the outer edges or the middle of the group', () => {
    expect(alignMoves(rects, 'left').map((d) => d.x)).toEqual([0, -50, -200]);
    expect(alignMoves(rects, 'right').map((d) => d.x)).toEqual([220, 160, 0]);
    expect(alignMoves(rects, 'vcentre').map((d) => d.y)).toEqual([25, -10, 20]);
  });

  it('spaces boxes evenly between the first and last', () => {
    const moves = distributeMoves(rects, 'x');
    // 230 wide in all, 60 of boxes, so gaps of 85: the middle box starts at 95.
    expect(moves.map((d) => d.x)).toEqual([0, 45, 0]);
  });
});
