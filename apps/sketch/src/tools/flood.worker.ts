import { croppedMask, fillRegion, floodRegion } from '../engine/flood';
import { maskOutline } from '../engine/pixels';

export type FloodRequest =
  | {
      id: number;
      kind: 'fill';
      width: number;
      height: number;
      /** The layer's pixels; the filled pixels come back in it. */
      target: ArrayBuffer;
      /** The pixels to compare, when that's the whole picture rather than the layer. */
      sample: ArrayBuffer | null;
      x: number;
      y: number;
      tolerance: number;
      global: boolean;
      color: [number, number, number, number];
    }
  | { id: number; kind: 'area'; width: number; height: number; sample: ArrayBuffer; x: number; y: number; tolerance: number };

export type FloodResponse =
  | { id: number; kind: 'fill'; target: ArrayBuffer; rect: { x: number; y: number; w: number; h: number } }
  | {
      id: number;
      kind: 'area';
      /** The selection's mask as see-through or solid black pixels, and its outline as [x0, y0, x1, y1] runs. */
      pixels: ArrayBuffer;
      outline: ArrayBuffer;
      rect: { x: number; y: number; w: number; h: number };
    }
  | { id: number; kind: 'none' }
  | { id: number; kind: 'error'; error: string };

// Fills run here so a big picture never freezes the window.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<FloodRequest>) => void) | null;
  postMessage(msg: FloodResponse, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const req = e.data;
  try {
    if (req.kind === 'fill') {
      const target = new Uint8ClampedArray(req.target);
      const sample = req.sample ? new Uint8ClampedArray(req.sample) : target;
      const region = floodRegion(sample, req.width, req.height, req.x, req.y, req.tolerance, req.global);
      if (!region) return post({ id: req.id, kind: 'none' });
      const rect = fillRegion(target, sample, req.width, req.height, region, req.color, req.tolerance);
      post({ id: req.id, kind: 'fill', target: req.target, rect }, [req.target]);
    } else {
      const sample = new Uint8ClampedArray(req.sample);
      const region = floodRegion(sample, req.width, req.height, req.x, req.y, req.tolerance, false);
      if (!region) return post({ id: req.id, kind: 'none' });
      // The mask's pixels and outline are made here too, which kept the page busy for about 60 ms
      // after a wand click on a 4K picture.
      const m = croppedMask(region, req.width);
      const pixels = new Uint8ClampedArray(m.mask.length * 4);
      for (let i = 0; i < m.mask.length; i++) pixels[i * 4 + 3] = m.mask[i] ? 255 : 0;
      const outline = Int32Array.from(maskOutline(m.mask, m.w, m.h).flat());
      post({ id: req.id, kind: 'area', pixels: pixels.buffer, outline: outline.buffer, rect: { x: m.x, y: m.y, w: m.w, h: m.h } }, [pixels.buffer, outline.buffer]);
    }
  } catch (err) {
    post({ id: req.id, kind: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};

function post(msg: FloodResponse, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}
