import { parseHex, toHex } from '../app/color';
import type { ColorTarget } from '../app/colorTargets';
import { app, changed, toast } from '../app/store';
import { settingsOf } from '../app/tools';
import { ctxOf, drawLayer, flatten, newCanvas } from '../engine/document';
import { PixelEdit } from '../engine/tiles';
import type { Point } from './box';
import type { ToolDrag } from './drag';
import { floodFill, queued } from './floodClient';

/** Fill: paints the area of similar colour around the click with colour 1 (left) or colour 2 (right). */
export function fillAt(p: Point, button: number): Promise<void> {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  const color = parseHex(button === 2 ? app.secondary : app.primary) ?? { r: 0, g: 0, b: 0, a: 1 };
  return queued(async () => {
    const doc = app.doc;
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    const st = settingsOf('fill');
    const layer = doc.activeLayer;
    const ctx = ctxOf(layer.canvas);
    const target = ctx.getImageData(0, 0, doc.width, doc.height);
    const sample = st.sample === 'picture' ? ctxOf(flatten(doc)).getImageData(0, 0, doc.width, doc.height) : null;
    try {
      const done = await floodFill(target, sample, x, y, (st.tolerance as number) / 100, st.global as boolean, [
        color.r,
        color.g,
        color.b,
        Math.round(color.a * 255),
      ]);
      // The picture may have been swapped or resized while the fill ran.
      if (!done || app.doc !== doc || layer.canvas.width !== target.width || layer.canvas.height !== target.height) return;
      const r = done.rect;
      // A whiteboard's empty space runs on past its canvas, as does a capture's past the sides it has
      // grown on, so a fill reaching the canvas's edge there isn't inside anything.
      const e = doc.board ? { left: 1, top: 1, right: 1, bottom: 1 } : doc.edges;
      const open = e && ((e.left && r.x === 0) || (e.top && r.y === 0) || (e.right && r.x + r.w === target.width) || (e.bottom && r.y + r.h === target.height));
      if (open) {
        toast(
          doc.board
            ? 'On a whiteboard, Fill fills inside closed outlines. This area runs out into the board.'
            : 'Past the edges of a capture, Fill fills inside closed outlines. This area runs out past them.',
          4000,
        );
        // The board grew for this fill; with nothing filled, that growth isn't a step of its own.
        if (app.history.top?.joinNext) app.history.discardTop();
        return;
      }
      const edit = new PixelEdit(layer, 'Fill');
      edit.touch(r.x, r.y, r.w, r.h);
      ctx.putImageData(new ImageData(done.data as Uint8ClampedArray<ArrayBuffer>, target.width, target.height), 0, 0, r.x, r.y, r.w, r.h);
      const cmd = edit.finish();
      if (cmd) app.history.record(cmd);
      changed();
    } catch (e) {
      toast(`Couldn't fill: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  });
}

/** The colour at a picture pixel: in the current layer, or the whole picture as it shows. Null off the picture. */
export function colorAt(x: number, y: number, sample: 'layer' | 'picture'): string | null {
  const doc = app.doc;
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= doc.width || py >= doc.height) return null;
  let d: Uint8ClampedArray;
  if (sample === 'layer') {
    d = ctxOf(doc.activeLayer.canvas).getImageData(px, py, 1, 1).data;
  } else {
    const one = newCanvas(1, 1);
    const ctx = ctxOf(one);
    ctx.translate(-px, -py);
    for (const layer of doc.layers) if (layer.visible) drawLayer(ctx, layer);
    d = ctx.getImageData(0, 0, 1, 1).data;
  }
  return toHex({ r: d[0], g: d[1], b: d[2], a: d[3] / 255 });
}

/**
 * Colour picker: sets colour 1 (left) or colour 2 (right) from the picture, following the pointer
 * while it's held. Also Alt+click with any tool that paints. `into` is the colour to set whatever the
 * button (the colour popover's picker button, and Alt+click with a line tool, which sets the outline).
 */
export function pickDrag(
  p: Point,
  button: number,
  sample: 'layer' | 'picture',
  remember: (c: string) => void,
  into?: ColorTarget,
): ToolDrag {
  const which = button === 2 ? 'secondary' : 'primary';
  const read = () => (into ? into.read() : app[which]);
  const pick = (q: Point) => {
    const c = colorAt(q.x, q.y, sample);
    if (c && c !== read()) {
      if (into) into.write(c);
      else {
        app[which] = c;
        changed();
      }
    }
  };
  pick(p);
  return {
    cursor: PICKER_CURSOR,
    move: pick,
    up: () => remember(read()),
  };
}

/** A pipette with its tip at the bottom left. */
export const PICKER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9M3 21v-3l9-9m3 6 3.4 3.4M12 9l3 3" stroke="#fff" stroke-width="4"/><path d="m2 22 1-1h3l9-9M3 21v-3l9-9m3 6 3.4 3.4M12 9l3 3m-1.6-5.6L16 4.8a2.8 2.8 0 0 1 4 4L17.4 11.4z" stroke="#000" stroke-width="1.6"/></g></svg>',
)}") 2 22, default`;
