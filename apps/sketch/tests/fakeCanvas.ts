/**
 * A small stand-in for `OffscreenCanvas` so layer code can run in Vitest's Node environment: real RGBA
 * pixels with source-over and destination-out blending, `globalAlpha`, translation and unscaled
 * `drawImage`. Objects aren't drawn with paths here; tests that draw them mock `drawObjects` with
 * `fakeDrawObjects`, which paints each object's box in its colour. Not a test file itself.
 */
import { vi } from 'vitest';

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

function parseColor(c: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (!m) throw new Error(`The fake canvas can't read the colour ${c}`);
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255];
}

class FakeContext {
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  fillStyle = '#000000';
  strokeStyle = '#000000';
  lineWidth = 1;
  filter = 'none';
  font = '10px sans-serif';
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'low';
  private tx = 0;
  private ty = 0;
  private stack: { alpha: number; op: string; fill: string; tx: number; ty: number }[] = [];

  constructor(readonly canvas: FakeCanvas) {}

  save(): void {
    this.stack.push({ alpha: this.globalAlpha, op: this.globalCompositeOperation, fill: this.fillStyle, tx: this.tx, ty: this.ty });
  }
  restore(): void {
    const s = this.stack.pop();
    if (!s) return;
    this.globalAlpha = s.alpha;
    this.globalCompositeOperation = s.op;
    this.fillStyle = s.fill;
    this.tx = s.tx;
    this.ty = s.ty;
  }
  translate(x: number, y: number): void {
    this.tx += x;
    this.ty += y;
  }
  setTransform(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0): void {
    if (a !== 1 || b !== 0 || c !== 0 || d !== 1) throw new Error('The fake canvas only moves, it never scales or turns');
    this.tx = e;
    this.ty = f;
  }
  measureText(s: string): { width: number; fontBoundingBoxAscent: number; fontBoundingBoxDescent: number } {
    return { width: s.length * 10, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4 };
  }

  /** Blends one pixel (straight alpha, 0 to 255) onto the canvas at (x, y). */
  private blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    const c = this.canvas;
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
    const i = (y * c.width + x) * 4;
    const d = c.data;
    const sa = (a / 255) * this.globalAlpha;
    const da = d[i + 3] / 255;
    if (this.globalCompositeOperation === 'destination-out') {
      d[i + 3] = Math.round(da * (1 - sa) * 255);
      return;
    }
    const oa = sa + da * (1 - sa);
    if (oa === 0) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      return;
    }
    d[i] = Math.round((r * sa + d[i] * da * (1 - sa)) / oa);
    d[i + 1] = Math.round((g * sa + d[i + 1] * da * (1 - sa)) / oa);
    d[i + 2] = Math.round((b * sa + d[i + 2] * da * (1 - sa)) / oa);
    d[i + 3] = Math.round(oa * 255);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, a] = parseColor(this.fillStyle);
    const x0 = Math.round(x + this.tx);
    const y0 = Math.round(y + this.ty);
    for (let yy = y0; yy < y0 + Math.round(h); yy++) for (let xx = x0; xx < x0 + Math.round(w); xx++) this.blend(xx, yy, r, g, b, a);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    const c = this.canvas;
    const x0 = Math.max(0, Math.round(x + this.tx));
    const y0 = Math.max(0, Math.round(y + this.ty));
    for (let yy = y0; yy < Math.min(c.height, y0 + Math.round(h)); yy++) c.data.fill(0, (yy * c.width + x0) * 4, (yy * c.width + Math.min(c.width, x0 + Math.round(w))) * 4);
  }
  drawImage(src: Pixels, ...n: number[]): void {
    let [sx, sy, sw, sh, dx, dy, dw, dh] = [0, 0, src.width, src.height, 0, 0, src.width, src.height];
    if (n.length === 2) [dx, dy] = n;
    else if (n.length === 4) [dx, dy, dw, dh] = n;
    else [sx, sy, sw, sh, dx, dy, dw, dh] = n;
    if (dw !== sw || dh !== sh) throw new Error('The fake canvas never scales images');
    dx = Math.round(dx + this.tx);
    dy = Math.round(dy + this.ty);
    // Read first, so drawing a canvas onto itself works.
    const from = new Uint8ClampedArray(src.data);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const px = sx + x;
        const py = sy + y;
        if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
        const i = (py * src.width + px) * 4;
        if (from[i + 3] === 0 && this.globalCompositeOperation === 'source-over') continue;
        this.blend(dx + x, dy + y, from[i], from[i + 1], from[i + 2], from[i + 3]);
      }
    }
  }
  getImageData(x: number, y: number, w: number, h: number): Pixels {
    const c = this.canvas;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const px = x + xx;
        const py = y + yy;
        if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
        out.set(c.data.subarray((py * c.width + px) * 4, (py * c.width + px) * 4 + 4), (yy * w + xx) * 4);
      }
    }
    return { width: w, height: h, data: out };
  }
  putImageData(img: Pixels, x: number, y: number): void {
    const c = this.canvas;
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const px = x + xx;
        const py = y + yy;
        if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
        c.data.set(img.data.subarray((yy * img.width + xx) * 4, (yy * img.width + xx) * 4 + 4), (py * c.width + px) * 4);
      }
    }
  }
}

export class FakeCanvas implements Pixels {
  data: Uint8ClampedArray;
  private ctx: FakeContext | null = null;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  getContext(): FakeContext {
    return (this.ctx ??= new FakeContext(this));
  }
  close(): void {}
}

/** A canvas's pixels as "PNG" bytes the fake `createImageBitmap` reads back: a size header, then RGBA. */
export function fakePng(c: OffscreenCanvas): Promise<Uint8Array> {
  const f = c as unknown as FakeCanvas;
  const out = new Uint8Array(8 + f.data.length);
  new DataView(out.buffer).setUint32(0, f.width);
  new DataView(out.buffer).setUint32(4, f.height);
  out.set(f.data, 8);
  return Promise.resolve(out);
}

async function fakeBitmap(blob: Blob): Promise<FakeCanvas> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const c = new FakeCanvas(view.getUint32(0), view.getUint32(4));
  c.data.set(bytes.subarray(8));
  return c;
}

/** Puts the stand-ins in place of `OffscreenCanvas` and `createImageBitmap`. Undo with `vi.unstubAllGlobals`. */
export function installFakeCanvas(): void {
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('createImageBitmap', fakeBitmap);
}

/** The colour an object is painted in by `fakeDrawObjects`. */
export function colorOf(o: { type: string; stroke?: string; color?: string }): string {
  return (o.type === 'shape' ? o.stroke : o.color) ?? '#000000';
}

/** The RGBA of one pixel of a canvas. */
export function pixel(c: OffscreenCanvas, x: number, y: number): number[] {
  const f = c as unknown as FakeCanvas;
  const i = (y * f.width + x) * 4;
  return [...f.data.subarray(i, i + 4)];
}
