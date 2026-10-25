import { parseHex } from '../app/color';
import { app, changed, colorSignal, toast } from '../app/store';
import { onOptionChange, onToolChange, settingsOf, tools } from '../app/tools';
import { ctxOf, newCanvas, type PixelLayer } from '../engine/document';
import { CompositeCommand, type Command } from '../engine/history';
import { clearColor } from '../engine/pixels';
import { PixelEdit } from '../engine/tiles';
import {
  boundsOf,
  EDGE_HANDLES,
  handleCursor,
  handlePoint,
  insideBox,
  moveBox,
  resizeBox,
  rotateBox,
  type Box,
  type Handle,
  type Point,
} from './box';
import type { ToolDrag } from './drag';
import { floodArea } from './floodClient';

/**
 * A selected area of the current layer, or a pasted picture that hasn't been placed yet.
 *
 * The pixels stay in the layer until the selection is moved, resized or turned. Then they're
 * lifted off (leaving a see-through hole) and shown in the box until the selection is placed.
 */
export interface Selection extends Box {
  layer: PixelLayer;
  /** Where the picked pixels came from, in picture pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Which pixels of that rectangle are picked (by opacity), or null for all of them. */
  mask: OffscreenCanvas | null;
  /** The outline of the picked pixels, in the rectangle's own pixels. */
  outline: Path2D;
  /** The picked pixels once lifted (or pasted), before and after taking out the second colour. */
  raw: OffscreenCanvas | null;
  image: OffscreenCanvas | null;
  /** The colour taken out of `image` for a transparent selection, or null. */
  cleared: string | null;
  /** The change that lifted the pixels, kept open until the selection is placed. */
  lift: PixelEdit | null;
  /** A canvas growth made for a paste, undone if the paste is cancelled. */
  pendingResize: Command | null;
  pasted: boolean;
  flipX: boolean;
  flipY: boolean;
}

export const SELECT_TOOLS = ['select-rect', 'select-free', 'magic-wand'];
export const isSelectTool = (id: string) => SELECT_TOOLS.includes(id);

/** Handles are this many view pixels from the pointer to count as hit; the turn handle stands this far above the box. */
const HIT = 7;
export const ROTATE_GAP = 24;

function rectPath(w: number, h: number): Path2D {
  const p = new Path2D();
  p.rect(0, 0, w, h);
  return p;
}

function create(layer: PixelLayer, sx: number, sy: number, sw: number, sh: number, mask: OffscreenCanvas | null, outline: Path2D): Selection {
  return {
    layer,
    sx,
    sy,
    sw,
    sh,
    mask,
    outline,
    raw: null,
    image: null,
    cleared: null,
    lift: null,
    pendingResize: null,
    pasted: false,
    x: sx,
    y: sy,
    w: sw,
    h: sh,
    angle: 0,
    flipX: false,
    flipY: false,
  };
}

/** Clamps a rectangle to the picture; null when nothing of it is left. */
function clampRect(x: number, y: number, w: number, h: number) {
  const x0 = Math.max(0, Math.floor(Math.min(x, x + w)));
  const y0 = Math.max(0, Math.floor(Math.min(y, y + h)));
  const x1 = Math.min(app.doc.width, Math.ceil(Math.max(x, x + w)));
  const y1 = Math.min(app.doc.height, Math.ceil(Math.max(y, y + h)));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function selectRect(x: number, y: number, w: number, h: number): void {
  const r = clampRect(x, y, w, h);
  app.selection = r ? create(app.doc.paintLayer, r.x, r.y, r.w, r.h, null, rectPath(r.w, r.h)) : null;
  changed();
}

export function selectAll(): void {
  selectRect(0, 0, app.doc.width, app.doc.height);
}

function selectPolygon(points: Point[]): void {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const r = clampRect(minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY);
  if (!r || r.w < 2 || r.h < 2) {
    app.selection = null;
    return changed();
  }
  const outline = new Path2D();
  points.forEach((p, i) => (i ? outline.lineTo(p.x - r.x, p.y - r.y) : outline.moveTo(p.x - r.x, p.y - r.y)));
  outline.closePath();
  const mask = newCanvas(r.w, r.h);
  const m = ctxOf(mask);
  m.fillStyle = '#000';
  m.fill(outline);
  app.selection = create(app.doc.paintLayer, r.x, r.y, r.w, r.h, mask, outline);
  changed();
}

/** Selects an area from its mask pixels and outline runs (see floodArea). */
function selectMask(pixels: Uint8ClampedArray, runs: Int32Array, r: { x: number; y: number; w: number; h: number }): void {
  const mask = newCanvas(r.w, r.h);
  ctxOf(mask).putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
  const outline = new Path2D();
  for (let i = 0; i < runs.length; i += 4) {
    outline.moveTo(runs[i], runs[i + 1]);
    outline.lineTo(runs[i + 2], runs[i + 3]);
  }
  app.selection = create(app.doc.paintLayer, r.x, r.y, r.w, r.h, mask, outline);
  changed();
}

/** Shows a pasted picture at (x, y), ready to move, resize or turn before it's placed. */
export function pasteSelection(image: OffscreenCanvas, x: number, y: number, pendingResize: Command | null): void {
  const sel = create(app.doc.paintLayer, x, y, image.width, image.height, null, rectPath(image.width, image.height));
  sel.raw = image;
  sel.pasted = true;
  sel.pendingResize = pendingResize;
  refreshCleared(sel);
  app.selection = sel;
  changed();
}

export function isTransformed(sel: Selection): boolean {
  return sel.angle !== 0 || sel.flipX || sel.flipY || sel.w !== sel.sw || sel.h !== sel.sh;
}

/** Maps the picked rectangle's own pixels to where they show in the picture. */
export function matrixOf(sel: Selection): DOMMatrix {
  return new DOMMatrix()
    .translateSelf(sel.x + sel.w / 2, sel.y + sel.h / 2)
    .rotateSelf((sel.angle * 180) / Math.PI)
    .scaleSelf(((sel.flipX ? -1 : 1) * sel.w) / sel.sw, ((sel.flipY ? -1 : 1) * sel.h) / sel.sh)
    .translateSelf(-sel.sw / 2, -sel.sh / 2);
}

/** The colour a transparent selection leaves out: the second colour, when the option is on. */
function wantedClear(): string | null {
  return settingsOf(tools.slots.select).transparent ? app.secondary : null;
}

function refreshCleared(sel: Selection): void {
  const want = wantedClear();
  if (!sel.raw || (sel.image && want === sel.cleared)) return;
  if (!want) {
    sel.image = sel.raw;
  } else {
    const img = newCanvas(sel.raw.width, sel.raw.height);
    const ctx = ctxOf(img);
    ctx.drawImage(sel.raw, 0, 0);
    const c = parseHex(want)!;
    const data = ctx.getImageData(0, 0, img.width, img.height);
    clearColor(data.data, c.r, c.g, c.b);
    ctx.putImageData(data, 0, 0);
    sel.image = img;
  }
  sel.cleared = want;
}

/** Swaps a lifted or pasted selection's pixels for changed ones (an adjustment), keeping its other settings. */
export function replaceFloating(sel: Selection, raw: OffscreenCanvas): void {
  sel.raw = raw;
  sel.image = null;
  refreshCleared(sel);
  changed();
}

/** The picked pixels, cut out of their layer. */
function pickedPixels(sel: Selection): OffscreenCanvas {
  const c = newCanvas(sel.sw, sel.sh);
  const ctx = ctxOf(c);
  ctx.drawImage(sel.layer.canvas, sel.sx, sel.sy, sel.sw, sel.sh, 0, 0, sel.sw, sel.sh);
  if (sel.mask) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(sel.mask, 0, 0);
  }
  return c;
}

/** Takes the picked pixels off the layer, ready to move. False (with a message) when the layer is locked or hidden. */
function lift(sel: Selection): boolean {
  if (sel.raw) return true;
  const l = sel.layer;
  if (l.locked || !l.visible) {
    toast(`${l.name} is ${l.locked ? 'locked' : 'hidden'}. ${l.locked ? 'Unlock' : 'Show'} it in the Layers panel to change it.`, 4000);
    return false;
  }
  const edit = new PixelEdit(sel.layer, 'Move selection');
  edit.touch(sel.sx, sel.sy, sel.sw, sel.sh);
  sel.raw = pickedPixels(sel);
  const ctx = ctxOf(sel.layer.canvas);
  if (sel.mask) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(sel.mask, sel.sx, sel.sy);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.clearRect(sel.sx, sel.sy, sel.sw, sel.sh);
  }
  sel.lift = edit;
  refreshCleared(sel);
  return true;
}

function record(label: string, parts: (Command | null)[]): void {
  const list = parts.filter((c): c is Command => c !== null);
  if (list.length) app.history.record(new CompositeCommand(label, list));
}

/** Puts the selection down where it is. Enter, clicking outside it, or changing tools. */
export function placeSelection(): void {
  const sel = app.selection;
  if (!sel) return;
  app.selection = null;
  if (!sel.image) return changed();
  const moved = sel.pasted || isTransformed(sel) || sel.x !== sel.sx || sel.y !== sel.sy || sel.cleared !== null;
  if (!moved) {
    // Lifted but put back where it was: nothing to record.
    sel.lift?.finish()?.revert();
    return changed();
  }
  const edit = sel.lift ?? new PixelEdit(sel.layer, 'Paste');
  const b = boundsOf(sel);
  edit.touch(b.x, b.y, b.w, b.h);
  const ctx = ctxOf(sel.layer.canvas);
  ctx.save();
  ctx.setTransform(matrixOf(sel));
  ctx.imageSmoothingEnabled = isTransformed(sel);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sel.image, 0, 0);
  ctx.restore();
  const label = sel.pasted ? 'Paste' : isTransformed(sel) ? 'Transform selection' : 'Move selection';
  record(label, [sel.pendingResize, edit.finish()]);
  changed();
}

/** Esc: puts lifted pixels back where they came from, or throws a paste away. */
export function cancelSelection(): boolean {
  const sel = app.selection;
  if (!sel) return false;
  app.selection = null;
  sel.lift?.finish()?.revert();
  sel.pendingResize?.revert();
  changed();
  return true;
}

/** Delete: clears the selected pixels to transparent. `label` names the history step (moving the pixels to another tab cuts them, F14.3). */
export function deleteSelection(label = 'Delete selection'): void {
  const sel = app.selection;
  if (!sel) return;
  if (sel.pasted) {
    cancelSelection();
    return;
  }
  if (!lift(sel)) return;
  app.selection = null;
  record(label, [sel.lift!.finish()]);
  changed();
}

/** The selection's pixels as they look now, for copying. */
export function selectionImage(sel: Selection): OffscreenCanvas {
  const image = sel.image ?? pickedPixels(sel);
  if (!isTransformed(sel)) return image;
  const b = boundsOf(sel);
  const c = newCanvas(b.w, b.h);
  const ctx = ctxOf(c);
  ctx.setTransform(new DOMMatrix().translateSelf(-b.x, -b.y).multiplySelf(matrixOf(sel)));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0);
  return c;
}

export function nudgeSelection(dx: number, dy: number): void {
  const sel = app.selection;
  if (!sel || !lift(sel)) return;
  sel.x += dx;
  sel.y += dy;
  changed();
}

export function flipSelection(axis: 'h' | 'v'): void {
  const sel = app.selection!;
  if (!lift(sel)) return;
  if (axis === 'h') sel.flipX = !sel.flipX;
  else sel.flipY = !sel.flipY;
  changed();
}

export function rotateSelection(dir: 1 | -1): void {
  const sel = app.selection!;
  if (!lift(sel)) return;
  const a = sel.angle + (dir * Math.PI) / 2;
  sel.angle = Math.abs(Math.sin(a)) < 1e-9 && Math.cos(a) > 0 ? 0 : Math.atan2(Math.sin(a), Math.cos(a));
  changed();
}

// ---------- Pointer ----------

/** The handles' positions in view pixels. */
export function selectionHandles(sel: Selection): { id: Handle; x: number; y: number }[] {
  const v = app.viewport;
  return [...EDGE_HANDLES, 'rotate' as const].map((id) => {
    const p = handlePoint(sel, id, ROTATE_GAP / v.zoom);
    const s = v.toScreen(p.x, p.y);
    return { id, x: s.x, y: s.y };
  });
}

function hit(sel: Selection, sx: number, sy: number, p: Point): Handle | 'inside' | null {
  for (const h of selectionHandles(sel)) if (Math.abs(sx - h.x) <= HIT && Math.abs(sy - h.y) <= HIT) return h.id;
  return insideBox(sel, p.x, p.y) ? 'inside' : null;
}

export function selectionCursor(sx: number, sy: number, p: Point): string | null {
  const sel = app.selection;
  if (!sel) return null;
  const h = hit(sel, sx, sy, p);
  if (h === 'inside') return 'move';
  return h ? handleCursor(sel, h) : null;
}

/** Pressing on the selection's handles or inside it: resize, turn or move it. Null when the press missed it. */
export function selectionDrag(sx: number, sy: number, p: Point): ToolDrag | null {
  const sel = app.selection;
  if (!sel) return null;
  const h = hit(sel, sx, sy, p);
  if (!h) return null;
  const start: Box = { x: sel.x, y: sel.y, w: sel.w, h: sel.h, angle: sel.angle };
  const apply = (b: Box) => {
    if (!lift(sel)) return;
    Object.assign(sel, b);
    changed();
  };
  if (h === 'inside') {
    return {
      cursor: 'move',
      move: (q) => {
        if (q.x !== p.x || q.y !== p.y) apply(moveBox(start, q.x - p.x, q.y - p.y, true));
      },
      up: () => {},
      carry: { kind: 'selection' },
      cancel: () => {
        Object.assign(sel, start);
        changed();
      },
    };
  }
  if (h === 'rotate') {
    return { cursor: 'grabbing', move: (q, e) => apply(rotateBox(start, p, q, e.shiftKey)), up: () => {} };
  }
  return {
    cursor: handleCursor(sel, h),
    move: (q, e) => apply(resizeBox(start, h, q, { ratio: e.shiftKey ? start.w / start.h : null, round: start.angle === 0 })),
    up: () => {},
  };
}

/** Rectangle select: drag out a rectangle (Shift for a square). A click without a drag selects nothing. */
export function rectSelectDrag(p: Point): ToolDrag {
  const x0 = Math.round(p.x);
  const y0 = Math.round(p.y);
  const rectTo = (q: Point, square: boolean) => {
    let w = Math.round(q.x) - x0;
    let h = Math.round(q.y) - y0;
    if (square) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    return { x: x0, y: y0, w, h };
  };
  app.selection = null;
  changed();
  return {
    move: (q, e) => {
      app.marquee = { rect: rectTo(q, e.shiftKey) };
      changed();
    },
    up: (q, e) => {
      app.marquee = null;
      const r = rectTo(q, e.shiftKey);
      if (Math.abs(r.w) >= 1 && Math.abs(r.h) >= 1) selectRect(r.x, r.y, r.w, r.h);
      else changed();
    },
  };
}

/** Freehand select: draw round the area; the ends join when you let go. */
export function freeSelectDrag(p: Point): ToolDrag {
  const points: Point[] = [p];
  app.selection = null;
  app.marquee = { points };
  changed();
  return {
    move: (q) => {
      const last = points[points.length - 1];
      if (Math.hypot(q.x - last.x, q.y - last.y) * app.viewport.zoom < 2) return;
      points.push(q);
      app.requestRender();
    },
    up: () => {
      app.marquee = null;
      if (points.length >= 3) selectPolygon(points);
      else changed();
    },
  };
}

/** Magic wand: selects the area of similar colour around the click. */
export async function wandSelect(p: Point): Promise<void> {
  const doc = app.doc;
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) {
    app.selection = null;
    return changed();
  }
  const layer = doc.paintLayer;
  const data = ctxOf(layer.canvas).getImageData(0, 0, doc.width, doc.height);
  const tolerance = (settingsOf('magic-wand').tolerance as number) / 100;
  const area = await floodArea(data, x, y, tolerance);
  if (app.doc !== doc || !area) return;
  selectMask(area.pixels, area.outline, area.rect);
}

// The selection follows the transparent option and the second colour while it's lifted.
const refresh = () => {
  const sel = app.selection;
  if (!sel?.raw) return;
  refreshCleared(sel);
  changed();
};
onOptionChange((_, key) => key === 'transparent' && refresh());
colorSignal.on(refresh);

// Switching to a tool that doesn't use the selection puts it down, as in Paint.
onToolChange((_, to) => {
  if (!isSelectTool(to)) placeSelection();
});
