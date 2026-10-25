import { opaqueHex, parseHex } from '../app/color';
import { ctxOf, newCanvas, type PixelLayer } from '../engine/document';
import type { Command } from '../engine/history';
import { linePixels } from '../engine/pixels';
import { PixelEdit } from '../engine/tiles';

/** A stroke being drawn see-through, for the renderer to show over its layer until it ends. */
export interface LiveStroke {
  layer: PixelLayer;
  canvas: OffscreenCanvas;
  alpha: number;
  blend: GlobalCompositeOperation;
}

/**
 * - round: the brush, smooth and anti-aliased, with pen pressure.
 * - marker: a flat nib at an angle, see-through.
 * - highlighter: a tall flat nib that darkens what's under it instead of covering it.
 * - pencil: hard square pixels, no anti-aliasing.
 * - eraser: round, clearing to transparent (or painting the second colour, as a round brush).
 */
export type Nib = 'round' | 'marker' | 'highlighter' | 'pencil' | 'eraser';

export interface StrokeSpec {
  nib: Nib;
  color: string;
  size: number;
  /** 0 to 1. */
  opacity: number;
  smoothing: boolean;
  /** What pen pressure changes. Only the round brush uses it. */
  pressure: 'size' | 'opacity' | 'off';
  label: string;
}

export interface StrokePoint {
  x: number;
  y: number;
  /** Pen pressure, 0 to 1; 1 for a mouse. */
  p: number;
}

/** How see-through each nib is, on top of the opacity setting. */
const NIB_ALPHA: Record<Nib, number> = { round: 1, marker: 0.75, highlighter: 0.45, pencil: 1, eraser: 1 };

/** How far a smoothed point moves towards the pointer each time it moves. Lower is smoother but lags more. */
const FOLLOW = 0.45;

/**
 * One stroke of the brush, pencil or eraser. See-through strokes are drawn solid on their own
 * canvas and blended onto the layer when they end, so the stroke's own overlaps don't build up.
 */
export class Stroke {
  private edit: PixelEdit;
  readonly live: LiveStroke | null;
  private ctx: OffscreenCanvasRenderingContext2D;
  private bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  private readonly color: string;
  /** Pressure fades each piece, so pieces mustn't overlap: their ends are cut flat. */
  private readonly fade: boolean;
  /** Smoothed position, and the last two points the curve passed through. */
  private sm: StrokePoint;
  private prev: StrokePoint;
  private mid: StrokePoint;
  /** The last point the pointer was at, for Shift+click lines from it next time. */
  last: StrokePoint;

  constructor(
    layer: PixelLayer,
    private readonly spec: StrokeSpec,
    start: StrokePoint,
  ) {
    this.edit = new PixelEdit(layer, spec.label);
    const c = parseHex(spec.color) ?? { r: 0, g: 0, b: 0, a: 1 };
    this.color = opaqueHex(spec.color);
    this.fade = spec.nib === 'round' && spec.pressure === 'opacity';
    const alpha = spec.nib === 'eraser' && spec.color === 'clear' ? 1 : c.a * spec.opacity * NIB_ALPHA[spec.nib];
    const blend: GlobalCompositeOperation = spec.nib === 'highlighter' ? 'multiply' : 'source-over';
    const needsLive = spec.color !== 'clear' && (alpha < 1 || blend !== 'source-over' || this.fade);
    this.live = needsLive ? { layer, canvas: newCanvas(layer.canvas.width, layer.canvas.height), alpha, blend } : null;
    this.ctx = ctxOf(this.live ? this.live.canvas : layer.canvas);
    this.sm = this.prev = this.mid = this.last = start;
    this.dab(start);
  }

  private get erasing(): boolean {
    return this.spec.color === 'clear';
  }

  /** Notes an area about to change: straight to the undo snapshot, or kept for the end of a see-through stroke. */
  private mark(x0: number, y0: number, x1: number, y1: number): void {
    const pad = this.spec.size / 2 + 2;
    const left = Math.min(x0, x1) - pad;
    const top = Math.min(y0, y1) - pad;
    const w = Math.abs(x1 - x0) + pad * 2;
    const h = Math.abs(y1 - y0) + pad * 2;
    if (!this.live) return this.edit.touch(left, top, w, h);
    const b = this.bounds;
    b.x0 = Math.min(b.x0, left);
    b.y0 = Math.min(b.y0, top);
    b.x1 = Math.max(b.x1, left + w);
    b.y1 = Math.max(b.y1, top + h);
  }

  private width(p: number): number {
    const { size, nib, pressure } = this.spec;
    return nib === 'round' && pressure === 'size' ? Math.max(0.5, size * p) : size;
  }

  private begin(alpha = 1): OffscreenCanvasRenderingContext2D {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = this.erasing ? 'destination-out' : 'source-over';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = ctx.strokeStyle = this.erasing ? '#000000' : this.color;
    return ctx;
  }

  private end(): void {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
  }

  /** The mark the nib makes where the stroke starts. */
  private dab(pt: StrokePoint): void {
    const { nib } = this.spec;
    this.mark(pt.x, pt.y, pt.x, pt.y);
    if (nib === 'pencil') return this.pencil(pt, pt);
    const ctx = this.begin(this.fade ? pt.p : 1);
    if (nib === 'marker' || nib === 'highlighter') {
      this.nibShape(ctx, pt);
    } else {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, this.width(pt.p) / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    this.end();
  }

  /** The flat nib's half-length and half-thickness, as vectors. */
  private nibVectors(): { n: [number, number]; t: [number, number] } {
    const half = this.spec.size / 2;
    if (this.spec.nib === 'highlighter') return { n: [0, half], t: [Math.max(0.5, half * 0.3), 0] };
    const k = Math.SQRT1_2;
    const thick = Math.max(0.5, half * 0.3);
    return { n: [half * k, -half * k], t: [thick * k, thick * k] };
  }

  private nibShape(ctx: OffscreenCanvasRenderingContext2D, p: StrokePoint): void {
    const { n, t } = this.nibVectors();
    ctx.beginPath();
    ctx.moveTo(p.x + n[0] + t[0], p.y + n[1] + t[1]);
    ctx.lineTo(p.x + n[0] - t[0], p.y + n[1] - t[1]);
    ctx.lineTo(p.x - n[0] - t[0], p.y - n[1] - t[1]);
    ctx.lineTo(p.x - n[0] + t[0], p.y - n[1] + t[1]);
    ctx.closePath();
    ctx.fill();
  }

  /** The area the flat nib sweeps going from a to b. */
  private sweep(a: StrokePoint, b: StrokePoint): void {
    const ctx = this.begin();
    const { n } = this.nibVectors();
    ctx.beginPath();
    ctx.moveTo(a.x + n[0], a.y + n[1]);
    ctx.lineTo(b.x + n[0], b.y + n[1]);
    ctx.lineTo(b.x - n[0], b.y - n[1]);
    ctx.lineTo(a.x - n[0], a.y - n[1]);
    ctx.closePath();
    ctx.fill();
    this.nibShape(ctx, b);
    this.end();
  }

  private pencil(a: StrokePoint, b: StrokePoint): void {
    const ctx = this.begin();
    const s = Math.max(1, Math.round(this.spec.size));
    const off = Math.floor((s - 1) / 2);
    linePixels(Math.floor(a.x), Math.floor(a.y), Math.floor(b.x), Math.floor(b.y), (x, y) => ctx.fillRect(x - off, y - off, s, s));
    this.end();
  }

  /** A round piece from a to b, curving through `ctrl` when given. */
  private piece(a: StrokePoint, b: StrokePoint, ctrl?: StrokePoint): void {
    const p = (a.p + b.p) / 2;
    const ctx = this.begin(this.fade ? p : 1);
    ctx.lineWidth = this.width(p);
    ctx.lineCap = this.fade ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    if (ctrl) ctx.quadraticCurveTo(ctrl.x, ctrl.y, b.x, b.y);
    else ctx.lineTo(b.x, b.y);
    ctx.stroke();
    this.end();
  }

  to(raw: StrokePoint): void {
    const { nib, smoothing } = this.spec;
    this.last = raw;
    if (nib === 'pencil') {
      this.mark(this.prev.x, this.prev.y, raw.x, raw.y);
      this.pencil(this.prev, raw);
      this.prev = raw;
      return;
    }
    const smooth = smoothing && nib !== 'eraser';
    const pt = smooth
      ? { x: this.sm.x + (raw.x - this.sm.x) * FOLLOW, y: this.sm.y + (raw.y - this.sm.y) * FOLLOW, p: raw.p }
      : raw;
    this.sm = pt;
    if (nib === 'marker' || nib === 'highlighter') {
      this.mark(this.prev.x, this.prev.y, pt.x, pt.y);
      this.sweep(this.prev, pt);
      this.prev = pt;
      return;
    }
    if (!smooth) {
      this.mark(this.prev.x, this.prev.y, pt.x, pt.y);
      this.piece(this.prev, pt);
      this.prev = pt;
      return;
    }
    // A curve through the midpoints, bending at each smoothed point.
    const mid = { x: (this.prev.x + pt.x) / 2, y: (this.prev.y + pt.y) / 2, p: (this.prev.p + pt.p) / 2 };
    this.mark(Math.min(this.mid.x, this.prev.x, mid.x), Math.min(this.mid.y, this.prev.y, mid.y), Math.max(this.mid.x, this.prev.x, mid.x), Math.max(this.mid.y, this.prev.y, mid.y));
    this.piece(this.mid, mid, this.prev);
    this.mid = mid;
    this.prev = pt;
  }

  /** Draws a straight line from the stroke's start to `pt` (Shift+click). */
  lineTo(pt: StrokePoint): void {
    const smoothing = this.spec.smoothing;
    this.spec.smoothing = false;
    this.to(pt);
    this.spec.smoothing = smoothing;
    this.sm = this.mid = this.prev = pt;
  }

  finish(): Command | null {
    // Catch up with where the pointer stopped.
    const last = this.last;
    if (this.spec.nib !== 'pencil' && (this.prev.x !== last.x || this.prev.y !== last.y)) {
      const from = this.spec.smoothing && this.spec.nib === 'round' ? this.mid : this.prev;
      this.mark(from.x, from.y, last.x, last.y);
      if (this.spec.nib === 'marker' || this.spec.nib === 'highlighter') this.sweep(from, last);
      else this.piece(from, last, this.spec.smoothing && this.spec.nib === 'round' ? this.prev : undefined);
    }
    if (this.live) {
      const b = this.bounds;
      this.edit.touch(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      const ctx = ctxOf(this.edit.layer.canvas);
      ctx.globalAlpha = this.live.alpha;
      ctx.globalCompositeOperation = this.live.blend;
      ctx.drawImage(this.live.canvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    return this.edit.finish();
  }
}
