import { boardGrowth, CAPTURE_MARGIN, contentBounds, frameOf, isOpen, objectsBounds, pictureArea } from '../engine/board';
import { growCanvas, resizeCanvas } from '../engine/commands';
import type { Command } from '../engine/history';
import type { SketchObject } from '../engine/objects';
import type { Rect } from '../engine/pixels';
import { app, toast } from './store';

/** How far past the pointer a stroke can reach without the board growing again, in picture pixels. */
const REACH = 3072;

/**
 * A whiteboard's or capture's canvas growing (or a capture's shrinking to what's drawn, `settleEdges`).
 * Growing up or left moves everything in the canvas's pixels, so the view moves the other way to keep
 * the picture still on screen, now and on undo and redo.
 */
class BoardGrowCommand implements Command {
  readonly bytes: number;

  constructor(
    private readonly inner: Command,
    private readonly dx: number,
    private readonly dy: number,
    readonly label: string,
    readonly joinNext = true,
  ) {
    this.bytes = inner.bytes;
    this.shift(1);
  }

  apply(): void {
    this.inner.apply();
    this.shift(1);
  }

  revert(): void {
    this.inner.revert();
    this.shift(-1);
  }

  private shift(dir: 1 | -1): void {
    const dx = this.dx * dir;
    const dy = this.dy * dir;
    if (!dx && !dy) return;
    const v = app.viewport;
    v.panX -= dx * v.zoom;
    v.panY -= dy * v.zoom;
    const lp = app.lastPoint;
    if (lp) app.lastPoint = { ...lp, x: lp.x + dx, y: lp.y + dy };
  }
}

let warnedFull = false;

/**
 * Grows a whiteboard's or capture's canvas to hold `need` (in its pixels) and returns the change,
 * already made but not recorded. Null when it needn't grow, or when this is any other picture.
 */
export function growBoard(need: Rect): Command | null {
  const doc = app.doc;
  if (!isOpen(doc)) return null;
  const g = boardGrowth(doc.width, doc.height, need, doc.board ? undefined : CAPTURE_MARGIN);
  const covers = (w: number, h: number, dx: number, dy: number) =>
    need.x + dx >= 0 && need.y + dy >= 0 && need.x + need.w + dx <= w && need.y + need.h + dy <= h;
  if (!(g ? covers(g.width, g.height, g.dx, g.dy) : covers(doc.width, doc.height, 0, 0)) && !warnedFull) {
    warnedFull = true;
    const what = doc.board ? "The whiteboard's" : "The picture's";
    toast(`${what} pixels can't grow any further this way. Shapes and text can still go anywhere.`, 6000);
  }
  if (!g) return null;
  const label = doc.board ? 'Grow whiteboard' : 'Grow canvas';
  return new BoardGrowCommand(growCanvas(doc, g.width, g.height, g.dx, g.dy, label), g.dx, g.dy, label);
}

/**
 * Before a change made in the picture's own size (Resize, Canvas Size): a capture that has grown past
 * its edges shrinks to exactly what a copy would hold, which becomes the picture. Made but not
 * recorded, so the caller records it with its change, or reverts it if nothing changes. Null when
 * there's nothing to shrink.
 */
export function settleEdges(): Command | null {
  const doc = app.doc;
  if (!doc.edges) return null;
  const f = frameOf(doc);
  const a = pictureArea(doc);
  const grown = f.w !== doc.width || f.h !== doc.height;
  if (!grown) return null;
  return new BoardGrowCommand(resizeCanvas(doc, a.w, a.h, 'Fit canvas', -a.x, -a.y), -a.x, -a.y, 'Fit canvas', false);
}

/** Grows the whiteboard to hold `need` as a step that joins the next one, so one undo takes both away. */
export function growBoardForNext(need: Rect | null): void {
  if (!need) return;
  const cmd = growBoard(need);
  if (cmd) app.history.record(cmd);
}

/** Before a pixel tool starts: the canvas must hold what's on screen near the pointer, wherever it was drawn before. */
export function growBoardForPointer(sx: number, sy: number): void {
  if (!isOpen(app.doc)) return;
  const v = app.viewport;
  const p = v.toDoc(sx, sy);
  const a = v.toDoc(0, 0);
  const b = v.toDoc(v.width, v.height);
  const x0 = Math.max(a.x, p.x - REACH);
  const y0 = Math.max(a.y, p.y - REACH);
  const x1 = Math.min(b.x, p.x + REACH);
  const y1 = Math.min(b.y, p.y + REACH);
  growBoardForNext({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

/** Before shapes and text become pixels: the canvas must hold them, as they can sit anywhere on a board or round a capture. */
export function growBoardForObjects(objects: readonly SketchObject[]): void {
  if (isOpen(app.doc)) growBoardForNext(objectsBounds(objects));
}

/**
 * Fits the picture in the view: a capture with everything drawn round it. A whiteboard fits what's on
 * it instead (never past `maxZoom`), or shows its middle at 100% when it's empty.
 */
export function fitView(maxZoom: number): void {
  const doc = app.doc;
  const v = app.viewport;
  if (doc.edges) {
    const a = pictureArea(doc);
    v.fit(a.w, a.h, maxZoom);
    v.panX = Math.round(v.panX - a.x * v.zoom);
    v.panY = Math.round(v.panY - a.y * v.zoom);
    return;
  }
  if (!doc.board) return v.fit(doc.width, doc.height, maxZoom);
  const r = contentBounds(doc);
  if (!r) {
    v.zoom = 1;
    v.center(doc.width, doc.height);
    return;
  }
  v.fit(r.w, r.h, maxZoom, 48);
  v.panX = Math.round(v.panX - r.x * v.zoom);
  v.panY = Math.round(v.panY - r.y * v.zoom);
}

/** Keeps a picture on screen while panning. A whiteboard has no edges to keep. */
export function clampView(): void {
  const doc = app.doc;
  if (!doc.board) app.viewport.clampPan(doc.width, doc.height);
}
