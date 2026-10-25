import { adjustedPart, adjustLayer, filterFor, isNoChange, type AdjustArea, type Adjustment } from '../engine/adjust';
import type { PixelLayer } from '../engine/document';
import { replaceFloating, type Selection } from '../tools/selection';
import { commitText } from '../tools/text';
import { blockedReason } from './layers';
import { app, changed, openModal, toast } from './store';

/**
 * The Adjust menu (step 5.3). An adjustment changes the selection if there is one, otherwise the
 * layer the pixel tools paint on. A lifted or pasted selection changes before it's placed.
 */

type Target = { kind: 'layer'; layer: PixelLayer; area: AdjustArea; whole: boolean } | { kind: 'floating'; sel: Selection };

/** What the adjustment changes, or null (with a message) when that can't be changed now. */
function target(): Target | null {
  commitText();
  const sel = app.selection;
  if (sel?.raw) return { kind: 'floating', sel };
  const layer = sel ? sel.layer : app.doc.paintLayer;
  const why = blockedReason(layer);
  if (why) {
    toast(why, 4000);
    return null;
  }
  if (sel) return { kind: 'layer', layer, area: { x: sel.sx, y: sel.sy, w: sel.sw, h: sel.sh, mask: sel.mask }, whole: false };
  return { kind: 'layer', layer, area: { x: 0, y: 0, w: layer.canvas.width, h: layer.canvas.height, mask: null }, whole: true };
}

const wholeOf = (c: OffscreenCanvas): AdjustArea => ({ x: 0, y: 0, w: c.width, h: c.height, mask: null });

/** Shows the adjustment on the picture without changing it; null takes the preview away. */
function preview(t: Target, change: Adjustment | null): void {
  if (t.kind === 'floating') {
    if (change) t.sel.image = adjustedPart(t.sel.raw!, wholeOf(t.sel.raw!), change);
    else replaceFloating(t.sel, t.sel.raw!);
  } else if (!change) {
    app.adjustPreview = null;
  } else if (t.whole) {
    // The whole layer previews through the view's own filter, so nothing is copied while a slider moves.
    app.adjustPreview = { layer: t.layer, filter: filterFor(change), part: null, x: 0, y: 0 };
  } else {
    app.adjustPreview = { layer: t.layer, filter: null, part: adjustedPart(t.layer.canvas, t.area, change), x: t.area.x, y: t.area.y };
  }
  app.requestRender();
}

function apply(t: Target, change: Adjustment | 'auto'): void {
  if (t.kind === 'floating') {
    replaceFloating(t.sel, adjustedPart(t.sel.raw!, wholeOf(t.sel.raw!), change));
    return;
  }
  const cmd = adjustLayer(t.layer, t.area, change);
  if (cmd) app.history.record(cmd);
  // Shapes and text can't be adjusted, so say where the change went.
  if (!app.selection && app.doc.activeLayer.kind === 'objects') toast(`Adjustments change pixels, so this changed ${t.layer.name}.`, 4000);
  changed();
}

/** Brightness and contrast, or hue and saturation: a dialog whose sliders preview on the picture. */
export async function adjustWithDialog(kind: 'brightness' | 'hue'): Promise<void> {
  const t = target();
  if (!t) return;
  const result = await openModal('adjust', { adjust: kind, preview: (a: Adjustment | null) => preview(t, a) });
  preview(t, null);
  if (result && !isNoChange(result)) apply(t, result);
  changed();
}

/** Black and white, invert and auto level happen at once; undo takes them back. */
export function adjustNow(change: Adjustment | 'auto'): void {
  const t = target();
  if (t) apply(t, change);
}
