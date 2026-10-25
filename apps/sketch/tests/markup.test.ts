import { describe, expect, it } from 'vitest';
import { applyLevels, filterFor, isNoChange, levelsOf } from '../src/engine/adjust';
import { blurRadius, changeMark, numberColor, pathBox, pathPoints, readMark, renumbered, type MarkObject } from '../src/engine/marks';
import { changeObject, readObject, type TextObject } from '../src/engine/objects';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

function mark(extra: Partial<MarkObject>): MarkObject {
  return readMark({ kind: 'highlight', x: 10, y: 20, w: 100, h: 40, ...extra }, 1)!;
}

describe('mark-up', () => {
  it('keeps a highlighter stroke inside a box that has height even when the stroke is straight', () => {
    const b = pathBox(
      [
        { x: 10, y: 50 },
        { x: 110, y: 50 },
      ],
      20,
    );
    expect(b).toMatchObject({ x: 0, y: 40, w: 120, h: 20 });
    expect(b.path).toEqual([
      { x: 10 / 120, y: 0.5 },
      { x: 110 / 120, y: 0.5 },
    ]);
    const pts = pathPoints({ ...mark({}), ...b });
    close(pts[0].x, 10);
    close(pts[1].x, 110);
    close(pts[1].y, 50);
  });

  it('mirrors the highlighter path when the picture flips, so the stroke lands where the mirror puts it', () => {
    const b = pathBox(
      [
        { x: 20, y: 30 },
        { x: 80, y: 70 },
      ],
      10,
    );
    const m = { ...mark({}), ...b };
    const flipped = changeMark(m, { kind: 'flip', axis: 'h', width: 200, height: 100 });
    const pts = pathPoints(flipped);
    close(pts[0].x, 180);
    close(pts[0].y, 30);
    close(pts[1].x, 120);
    close(pts[1].y, 70);
    const down = pathPoints(changeMark(m, { kind: 'flip', axis: 'v', width: 200, height: 100 }));
    close(down[0].y, 70);
    close(down[1].y, 30);
  });

  it('turns marks with the picture and scales their sizes', () => {
    const m = mark({ kind: 'pixelate', block: 10 });
    const r = changeMark(m, { kind: 'rotate', dir: 1, width: 300, height: 200 });
    close(r.angle, Math.PI / 2);
    // The centre (60, 40) goes to (200 - 40, 60).
    close(r.x + r.w / 2, 160);
    close(r.y + r.h / 2, 60);
    expect(changeMark(m, { kind: 'scale', sx: 2, sy: 2 }).block).toBe(20);
  });

  it('renumbers the markers after deleted ones', () => {
    const ms = [1, 2, 3, 4, 5].map((n) => mark({ kind: 'marker', number: n, id: n }));
    ms.forEach((m, i) => (m.id = i + 1));
    const kept = ms.filter((m) => m.number !== 2 && m.number !== 4);
    const numbers = renumbered(kept, [2, 4]);
    expect(kept.map((m) => numbers.get(m.id) ?? m.number)).toEqual([1, 2, 3]);
  });

  it('picks a readable number colour', () => {
    expect(numberColor('#000000')).toBe('#ffffff');
    expect(numberColor('#e53935')).toBe('#ffffff');
    expect(numberColor('#ffe94d')).toBe('#000000');
  });

  it('blurs small text away even at the lowest strength', () => {
    expect(blurRadius(10)).toBeGreaterThanOrEqual(3.5);
    expect(blurRadius(70)).toBeGreaterThan(14);
  });

  it('reads marks and callouts back from a file, filling in what is missing', () => {
    const m = readMark({ kind: 'blur', x: 1, y: 2, w: 0, h: 5, strength: 500 }, 7)!;
    expect(m).toMatchObject({ id: 7, w: 1, h: 5, strength: 100, block: 14, dim: 60, round: false });
    expect(readMark({ kind: 'sparkle' }, 1)).toBeNull();
    const t = readObject({ type: 'text', id: 3, text: 'Hi', tail: { x: 5, y: 6 } }) as TextObject;
    expect(t.tail).toEqual({ x: 5, y: 6 });
    expect((readObject({ type: 'text', id: 4, text: 'Hi' }) as TextObject).tail).toBeNull();
  });

  it('keeps a callout pointing at the same spot when the picture changes', () => {
    const t = readObject({ type: 'text', id: 3, x: 10, y: 10, text: 'Hi', tail: { x: 50, y: 60 } }) as TextObject;
    const moved = changeObject(t, { kind: 'offset', dx: 5, dy: -5 }) as TextObject;
    expect(moved.tail).toEqual({ x: 55, y: 55 });
    const turned = changeObject(t, { kind: 'rotate', dir: 1, width: 200, height: 100 }) as TextObject;
    expect(turned.tail).toEqual({ x: 40, y: 50 });
  });
});

describe('adjustments', () => {
  it('builds canvas filters from the sliders', () => {
    expect(filterFor({ kind: 'brightness', brightness: 20, contrast: -50 })).toBe('brightness(1.2) contrast(0.5)');
    expect(filterFor({ kind: 'hue', hue: 90, saturation: -100 })).toBe('hue-rotate(90deg) saturate(0)');
    expect(isNoChange({ kind: 'hue', hue: 0, saturation: 0 })).toBe(true);
    expect(isNoChange({ kind: 'invert' })).toBe(false);
  });

  it('finds levels without a few stray pixels or see-through ones', () => {
    const n = 1000;
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const v = 60 + Math.round((i / (n - 1)) * 100);
      data.set([v, v, v, 255], i * 4);
    }
    // One black and one white pixel don't count; a see-through pixel doesn't either.
    data.set([0, 0, 0, 255], 0);
    data.set([255, 255, 255, 255], 4);
    data.set([255, 0, 0, 0], 8);
    const l = levelsOf(data)!;
    expect(l.lo[0]).toBeGreaterThanOrEqual(60);
    expect(l.lo[0]).toBeLessThanOrEqual(62);
    expect(l.hi[0]).toBeLessThanOrEqual(160);
    expect(l.hi[0]).toBeGreaterThanOrEqual(158);
    expect(levelsOf(new Uint8ClampedArray(8))).toBeNull();
  });

  it('stretches levels to full range and leaves flat channels alone', () => {
    const data = new Uint8ClampedArray([60, 100, 100, 255, 160, 100, 101, 255]);
    applyLevels(data, [60, 100, 100], [160, 100, 101]);
    expect([...data]).toEqual([0, 100, 100, 255, 255, 100, 101, 255]);
  });
});
