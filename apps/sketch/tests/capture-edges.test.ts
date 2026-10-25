import { describe, expect, it } from 'vitest';
import { frameOf, isOpen } from '../src/engine/board';
import { flipEdges, grownEdges, turnEdges } from '../src/engine/commands';
import { NO_EDGES, type Edges, type PaintDocument } from '../src/engine/document';

const doc = (width: number, height: number, edges: Edges | null, board = false) => ({ width, height, edges, board }) as PaintDocument;

describe("a capture's open edges", () => {
  it('make the capture open, like a whiteboard, and other pictures not', () => {
    expect(isOpen(doc(10, 10, NO_EDGES))).toBe(true);
    expect(isOpen(doc(10, 10, null, true))).toBe(true);
    expect(isOpen(doc(10, 10, null))).toBe(false);
  });

  it('frame the capture inside its grown canvas', () => {
    expect(frameOf(doc(800, 600, null))).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(frameOf(doc(800, 600, NO_EDGES))).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(frameOf(doc(2000, 1600, { left: 1024, top: 512, right: 176, bottom: 488 }))).toEqual({ x: 1024, y: 512, w: 800, h: 600 });
  });

  it('take in what a growth adds on each side, and keep it when it grows again', () => {
    // 800 × 600 grown left by 1024 and down by 256.
    const once = grownEdges(NO_EDGES, 800, 600, 1824, 856, 1024, 0);
    expect(once).toEqual({ left: 1024, top: 0, right: 0, bottom: 256 });
    expect(frameOf(doc(1824, 856, once))).toEqual({ x: 1024, y: 0, w: 800, h: 600 });
    // Then up by 512 and right by 256.
    const twice = grownEdges(once, 1824, 856, 2080, 1368, 0, 512);
    expect(twice).toEqual({ left: 1024, top: 512, right: 256, bottom: 256 });
    expect(frameOf(doc(2080, 1368, twice))).toEqual({ x: 1024, y: 512, w: 800, h: 600 });
  });

  it('turn and flip with the picture, so the frame stays on the capture', () => {
    const e = { left: 1, top: 2, right: 3, bottom: 4 };
    // A 10 × 20 capture in a 14 × 26 canvas.
    const right = turnEdges(e, 1)!;
    const left = turnEdges(e, -1)!;
    expect(frameOf(doc(26, 14, right))).toMatchObject({ w: 20, h: 10 });
    expect(frameOf(doc(26, 14, left))).toMatchObject({ w: 20, h: 10 });
    expect(turnEdges(right, -1)).toEqual(e);
    expect(turnEdges(right, 1), "a half turn").toEqual({ left: 3, top: 4, right: 1, bottom: 2 });
    expect(flipEdges(e, 'h')).toEqual({ left: 3, top: 2, right: 1, bottom: 4 });
    expect(flipEdges(e, 'v')).toEqual({ left: 1, top: 4, right: 3, bottom: 2 });
    expect(turnEdges(null, 1)).toBeNull();
  });
});
