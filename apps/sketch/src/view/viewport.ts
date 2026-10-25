export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

/** Zoom levels that Ctrl+= and Ctrl+- step through. */
const STEPS = [0.02, 0.05, 0.1, 0.125, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Maps picture pixels to screen (CSS) pixels: screen = doc × zoom + pan. */
export class Viewport {
  zoom = 1;
  panX = 0;
  panY = 0;
  /** Size of the view in CSS pixels. */
  width = 0;
  height = 0;

  toDoc(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  toScreen(dx: number, dy: number): { x: number; y: number } {
    return { x: dx * this.zoom + this.panX, y: dy * this.zoom + this.panY };
  }

  /** Sets the zoom while keeping the picture point under (sx, sy) in place. */
  setZoomAt(zoom: number, sx: number, sy: number): void {
    const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const p = this.toDoc(sx, sy);
    this.zoom = z;
    this.panX = sx - p.x * z;
    this.panY = sy - p.y * z;
  }

  zoomBy(factor: number, sx: number, sy: number): void {
    this.setZoomAt(this.zoom * factor, sx, sy);
  }

  /** The next preset zoom in (dir 1) or out (dir -1), around the view's centre. */
  step(dir: 1 | -1): void {
    const z = this.zoom;
    const next = dir > 0 ? STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM : [...STEPS].reverse().find((s) => s < z / 1.001) ?? MIN_ZOOM;
    this.setZoomAt(next, this.width / 2, this.height / 2);
  }

  /** Fits the picture in the view with a margin, never zooming in past `maxZoom`. */
  fit(docW: number, docH: number, maxZoom = MAX_ZOOM, margin = 32): void {
    const availW = Math.max(1, this.width - margin * 2);
    const availH = Math.max(1, this.height - margin * 2);
    this.zoom = clamp(Math.min(availW / docW, availH / docH, maxZoom), MIN_ZOOM, MAX_ZOOM);
    this.center(docW, docH);
  }

  center(docW: number, docH: number): void {
    this.panX = Math.round((this.width - docW * this.zoom) / 2);
    this.panY = Math.round((this.height - docH * this.zoom) / 2);
  }

  /** Keeps at least `keep` pixels of the picture on screen, so it can't be lost off the edge. */
  clampPan(docW: number, docH: number, keep = 64): void {
    const w = docW * this.zoom;
    const h = docH * this.zoom;
    const kx = Math.min(keep, w);
    const ky = Math.min(keep, h);
    this.panX = clamp(this.panX, kx - w, this.width - kx);
    this.panY = clamp(this.panY, ky - h, this.height - ky);
  }
}
