import { addLayer, ObjectsCommand, setLayerProp } from '../engine/commands';
import { createLayer, ctxOf, newCanvas, type PaintDocument, type Layer } from '../engine/document';
import { CompositeCommand, type Command } from '../engine/history';
import * as platform from '../platform';
import { replaceFloating } from '../tools/selection';
import { commitText } from '../tools/text';
import { blockedReason } from './layers';
import { app, changed, openModal, toast } from './store';

/**
 * Remove Background (F13): the cutout model (Rust, `cutout.rs`) says how much of each pixel is the
 * person or object in front, and everything else turns see-through. The page shrinks the area to
 * the model's size and scales the mask back up itself, so only a few hundred KB cross to Rust.
 *
 * On a layer, the cut-out goes on a new layer above it and the original is hidden, all one step,
 * so the original is never lost. A lifted or pasted selection is cut out before it's placed, as
 * the Adjust menu changes one.
 */

type Area = { x: number; y: number; w: number; h: number; mask: OffscreenCanvas | null };

let running = false;

export async function removeBackground(): Promise<void> {
  // Set before anything awaits, so a double-click or a repeat from the menu can't start a second one.
  if (running) return;
  running = true;
  try {
    await cutOut();
  } finally {
    running = false;
  }
}

async function cutOut(): Promise<void> {
  if (!platform.isTauri) {
    toast('Remove Background works in the Sketch app, not in a browser.', 4000);
    return;
  }
  commitText();
  // Held, not read from `app` later: the tab showing may change while the model runs.
  const doc = app.doc;
  const history = app.history;
  const sel = app.selection;
  const floating = sel?.raw ? sel : null;
  const layer = sel ? sel.layer : doc.activeLayer;
  if (!floating) {
    const why = blockedReason(layer);
    if (why) {
      toast(why, 4000);
      return;
    }
  }
  if (!(await platform.cutoutReady()) && !(await openModal('cutout-download'))) return;
  const source = floating ? floating.raw! : layer.canvas;
  const area: Area = floating || !sel ? { x: 0, y: 0, w: source.width, h: source.height, mask: null } : { x: sel.sx, y: sel.sy, w: sel.sw, h: sel.sh, mask: sel.mask };
  toast('Removing the background…', 60_000);
  let cut: OffscreenCanvas;
  try {
    cut = await maskFor(source, area);
  } catch (e) {
    toast(`Remove Background didn't work: ${e}`, 6000);
    return;
  }
  if (floating) {
    // Placed or dropped while the model ran: there's nothing left to change.
    if (app.selection !== floating || !floating.raw) return toast('The selection changed, so nothing was cut out.', 4000);
    replaceFloating(floating, keepOnly(floating.raw, cut));
  } else {
    if (!doc.layers.includes(layer) || blockedReason(layer)) return toast('The layer changed, so nothing was cut out.', 4000);
    history.record(cutOntoNewLayer(doc, layer, area, cut));
    // The selection points at the now hidden layer. One lifted while the model ran keeps its pixels.
    if (app.doc === doc && app.selection?.layer === layer && !app.selection.raw) app.selection = null;
  }
  toast(floating ? 'Background removed.' : `Background removed. ${layer.name} is hidden below the cut-out.`, 4000);
  changed();
}

/** The model's mask for an area, scaled back up to the area's size as an alpha-only canvas. */
async function maskFor(source: OffscreenCanvas, area: Area): Promise<OffscreenCanvas> {
  const n = platform.CUTOUT_SIZE;
  const small = newCanvas(n, n);
  const sctx = ctxOf(small);
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(source, area.x, area.y, area.w, area.h, 0, 0, n, n);
  const mask = await platform.cutoutMask(new Uint8Array(sctx.getImageData(0, 0, n, n).data.buffer));
  const alpha = new ImageData(n, n);
  for (let i = 0; i < mask.length; i++) alpha.data[i * 4 + 3] = mask[i];
  sctx.clearRect(0, 0, n, n);
  sctx.putImageData(alpha, 0, 0);
  // Scaling the small mask up smoothly softens its edge, so the cut-out has no jagged steps.
  const full = newCanvas(area.w, area.h);
  const fctx = ctxOf(full);
  fctx.imageSmoothingQuality = 'high';
  fctx.drawImage(small, 0, 0, area.w, area.h);
  return full;
}

/** A copy of `image` with only what the mask keeps. */
function keepOnly(image: OffscreenCanvas, keep: OffscreenCanvas): OffscreenCanvas {
  const out = newCanvas(image.width, image.height);
  const ctx = ctxOf(out);
  ctx.drawImage(image, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(keep, 0, 0);
  return out;
}

/**
 * Adds the cut-out above `layer` and hides `layer`, as one step. Inside a selection only the picked pixels
 * change. The layer's shapes and text move up onto the cut-out, so they still show and stay editable.
 */
function cutOntoNewLayer(doc: PaintDocument, layer: Layer, area: Area, cut: OffscreenCanvas) {
  let keep = cut;
  if (area.mask) {
    // Keep everything outside the selection: the unpicked part fully, plus the cut-out inside it.
    keep = newCanvas(area.w, area.h);
    const ctx = ctxOf(keep);
    ctx.fillRect(0, 0, area.w, area.h);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(area.mask, 0, 0);
    const picked = keepOnly(cut, area.mask);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(picked, 0, 0);
  }
  const part = newCanvas(area.w, area.h);
  ctxOf(part).drawImage(layer.canvas, area.x, area.y, area.w, area.h, 0, 0, area.w, area.h);
  const result = createLayer(`${layer.name} cut out`, layer.canvas.width, layer.canvas.height);
  result.opacity = layer.opacity;
  const ctx = ctxOf(result.canvas);
  ctx.drawImage(layer.canvas, 0, 0);
  ctx.clearRect(area.x, area.y, area.w, area.h);
  ctx.drawImage(keepOnly(part, keep), area.x, area.y);
  // The new layer goes straight above the one it came from, which may not be the current one.
  doc.active = doc.layers.indexOf(layer);
  const add = addLayer(doc, result, 'Remove background');
  const hide = setLayerProp(layer, 'visible', false, 'Remove background');
  const parts: Command[] = hide ? [add, hide] : [add];
  if (layer.objects.length) {
    const objects = layer.objects;
    result.objects = objects;
    layer.objects = [];
    parts.push(new ObjectsCommand('Remove background', layer, objects, layer.objects));
  }
  return new CompositeCommand('Remove background', parts);
}
