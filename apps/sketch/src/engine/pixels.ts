/** Pixel helpers that work on plain RGBA arrays, so they can be tested without a canvas. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The part of a picture inside its border, where the border is empty or one flat colour (the
 * top-left pixel's). Null when the whole picture is that colour.
 */
export function trimBounds(data: Uint8ClampedArray, width: number, height: number, tolerance = 4): Rect | null {
  const r0 = data[0];
  const g0 = data[1];
  const b0 = data[2];
  const a0 = data[3];
  const same = (i: number) => {
    const a = data[i + 3];
    if (a0 === 0 || a === 0) return a0 === a;
    return Math.abs(data[i] - r0) <= tolerance && Math.abs(data[i + 1] - g0) <= tolerance && Math.abs(data[i + 2] - b0) <= tolerance && Math.abs(a - a0) <= tolerance;
  };
  const rowBlank = (y: number) => {
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) if (!same(i)) return false;
    return true;
  };
  const colBlank = (x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) if (!same((y * width + x) * 4)) return false;
    return true;
  };
  let top = 0;
  while (top < height && rowBlank(top)) top++;
  if (top === height) return null;
  let bottom = height - 1;
  while (bottom > top && rowBlank(bottom)) bottom--;
  let left = 0;
  while (left < width && colBlank(left, top, bottom)) left++;
  let right = width - 1;
  while (right > left && colBlank(right, top, bottom)) right--;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** The smallest rectangle holding every pixel that isn't fully see-through; null when there's none. */
export function alphaBounds(data: Uint8ClampedArray, width: number, height: number): Rect | null {
  let left = width;
  let right = -1;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let first = -1;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] !== 0) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    if (top < 0) top = y;
    bottom = y;
    if (first < left) left = first;
    for (let x = width - 1; x > right; x--) {
      if (data[row + x * 4 + 3] !== 0) {
        right = x;
        break;
      }
    }
  }
  if (top < 0) return null;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** Calls `plot` for each pixel on the line from (x0, y0) to (x1, y1), ends included (Bresenham). */
export function linePixels(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    plot(x, y);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Makes pixels of one colour see-through, as Paint's transparent selection does. Returns how many changed. */
export function clearColor(data: Uint8ClampedArray, r: number, g: number, b: number, tolerance = 8): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] && Math.abs(data[i] - r) <= tolerance && Math.abs(data[i + 1] - g) <= tolerance && Math.abs(data[i + 2] - b) <= tolerance) {
      data[i + 3] = 0;
      n++;
    }
  }
  return n;
}

/**
 * The outline of a mask (1 = inside) as line segments along pixel edges, joined into runs.
 * Each segment is [x0, y0, x1, y1].
 */
export function maskOutline(mask: Uint8Array, width: number, height: number): number[][] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < width && y < height ? mask[y * width + x] : 0);
  const segs: number[][] = [];
  // Horizontal edges: between row y-1 and row y.
  for (let y = 0; y <= height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const edge = x < width && at(x, y - 1) !== at(x, y);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) {
        segs.push([start, y, x, y]);
        start = -1;
      }
    }
  }
  // Vertical edges: between column x-1 and column x.
  for (let x = 0; x <= width; x++) {
    let start = -1;
    for (let y = 0; y <= height; y++) {
      const edge = y < height && at(x - 1, y) !== at(x, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) {
        segs.push([x, start, x, y]);
        start = -1;
      }
    }
  }
  return segs;
}
