/**
 * Flood fill and the magic wand's area, on plain RGBA arrays (run in a worker).
 *
 * Colours are compared premultiplied by their opacity, so every fully see-through pixel counts as the
 * same colour. The distance runs from 0 (same colour) to 1 (opposite corners of the colour space).
 */

export interface Region {
  /** One byte per pixel of the whole picture: 1 inside the area. */
  mask: Uint8Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Vec4 = [number, number, number, number];

function pm(d: Uint8ClampedArray, i: number): Vec4 {
  const a = d[i + 3];
  const k = a / 255;
  return [d[i] * k, d[i + 1] * k, d[i + 2] * k, a];
}

/** The area of pixels like the one at (x, y): connected to it, or anywhere in the picture when `global`. */
export function floodRegion(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, tolerance: number, global: boolean): Region | null {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const [s0, s1, s2, s3] = pm(data, (y * width + x) * 4);
  // A little room even at 0%, for rounding in premultiplied colours.
  const limit = (tolerance * 510) ** 2 + 0.5;
  // dist2(pm(data, p * 4), seed) <= limit, worked out in place and remembered (1 like, 2 not):
  // the search asks about most pixels up to four times, and making arrays each time took most of
  // a 4K fill's time.
  const known = new Uint8Array(width * height);
  const match = (p: number) => {
    const seen = known[p];
    if (seen) return seen === 1;
    const i = p * 4;
    const a = data[i + 3];
    const k = a / 255;
    const r = data[i] * k - s0;
    const g = data[i + 1] * k - s1;
    const b = data[i + 2] * k - s2;
    const al = a - s3;
    const like = r * r + g * g + b * b + al * al <= limit;
    known[p] = like ? 1 : 2;
    return like;
  };
  const mask = new Uint8Array(width * height);
  let x0 = x;
  let y0 = y;
  let x1 = x;
  let y1 = y;

  if (global) {
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        if (!match(py * width + px)) continue;
        mask[py * width + px] = 1;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
    }
    return { mask, x0, y0, x1, y1 };
  }

  const stack: number[] = [x, y];
  while (stack.length) {
    const sy = stack.pop()!;
    const sx = stack.pop()!;
    const row = sy * width;
    if (mask[row + sx] || !match(row + sx)) continue;
    let l = sx;
    while (l > 0 && !mask[row + l - 1] && match(row + l - 1)) l--;
    let r = sx;
    while (r < width - 1 && !mask[row + r + 1] && match(row + r + 1)) r++;
    mask.fill(1, row + l, row + r + 1);
    if (l < x0) x0 = l;
    if (r > x1) x1 = r;
    if (sy < y0) y0 = sy;
    if (sy > y1) y1 = sy;
    for (let ny = sy - 1; ny <= sy + 1; ny += 2) {
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inRun = false;
      for (let px = l; px <= r; px++) {
        const ok = !mask[nrow + px] && match(nrow + px);
        if (ok && !inRun) stack.push(px, ny);
        inRun = ok;
      }
    }
  }
  return { mask, x0, y0, x1, y1 };
}

/** The region's mask cut down to its bounds. */
export function croppedMask(region: Region, width: number): { mask: Uint8Array; x: number; y: number; w: number; h: number } {
  const w = region.x1 - region.x0 + 1;
  const h = region.y1 - region.y0 + 1;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) mask.set(region.mask.subarray((region.y0 + y) * width + region.x0, (region.y0 + y) * width + region.x0 + w), y * w);
  return { mask, x: region.x0, y: region.y0, w, h };
}

/** How far past the area's edge the fill looks for soft edge pixels. */
const EDGE = 2;

/**
 * Fills the region with `color` (straight RGBA, 0 to 255) in `target`, and returns the changed area.
 *
 * Edge pixels just outside the area that are a blend of the area's colour and a line's colour (the
 * soft edge of an anti-aliased line) get the area's share of them swapped for the fill colour, so a
 * fill meets the line cleanly instead of leaving a fringe of the old colour. When `sample` is another
 * picture (sampling the whole picture while filling one layer), those pixels get the fill at partial
 * strength instead.
 */
export function fillRegion(
  target: Uint8ClampedArray,
  sample: Uint8ClampedArray,
  width: number,
  height: number,
  region: Region,
  color: Vec4,
  tolerance: number,
): { x: number; y: number; w: number; h: number } {
  const same = target === sample;
  const limit = (tolerance * 510) ** 2 + 0.5;
  const { mask } = region;
  const seedIndex = (() => {
    for (let y = region.y0; y <= region.y1; y++) for (let x = region.x0; x <= region.x1; x++) if (mask[y * width + x]) return (y * width + x) * 4;
    return 0;
  })();
  const S = pm(sample, seedIndex);
  const fa = color[3] / 255;
  const F: Vec4 = [color[0] * fa, color[1] * fa, color[2] * fa, color[3]];

  const bx0 = Math.max(0, region.x0 - EDGE);
  const by0 = Math.max(0, region.y0 - EDGE);
  const bx1 = Math.min(width - 1, region.x1 + EDGE);
  const by1 = Math.min(height - 1, region.y1 + EDGE);

  // Pixels within EDGE of the area, in all eight directions (the area grown one pixel at a time,
  // EDGE times), counted with running windows along each row and then down each column.
  const bw = bx1 - bx0 + 1;
  const bh = by1 - by0 + 1;
  const across = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const m = (y + by0) * width + bx0;
    const row = y * bw;
    let count = 0;
    for (let x = 0; x < EDGE && x < bw; x++) count += mask[m + x];
    for (let x = 0; x < bw; x++) {
      if (x + EDGE < bw) count += mask[m + x + EDGE];
      if (x > EDGE) count -= mask[m + x - EDGE - 1];
      across[row + x] = count > 0 ? 1 : 0;
    }
  }
  const near = new Uint8Array(bw * bh);
  const down = new Uint8Array(bw);
  for (let y = 0; y < EDGE && y < bh; y++) for (let x = 0; x < bw; x++) down[x] += across[y * bw + x];
  for (let y = 0; y < bh; y++) {
    const add = (y + EDGE) * bw;
    const drop = (y - EDGE - 1) * bw;
    const row = y * bw;
    for (let x = 0; x < bw; x++) {
      if (y + EDGE < bh) down[x] += across[add + x];
      if (y > EDGE) down[x] -= across[drop + x];
      near[row + x] = down[x] > 0 ? 1 : 0;
    }
  }

  const writeStraight = (i: number, p: Vec4) => {
    const a = Math.min(255, Math.max(0, p[3]));
    target[i + 3] = Math.round(a);
    if (a <= 0) return;
    const k = 255 / a;
    target[i] = Math.round(Math.min(255, Math.max(0, p[0] * k)));
    target[i + 1] = Math.round(Math.min(255, Math.max(0, p[1] * k)));
    target[i + 2] = Math.round(Math.min(255, Math.max(0, p[2] * k)));
  };

  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const p = y * width + x;
      const i = p * 4;
      if (mask[p]) {
        target[i] = color[0];
        target[i + 1] = color[1];
        target[i + 2] = color[2];
        target[i + 3] = color[3];
        continue;
      }
      if (!near[(y - by0) * bw + (x - bx0)]) continue;

      // The line colour: the neighbour outside the area that's furthest from the area's colour.
      // Worked out in plain numbers (the same sums as pm and the match above) rather than arrays,
      // since a photo's edges hold many pixels.
      const pa = sample[i + 3];
      const pk = pa / 255;
      const p0 = sample[i] * pk;
      const p1 = sample[i + 1] * pk;
      const p2 = sample[i + 2] * pk;
      const d0 = p0 - S[0];
      const d1 = p1 - S[1];
      const d2 = p2 - S[2];
      const d3 = pa - S[3];
      let best = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
      // The area's own colour, cut off by a thin line: leave it for its own fill.
      if (best <= limit) continue;
      let l0 = p0;
      let l1 = p1;
      let l2 = p2;
      let l3 = pa;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || mask[ny * width + nx]) continue;
          const j = (ny * width + nx) * 4;
          const qa = sample[j + 3];
          const qk = qa / 255;
          const q0 = sample[j] * qk;
          const q1 = sample[j + 1] * qk;
          const q2 = sample[j + 2] * qk;
          const e0 = q0 - S[0];
          const e1 = q1 - S[1];
          const e2 = q2 - S[2];
          const e3 = qa - S[3];
          const dq = e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3;
          if (dq > best) {
            best = dq;
            l0 = q0;
            l1 = q1;
            l2 = q2;
            l3 = qa;
          }
        }
      }
      const v0 = l0 - S[0];
      const v1 = l1 - S[1];
      const v2 = l2 - S[2];
      const v3 = l3 - S[3];
      const vv = v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3;
      if (vv < 1) continue;
      const a = Math.min(1, Math.max(0, (d0 * v0 + d1 * v1 + d2 * v2 + d3 * v3) / vv));
      if (a > 0.995) continue;
      // Only pixels that really are a blend of the two colours.
      const r0 = d0 - a * v0;
      const r1 = d1 - a * v1;
      const r2 = d2 - a * v2;
      const r3 = d3 - a * v3;
      if (r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3 > 0.0225 * vv + 64) continue;
      const P: Vec4 = [p0, p1, p2, pa];
      const cover = 1 - a;
      if (same) {
        writeStraight(i, [P[0] + cover * (F[0] - S[0]), P[1] + cover * (F[1] - S[1]), P[2] + cover * (F[2] - S[2]), P[3] + cover * (F[3] - S[3])]);
      } else {
        const T = pm(target, i);
        const k = cover * fa;
        writeStraight(i, [F[0] * cover + T[0] * (1 - k), F[1] * cover + T[1] * (1 - k), F[2] * cover + T[2] * (1 - k), F[3] * cover + T[3] * (1 - k)]);
      }
    }
  }
  return { x: bx0, y: by0, w: bw, h: bh };
}
