import { describe, expect, it } from 'vitest';
import { croppedMask, fillRegion, floodRegion } from '../src/engine/flood';
import { changeObject, tidyAngle, wrapLines, type TextObject } from '../src/engine/objects';
import { clearColor, linePixels, maskOutline, trimBounds } from '../src/engine/pixels';
import { boundsOf, handleCursor, handlePoint, resizeBox, rotateBox, toLocal, type Box } from '../src/tools/box';

/** A w × h picture of one colour, with `paint` setting chosen pixels. */
function picture(w: number, h: number, bg: number[], paint: (set: (x: number, y: number, c: number[]) => void) => void = () => {}) {
  const d = new Uint8ClampedArray(w * h * 4);
  const set = (x: number, y: number, c: number[]) => d.set(c, (y * w + x) * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, bg);
  paint(set);
  return d;
}
const px = (d: Uint8ClampedArray, w: number, x: number, y: number) => [...d.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];

const WHITE = [255, 255, 255, 255];
const BLACK = [0, 0, 0, 255];
const RED = [255, 0, 0, 255];

describe('flood fill', () => {
  // A white picture split down the middle by a black line at x = 4.
  const split = () => picture(9, 5, WHITE, (set) => {
    for (let y = 0; y < 5; y++) set(4, y, BLACK);
  });

  it('fills the connected area and stops at a line', () => {
    const d = split();
    const r = floodRegion(d, 9, 5, 1, 1, 0, false)!;
    expect(r.x0).toBe(0);
    expect(r.x1).toBe(3);
    expect(r.mask[1 * 9 + 6]).toBe(0);
  });

  it('fills every matching pixel with "all matching"', () => {
    const r = floodRegion(split(), 9, 5, 1, 1, 0, true)!;
    expect(r.x1).toBe(8);
    expect(r.mask[4]).toBe(0);
  });

  it('takes pixels within the tolerance', () => {
    const d = picture(4, 1, WHITE, (set) => set(2, 0, [230, 230, 230, 255]));
    expect(floodRegion(d, 4, 1, 0, 0, 0, false)!.x1).toBe(1);
    expect(floodRegion(d, 4, 1, 0, 0, 0.1, false)!.x1).toBe(3);
  });

  it('counts every see-through pixel as the same colour', () => {
    const d = picture(3, 1, [0, 0, 0, 0], (set) => set(1, 0, [255, 0, 0, 0]));
    expect(floodRegion(d, 3, 1, 0, 0, 0, false)!.x1).toBe(2);
  });

  it("doesn't leak through a thin line into the area beyond", () => {
    const d = split();
    const r = floodRegion(d, 9, 5, 1, 1, 0.16, false)!;
    fillRegion(d, d, 9, 5, r, [255, 0, 0, 255], 0.16);
    expect(px(d, 9, 1, 1)).toEqual(RED);
    expect(px(d, 9, 4, 1)).toEqual(BLACK);
    expect(px(d, 9, 5, 1)).toEqual(WHITE);
    expect(px(d, 9, 6, 1)).toEqual(WHITE);
  });

  it('swaps the old colour in soft line edges for the fill colour, leaving no fringe', () => {
    // White, then a half-covered grey edge pixel, then the black line.
    const d = picture(6, 1, WHITE, (set) => {
      set(3, 0, [128, 128, 128, 255]);
      set(4, 0, BLACK);
      set(5, 0, BLACK);
    });
    const r = floodRegion(d, 6, 1, 0, 0, 0.16, false)!;
    fillRegion(d, d, 6, 1, r, [255, 0, 0, 255], 0.16);
    // Half line, half fill: dark red, not pink.
    const [red, green, blue] = px(d, 6, 3, 0);
    expect(red).toBeGreaterThan(120);
    expect(red).toBeLessThan(136);
    expect(green).toBeLessThan(4);
    expect(blue).toBeLessThan(4);
    expect(px(d, 6, 4, 0)).toEqual(BLACK);
  });

  it('cuts a mask down to the area', () => {
    const d = picture(5, 5, WHITE, (set) => set(2, 2, BLACK));
    const m = croppedMask(floodRegion(d, 5, 5, 2, 2, 0, false)!, 5);
    expect(m).toMatchObject({ x: 2, y: 2, w: 1, h: 1 });
    expect([...m.mask]).toEqual([1]);
  });
});

describe('pixel helpers', () => {
  it('trims a flat border', () => {
    const d = picture(6, 4, WHITE, (set) => {
      set(2, 1, RED);
      set(3, 2, RED);
    });
    expect(trimBounds(d, 6, 4)).toEqual({ x: 2, y: 1, w: 2, h: 2 });
    expect(trimBounds(picture(3, 3, WHITE), 3, 3)).toBeNull();
  });

  it('trims a see-through border whatever its hidden colour', () => {
    const d = picture(4, 1, [0, 0, 0, 0], (set) => {
      set(1, 0, RED);
      set(3, 0, [255, 255, 255, 0]);
    });
    expect(trimBounds(d, 4, 1)).toEqual({ x: 1, y: 0, w: 1, h: 1 });
  });

  it('draws lines pixel by pixel, ends included', () => {
    const pts: string[] = [];
    linePixels(0, 0, 3, 1, (x, y) => pts.push(`${x},${y}`));
    expect(pts[0]).toBe('0,0');
    expect(pts.at(-1)).toBe('3,1');
    expect(pts).toHaveLength(4);
  });

  it('makes one colour see-through', () => {
    const d = picture(2, 1, WHITE, (set) => set(1, 0, RED));
    expect(clearColor(d, 255, 255, 255)).toBe(1);
    expect(d[3]).toBe(0);
    expect(d[7]).toBe(255);
  });

  it('outlines a mask along pixel edges', () => {
    const segs = maskOutline(new Uint8Array([1, 1, 0, 1]), 2, 2);
    const length = segs.reduce((n, [x0, y0, x1, y1]) => n + Math.abs(x1 - x0) + Math.abs(y1 - y0), 0);
    expect(length).toBe(8);
  });
});

describe('transform box', () => {
  const box: Box = { x: 10, y: 20, w: 100, h: 50, angle: 0 };

  it('keeps the opposite corner still when a corner is dragged', () => {
    const b = resizeBox(box, 'se', { x: 150, y: 90 }, { round: true });
    expect(b).toEqual({ x: 10, y: 20, w: 140, h: 70, angle: 0 });
    const c = resizeBox(box, 'nw', { x: 0, y: 0 }, { round: true });
    expect(c).toEqual({ x: 0, y: 0, w: 110, h: 70, angle: 0 });
  });

  it('keeps the shape with Shift, or a set ratio', () => {
    const b = resizeBox(box, 'se', { x: 210, y: 30 }, { ratio: 2, round: true });
    expect(b.w / b.h).toBe(2);
    expect(b.w).toBe(200);
    const e = resizeBox(box, 'e', { x: 160, y: 0 }, { ratio: 2, round: true });
    expect(e).toMatchObject({ w: 150, h: 75 });
  });

  it('resizes a turned box along its own sides', () => {
    const turned: Box = { ...box, angle: Math.PI / 2 };
    const east = handlePoint(turned, 'e');
    const b = resizeBox(turned, 'e', { x: east.x, y: east.y + 20 });
    expect(b.w).toBeCloseTo(120);
    expect(b.h).toBeCloseTo(50);
    // The west edge stays put.
    const w0 = handlePoint(turned, 'w');
    const w1 = handlePoint(b, 'w');
    expect(w1.x).toBeCloseTo(w0.x);
    expect(w1.y).toBeCloseTo(w0.y);
  });

  it('turns with the pointer, snapping to 15° with Shift', () => {
    const c = { x: 60, y: 45 };
    const b = rotateBox(box, { x: 160, y: 45 }, { x: 60, y: 145 }, false);
    expect(b.angle).toBeCloseTo(Math.PI / 2);
    const s = rotateBox(box, { x: 160, y: 45 }, { x: c.x + 100 * Math.cos(0.3), y: c.y + 100 * Math.sin(0.3) }, true);
    expect(s.angle).toBeCloseTo(Math.PI / 12);
  });

  it('maps points into the box and finds its bounds', () => {
    const turned: Box = { ...box, angle: Math.PI / 2 };
    const l = toLocal(turned, 60, 95);
    expect(l.x).toBeCloseTo(50);
    expect(l.y).toBeCloseTo(0);
    expect(boundsOf(turned)).toEqual({ x: 35, y: -5, w: 50, h: 100 });
  });

  it('turns the resize cursors with the box', () => {
    expect(handleCursor(box, 'e')).toBe('ew-resize');
    expect(handleCursor(box, 'se')).toBe('nwse-resize');
    expect(handleCursor({ ...box, angle: Math.PI / 2 }, 'e')).toBe('ns-resize');
  });
});

describe('text', () => {
  const measure = (s: string) => s.length * 10;

  it('keeps lines as typed when the box grows with the text', () => {
    expect(wrapLines('one two\nthree', null, measure)).toEqual(['one two', 'three']);
  });

  it('wraps between words, and breaks words too long for the line', () => {
    expect(wrapLines('one two three', 80, measure)).toEqual(['one two', 'three']);
    expect(wrapLines('abcdefghij', 40, measure)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapLines('', 40, measure)).toEqual(['']);
  });

  const text: TextObject = {
    id: 1,
    type: 'text',
    x: 10,
    y: 20,
    width: null,
    angle: 0,
    text: 'Hi',
    font: 'Segoe UI',
    size: 20,
    bold: false,
    italic: false,
    align: 'left',
    color: '#000000',
    accent: '#ffffff',
    outline: false,
    box: false,
        tail: null,
  };

  it('moves and turns text with the picture', () => {
    expect(changeObject(text, { kind: 'offset', dx: -5, dy: 5 })).toMatchObject({ x: 5, y: 25 });
    expect(changeObject(text, { kind: 'scale', sx: 2, sy: 2 })).toMatchObject({ x: 20, y: 40, size: 40 });
    const right = changeObject(text, { kind: 'rotate', dir: 1, width: 100, height: 50 });
    expect(right).toMatchObject({ x: 30, y: 10, angle: Math.PI / 2 });
    const back = changeObject(right, { kind: 'rotate', dir: -1, width: 50, height: 100 });
    expect(back).toMatchObject({ x: 10, y: 20, angle: 0 });
  });

  it('mirrors where text sits on a flip but keeps it readable', () => {
    const f = changeObject(text, { kind: 'flip', axis: 'h', width: 100, height: 50 }, { w: 30, h: 25 });
    expect(f).toMatchObject({ x: 60, y: 20, angle: 0 });
  });

  it('keeps angles tidy', () => {
    expect(tidyAngle(Math.PI * 2)).toBe(0);
    expect(tidyAngle(-Math.PI / 2 + 1e-12)).toBe(-Math.PI / 2);
  });
});
