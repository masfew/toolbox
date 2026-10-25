/**
 * Carrying a selection or picked shapes onto another tab (F14.3). While one is being moved, holding
 * the pointer over another tab for a moment switches to it, as browsers do, and what was being moved
 * comes along under the pointer: shapes stay editable, pixels arrive as a floating selection to place.
 * Each picture gets its own undo step: taking them out of one, putting them in the other.
 */
import { addLayer, ObjectsCommand } from '../engine/commands';
import { createObjectLayer, objectLayerForNew, type ObjectLayer } from '../engine/document';
import { moveObject, newObjectId } from '../engine/objects';
import { moveBox, type Box, type Point } from '../tools/box';
import type { ToDoc, ToolDrag } from '../tools/drag';
import { deleteSelection, pasteSelection, selectionImage } from '../tools/selection';
import { labelFor, pickObjects, removeObjects, type Drawn } from '../tools/shapes';
import { growBoard } from './board';
import { isOpen } from '../engine/board';
import { app, changed, tabs } from './store';
import { switchTo } from './tabs';

/** How long the pointer rests on a tab before it switches. */
export const HOVER_MS = 500;

const tabName = (i: number) => {
  const t = tabs.list[i];
  return t.doc.board && t.file.name === 'Untitled' ? 'whiteboard' : t.file.name;
};

/** The tab under a screen point, other than the one showing, or -1. */
export function tabAt(x: number, y: number): number {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-tab-index]');
  const i = el ? Number(el.dataset.tabIndex) : -1;
  return i === tabs.active ? -1 : i;
}

/** Marks the tab a carried drag is resting on, since the canvas holds the pointer and the tab gets no hover. */
export function markTarget(index: number): void {
  document.querySelectorAll('.tab.drop-target').forEach((el) => el.classList.remove('drop-target'));
  if (index >= 0) document.querySelector(`[data-tab-index="${index}"]`)?.classList.add('drop-target');
}

/**
 * Moves what `drag` is carrying onto tab `index` and shows it. Returns the drag that carries on moving
 * it there until the pointer is let go, or null when there was nothing to carry.
 */
export function carryTo(index: number, drag: ToolDrag, pointer: { clientX: number; clientY: number }, toDoc: ToDoc): ToolDrag | null {
  const carry = drag.carry;
  if (!carry || index < 0 || index >= tabs.list.length) return null;
  const from = toDoc(pointer);
  const to = tabName(index);
  if (carry.kind === 'objects') {
    const { layer, ids } = carry;
    // Where they are now, moved by the drag so far; then the drag is undone and they're taken out as one step.
    const moving = layer.objects.filter((o): o is Drawn => ids.includes(o.id) && o.type !== 'text');
    if (!moving.length) return null;
    drag.cancel?.();
    const back = tabName(tabs.active);
    removeObjects(layer, ids, `${labelFor('Move', moving)} to ${to}`);
    switchTo(index);
    return objectsArrive(moving, from, toDoc(pointer), `${labelFor('Move', moving)} from ${back}`);
  }
  const sel = app.selection;
  if (!sel) return null;
  // The grab point stays under the pointer: the box's corner relative to it, before the drag is undone.
  const off = { x: from.x - sel.x, y: from.y - sel.y };
  drag.cancel?.();
  const image = selectionImage(sel);
  // A paste not yet placed was never in this picture, so it just goes.
  deleteSelection(`Move selection to ${to}`);
  switchTo(index);
  const p = toDoc(pointer);
  let pending = null;
  if (isOpen(app.doc)) pending = growBoard({ x: p.x - off.x, y: p.y - off.y, w: image.width, h: image.height });
  // A whiteboard or capture that grew up or left moved its pixels, so the point is found again.
  const q = toDoc(pointer);
  pasteSelection(image, Math.round(q.x - off.x), Math.round(q.y - off.y), pending);
  return selectionFollows(q);
}

/** Shapes from another tab, placed under the pointer and moved with it until it's let go, then recorded as one step. */
function objectsArrive(moving: Drawn[], from: Point, at: Point, label: string): ToolDrag {
  const dx = Math.round(at.x - from.x);
  const dy = Math.round(at.y - from.y);
  const arrived = moving.map((o) => ({ ...moveObject(o, dx, dy), id: newObjectId() }));
  const ids = arrived.map((o) => o.id);
  const doc = app.doc;
  const existing = objectLayerForNew(doc);
  let layer: ObjectLayer;
  let before: ObjectLayer['objects'] = [];
  let added: ReturnType<typeof addLayer> | null = null;
  if (existing) {
    layer = existing;
    before = layer.objects;
    layer.objects = [...before, ...arrived];
  } else {
    layer = createObjectLayer('Shapes', arrived);
    added = addLayer(doc, layer, label);
  }
  pickObjects(layer, ids);
  changed();
  const place = (q: Point) => {
    const mx = Math.round(q.x - at.x);
    const my = Math.round(q.y - at.y);
    layer.objects = [...before, ...arrived.map((o) => moveObject(o, mx, my))];
    changed();
  };
  return {
    cursor: 'move',
    move: (q) => place(q),
    up: (q) => {
      place(q);
      // A new layer is recorded holding them where they ended up; else the layer's objects change.
      app.history.record(added ?? new ObjectsCommand(label, layer, before, layer.objects));
      changed();
    },
  };
}

/** A floating selection that follows the pointer until it's let go; Enter or a click places it as usual. */
function selectionFollows(at: Point): ToolDrag {
  const sel = app.selection!;
  const start: Box = { x: sel.x, y: sel.y, w: sel.w, h: sel.h, angle: sel.angle };
  return {
    cursor: 'move',
    move: (q) => {
      if (app.selection !== sel) return;
      Object.assign(sel, moveBox(start, q.x - at.x, q.y - at.y, true));
      changed();
    },
    up: () => {},
  };
}
