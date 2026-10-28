import { ctxOf, newCanvas, type Layer } from './document';
import type { Command } from './history';

export const TILE = 256;

export interface TileRange {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The tiles a rectangle overlaps, clamped to the canvas. Empty when x1 < x0 or y1 < y0. */
export function tileRange(x: number, y: number, w: number, h: number, canvasW: number, canvasH: number): TileRange {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(canvasW, Math.ceil(x + w));
  const bottom = Math.min(canvasH, Math.ceil(y + h));
  if (right <= left || bottom <= top) return { x0: 0, y0: 0, x1: -1, y1: -1 };
  return {
    x0: Math.floor(left / TILE),
    y0: Math.floor(top / TILE),
    x1: Math.floor((right - 1) / TILE),
    y1: Math.floor((bottom - 1) / TILE),
  };
}

export function tileRect(canvasW: number, canvasH: number, tx: number, ty: number) {
  const x = tx * TILE;
  const y = ty * TILE;
  return { x, y, w: Math.min(TILE, canvasW - x), h: Math.min(TILE, canvasH - y) };
}

function copyTile(canvas: OffscreenCanvas, tx: number, ty: number): OffscreenCanvas {
  const r = tileRect(canvas.width, canvas.height, tx, ty);
  const tile = newCanvas(r.w, r.h);
  ctxOf(tile).drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return tile;
}

interface TileSnap {
  tx: number;
  ty: number;
  before: OffscreenCanvas;
  after?: OffscreenCanvas;
}

/**
 * Records a pixel change to one layer. Call `touch` with each area before drawing on it;
 * the tile is copied the first time it's touched. `finish` returns the undo command.
 */
export class PixelEdit {
  private tiles = new Map<number, TileSnap>();

  constructor(
    readonly layer: Layer,
    readonly label: string,
  ) {}

  touch(x: number, y: number, w: number, h: number): void {
    const c = this.layer.canvas;
    const r = tileRange(x, y, w, h, c.width, c.height);
    for (let ty = r.y0; ty <= r.y1; ty++) {
      for (let tx = r.x0; tx <= r.x1; tx++) {
        const key = ty * 65536 + tx;
        if (!this.tiles.has(key)) this.tiles.set(key, { tx, ty, before: copyTile(c, tx, ty) });
      }
    }
  }

  finish(): Command | null {
    if (this.tiles.size === 0) return null;
    const snaps = [...this.tiles.values()];
    for (const s of snaps) s.after = copyTile(this.layer.canvas, s.tx, s.ty);
    return new TileCommand(this.layer, this.label, snaps);
  }
}

class TileCommand implements Command {
  readonly bytes: number;

  constructor(
    private readonly layer: Layer,
    readonly label: string,
    private readonly snaps: TileSnap[],
  ) {
    this.bytes = snaps.reduce((n, s) => n + s.before.width * s.before.height * 8, 0);
  }

  apply(): void {
    this.put('after');
  }
  revert(): void {
    this.put('before');
  }

  private put(which: 'before' | 'after'): void {
    const c = this.layer.canvas;
    const ctx = ctxOf(c);
    for (const s of this.snaps) {
      const r = tileRect(c.width, c.height, s.tx, s.ty);
      ctx.clearRect(r.x, r.y, r.w, r.h);
      ctx.drawImage(s[which]!, r.x, r.y);
    }
  }
}
