/**
 * Basic adjustments (step 5.3): brightness and contrast, hue and saturation, black and white, invert
 * and auto level. All but auto level are canvas filters, which Chromium runs on the GPU, so the live
 * preview keeps up while a slider is dragged. Auto level works out levels from the pixels first.
 */

import { ctxOf, newCanvas, type PixelLayer } from './document';
import type { Command } from './history';
import { PixelEdit } from './tiles';

export type Adjustment =
  | { kind: 'brightness'; brightness: number; contrast: number }
  | { kind: 'hue'; hue: number; saturation: number }
  | { kind: 'bw' }
  | { kind: 'invert' };

/** The canvas filter for an adjustment. Brightness, contrast and saturation run -100 to 100, hue -180 to 180 degrees. */
export function filterFor(a: Adjustment): string {
  switch (a.kind) {
    case 'brightness':
      return `brightness(${1 + a.brightness / 100}) contrast(${1 + a.contrast / 100})`;
    case 'hue':
      return `hue-rotate(${a.hue}deg) saturate(${1 + a.saturation / 100})`;
    case 'bw':
      return 'grayscale(1)';
    case 'invert':
      return 'invert(1)';
  }
}

/** True when the adjustment would change nothing. */
export function isNoChange(a: Adjustment): boolean {
  if (a.kind === 'brightness') return a.brightness === 0 && a.contrast === 0;
  if (a.kind === 'hue') return a.hue === 0 && a.saturation === 0;
  return false;
}

export const ADJUST_LABELS: Record<Adjustment['kind'] | 'auto', string> = {
  brightness: 'Brightness and contrast',
  hue: 'Hue and saturation',
  bw: 'Black and white',
  invert: 'Invert colours',
  auto: 'Auto level',
};

// ---------- Auto level ----------

/** Share of pixels at each end of a channel that auto level lets go dark or bright, so a few stray pixels don't stop it. */
const CLIP = 0.005;

/**
 * Each colour channel's darkest and brightest level, ignoring the outer half percent and see-through
 * pixels (and pixels outside `mask`, by its alpha). Null when there's nothing to go on.
 */
export function levelsOf(data: Uint8ClampedArray, mask?: Uint8ClampedArray): { lo: number[]; hi: number[] } | null {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8 || (mask && mask[i + 3] < 128)) continue;
    hist[0][data[i]]++;
    hist[1][data[i + 1]]++;
    hist[2][data[i + 2]]++;
    n++;
  }
  if (!n) return null;
  const cut = Math.floor(n * CLIP);
  const lo: number[] = [];
  const hi: number[] = [];
  for (const h of hist) {
    let sum = 0;
    let a = 0;
    while (a < 255 && sum + h[a] <= cut) sum += h[a++];
    sum = 0;
    let b = 255;
    while (b > 0 && sum + h[b] <= cut) sum += h[b--];
    lo.push(a);
    hi.push(Math.max(a, b));
  }
  return { lo, hi };
}

/** Stretches each channel so `lo` becomes black and `hi` white. A channel with almost no range is left alone. */
export function applyLevels(data: Uint8ClampedArray, lo: number[], hi: number[]): void {
  const maps = lo.map((l, c) => {
    const range = hi[c] - l;
    const m = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) m[v] = range < 2 ? v : Math.round(((v - l) * 255) / range);
    return m;
  });
  for (let i = 0; i < data.length; i += 4) {
    data[i] = maps[0][data[i]];
    data[i + 1] = maps[1][data[i + 1]];
    data[i + 2] = maps[2][data[i + 2]];
  }
}

// ---------- Applying ----------

/** The part of a layer to change: a rectangle, and which of its pixels (by the mask's opacity), or all of them. */
export interface AdjustArea {
  x: number;
  y: number;
  w: number;
  h: number;
  mask: OffscreenCanvas | null;
}

/** The area's pixels changed by an adjustment, cut to the mask. */
export function adjustedPart(src: OffscreenCanvas, area: AdjustArea, change: Adjustment | 'auto'): OffscreenCanvas {
  const { x, y, w, h, mask } = area;
  const part = newCanvas(w, h);
  const p = ctxOf(part);
  if (change === 'auto') {
    p.drawImage(src, x, y, w, h, 0, 0, w, h);
    const img = p.getImageData(0, 0, w, h);
    const m = mask ? ctxOf(mask).getImageData(0, 0, w, h).data : undefined;
    const levels = levelsOf(img.data, m);
    // One stretch for all three channels, so greys stay grey and colours keep their hue.
    if (levels) applyLevels(img.data, Array(3).fill(Math.min(...levels.lo)), Array(3).fill(Math.max(...levels.hi)));
    p.putImageData(img, 0, 0);
  } else {
    p.filter = filterFor(change);
    p.drawImage(src, x, y, w, h, 0, 0, w, h);
    p.filter = 'none';
  }
  if (mask) {
    p.globalCompositeOperation = 'destination-in';
    p.drawImage(mask, 0, 0);
  }
  return part;
}

/** Changes an area of a layer and returns the undo step. */
export function adjustLayer(layer: PixelLayer, area: AdjustArea, change: Adjustment | 'auto'): Command | null {
  const label = ADJUST_LABELS[change === 'auto' ? 'auto' : change.kind];
  const part = adjustedPart(layer.canvas, area, change);
  const edit = new PixelEdit(layer, label);
  edit.touch(area.x, area.y, area.w, area.h);
  const ctx = ctxOf(layer.canvas);
  if (area.mask) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(area.mask, area.x, area.y);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.clearRect(area.x, area.y, area.w, area.h);
  }
  ctx.drawImage(part, area.x, area.y);
  return edit.finish();
}
