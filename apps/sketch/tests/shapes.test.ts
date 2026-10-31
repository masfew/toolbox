import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readObject, writeObject } from '../src/engine/objects';
import {
  bendToward,
  changeLine,
  changeShape,
  curveAt,
  geometryBounds,
  hasFill,
  hitShape,
  lineCurve,
  lineMiddle,
  subCurve,
  tFromEnd,
  unitPoints,
  type LineObject,
  type ShapeObject,
} from '../src/engine/shapes';
import { alignMoves, distributeMoves, snapAngle, snapPoint, snapRect, type SnapTargets } from '../src/tools/snap';
import { installFakeCanvas } from './fakeCanvas';

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
  fill: '#ffffff00',
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

describe('a fill is a colour with an opacity', () => {
  it('reads a shape saved unfilled as its fill colour with no opacity', () => {
    expect(readObject({ type: 'shape', kind: 'rectangle', id: 1, fill: '#ff0000', filled: false })).toMatchObject({ fill: '#ff000000' });
    // Files from before the flag existed, and ones with junk in it, read as unfilled too.
    expect(readObject({ type: 'shape', kind: 'rectangle', id: 1, fill: '#00ff00' })).toMatchObject({ fill: '#00ff0000' });
    expect(readObject({ type: 'shape', kind: 'rectangle', id: 1, fill: '#00ff00', filled: 'yes' })).toMatchObject({ fill: '#00ff0000' });
    expect(readObject({ type: 'shape', kind: 'rectangle', id: 1, filled: false })).toMatchObject({ fill: '#ffffff00' });
    const hollow = readObject({ type: 'shape', kind: 'rectangle', id: 1, fill: '#ff0000', filled: false }) as ShapeObject;
    expect(hasFill(hollow)).toBe(false);
    expect(hollow).not.toHaveProperty('filled');
  });

  it('keeps the fill of a shape saved filled', () => {
    const o = readObject({ type: 'shape', kind: 'ellipse', id: 2, fill: '#ff0000', filled: true }) as ShapeObject;
    expect(o.fill).toBe('#ff0000');
    expect(hasFill(o)).toBe(true);
    // A translucent fill still shows.
    expect(hasFill({ ...o, fill: '#ff000080' })).toBe(true);
    expect(hasFill({ ...o, fill: '#ff000000' })).toBe(false);
  });

  it('writes the filled flag older Sketches read: true unless the fill is see-through', () => {
    expect(writeObject({ ...shape, fill: '#ff0000' })).toMatchObject({ fill: '#ff0000', filled: true });
    expect(writeObject({ ...shape, fill: '#ff000080' })).toMatchObject({ filled: true });
    expect(writeObject({ ...shape, fill: '#ff000000' })).toMatchObject({ fill: '#ff000000', filled: false });
    // Lines and the rest are written as they are.
    expect(writeObject(line)).toBe(line);
    const back = readObject(JSON.parse(JSON.stringify(writeObject({ ...shape, fill: '#ff0000' }))));
    expect(back).toEqual({ ...shape, fill: '#ff0000' });
  });

  it('hits the inside of a shape only when its fill shows', () => {
    // A canvas that says every point is inside the path and none is on its stroke, so only the fill rule decides.
    class Path {
      [key: string]: unknown;
      constructor() {
        return new Proxy(this, { get: (t, k) => (k in t ? t[k as string] : () => {}) });
      }
    }
    vi.stubGlobal('Path2D', Path);
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { lineWidth: 1, isPointInPath: () => true, isPointInStroke: () => false };
        }
      },
    );
    try {
      expect(hitShape({ ...shape, fill: '#ffffff00' }, 30, 35, 6)).toBe(false);
      expect(hitShape({ ...shape, fill: '#ffffff' }, 30, 35, 6)).toBe(true);
      expect(hitShape({ ...shape, fill: '#ffffff40' }, 30, 35, 6)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('shapes and lines keep their own fill and outline colours', () => {
  let store: typeof import('../src/app/store');
  let tools: typeof import('../src/tools/shapes');
  let actions: typeof import('../src/app/actions');
  let toolState: typeof import('../src/app/tools');
  const ev = (button = 0) => ({ button, shiftKey: false, altKey: false, ctrlKey: true }) as PointerEvent;

  beforeAll(async () => {
    installFakeCanvas();
    // The page's timers, for the settings the tools save.
    vi.stubGlobal('window', globalThis);
    store = await import('../src/app/store');
    tools = await import('../src/tools/shapes');
    actions = await import('../src/app/actions');
    toolState = await import('../src/app/tools');
  });
  afterAll(() => vi.unstubAllGlobals());

  beforeEach(() => {
    const { app } = store;
    app.doc.activeLayer.objects = [];
    app.objectSel = null;
    app.draft = null;
    app.primary = '#112233';
    app.secondary = '#445566';
    tools.loadShapeColors({ fill: '#ffffff00', outline: '#000000' });
    toolState.selectTool('rectangle');
  });

  /** Drags a shape or line out with the given button and returns what was added. */
  function draw(toolId: string, button = 0): ShapeObject {
    const e = ev(button);
    const d = tools.SHAPE_TOOLS.includes(toolId) ? tools.shapeDrag(toolId, { x: 100, y: 100 }, e, () => {}) : tools.lineDrag(toolId, { x: 100, y: 100 }, e);
    d.move({ x: 300, y: 250 }, e, () => ({ x: 0, y: 0 }));
    d.up({ x: 300, y: 250 }, e);
    // A line is checked through toMatchObject; only its id is read as a shape's.
    return store.app.doc.activeLayer.objects.at(-1) as ShapeObject;
  }
  const objects = () => store.app.doc.activeLayer.objects;

  it('draws a new shape in the stored outline and fill, not colours 1 and 2', () => {
    // Out of the box: a black outline, no fill.
    const first = draw('rectangle');
    expect(first).toMatchObject({ type: 'shape', stroke: '#000000' });
    expect(hasFill(first)).toBe(false);
    tools.loadShapeColors({ fill: '#aabbcc', outline: '#ff0000' });
    const second = draw('star');
    expect(second).toMatchObject({ stroke: '#ff0000', fill: '#aabbcc' });
    expect(second).not.toHaveProperty('filled');
  });

  it('draws with the two swapped on a right-drag', () => {
    tools.loadShapeColors({ fill: '#aabbcc', outline: '#ff0000' });
    expect(draw('ellipse', 2)).toMatchObject({ stroke: '#aabbcc', fill: '#ff0000' });
    // With the default no fill, the swap fills the shape with the outline colour and leaves it with no outline.
    tools.loadShapeColors({ fill: '#ffffff00', outline: '#000000' });
    const s = draw('rectangle', 2);
    expect(s.fill).toBe('#000000');
    expect(hasFill(s)).toBe(true);
    expect(s.stroke).toBe('#ffffff00');
  });

  it('draws a line in the outline colour, and on a right-drag in the fill colour unless that is see-through', () => {
    tools.loadShapeColors({ fill: '#aabbcc', outline: '#ff0000' });
    expect(draw('line')).toMatchObject({ type: 'line', color: '#ff0000' });
    expect(draw('arrow', 2)).toMatchObject({ color: '#aabbcc' });
    // No fill: the right-drag line would be invisible, so it uses the outline colour.
    tools.loadShapeColors({ fill: '#aabbcc00' });
    expect(draw('line', 2)).toMatchObject({ color: '#ff0000' });
  });

  it('leaves colours 1 and 2 alone, and shapes ignore them', () => {
    draw('rectangle');
    expect(store.app.primary).toBe('#112233');
    expect(store.app.secondary).toBe('#445566');
    store.app.primary = '#abcdef';
    store.colorSignal.emit();
    expect(objects()[0]).toMatchObject({ stroke: '#000000' });
  });

  it('restyles picked shapes and lines when the fill or outline changes, in one history step', () => {
    const { app } = store;
    const rect = draw('rectangle');
    const ln = draw('line');
    tools.pickObjects(app.doc.activeLayer, [rect.id, ln.id]);
    const before = app.history.position;
    actions.setShapeColor('fill', '#00ff00');
    actions.setShapeColor('outline', '#0000ff');
    const [r, l] = objects() as [ShapeObject, LineObject];
    expect(r).toMatchObject({ fill: '#00ff00', stroke: '#0000ff' });
    // The outline is a line's colour; the fill leaves it alone.
    expect(l.color).toBe('#0000ff');
    // The two drags join into one step.
    expect(app.history.position).toBe(before + 1);
  });

  it("shows a picked shape's colours in the bar without restyling anything", () => {
    const { app } = store;
    const a = draw('rectangle');
    tools.loadShapeColors({ fill: '#123456', outline: '#654321' });
    const b = draw('ellipse');
    tools.pickObjects(app.doc.activeLayer, [a.id]);
    const before = app.history.position;
    // The first rectangle was drawn in the defaults; picking it loads those.
    expect([app.fillColor, app.outlineColor]).toEqual(['#ffffff00', '#000000']);
    tools.pickObjects(app.doc.activeLayer, [b.id, a.id]);
    expect([app.fillColor, app.outlineColor]).toEqual(['#123456', '#654321']);
    expect(objects()).toEqual([a, b]);
    expect(app.history.position).toBe(before);
    // Picking a line loads its colour as the outline and leaves the fill.
    tools.loadShapeColors({ outline: '#00ff00' });
    const ln = draw('line');
    tools.loadShapeColors({ fill: '#999999', outline: '#111111' });
    tools.pickObjects(app.doc.activeLayer, [ln.id]);
    expect([app.fillColor, app.outlineColor]).toEqual(['#999999', '#00ff00']);
    expect(objects()).toHaveLength(3);
  });

  it('still recolours a picked numbered marker with colour 1, and nothing else', () => {
    const { app } = store;
    const rect = draw('rectangle');
    const marker = readObject({ type: 'mark', kind: 'marker', id: 900, x: 5, y: 5, w: 28, h: 28, number: 1, color: '#ff0000' })!;
    app.doc.activeLayer.objects = [...objects(), marker];
    tools.pickObjects(app.doc.activeLayer, [marker.id, rect.id]);
    const before = app.history.position;
    app.primary = '#00aa00';
    store.colorSignal.emit();
    expect(objects()).toMatchObject([{ stroke: '#000000' }, { kind: 'marker', color: '#00aa00' }]);
    expect(app.history.position).toBe(before + 1);
    // The fill colour doesn't touch a marker.
    actions.setShapeColor('fill', '#ff00ff');
    expect(objects()[1]).toMatchObject({ color: '#00aa00' });
  });

  it('X swaps the fill and outline while a shape tool shows them, else colours 1 and 2', () => {
    const { app } = store;
    tools.loadShapeColors({ fill: '#aabbcc', outline: '#ff0000' });
    actions.swapColors();
    expect([app.fillColor, app.outlineColor]).toEqual(['#ff0000', '#aabbcc']);
    expect([app.primary, app.secondary]).toEqual(['#112233', '#445566']);
    toolState.selectTool('brush');
    actions.swapColors();
    expect([app.primary, app.secondary]).toEqual(['#445566', '#112233']);
    expect([app.fillColor, app.outlineColor]).toEqual(['#ff0000', '#aabbcc']);
    // With a shape picked it restyles the shape, in one step.
    toolState.selectTool('rectangle');
    const rect = draw('rectangle');
    tools.pickObjects(app.doc.activeLayer, [rect.id]);
    const before = app.history.position;
    actions.swapColors();
    expect(objects()[0]).toMatchObject({ stroke: '#ff0000', fill: '#aabbcc' });
    expect(app.history.position).toBe(before + 1);
  });

  it("sets a capture's red as the outline without restyling the picked shapes", () => {
    const { app } = store;
    const rect = draw('rectangle');
    tools.pickObjects(app.doc.activeLayer, [rect.id]);
    const before = app.history.position;
    tools.loadShapeColors({ outline: actions.CAPTURE_COLOR });
    expect(app.outlineColor).toBe('#ed1c24');
    expect(objects()[0]).toMatchObject({ stroke: '#000000' });
    expect(app.history.position).toBe(before);
    // The next real change restyles only what changed.
    actions.setShapeColor('fill', '#00ff00');
    expect(objects()[0]).toMatchObject({ stroke: '#000000', fill: '#00ff00' });
  });
});
