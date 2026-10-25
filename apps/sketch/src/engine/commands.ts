import {
  createLayer,
  createObjectLayer,
  ctxOf,
  drawLayer,
  fillFor,
  flatten,
  newCanvas,
  NO_EDGES,
  type Edges,
  type Layer,
  type ObjectLayer,
  type PaintDocument,
  type PixelLayer,
} from './document';
import { CompositeCommand, type Command } from './history';
import { changeObject, drawObjects, layoutText, objectPaintBounds, type PictureChange, type SketchObject } from './objects';
import { PixelEdit } from './tiles';

type LayerContent = OffscreenCanvas | readonly SketchObject[];

interface DocState {
  width: number;
  height: number;
  fill: string | null;
  edges: Edges | null;
  content: Map<number, LayerContent>;
}

function contentOf(layer: Layer): LayerContent {
  return layer.kind === 'pixel' ? layer.canvas : layer.objects;
}

function capture(doc: PaintDocument): DocState {
  return { width: doc.width, height: doc.height, fill: doc.fill, edges: doc.edges, content: new Map(doc.layers.map((l) => [l.id, contentOf(l)])) };
}

function restore(doc: PaintDocument, s: DocState): void {
  doc.width = s.width;
  doc.height = s.height;
  doc.fill = s.fill;
  doc.edges = s.edges;
  for (const layer of doc.layers) {
    const c = s.content.get(layer.id);
    if (c === undefined) continue;
    if (layer.kind === 'pixel') layer.canvas = c as OffscreenCanvas;
    else layer.objects = c as readonly SketchObject[];
  }
}

/** Swaps the whole document between two states: size, fill, every layer's pixels and objects. */
class DocStateCommand implements Command {
  readonly bytes: number;
  constructor(
    readonly label: string,
    private readonly doc: PaintDocument,
    private readonly before: DocState,
    private readonly after: DocState,
  ) {
    const layers = doc.layers.filter((l) => l.kind === 'pixel').length;
    this.bytes = (before.width * before.height + after.width * after.height) * 4 * layers;
  }
  apply(): void {
    restore(this.doc, this.after);
  }
  revert(): void {
    restore(this.doc, this.before);
  }
}

/**
 * Changes the whole picture and applies it: each pixel layer gets a new canvas from `pixels`,
 * and each object moves with `change`. A capture's open edges become `size.edges`; by default the
 * changed canvas is all picture (crop, canvas size), so it no longer reaches past it.
 */
function changeDocument(
  doc: PaintDocument,
  label: string,
  size: { width: number; height: number; fill?: string | null; edges?: Edges | null },
  pixels: (layer: PixelLayer, index: number) => OffscreenCanvas,
  change: PictureChange,
): Command {
  const before = capture(doc);
  const content = new Map<number, LayerContent>();
  doc.layers.forEach((layer, i) => {
    if (layer.kind === 'pixel') content.set(layer.id, pixels(layer, i));
    else
      content.set(
        layer.id,
        layer.objects.map((o) => {
          const l = change.kind === 'flip' && o.type === 'text' ? layoutText(o) : null;
          return changeObject(o, change, l ? { w: l.width, h: l.height } : undefined);
        }),
      );
  });
  const fill = size.fill === undefined ? doc.fill : size.fill;
  const edges = size.edges === undefined ? (doc.edges ? NO_EDGES : null) : size.edges;
  const cmd = new DocStateCommand(label, doc, before, { width: size.width, height: size.height, fill, edges, content });
  cmd.apply();
  return cmd;
}

/**
 * Gives the canvas a new size and applies it. The picture moves by (dx, dy), so a negative offset
 * crops from the top-left. New area on the bottom layer gets `doc.fill`.
 */
export function resizeCanvas(doc: PaintDocument, width: number, height: number, label = 'Resize canvas', dx = 0, dy = 0, edges?: Edges | null): Command {
  return changeDocument(
    doc,
    label,
    { width, height, edges },
    (layer, i) => {
      const c = newCanvas(width, height);
      const ctx = ctxOf(c);
      if (i === 0 && doc.fill) {
        ctx.fillStyle = doc.fill;
        ctx.fillRect(0, 0, width, height);
        ctx.clearRect(dx, dy, doc.width, doc.height);
      }
      ctx.drawImage(layer.canvas, dx, dy);
      return c;
    },
    { kind: 'offset', dx, dy },
  );
}

/**
 * A whiteboard's or capture's canvas growing to `width` × `height`, with the old canvas at (dx, dy) in
 * it. A capture's new canvas is past its edges, so it isn't part of the capture.
 */
export function growCanvas(doc: PaintDocument, width: number, height: number, dx: number, dy: number, label: string): Command {
  const edges = doc.edges && grownEdges(doc.edges, doc.width, doc.height, width, height, dx, dy);
  return resizeCanvas(doc, width, height, label, dx, dy, edges);
}

/** A capture's open edges once its `width` × `height` canvas has grown, with the old one at (dx, dy). */
export function grownEdges(e: Edges, oldW: number, oldH: number, width: number, height: number, dx: number, dy: number): Edges {
  return { left: e.left + dx, top: e.top + dy, right: e.right + width - oldW - dx, bottom: e.bottom + height - oldH - dy };
}

/** Keeps only the area (x, y, w, h) of every layer. */
export function cropTo(doc: PaintDocument, x: number, y: number, w: number, h: number, label = 'Crop'): Command {
  return resizeCanvas(doc, w, h, label, -x, -y);
}

/**
 * Scales a canvas. Big reductions halve in steps first, so detail averages out instead of
 * shimmering. `pixelArt` keeps hard edges (nearest pixel).
 */
export function scaleCanvas(src: OffscreenCanvas, w: number, h: number, pixelArt: boolean): OffscreenCanvas {
  let cur = src;
  if (!pixelArt) {
    while (cur.width >= w * 2 || cur.height >= h * 2) {
      const nw = cur.width >= w * 2 ? Math.ceil(cur.width / 2) : cur.width;
      const nh = cur.height >= h * 2 ? Math.ceil(cur.height / 2) : cur.height;
      const half = newCanvas(nw, nh);
      const ctx = ctxOf(half);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cur, 0, 0, nw, nh);
      cur = half;
    }
  }
  const out = newCanvas(w, h);
  const ctx = ctxOf(out);
  ctx.imageSmoothingEnabled = !pixelArt;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

export function scalePicture(doc: PaintDocument, w: number, h: number, pixelArt: boolean): Command {
  return changeDocument(doc, 'Resize', { width: w, height: h }, (layer) => scaleCanvas(layer.canvas, w, h, pixelArt), {
    kind: 'scale',
    sx: w / doc.width,
    sy: h / doc.height,
  });
}

/** Turns the whole picture a quarter turn: 1 is right (clockwise), -1 left. */
export function rotatePicture(doc: PaintDocument, dir: 1 | -1): Command {
  const { width: w, height: h } = doc;
  return changeDocument(
    doc,
    dir > 0 ? 'Rotate right' : 'Rotate left',
    { width: h, height: w, edges: turnEdges(doc.edges, dir) },
    (layer) => {
      const c = newCanvas(h, w);
      const ctx = ctxOf(c);
      if (dir > 0) ctx.setTransform(0, 1, -1, 0, h, 0);
      else ctx.setTransform(0, -1, 1, 0, 0, w);
      ctx.drawImage(layer.canvas, 0, 0);
      return c;
    },
    { kind: 'rotate', dir, width: w, height: h },
  );
}

/** A capture's open edges after a quarter turn of the picture. */
export function turnEdges(e: Edges | null, dir: 1 | -1): Edges | null {
  if (!e) return null;
  return dir > 0 ? { left: e.bottom, top: e.left, right: e.top, bottom: e.right } : { left: e.top, top: e.right, right: e.bottom, bottom: e.left };
}

export function flipEdges(e: Edges | null, axis: 'h' | 'v'): Edges | null {
  if (!e) return null;
  return axis === 'h' ? { ...e, left: e.right, right: e.left } : { ...e, top: e.bottom, bottom: e.top };
}

export function flipPicture(doc: PaintDocument, axis: 'h' | 'v'): Command {
  const { width: w, height: h } = doc;
  return changeDocument(
    doc,
    axis === 'h' ? 'Flip horizontal' : 'Flip vertical',
    { width: w, height: h, edges: flipEdges(doc.edges, axis) },
    (layer) => {
      const c = newCanvas(w, h);
      const ctx = ctxOf(c);
      if (axis === 'h') ctx.setTransform(-1, 0, 0, 1, w, 0);
      else ctx.setTransform(1, 0, 0, -1, 0, h);
      ctx.drawImage(layer.canvas, 0, 0);
      return c;
    },
    { kind: 'flip', axis, width: w, height: h },
  );
}

/**
 * Turns the document into exactly this image (for pasting into a new, untouched picture) and applies it.
 * `open`: a screen capture, whose edges are open (`PaintDocument.edges`) and whose canvas grows
 * see-through.
 */
export function replaceWithImage(
  doc: PaintDocument,
  image: CanvasImageSource & { width: number; height: number },
  label = 'Paste',
  open = false,
): Command {
  let bottom: OffscreenCanvas | null = null;
  const pixelsOf = (_: PixelLayer, i: number) => {
    const c = newCanvas(image.width, image.height);
    if (i === 0) {
      ctxOf(c).drawImage(image, 0, 0);
      bottom = c;
    }
    return c;
  };
  const before = capture(doc);
  const content = new Map<number, LayerContent>();
  doc.layers.forEach((layer, i) => content.set(layer.id, layer.kind === 'pixel' ? pixelsOf(layer, i) : layer.objects));
  const after: DocState = { width: image.width, height: image.height, fill: open ? null : '#ffffff', edges: open ? NO_EDGES : null, content };
  const cmd = new DocStateCommand(label, doc, before, after);
  cmd.apply();
  if (open) return cmd;
  // The fill depends on whether the image has see-through pixels, which takes reading every pixel
  // back from the GPU (about 200 ms the first time on a 4K picture). It only matters once the canvas
  // grows, so it's worked out just after the paste shows rather than before.
  const first = bottom as OffscreenCanvas | null;
  if (first) {
    setTimeout(() => {
      after.fill = fillFor(first);
      if (doc.layers.some((l) => l.kind === 'pixel' && l.canvas === first)) doc.fill = after.fill;
    }, 250);
  }
  return cmd;
}

class AddLayerCommand implements Command {
  readonly bytes: number;
  private prevActive = 0;
  constructor(
    readonly label: string,
    private readonly doc: PaintDocument,
    private readonly layer: Layer,
    private readonly index: number,
  ) {
    this.bytes = layer.kind === 'pixel' ? layer.canvas.width * layer.canvas.height * 4 : 4096;
  }
  apply(): void {
    this.prevActive = this.doc.active;
    this.doc.layers.splice(this.index, 0, this.layer);
    this.doc.active = this.index;
  }
  revert(): void {
    this.doc.layers.splice(this.index, 1);
    this.doc.active = Math.min(this.prevActive, this.doc.layers.length - 1);
  }
}

/** Adds a layer above the current one, makes it current, and applies it. */
export function addLayer(doc: PaintDocument, layer: Layer, label: string): Command {
  const cmd = new AddLayerCommand(label, doc, layer, doc.active + 1);
  cmd.apply();
  return cmd;
}

/** Adds a layer holding an image at (x, y), above the current layer, and applies it. */
export function addImageLayer(doc: PaintDocument, image: CanvasImageSource, x: number, y: number, name: string): Command {
  const layer = createLayer(name, doc.width, doc.height);
  ctxOf(layer.canvas).drawImage(image, x, y);
  return addLayer(doc, layer, 'Add layer from file');
}

/**
 * Swaps an object layer's list of objects. Recorded after the change is made. `after` can be moved on
 * while it's the last step, so a run of small changes (dragging a slider, nudging) is one step.
 */
export class ObjectsCommand implements Command {
  readonly bytes = 4096;
  constructor(
    readonly label: string,
    private readonly layer: ObjectLayer,
    private readonly before: readonly SketchObject[],
    public after: readonly SketchObject[],
  ) {}
  apply(): void {
    this.layer.objects = this.after;
  }
  revert(): void {
    this.layer.objects = this.before;
  }
}

// ---------- Rasterize and flatten (step 4.4) ----------

/** Swaps the document's whole list of layers, and which one is current. */
class LayersCommand implements Command {
  readonly bytes: number;
  constructor(
    readonly label: string,
    private readonly doc: PaintDocument,
    private readonly before: { layers: Layer[]; active: number },
    private readonly after: { layers: Layer[]; active: number },
  ) {
    this.bytes = after.layers.filter((l) => !before.layers.includes(l)).length * doc.width * doc.height * 4;
  }
  apply(): void {
    this.doc.layers = [...this.after.layers];
    this.doc.active = this.after.active;
  }
  revert(): void {
    this.doc.layers = [...this.before.layers];
    this.doc.active = this.before.active;
  }
}

function swapLayers(doc: PaintDocument, label: string, layers: Layer[], active: number): Command {
  const cmd = new LayersCommand(label, doc, { layers: [...doc.layers], active: doc.active }, { layers, active });
  cmd.apply();
  return cmd;
}

/** The visible layers under `index` merged, for blur and pixelate marks to take their pixels from. */
function backdropFor(doc: PaintDocument, index: number): OffscreenCanvasRenderingContext2D {
  return ctxOf(flatten(doc, null, index));
}

/** Turns an object layer into a pixel layer that looks the same, in its place, and applies it. */
export function rasterizeLayer(doc: PaintDocument, index: number): Command {
  const old = doc.layers[index] as ObjectLayer;
  const layer = createLayer(old.name, doc.width, doc.height);
  drawObjects(ctxOf(layer.canvas), old.objects, backdropFor(doc, index));
  layer.visible = old.visible;
  layer.locked = old.locked;
  layer.opacity = old.opacity;
  return swapLayers(doc, 'Rasterize layer', doc.layers.map((l, i) => (i === index ? layer : l)), doc.active);
}

/** Merges the layers that are showing into one pixel layer, and applies it. Hidden layers are dropped. */
export function flattenLayers(doc: PaintDocument): Command {
  const layer = createLayer('Background', doc.width, doc.height);
  ctxOf(layer.canvas).drawImage(flatten(doc), 0, 0);
  return swapLayers(doc, 'Flatten', [layer], 0);
}

/**
 * Turns some of a layer's objects into pixels on the nearest pixel layer under it, and applies it.
 * Null when there's no pixel layer under it.
 */
export function rasterizeObjects(doc: PaintDocument, layer: ObjectLayer, ids: number[], label: string): Command | null {
  const index = doc.layers.indexOf(layer);
  let target: PixelLayer | null = null;
  for (let i = index - 1; i >= 0 && !target; i--) {
    const l = doc.layers[i];
    if (l.kind === 'pixel') target = l;
  }
  if (!target) return null;
  const objects = layer.objects.filter((o) => ids.includes(o.id));
  const edit = new PixelEdit(target, label);
  for (const o of objects) {
    const r = objectPaintBounds(o);
    edit.touch(r.x, r.y, r.w, r.h);
  }
  // Drawn as the layer shows them: at the layer's opacity.
  drawLayer(ctxOf(target.canvas), { ...layer, objects }, 1, backdropFor(doc, index));
  const before = layer.objects;
  layer.objects = before.filter((o) => !ids.includes(o.id));
  const parts = [edit.finish(), new ObjectsCommand(label, layer, before, layer.objects)].filter((c): c is Command => c !== null);
  return new CompositeCommand(label, parts);
}

// ---------- Layers (step 5.1) ----------

export type LayerProps = Pick<Layer, 'name' | 'visible' | 'locked' | 'opacity'>;

/**
 * Changes a layer's name, visibility, lock or opacity. Recorded after the change is made. `after` can be
 * moved on while it's the last step, so dragging the opacity slider is one step.
 */
export class LayerPropsCommand implements Command {
  readonly bytes = 256;
  constructor(
    readonly label: string,
    readonly layer: Layer,
    private readonly before: Partial<LayerProps>,
    public after: Partial<LayerProps>,
  ) {}
  apply(): void {
    Object.assign(this.layer, this.after);
  }
  revert(): void {
    Object.assign(this.layer, this.before);
  }
}

/** Sets one of a layer's properties and returns the command, or null when it's already that. */
export function setLayerProp<K extends keyof LayerProps>(layer: Layer, key: K, value: LayerProps[K], label: string): LayerPropsCommand | null {
  if (layer[key] === value) return null;
  const cmd = new LayerPropsCommand(label, layer, { [key]: layer[key] }, { [key]: value });
  cmd.apply();
  return cmd;
}

/** Takes a layer out of the picture, and applies it. The layer under it becomes current. */
export function deleteLayer(doc: PaintDocument, index: number): Command {
  const layers = doc.layers.filter((_, i) => i !== index);
  return swapLayers(doc, 'Delete layer', layers, Math.max(0, Math.min(index - 1, layers.length - 1)));
}

/** Moves a layer from one place in the stack to another, and applies it. It stays current. */
export function moveLayer(doc: PaintDocument, from: number, to: number): Command {
  const layers = [...doc.layers];
  const [layer] = layers.splice(from, 1);
  layers.splice(to, 0, layer);
  return swapLayers(doc, to > from ? 'Move layer up' : 'Move layer down', layers, to);
}

/**
 * Merges the layer at `index` into the one under it, and applies it. Two object layers at the same
 * opacity stay objects; anything else becomes pixels. The result keeps the lower layer's name and opacity.
 */
export function mergeDown(doc: PaintDocument, index: number): Command {
  const upper = doc.layers[index];
  const lower = doc.layers[index - 1];
  let merged: Layer;
  if (upper.kind === 'objects' && lower.kind === 'objects' && upper.opacity === lower.opacity) {
    merged = createObjectLayer(lower.name, [...lower.objects, ...upper.objects]);
  } else {
    merged = createLayer(lower.name, doc.width, doc.height);
    const ctx = ctxOf(merged.canvas);
    // What's under both, for blur and pixelate marks; each layer is drawn on it too as it goes.
    const back = backdropFor(doc, index - 1);
    back.globalAlpha = lower.opacity;
    if (lower.kind === 'pixel') {
      ctx.drawImage(lower.canvas, 0, 0);
      back.drawImage(lower.canvas, 0, 0);
    } else {
      drawObjects(ctx, lower.objects, back);
    }
    back.globalAlpha = 1;
    drawLayer(ctx, upper, 1, back);
  }
  merged.opacity = lower.opacity;
  const layers = doc.layers.flatMap((l, i) => (i === index ? [] : i === index - 1 ? [merged] : [l]));
  return swapLayers(doc, 'Merge down', layers, index - 1);
}
