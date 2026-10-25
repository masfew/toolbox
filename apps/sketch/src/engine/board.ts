import { createLayer, ctxOf, drawLayer, MAX_SIZE, newCanvas, PaintDocument } from './document';
import { objectBounds, objectPaintBounds, type SketchObject } from './objects';
import { alphaBounds, type Rect } from './pixels';
import { TILE } from './tiles';

/** A new whiteboard's canvas. It's see-through, so an empty board only costs this much. */
export const BOARD_START = 2048;
/** Extra canvas added past what's needed each time the board grows, so it doesn't grow on every stroke. */
export const BOARD_MARGIN = 1024;
/**
 * The same for a capture, smaller: what's drawn round a capture is found by reading back the canvas
 * past its edges on each copy, which took 108 ms on a 4K capture grown by the board's margin.
 */
export const CAPTURE_MARGIN = TILE;
/** The board's colour on screen, and the background of its exports. */
export const BOARD_BACKGROUND = '#ffffff';
/** Space left round what's on the board when it's exported or copied. */
export const EXPORT_MARGIN = 24;

export function newBoard(): PaintDocument {
  const doc = new PaintDocument(BOARD_START, BOARD_START, null, [createLayer('Background', BOARD_START, BOARD_START)]);
  doc.board = true;
  return doc;
}

const alignUp = (n: number) => Math.ceil(n / TILE) * TILE;

/**
 * One side of a board's growth: the new canvas runs from `a` to `b`, in the old canvas's pixels
 * (a ≤ 0, b ≥ size). Grows a margin past what's needed, in whole tiles, never past MAX_SIZE.
 */
function growAxis(size: number, lo: number, hi: number, margin: number): [number, number] {
  const needLo = Math.min(0, Math.floor(lo));
  const needHi = Math.max(size, Math.ceil(hi));
  let a = needLo < 0 ? -alignUp(-needLo + margin) : 0;
  let b = needHi > size ? size + alignUp(needHi - size + margin) : size;
  if (b - a <= MAX_SIZE) return [a, b];
  // Without the margin, in whole tiles.
  a = needLo < 0 ? -alignUp(-needLo) : 0;
  b = needHi > size ? size + alignUp(needHi - size) : size;
  if (b - a <= MAX_SIZE) return [a, b];
  // Still too big: grow as far as it can, sharing what's left between the sides that need it.
  const spare = Math.max(0, Math.floor((MAX_SIZE - size) / TILE) * TILE);
  if (needLo < 0 && needHi > size) {
    const left = Math.min(-a, Math.floor(spare / 2 / TILE) * TILE);
    return [-left, size + Math.min(b - size, spare - left)];
  }
  return needLo < 0 ? [-spare, size] : [0, size + spare];
}

/**
 * How a board's canvas must grow to hold `need` (in its pixels): its new size, and how far the old
 * canvas moves in it. Null when it already holds it, or can't grow at all.
 */
export function boardGrowth(
  width: number,
  height: number,
  need: Rect,
  margin = BOARD_MARGIN,
): { width: number; height: number; dx: number; dy: number } | null {
  const [x0, x1] = growAxis(width, need.x, need.x + need.w, margin);
  const [y0, y1] = growAxis(height, need.y, need.y + need.h, margin);
  if (x0 === 0 && y0 === 0 && x1 === width && y1 === height) return null;
  return { width: x1 - x0, height: y1 - y0, dx: 0 - x0, dy: 0 - y0 };
}

/**
 * Where an object puts paint. A spotlight dims everything round it without end, so only its own box
 * counts on a board.
 */
export function inkBounds(o: SketchObject): Rect {
  return o.type === 'mark' && o.kind === 'spotlight' ? objectBounds(o) : objectPaintBounds(o);
}

export function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function objectsBounds(objects: readonly SketchObject[]): Rect | null {
  let r: Rect | null = null;
  for (const o of objects) r = union(r, inkBounds(o));
  return r;
}

/** Everything showing on the document: painted pixels on every visible layer, and every visible object. */
export function contentBounds(doc: PaintDocument): Rect | null {
  let r: Rect | null = null;
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    if (layer.kind === 'objects') r = union(r, objectsBounds(layer.objects));
    else {
      const c = layer.canvas;
      r = union(r, alphaBounds(ctxOf(c).getImageData(0, 0, c.width, c.height).data, c.width, c.height));
    }
  }
  return r;
}

/**
 * Whether drawing can run past the canvas: on a whiteboard, which has no edges, and on a screen
 * capture, whose edges are open (`PaintDocument.edges`). The canvas grows to hold pixels drawn past it.
 */
export function isOpen(doc: PaintDocument): boolean {
  return doc.board || !!doc.edges;
}

/** The picture itself in its canvas: the whole canvas, or a capture's own area once it has grown. */
export function frameOf(doc: PaintDocument): Rect {
  const e = doc.edges;
  if (!e) return { x: 0, y: 0, w: doc.width, h: doc.height };
  return { x: e.left, y: e.top, w: doc.width - e.left - e.right, h: doc.height - e.top - e.bottom };
}

/** Painted pixels on the visible layers outside `frame`, read from the four strips round it only. */
function outsideBounds(doc: PaintDocument, frame: Rect): Rect | null {
  const W = doc.width;
  const H = doc.height;
  const strips: Rect[] = [
    { x: 0, y: 0, w: W, h: frame.y },
    { x: 0, y: frame.y + frame.h, w: W, h: H - frame.y - frame.h },
    { x: 0, y: frame.y, w: frame.x, h: frame.h },
    { x: frame.x + frame.w, y: frame.y, w: W - frame.x - frame.w, h: frame.h },
  ].filter((s) => s.w > 0 && s.h > 0);
  let r: Rect | null = null;
  for (const layer of doc.layers) {
    if (!layer.visible || layer.kind !== 'pixel') continue;
    const ctx = ctxOf(layer.canvas);
    for (const s of strips) {
      const b = alphaBounds(ctx.getImageData(s.x, s.y, s.w, s.h).data, s.w, s.h);
      if (b) r = union(r, { x: b.x + s.x, y: b.y + s.y, w: b.w, h: b.h });
    }
  }
  return r;
}

/**
 * What a capture's copy or flat save holds, in whole pixels: the capture, and everything drawn round
 * it (pixels past its edges, shapes and text off the canvas), plus `extra`. With nothing drawn round
 * it, that's exactly the capture.
 */
export function pictureArea(doc: PaintDocument, extra: Rect | null = null): Rect {
  const frame = frameOf(doc);
  const objects = doc.layers.flatMap((l) => (l.kind === 'objects' && l.visible ? l.objects : []));
  const grown = frame.w !== doc.width || frame.h !== doc.height;
  const r = union(union(union(frame, objectsBounds(objects)), grown ? outsideBounds(doc, frame) : null), extra)!;
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y };
}

/** What a board's export holds: everything on it plus a small margin, in whole pixels. Null when it's empty. */
export function exportArea(doc: PaintDocument, extra: Rect | null = null): Rect | null {
  const r = union(contentBounds(doc), extra);
  if (!r) return null;
  const x = Math.floor(r.x - EXPORT_MARGIN);
  const y = Math.floor(r.y - EXPORT_MARGIN);
  return { x, y, w: Math.ceil(r.x + r.w + EXPORT_MARGIN) - x, h: Math.ceil(r.y + r.h + EXPORT_MARGIN) - y };
}

/** Merges the visible layers within `area` (which may reach past the canvas) into one canvas. */
export function flattenArea(doc: PaintDocument, area: Rect, background: string | null): OffscreenCanvas {
  const out = newCanvas(area.w, area.h);
  const ctx = ctxOf(out);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, area.w, area.h);
  }
  ctx.translate(-area.x, -area.y);
  for (const layer of doc.layers) if (layer.visible) drawLayer(ctx, layer);
  return out;
}
