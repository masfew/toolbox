import { describe, expect, it } from 'vitest';
import { TILE, tileRange, tileRect } from '../src/engine/tiles';

describe('tileRange', () => {
  it('covers every tile a rectangle touches', () => {
    expect(tileRange(250, 10, 20, 10, 1000, 1000)).toEqual({ x0: 0, y0: 0, x1: 1, y1: 0 });
    expect(tileRange(0, 0, TILE, TILE, 1000, 1000)).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });

  it('clamps to the canvas', () => {
    expect(tileRange(-50, -50, 2000, 2000, 600, 300)).toEqual({ x0: 0, y0: 0, x1: 2, y1: 1 });
  });

  it('is empty for rectangles off the canvas', () => {
    const r = tileRange(700, 0, 10, 10, 600, 300);
    expect(r.x1 < r.x0).toBe(true);
  });

  it('gives edge tiles their real size', () => {
    expect(tileRect(600, 300, 2, 1)).toEqual({ x: 512, y: 256, w: 88, h: 44 });
  });
});
