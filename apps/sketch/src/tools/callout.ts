import { app, changed } from '../app/store';
import { currentTool, onOptionChange, settingsOf } from '../app/tools';
import { ObjectsCommand } from '../engine/commands';
import type { Layer } from '../engine/document';
import { LINE_HEIGHT, layoutText, newObjectId, type TextObject } from '../engine/objects';
import type { Point } from './box';
import type { ToolDrag } from './drag';
import { dragged } from './shapes';
import { newTextBlocked, startEdit, textAt, textDrag, updateText } from './text';

/**
 * The Callout tool (step 5.2): a speech bubble with a tail pointing at something. A callout is a text
 * box with a background and a `tail`, so it's typed in, moved and restyled like text. Moving the
 * bubble leaves the tail pointing at the same spot; its round handle moves the point.
 */

/** Tail handles are this many view pixels from the pointer to count as hit. */
const HIT = 8;

/** Where a click without a drag puts the bubble's middle, from the point it points at. */
const CLICK_OFFSET = { x: 60, y: -70 };

/** Callouts whose tails can be dragged now: the one being typed in, and with the Callout tool, every one that can be changed. */
export function tailHandles(): { x: number; y: number; layer: Layer | null; obj: TextObject }[] {
  const out: { x: number; y: number; layer: Layer | null; obj: TextObject }[] = [];
  const te = app.textEdit;
  if (te?.obj.tail) out.push({ ...te.obj.tail, layer: te.layer, obj: te.obj });
  if (currentTool().id !== 'callout') return out;
  for (const layer of app.doc.layers) {
    if (!layer.visible || layer.locked) continue;
    for (const o of layer.objects) if (o.type === 'text' && o.tail && o.id !== te?.obj.id) out.push({ ...o.tail, layer, obj: o });
  }
  return out;
}

/** The tail handle under a view point, if any. */
export function tailHandleAt(sx: number, sy: number): ReturnType<typeof tailHandles>[number] | undefined {
  const v = app.viewport;
  return tailHandles().find((t) => {
    const s = v.toScreen(t.x, t.y);
    return Math.abs(sx - s.x) <= HIT && Math.abs(sy - s.y) <= HIT;
  });
}

/** Pressing on a tail handle drags the point the callout points at. Null when the press missed them. */
export function tailDrag(sx: number, sy: number): ToolDrag | null {
  const h = tailHandleAt(sx, sy);
  if (!h) return null;
  // The callout being typed in changes as you drag; it's recorded when the typing is done.
  if (app.textEdit?.obj.id === h.obj.id) {
    return { cursor: 'grabbing', move: (q) => updateText({ tail: { x: Math.round(q.x), y: Math.round(q.y) } }), up: () => changed() };
  }
  const layer = h.layer!;
  const before = layer.objects;
  return {
    cursor: 'grabbing',
    move: (q) => {
      layer.objects = before.map((o) => (o.id === h.obj.id ? { ...h.obj, tail: { x: Math.round(q.x), y: Math.round(q.y) } } : o));
      changed();
    },
    up: () => {
      if (layer.objects !== before) app.history.record(new ObjectsCommand('Move callout point', layer, before, layer.objects));
      changed();
    },
  };
}

/** A new callout pointing at `tip`, with its bubble's middle at `at`. */
function newCallout(tip: Point, at: Point, swap: boolean): TextObject {
  const size = settingsOf('callout').size as number;
  const o: TextObject = {
    id: newObjectId(),
    type: 'text',
    x: 0,
    y: 0,
    width: null,
    angle: 0,
    text: '',
    font: settingsOf('text').font as string,
    size,
    bold: false,
    italic: false,
    align: 'left',
    color: swap ? app.secondary : app.primary,
    accent: swap ? app.primary : app.secondary,
    outline: false,
    box: true,
    tail: { x: Math.round(tip.x), y: Math.round(tip.y) },
  };
  // Room for a few letters, so the bubble doesn't start as a sliver.
  const w = Math.max(layoutText(o).width, size * 4);
  return { ...o, x: Math.round(at.x - w / 2), y: Math.round(at.y - (size * LINE_HEIGHT) / 2) };
}

/**
 * Callout tool, pressing on the picture: on a callout or text, edits or moves it, as the Text tool does.
 * Elsewhere, the press is the point the callout points at: drag to where the bubble goes, or click
 * for a bubble up and to the right. Then type.
 */
export function calloutDrag(p: Point, e: PointerEvent): ToolDrag {
  if (textAt(p.x, p.y, 4 / app.viewport.zoom)) return textDrag(p, e.button);
  const blocked = newTextBlocked();
  if (blocked) return blocked;
  const swap = e.button === 2;
  return {
    cursor: 'default',
    move: (q) => {
      if (!app.draft && !dragged(p, q)) return;
      app.draft = newCallout(p, q, swap);
      changed();
    },
    up: (q) => {
      app.draft = null;
      const at = dragged(p, q) ? q : { x: p.x + CLICK_OFFSET.x, y: p.y + CLICK_OFFSET.y };
      startEdit({ layer: null, original: null, obj: newCallout(p, at, swap) });
    },
  };
}

// The text size on the options bar changes the callout being typed in.
onOptionChange((toolId, key) => {
  if (toolId === 'callout' && key === 'size' && app.textEdit?.obj.tail) updateText({ size: settingsOf('callout').size as number });
});
