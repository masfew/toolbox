import { app } from '../app/store';
import { BOARD_BACKGROUND, frameOf, isOpen } from '../engine/board';
import { TILE } from '../engine/tiles';
import { currentTool } from '../app/tools';
import { onThemeChange } from '../app/theme';
import { ctxOf, newCanvas, type Layer } from '../engine/document';
import { drawObject, drawObjects, drawText } from '../engine/objects';
import { curvePoints, lineCurve, shapeCorners } from '../engine/shapes';
import { corners, type Point } from '../tools/box';
import { cropBox, cropHandles } from '../tools/crop';
import { isTransformed, matrixOf, selectionHandles } from '../tools/selection';
import { objectHandles, pickedObjects } from '../tools/shapes';
import { tailHandles } from '../tools/callout';

/** Smart guides are drawn in this pink, which stands out from the selection blue on most pictures. */
const GUIDE = '#f0368c';

/** A whiteboard's dots are this far apart in picture pixels, or a whole multiple of it when zoomed out. */
const DOT_STEP = 32;
/** Dots closer than this on screen are spaced out further, or left out. */
const DOT_MIN_GAP = 14;

export type HandleEdge = 'r' | 'b' | 'rb';
const HANDLE = 8;

/** Screen positions (CSS pixels) of the canvas resize handles, centred on each point. */
export function handlePositions(): Record<HandleEdge, { x: number; y: number }> {
  const v = app.viewport;
  const w = app.doc.width * v.zoom;
  const h = app.doc.height * v.zoom;
  const x = v.panX;
  const y = v.panY;
  return {
    r: { x: x + w + HANDLE / 2 + 2, y: y + h / 2 },
    b: { x: x + w / 2, y: y + h + HANDLE / 2 + 2 },
    rb: { x: x + w + HANDLE / 2 + 2, y: y + h + HANDLE / 2 + 2 },
  };
}

export function hitHandle(sx: number, sy: number): HandleEdge | null {
  // A whiteboard and a capture grow by themselves, so they have no size handles.
  if (isOpen(app.doc)) return null;
  const hs = handlePositions();
  for (const edge of ['rb', 'r', 'b'] as HandleEdge[]) {
    const p = hs[edge];
    if (Math.abs(sx - p.x) <= HANDLE && Math.abs(sy - p.y) <= HANDLE) return edge;
  }
  return null;
}

interface Theme {
  workspace: string;
  handleFill: string;
  handleStroke: string;
  outline: string;
  checkA: string;
  checkB: string;
}

function readTheme(): Theme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    workspace: v('--workspace'),
    handleFill: v('--handle-fill'),
    handleStroke: v('--handle-stroke'),
    outline: v('--accent'),
    checkA: v('--check-a'),
    checkB: v('--check-b'),
  };
}

/** Draws the picture, the selection, the crop box, the pixel grid and the handles on the view canvas. */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private pending = false;
  private theme: Theme;
  private checker: CanvasPattern | null = null;
  /** Halved copies of the canvas being drawn, for shrinking big pictures (see drawShrunk). */
  private halves: OffscreenCanvas[] = [];
  onFirstFrame: (() => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.theme = readTheme();
    this.buildChecker();
    onThemeChange(() => {
      this.theme = readTheme();
      this.buildChecker();
      this.request();
    });
  }

  private buildChecker(): void {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 16;
    const t = tile.getContext('2d')!;
    t.fillStyle = this.theme.checkA;
    t.fillRect(0, 0, 16, 16);
    t.fillStyle = this.theme.checkB;
    t.fillRect(0, 0, 8, 8);
    t.fillRect(8, 8, 8, 8);
    this.checker = this.ctx.createPattern(tile, 'repeat');
  }

  /** Matches the canvas to its element's size. Returns true if the size changed. */
  resize(): boolean {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * this.dpr);
    const h = Math.round(r.height * this.dpr);
    app.viewport.width = r.width;
    app.viewport.height = r.height;
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.request();
    return true;
  }

  request(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
      if (this.onFirstFrame) {
        const fn = this.onFirstFrame;
        this.onFirstFrame = null;
        fn();
      }
    });
  }

  private draw(): void {
    const { ctx, dpr, theme } = this;
    const v = app.viewport;
    const doc = app.doc;
    // Whole device pixels keep the picture sharp at 100%.
    const panX = Math.round(v.panX * dpr) / dpr;
    const panY = Math.round(v.panY * dpr) / dpr;
    const toolId = currentTool().id;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = doc.board ? BOARD_BACKGROUND : theme.workspace;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (doc.board) {
      this.drawDots(panX, panY);
    } else {
      // Shadow and transparency checkerboard behind the picture. A capture that has grown past its
      // edges has them behind the capture only; what's drawn round it shows on the workspace.
      const f = frameOf(doc);
      const fx = panX + f.x * v.zoom;
      const fy = panY + f.y * v.zoom;
      const fw = f.w * v.zoom;
      const fh = f.h * v.zoom;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = theme.checkA;
      ctx.fillRect(fx, fy, fw, fh);
      ctx.restore();
      if (this.checker) {
        this.checker.setTransform(new DOMMatrix([1, 0, 0, 1, fx, fy]));
        ctx.fillStyle = this.checker;
        ctx.fillRect(fx, fy, fw, fh);
      }
    }

    // Layers, smoothed only when zoomed out. Everything on a picture is clipped to it; a whiteboard has
    // no edge, and a capture's are open.
    const docTransform = new DOMMatrix([dpr * v.zoom, 0, 0, dpr * v.zoom, panX * dpr, panY * dpr]);
    ctx.setTransform(docTransform);
    ctx.save();
    if (!isOpen(doc)) {
      ctx.beginPath();
      ctx.rect(0, 0, doc.width, doc.height);
      ctx.clip();
    }
    ctx.imageSmoothingEnabled = v.zoom < 1;
    ctx.imageSmoothingQuality = 'high';
    for (const layer of doc.layers) if (layer.visible) this.drawLayer(layer);
    const te = app.textEdit;
    if (te && !te.original) drawText(ctx, te.obj);
    if (app.draft) drawObject(ctx, app.draft);
    ctx.restore();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (app.showGrid && v.zoom >= 8 && !doc.board) this.drawGrid(panX, panY);

    if (toolId === 'crop') this.drawCrop(docTransform);
    this.drawSelectionFrame(docTransform);
    this.drawPicked();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const t of tailHandles()) {
      const s = v.toScreen(t.x, t.y);
      this.roundHandle(s.x, s.y);
    }
    this.drawGuides();
    this.drawMarquee(docTransform);

    if (app.resizePreview) {
      this.dashedRect(panX - 0.5, panY - 0.5, app.resizePreview.w * v.zoom + 1, app.resizePreview.h * v.zoom + 1);
    }

    const sp = app.sizePreview;
    if (sp) this.circle(sp.x, sp.y, (sp.size * v.zoom) / 2);

    // Canvas resize handles. The crop tool has its own handles on the picture's edges.
    if (toolId !== 'crop' && !isOpen(doc)) {
      ctx.lineWidth = 1;
      for (const p of Object.values(handlePositions())) this.handle(p.x, p.y);
    }
  }

  /**
   * One layer: its pixels (with a stroke being drawn, an adjustment's preview or a floating selection on
   * them), then its objects over them, as `drawLayer` draws it everywhere else.
   */
  private drawLayer(layer: Layer): void {
    const ctx = this.ctx;
    if (app.adjustPreview?.layer === layer) {
      const ap = app.adjustPreview;
      ctx.globalAlpha = layer.opacity;
      if (ap.filter) ctx.filter = ap.filter;
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.filter = 'none';
      if (ap.part) ctx.drawImage(ap.part, ap.x, ap.y);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = layer.opacity;
      this.drawShrunk(layer.canvas);
      ctx.globalAlpha = 1;
    }
    const live = app.liveStroke;
    if (live && live.layer === layer) {
      ctx.globalAlpha = layer.opacity * live.alpha;
      ctx.globalCompositeOperation = live.blend;
      this.drawShrunk(live.canvas);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    const sel = app.selection;
    if (sel?.image && sel.layer === layer) {
      ctx.save();
      ctx.transform(...(matrixArgs(matrixOf(sel)) as [number, number, number, number, number, number]));
      if (isTransformed(sel)) ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(sel.image, 0, 0);
      ctx.restore();
    }
    if (!layer.objects.length) return;
    const te = app.textEdit;
    // Text being typed shows in place of the saved one.
    const objects = te?.original && te.layer === layer ? layer.objects.map((o) => (o.id === te.obj.id ? te.obj : o)) : layer.objects;
    ctx.globalAlpha = layer.opacity;
    drawObjects(ctx, objects);
    ctx.globalAlpha = 1;
  }

  /**
   * Draws a picture-sized canvas at picture position (0, 0). Shrinking a canvas to under half its
   * size with high-quality smoothing makes the browser build smaller copies of all of it on every
   * frame: 37 ms a frame for an 8K picture, so drawing on one ran at about 60 frames a second. So
   * it's halved first, as many times as the zoom allows, with plain smoothing (which at exactly half
   * size averages each 2 × 2 block, as those copies do), and the last, small copy drawn with
   * high-quality smoothing as before.
   */
  private drawShrunk(source: OffscreenCanvas): void {
    const ctx = this.ctx;
    const scale = ctx.getTransform().a;
    if (!ctx.imageSmoothingEnabled || scale >= 0.5) {
      ctx.drawImage(source, 0, 0);
      return;
    }
    let from: OffscreenCanvas = source;
    let w = source.width;
    let h = source.height;
    let f = 1;
    for (let i = 0; f / 2 >= scale; i++) {
      const hw = Math.ceil(w / 2);
      const hh = Math.ceil(h / 2);
      let half = this.halves[i];
      if (!half || half.width !== hw || half.height !== hh) half = this.halves[i] = newCanvas(hw, hh);
      const hc = ctxOf(half);
      hc.clearRect(0, 0, hw, hh);
      hc.imageSmoothingEnabled = true;
      hc.imageSmoothingQuality = 'low';
      hc.drawImage(from, 0, 0, w, h, 0, 0, w / 2, h / 2);
      from = half;
      w = hw;
      h = hh;
      f /= 2;
    }
    ctx.drawImage(from, 0, 0, w, h, 0, 0, w / f, h / f);
  }

  /** The selection's dashed outline, and its handles for resizing and turning. */
  private drawSelectionFrame(docTransform: DOMMatrix): void {
    const sel = app.selection;
    if (!sel) return;
    const { ctx, dpr } = this;
    const zoom = app.viewport.zoom;
    // The outline, mapped into the view, with lines a pixel wide whatever the zoom.
    const path = new Path2D();
    path.addPath(sel.outline, matrixOf(sel));
    ctx.save();
    ctx.setTransform(docTransform);
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke(path);
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.strokeStyle = this.theme.outline;
    ctx.stroke(path);
    ctx.restore();

    // The box, when it isn't just the outline.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = app.viewport;
    const pts = corners(sel).map((p) => v.toScreen(p.x, p.y));
    if (sel.mask || sel.angle) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.lineWidth = 1;
      ctx.strokeStyle = this.theme.handleStroke;
      ctx.setLineDash([2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this.boxHandles(selectionHandles(sel));
  }

  /** A box's eight square handles, and its turn handle on a stalk above the top edge. */
  private boxHandles(handles: { id: string; x: number; y: number }[]): void {
    const ctx = this.ctx;
    const rot = handles.find((h) => h.id === 'rotate')!;
    const top = handles.find((h) => h.id === 'n')!;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(rot.x, rot.y);
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.theme.handleStroke;
    ctx.stroke();
    for (const h of handles) {
      if (h.id === 'rotate') this.roundHandle(h.x, h.y);
      else this.handle(h.x, h.y);
    }
  }

  /**
   * Picked shapes and lines: an outline round each one, and when just one is picked, its handles.
   * A shape gets a box with handles; a line gets its two ends and a round handle in the middle for bending.
   */
  private drawPicked(): void {
    const picked = pickedObjects();
    if (!picked) return;
    const { ctx, dpr } = this;
    const v = app.viewport;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const o of picked.objects) {
      const pts: Point[] = (o.type === 'line' ? curvePoints(lineCurve(o), 24) : shapeCorners(o)).map((p) => v.toScreen(p.x, p.y));
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (o.type !== 'line') ctx.closePath();
      ctx.strokeStyle = this.theme.outline;
      ctx.stroke();
    }
    if (picked.objects.length !== 1) return;
    const o = picked.objects[0];
    const handles = objectHandles(o);
    if (o.type !== 'line') return this.boxHandles(handles);
    for (const h of handles) {
      if (h.id === 'bend') this.roundHandle(h.x, h.y);
      else this.handle(h.x, h.y);
    }
  }

  /** Smart guides: lines where edges and centres line up, and markers across gaps that match. */
  private drawGuides(): void {
    if (!app.guides.length) return;
    const { ctx, dpr } = this;
    const v = app.viewport;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = GUIDE;
    ctx.beginPath();
    for (const g of app.guides) {
      const a = v.toScreen(g.x1, g.y1);
      const b = v.toScreen(g.x2, g.y2);
      // Lines on whole pixels stay sharp.
      const ax = Math.round(a.x) + 0.5;
      const ay = Math.round(a.y) + 0.5;
      const bx = Math.round(b.x) + 0.5;
      const by = Math.round(b.y) + 0.5;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      if (g.kind === 'gap') {
        // Little end marks across the gap.
        const across = ay === by;
        for (const [x, y] of [
          [ax, ay],
          [bx, by],
        ]) {
          ctx.moveTo(across ? x : x - 4, across ? y - 4 : y);
          ctx.lineTo(across ? x : x + 4, across ? y + 4 : y);
        }
      }
    }
    ctx.stroke();
  }

  /** A rectangle or freehand outline being dragged out. */
  private drawMarquee(docTransform: DOMMatrix): void {
    const m = app.marquee;
    if (!m) return;
    const { ctx } = this;
    const zoom = app.viewport.zoom;
    const path = new Path2D();
    if (m.rect) path.rect(m.rect.x, m.rect.y, m.rect.w, m.rect.h);
    if (m.points) m.points.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    ctx.save();
    ctx.setTransform(docTransform);
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke(path);
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.strokeStyle = this.theme.outline;
    ctx.stroke(path);
    ctx.restore();
  }

  /** Darkens what the crop leaves out, with thirds lines and handles on the box. */
  private drawCrop(docTransform: DOMMatrix): void {
    const { ctx, dpr } = this;
    const doc = app.doc;
    const b = cropBox();
    ctx.save();
    ctx.setTransform(docTransform);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, doc.width, doc.height);
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.fill('evenodd');
    ctx.restore();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = app.viewport;
    const a = v.toScreen(b.x, b.y);
    const z = v.toScreen(b.x + b.w, b.y + b.h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    for (const t of [1 / 3, 2 / 3]) {
      const x = Math.round(a.x + (z.x - a.x) * t) + 0.5;
      const y = Math.round(a.y + (z.y - a.y) * t) + 0.5;
      ctx.moveTo(x, a.y);
      ctx.lineTo(x, z.y);
      ctx.moveTo(a.x, y);
      ctx.lineTo(z.x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(z.x - a.x) - 1, Math.round(z.y - a.y) - 1);
    for (const h of cropHandles()) this.handle(h.x, h.y);
  }

  private roundHandle(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.fillStyle = this.theme.handleFill;
    ctx.fill();
    ctx.strokeStyle = this.theme.handleStroke;
    ctx.stroke();
  }

  private handle(x: number, y: number): void {
    const ctx = this.ctx;
    const hx = Math.round(x - HANDLE / 2) + 0.5;
    const hy = Math.round(y - HANDLE / 2) + 0.5;
    ctx.lineWidth = 1;
    ctx.fillStyle = this.theme.handleFill;
    ctx.fillRect(hx, hy, HANDLE, HANDLE);
    ctx.strokeStyle = this.theme.handleStroke;
    ctx.strokeRect(hx, hy, HANDLE, HANDLE);
  }

  /** A size circle, dark and light so it shows on any colour. */
  private circle(x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.lineWidth = 1;
    for (const [color, inset] of [['rgba(0,0,0,0.7)', 0], ['rgba(255,255,255,0.9)', 1]] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, Math.max(1, r) - inset), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private dashedRect(x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = this.theme.outline;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  /**
   * A whiteboard's dot grid, shown on screen only. The spacing divides a tile, and the board grows in
   * whole tiles, so the dots stay put when it grows up or left.
   */
  private drawDots(panX: number, panY: number): void {
    const v = app.viewport;
    let step = DOT_STEP;
    while (step * v.zoom < DOT_MIN_GAP && step < TILE) step *= 2;
    const gap = step * v.zoom;
    if (gap < DOT_MIN_GAP) return;
    const ctx = this.ctx;
    const r = gap < 24 ? 0.75 : 1;
    const i0 = Math.ceil(-panX / gap);
    const i1 = Math.floor((v.width - panX) / gap);
    const j0 = Math.ceil(-panY / gap);
    const j1 = Math.floor((v.height - panY) / gap);
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const x = Math.round(panX + i * gap);
      for (let j = j0; j <= j1; j++) ctx.rect(x - r, Math.round(panY + j * gap) - r, r * 2, r * 2);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fill();
  }

  private drawGrid(panX: number, panY: number): void {
    const { ctx } = this;
    const v = app.viewport;
    const doc = app.doc;
    const x0 = Math.max(0, Math.floor(-panX / v.zoom));
    const y0 = Math.max(0, Math.floor(-panY / v.zoom));
    const x1 = Math.min(doc.width, Math.ceil((v.width - panX) / v.zoom));
    const y1 = Math.min(doc.height, Math.ceil((v.height - panY) / v.zoom));
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      const sx = Math.round(panX + x * v.zoom) + 0.5;
      ctx.moveTo(sx, panY + y0 * v.zoom);
      ctx.lineTo(sx, panY + y1 * v.zoom);
    }
    for (let y = y0; y <= y1; y++) {
      const sy = Math.round(panY + y * v.zoom) + 0.5;
      ctx.moveTo(panX + x0 * v.zoom, sy);
      ctx.lineTo(panX + x1 * v.zoom, sy);
    }
    ctx.lineWidth = 1 / this.dpr;
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.stroke();
  }
}

function matrixArgs(m: DOMMatrix): number[] {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}
