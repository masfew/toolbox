import { drawObjects, type SketchObject } from './objects';

/** Largest width or height a picture can have. Browsers refuse bigger canvases. */
export const MAX_SIZE = 16384;
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;

export interface PixelLayer {
  id: number;
  kind: 'pixel';
  name: string;
  canvas: OffscreenCanvas;
  visible: boolean;
  /** A locked layer can't be painted on, and its objects can't be picked. */
  locked: boolean;
  opacity: number;
}

/**
 * A layer of objects that stay editable (text, shapes, lines). The list is never changed
 * in place: every edit makes a new array, so undo can keep the old one.
 */
export interface ObjectLayer {
  id: number;
  kind: 'objects';
  name: string;
  objects: readonly SketchObject[];
  visible: boolean;
  locked: boolean;
  opacity: number;
}

export type Layer = PixelLayer | ObjectLayer;

let nextLayerId = 1;

export function newCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
}

export function ctxOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  return canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
}

export function createLayer(name: string, width: number, height: number, fill: string | null = null): PixelLayer {
  const canvas = newCanvas(width, height);
  if (fill) {
    const ctx = ctxOf(canvas);
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, width, height);
  }
  return { id: nextLayerId++, kind: 'pixel', name, canvas, visible: true, locked: false, opacity: 1 };
}

export function createObjectLayer(name: string, objects: readonly SketchObject[] = []): ObjectLayer {
  return { id: nextLayerId++, kind: 'objects', name, objects, visible: true, locked: false, opacity: 1 };
}

/**
 * Where a new object goes: the current object layer, or the one just above the current layer.
 * Null means make a new one. Locked and hidden layers are passed over.
 */
export function objectLayerForNew(doc: PaintDocument): ObjectLayer | null {
  const usable = (l: Layer | undefined): l is ObjectLayer => l?.kind === 'objects' && l.visible && !l.locked;
  const here = doc.layers[doc.active];
  if (here.kind === 'objects') return usable(here) ? here : null;
  const above = doc.layers[doc.active + 1];
  return usable(above) ? above : null;
}

/** "Layer 2", "Layer 3" and so on: the first number not used by a layer of that name. */
export function nextLayerName(doc: PaintDocument): string {
  const used = new Set(doc.layers.map((l) => l.name));
  let n = doc.layers.length + 1;
  while (used.has(`Layer ${n}`)) n++;
  return `Layer ${n}`;
}

/** How far a canvas reaches past its picture on each side, in pixels. */
export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const NO_EDGES: Edges = { left: 0, top: 0, right: 0, bottom: 0 };

export class PaintDocument {
  layers: Layer[];
  active = 0;
  /**
   * A whiteboard: no edges, so the canvas grows wherever pixels are drawn, and shapes and text can go
   * anywhere, even off the canvas. It shows on a white board and exports cropped to what's on it.
   */
  board = false;
  /**
   * A screen capture's open edges, null for other pictures. Drawing past the capture grows the
   * canvas as on a whiteboard, and shapes and text can sit off it, so marks round the capture aren't
   * cut off; this says how far the canvas now reaches past the capture itself. Copies and flat saves
   * hold the capture and everything drawn round it (`pictureArea`).
   */
  edges: Edges | null = null;

  /** `fill` is the colour the bottom layer gets when the canvas grows; null keeps it transparent. */
  constructor(
    public width: number,
    public height: number,
    public fill: string | null = '#ffffff',
    layers?: Layer[],
  ) {
    this.layers = layers ?? [createLayer('Background', width, height, fill)];
  }

  get activeLayer(): Layer {
    return this.layers[this.active];
  }

  /**
   * The layer pixel tools work on: the current layer when it holds pixels, otherwise the
   * nearest pixel layer below it (or above, if there's none below).
   */
  get paintLayer(): PixelLayer {
    for (let i = this.active; i >= 0; i--) {
      const l = this.layers[i];
      if (l.kind === 'pixel') return l;
    }
    return this.layers.find((l): l is PixelLayer => l.kind === 'pixel')!;
  }

  /** Grown canvas area is white, unless the image has see-through pixels of its own. */
  static fromImage(image: CanvasImageSource & { width: number; height: number }, name = 'Background'): PaintDocument {
    const layer = createLayer(name, image.width, image.height);
    ctxOf(layer.canvas).drawImage(image, 0, 0);
    return new PaintDocument(image.width, image.height, fillFor(layer.canvas), [layer]);
  }
}

/** The fill a document made from this image should use: null if any pixel is see-through, white otherwise. */
export function fillFor(canvas: OffscreenCanvas): string | null {
  const data = ctxOf(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return null;
  return '#ffffff';
}

export function checkSize(width: number, height: number): string | null {
  if (width > MAX_SIZE || height > MAX_SIZE) {
    return `Pictures can be at most ${MAX_SIZE} × ${MAX_SIZE} pixels (this one is ${width} × ${height}).`;
  }
  return null;
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/**
 * Draws one layer at its opacity. Blur and pixelate marks take their pixels from what's already on
 * `ctx`, or from `backdrop` when it's given (they're drawn on both, so later ones see them).
 */
export function drawLayer(ctx: Ctx, layer: Layer, alpha = 1, backdrop?: Ctx): void {
  ctx.globalAlpha = layer.opacity * alpha;
  if (backdrop) backdrop.globalAlpha = ctx.globalAlpha;
  if (layer.kind === 'pixel') ctx.drawImage(layer.canvas, 0, 0);
  else drawObjects(ctx, layer.objects, backdrop);
  ctx.globalAlpha = 1;
  if (backdrop) backdrop.globalAlpha = 1;
}

/** Merges the visible layers into one canvas, optionally on a solid background. `upTo` stops before that layer. */
export function flatten(doc: PaintDocument, background: string | null = null, upTo = doc.layers.length): OffscreenCanvas {
  const out = newCanvas(doc.width, doc.height);
  const ctx = ctxOf(out);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  for (const layer of doc.layers.slice(0, upTo)) if (layer.visible) drawLayer(ctx, layer);
  return out;
}
