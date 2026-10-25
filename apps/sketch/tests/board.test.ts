import { describe, expect, it } from 'vitest';
import { BOARD_MARGIN, boardGrowth, union } from '../src/engine/board';
import { MAX_SIZE } from '../src/engine/document';
import { History, type Command } from '../src/engine/history';
import { alphaBounds } from '../src/engine/pixels';
import { TILE } from '../src/engine/tiles';

describe('boardGrowth', () => {
  it("doesn't grow when the canvas already holds the area", () => {
    expect(boardGrowth(2048, 2048, { x: 10, y: 10, w: 500, h: 500 })).toBeNull();
    expect(boardGrowth(2048, 2048, { x: 0, y: 0, w: 2048, h: 2048 })).toBeNull();
  });

  it('grows right and down by what is needed plus a margin, in whole tiles', () => {
    const g = boardGrowth(2048, 2048, { x: 1000, y: 1000, w: 1100, h: 100 })!;
    expect(g.dx).toBe(0);
    expect(g.dy).toBe(0);
    expect(g.height).toBe(2048);
    expect(g.width).toBeGreaterThanOrEqual(2100 + BOARD_MARGIN);
    expect(g.width % TILE).toBe(0);
  });

  it('grows up and left by moving the old canvas, in whole tiles', () => {
    const g = boardGrowth(2048, 2048, { x: -300, y: -10, w: 100, h: 100 })!;
    expect(g.dx).toBeGreaterThanOrEqual(300 + BOARD_MARGIN);
    expect(g.dy).toBeGreaterThanOrEqual(10 + BOARD_MARGIN);
    expect(g.dx % TILE).toBe(0);
    expect(g.dy % TILE).toBe(0);
    expect(g.width).toBe(2048 + g.dx);
    expect(g.height).toBe(2048 + g.dy);
  });

  it('drops the margin, then stops at the largest size, rather than going past it', () => {
    const near = boardGrowth(MAX_SIZE - 512, 1024, { x: MAX_SIZE - 600, y: 0, w: 400, h: 10 })!;
    expect(near.width).toBe(MAX_SIZE);
    const far = boardGrowth(MAX_SIZE - 512, 1024, { x: -5000, y: 0, w: 10, h: 10 })!;
    expect(far.width).toBe(MAX_SIZE);
    expect(far.dx).toBe(512);
    expect(boardGrowth(MAX_SIZE, 1024, { x: -5000, y: 0, w: 10, h: 10 })).toBeNull();
  });

  it('shares what room is left between both sides', () => {
    const g = boardGrowth(MAX_SIZE - 1024, 1024, { x: -4000, y: 0, w: MAX_SIZE + 8000, h: 10 })!;
    expect(g.width).toBe(MAX_SIZE);
    expect(g.dx).toBe(512);
  });
});

describe('alphaBounds', () => {
  const W = 6;
  const H = 5;
  const blank = () => new Uint8ClampedArray(W * H * 4);
  const dot = (d: Uint8ClampedArray, x: number, y: number, a = 255) => (d[(y * W + x) * 4 + 3] = a);

  it('is null on an empty canvas', () => {
    expect(alphaBounds(blank(), W, H)).toBeNull();
  });

  it('holds every pixel that shows, however faint', () => {
    const d = blank();
    dot(d, 4, 1);
    dot(d, 1, 3, 1);
    expect(alphaBounds(d, W, H)).toEqual({ x: 1, y: 1, w: 4, h: 3 });
    dot(d, 0, 4);
    dot(d, 5, 0);
    expect(alphaBounds(d, W, H)).toEqual({ x: 0, y: 0, w: 6, h: 5 });
  });
});

describe('union', () => {
  it('joins two rectangles, or keeps the one that exists', () => {
    expect(union(null, null)).toBeNull();
    expect(union({ x: 1, y: 2, w: 3, h: 4 }, null)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(union({ x: 0, y: 0, w: 2, h: 2 }, { x: -1, y: 5, w: 1, h: 1 })).toEqual({ x: -1, y: 0, w: 3, h: 6 });
  });
});

describe('History joining', () => {
  function steps() {
    const state = { value: 0 };
    const make = (label: string, delta: number, joinNext = false): Command => {
      state.value += delta;
      return { label, bytes: 10, joinNext, apply: () => (state.value += delta), revert: () => (state.value -= delta) };
    };
    return { state, make };
  }

  it('takes a step marked joinNext into the next one, so one undo takes both away', () => {
    const h = new History();
    const { state, make } = steps();
    h.record(make('Grow whiteboard', 1, true));
    h.record(make('Brush', 10));
    expect(h.undoLabel).toBe('Brush');
    expect(h.entries()).toHaveLength(2);
    h.undo();
    expect(state.value).toBe(0);
    h.redo();
    expect(state.value).toBe(11);
    expect(h.bytesUsed).toBe(20);
  });

  it("doesn't count a picture saved between the two as still saved", () => {
    const h = new History();
    const { make } = steps();
    h.record(make('Grow whiteboard', 1, true));
    h.markSaved();
    h.record(make('Brush', 10));
    expect(h.dirty).toBe(true);
  });

  it('can take back a growth whose next step never came, leaving nothing to redo', () => {
    const h = new History();
    const { state, make } = steps();
    h.record(make('Brush', 10));
    h.record(make('Grow whiteboard', 1, true));
    h.discardTop();
    expect(state.value).toBe(10);
    expect(h.undoLabel).toBe('Brush');
    expect(h.canRedo).toBe(false);
    expect(h.bytesUsed).toBe(10);
  });

  it('leaves an undone growth alone', () => {
    const h = new History();
    const { state, make } = steps();
    h.record(make('Grow whiteboard', 1, true));
    h.undo();
    h.record(make('Brush', 10));
    expect(state.value).toBe(10);
    h.undo();
    expect(state.value).toBe(0);
    expect(h.canUndo).toBe(false);
  });
});
