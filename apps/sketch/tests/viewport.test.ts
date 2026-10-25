import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, Viewport } from '../src/view/viewport';

function view(w = 800, h = 600) {
  const v = new Viewport();
  v.width = w;
  v.height = h;
  return v;
}

describe('Viewport', () => {
  it('keeps the point under the cursor fixed while zooming', () => {
    const v = view();
    v.panX = 37;
    v.panY = -12;
    const before = v.toDoc(300, 200);
    v.zoomBy(2.5, 300, 200);
    const after = v.toDoc(300, 200);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('limits zoom to 2% to 6400%', () => {
    const v = view();
    v.setZoomAt(1000, 0, 0);
    expect(v.zoom).toBe(MAX_ZOOM);
    v.setZoomAt(0.0001, 0, 0);
    expect(v.zoom).toBe(MIN_ZOOM);
  });

  it('fits and centres the picture, not past the max zoom', () => {
    const v = view();
    v.fit(1600, 600);
    expect(v.zoom).toBeCloseTo((800 - 64) / 1600);
    expect(v.panX).toBe(Math.round((800 - 1600 * v.zoom) / 2));
    v.fit(100, 100, 1);
    expect(v.zoom).toBe(1);
    expect(v.panX).toBe(350);
  });

  it('steps through preset zoom levels', () => {
    const v = view();
    v.step(1);
    expect(v.zoom).toBe(1.5);
    v.step(-1);
    v.step(-1);
    expect(v.zoom).toBe(0.667);
  });

  it('keeps some of the picture on screen when panning', () => {
    const v = view();
    v.panX = -10000;
    v.panY = 10000;
    v.clampPan(1000, 1000);
    expect(v.panX).toBe(64 - 1000);
    expect(v.panY).toBe(600 - 64);
  });
});
