import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPref } from '../src/app/prefs';
import {
  CIRCLE_TOOLS,
  CROSS_SIZE,
  DEFAULT_POINTER,
  DOT_SIZE,
  drawnShape,
  imageUrl,
  MIN_RING,
  POINTER_TOOLS,
  pointerColors,
  pointerCursor,
  pointerImage,
  ringWidth,
  sanitizePointer,
  shapeFor,
} from '../src/app/pointerStyle';
import { TOOLS } from '../src/tools/registry';

afterEach(() => vi.unstubAllGlobals());

/** A stand-in for the WebView's local storage. */
function storage(items: Record<string, string>) {
  vi.stubGlobal('localStorage', { getItem: (k: string) => items[k] ?? null, setItem: () => {} });
}

describe('the saved pointer setting', () => {
  it('is the normal arrow for an install that never saved one', () => {
    // Settings saved by an earlier version: other keys, but no `sketch.pointer`.
    storage({ 'sketch.theme': '"dark"', 'sketch.openIn': '"here"', 'sketch.tools': '{}' });
    const p = sanitizePointer(loadPref<unknown>('pointer', null));
    expect(p).toEqual(DEFAULT_POINTER);
    expect(p.shape).toBe('arrow');
    expect(p.eraserOwn).toBe(false);
    for (const t of POINTER_TOOLS) expect(shapeFor(p, t)).toBe('arrow');
  });

  it('is the arrow with no storage at all, or storage holding junk', () => {
    expect(sanitizePointer(loadPref<unknown>('pointer', null)).shape).toBe('arrow');
    for (const junk of [null, undefined, 3, 'dot', [], { shape: 'laser' }, { shape: 7 }]) expect(sanitizePointer(junk).shape).toBe('arrow');
    storage({ 'sketch.pointer': '{not json' });
    expect(sanitizePointer(loadPref<unknown>('pointer', null))).toEqual(DEFAULT_POINTER);
  });

  it('keeps a saved choice, and fixes each wrong part on its own', () => {
    storage({ 'sketch.pointer': JSON.stringify({ shape: 'cross', crossSize: 31, color: '#FF0000', eraserOwn: true, eraserShape: 'circle' }) });
    const p = sanitizePointer(loadPref<unknown>('pointer', null));
    expect(p).toMatchObject({ shape: 'cross', crossSize: 31, color: '#ff0000', eraserOwn: true, eraserShape: 'circle', dotSize: DOT_SIZE.default });
    const bad = sanitizePointer({ shape: 'dot', dotSize: 9000, crossSize: -4, color: 'red', eraserOwn: 'yes' });
    expect(bad).toMatchObject({ shape: 'dot', dotSize: DOT_SIZE.max, crossSize: CROSS_SIZE.min, color: 'auto', eraserOwn: false });
  });
});

describe('which pointer a tool shows', () => {
  const picked = { ...DEFAULT_POINTER, shape: 'dot' as const };

  it('gives every drawing tool the choice and leaves the others with their own pointers', () => {
    for (const t of ['brush', 'pencil', 'eraser', 'fill', 'rectangle', 'ellipse', 'polygon', 'star', 'arrow', 'line', 'text']) expect(shapeFor(picked, t)).toBe('dot');
    for (const t of ['select-rect', 'select-free', 'magic-wand', 'crop', 'picker']) expect(shapeFor(picked, t)).toBe('arrow');
  });

  it('names real tools only', () => {
    const ids = new Set(TOOLS.map((t) => t.id));
    for (const t of POINTER_TOOLS) expect(ids.has(t), t).toBe(true);
    for (const t of CIRCLE_TOOLS) expect(POINTER_TOOLS.has(t), t).toBe(true);
  });

  it('gives the eraser its own choice only when the switch is on', () => {
    const own = { ...picked, eraserShape: 'circle' as const };
    expect(shapeFor(own, 'eraser')).toBe('dot');
    expect(shapeFor({ ...own, eraserOwn: true }, 'eraser')).toBe('circle');
    expect(shapeFor({ ...own, eraserOwn: true }, 'brush')).toBe('dot');
    expect(shapeFor({ ...DEFAULT_POINTER, eraserOwn: true, eraserShape: 'cross' }, 'brush')).toBe('arrow');
  });

  it('shows the size circle for brush-like tools and a dot for tools with no brush size', () => {
    for (const t of ['brush', 'pencil', 'eraser']) expect(drawnShape('circle', t)).toBe('circle');
    for (const t of ['fill', 'rectangle', 'text', 'arrow']) expect(drawnShape('circle', t)).toBe('dot');
    expect(drawnShape('cross', 'fill')).toBe('cross');
  });
});

describe('the dot and crosshair cursors', () => {
  it('are small pictures with the pointer on the middle pixel', () => {
    for (const size of [DOT_SIZE.min, DOT_SIZE.default, DOT_SIZE.max]) {
      const img = pointerImage('dot', size, 'auto');
      expect(img.w).toBe(size + 4);
      expect(img.hot).toBe(Math.floor(img.w / 2));
    }
    for (const size of [CROSS_SIZE.min, CROSS_SIZE.default, 16, CROSS_SIZE.max]) {
      const img = pointerImage('cross', size, '#336699');
      expect(img.w % 2).toBe(1);
      expect(img.hot).toBe((img.w - 1) / 2);
      expect(img.w).toBeLessThanOrEqual(128);
    }
  });

  it('are valid CSS cursors with a fallback', () => {
    const dot = pointerCursor('dot', 6, 'auto');
    expect(dot).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) \d+ \d+, default$/);
    expect(pointerCursor('cross', 15, 'auto')).toMatch(/, crosshair$/);
    expect(decodeURIComponent(imageUrl(pointerImage('dot', 6, 'auto')).split(',')[1])).toContain('<circle');
  });

  it('are light with a dark edge by default, and have an opposite edge for a chosen colour', () => {
    expect(pointerColors('auto')).toEqual({ fill: '#ffffff', edge: '#000000' });
    expect(pointerColors('#ffee00').edge).toBe('#000000');
    expect(pointerColors('#102040').edge).toBe('#ffffff');
    expect(pointerImage('dot', 6, '#ff0000').svg).toContain('fill="#ff0000"');
  });
});

describe('the size circle', () => {
  it('is the brush size at the zoom, never smaller than the minimum', () => {
    expect(ringWidth(20, 0.5)).toBe(10);
    expect(ringWidth(20, 1)).toBe(20);
    expect(ringWidth(20, 4)).toBe(80);
    expect(ringWidth(1, 0.5)).toBe(MIN_RING);
  });
});
