import { app, changed, colorSignal, toast } from '../app/store';
import { loadOptions, onOptionChange, onToolChange, settingsOf } from '../app/tools';
import { frameOf, inkBounds, isOpen } from '../engine/board';
import { addLayer, ObjectsCommand } from '../engine/commands';
import { createObjectLayer, ctxOf, newCanvas, objectLayerForNew, type ObjectLayer } from '../engine/document';
import { renumbered, type MarkObject } from '../engine/marks';
import { drawObject, hitObject, moveObject, newObjectId, objectBounds, objectPaintBounds, type SketchObject } from '../engine/objects';
import { bendToward, lineMiddle, rectAround, type Dash, type Head, type LineObject, type Rect, type ShapeKind, type ShapeObject } from '../engine/shapes';
import { EDGE_HANDLES, HANDLE_SIDES, handleCursor, handlePoint, resizeBox, rotateBox, type Box, type EdgeHandle, type Point } from './box';
import type { ToolDrag } from './drag';
import { colorAt } from './fill';
import { getTool, mergeSettings, type OptionValue } from './registry';
import { ROTATE_GAP } from './selection';
import { alignMoves, distributeMoves, snapAngle, snapPoint, snapRect, type AlignMode, type SnapResult, type SnapTargets } from './snap';

/**
 * The Shapes and Lines and Arrows tools (steps 4.1 and 4.2): drawing shapes and lines as objects,
 * picking them again to move, resize, turn, bend or restyle them, and the smart guides while
 * dragging (step 4.3). Mark-up (step 5.2, drawn in `marks.ts`) is picked and changed the same way.
 * Picked objects are `app.objectSel`; they're always in one layer.
 */

export type Drawn = ShapeObject | LineObject | MarkObject;

export const SHAPE_TOOLS = ['rectangle', 'ellipse', 'polygon', 'star'];
export const LINE_TOOLS = ['arrow', 'line'];
export const MARK_TOOLS = ['highlight', 'blur', 'pixelate', 'marker', 'spotlight'];
export const isObjectTool = (id: string) => SHAPE_TOOLS.includes(id) || LINE_TOOLS.includes(id) || MARK_TOOLS.includes(id);

/** Shapes and marks are boxes with resize and turn handles; lines have ends and a bend handle. */
export const isBoxed = (o: Drawn): o is ShapeObject | MarkObject => o.type !== 'line';

/** Handles are this many view pixels from the pointer to count as hit; objects this many. */
const HIT = 7;
const SLOP = 6;
/** New copies and pastes land this far down and to the right. */
const COPY_OFFSET = 16;

const isDrawn = (o: SketchObject): o is Drawn => o.type !== 'text';

/** The tool whose options show a shape's, line's or mark's settings. */
export function toolForObject(o: Drawn): string {
  if (o.type === 'mark') return o.kind;
  return o.type === 'shape' ? o.kind : o.start !== 'none' || o.end !== 'none' ? 'arrow' : 'line';
}

/** "rectangle", "arrow" and so on, for history labels. */
function nameOf(o: Drawn): string {
  return getTool(toolForObject(o)).name.toLowerCase();
}

function labelFor(verb: string, objects: Drawn[]): string {
  return objects.length === 1 ? `${verb} ${nameOf(objects[0])}` : `${verb} shapes`;
}

// ---------- Picking ----------

/** The picked shapes and lines still in their layer, in drawing order. Clears the pick when none are left. */
export function pickedObjects(): { layer: ObjectLayer; objects: Drawn[] } | null {
  const sel = app.objectSel;
  if (!sel) return null;
  const objects = app.doc.layers.includes(sel.layer) ? sel.layer.objects.filter((o): o is Drawn => isDrawn(o) && sel.ids.includes(o.id)) : [];
  if (!objects.length) {
    app.objectSel = null;
    return null;
  }
  return { layer: sel.layer, objects };
}

/** The object picked first, whose settings the options bar shows. */
function firstPicked(): Drawn | null {
  const picked = pickedObjects();
  return picked ? (picked.objects.find((o) => o.id === app.objectSel!.ids[0]) ?? picked.objects[0]) : null;
}

/** The tool whose options the options bar shows: the first picked object's, or the current tool's. */
export function optionsToolId(current: string): string {
  const first = firstPicked();
  return first ? toolForObject(first) : current;
}

/** The highlighter's colours, by option value. */
export const TINTS: Record<string, string> = { yellow: '#ffe94d', green: '#8ef07a', blue: '#7fd4ff', pink: '#ff9ecf', orange: '#ffb35c' };

/** A shape's, line's or mark's settings as its tool's options. */
function styleOf(o: Drawn): Record<string, OptionValue> {
  const opacity = Math.round(o.opacity * 100);
  if (o.type === 'mark') {
    switch (o.kind) {
      case 'highlight':
        return { size: Math.round(o.width), opacity, tint: Object.keys(TINTS).find((k) => TINTS[k] === o.color) ?? 'yellow' };
      case 'blur':
        return { strength: o.strength };
      case 'pixelate':
        return { block: o.block };
      case 'marker':
        return { size: Math.round(Math.min(o.w, o.h)), next: o.number };
      case 'spotlight':
        return { dim: o.dim, shape: o.round ? 'ellipse' : 'rect' };
    }
  }
  if (o.type === 'line') return { width: o.width, start: o.start, end: o.end, dash: o.dash, opacity };
  return { width: o.width, fill: o.filled, dash: o.dash, opacity, radius: o.radius, sides: o.sides, points: o.points };
}

/** Picks objects in a layer, and shows the first one's settings on the options bar. */
export function pickObjects(layer: ObjectLayer, ids: number[]): void {
  app.objectSel = ids.length ? { layer, ids } : null;
  const first = layer.objects.find((o): o is Drawn => isDrawn(o) && o.id === ids[0]);
  if (!first) return changed();
  const toolId = toolForObject(first);
  loadOptions(toolId, mergeSettings(getTool(toolId), styleOf(first)));
}

export function clearPicked(): void {
  if (!app.objectSel) return;
  app.objectSel = null;
  changed();
}

/**
 * The topmost shape, line or mark under a picture point, in a layer that's showing and not locked.
 * Text is left to the text tool. A spotlight is only picked when nothing else is there, since what
 * it lights up usually sits inside it.
 */
export function objectAt(p: Point): { layer: ObjectLayer; obj: Drawn } | null {
  const slop = SLOP / app.viewport.zoom;
  const layers = app.doc.layers;
  for (const spot of [false, true]) {
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (layer.kind !== 'objects' || !layer.visible || layer.locked) continue;
      for (let j = layer.objects.length - 1; j >= 0; j--) {
        const o = layer.objects[j];
        if (!isDrawn(o) || (o.type === 'mark' && o.kind === 'spotlight') !== spot) continue;
        if (hitObject(o, p.x, p.y, slop)) return { layer, obj: o };
      }
    }
  }
  return null;
}

// ---------- History ----------

let joinable: { key: string; cmd: ObjectsCommand; at: number } | null = null;

/**
 * Records a change to a layer's objects. Changes with the same `join` key that follow each other
 * within a second and a half (a slider being dragged, nudges) become one step.
 */
function record(label: string, layer: ObjectLayer, before: readonly SketchObject[], join?: string): void {
  const now = performance.now();
  const last = joinable;
  if (join && last && last.key === join && app.history.top === last.cmd && app.history.dirty && now - last.at < 1500) {
    last.cmd.after = layer.objects;
    last.at = now;
    changed();
    return;
  }
  const cmd = new ObjectsCommand(label, layer, before, layer.objects);
  app.history.record(cmd);
  joinable = join ? { key: join, cmd, at: now } : null;
}

/** Takes objects out of their layer as one history step (moving them to another tab, F14.3). */
export function removeObjects(layer: ObjectLayer, ids: number[], label: string): void {
  const before = layer.objects;
  layer.objects = before.filter((o) => !ids.includes(o.id));
  if (app.objectSel?.layer === layer) app.objectSel = null;
  record(label, layer, before);
  changed();
}

export { labelFor, nameOf };

/** Changes the picked objects with `fn` (null leaves one as it is) as one history step. */
function changePicked(label: string, fn: (o: Drawn) => Drawn | null, join?: string): void {
  const picked = pickedObjects();
  if (!picked) return;
  const { layer } = picked;
  const ids = app.objectSel!.ids;
  const before = layer.objects;
  let any = false;
  const after = before.map((o) => {
    if (!isDrawn(o) || !ids.includes(o.id)) return o;
    const n = fn(o);
    if (!n || JSON.stringify(n) === JSON.stringify(o)) return o;
    any = true;
    return n;
  });
  if (!any) return;
  layer.objects = after;
  record(label, layer, before, join && `${join}:${ids.join(',')}`);
}

/**
 * Adds new objects, to the layer given if it's still in the picture and can be changed, else the usual
 * layer for new objects (or a new one called `newName`), and picks them.
 */
export function addObjects(objects: Drawn[], label: string, prefer?: ObjectLayer, newName = 'Shapes'): void {
  let layer = prefer && app.doc.layers.includes(prefer) && prefer.visible && !prefer.locked ? prefer : objectLayerForNew(app.doc);
  if (layer) {
    const before = layer.objects;
    layer.objects = [...before, ...objects];
    record(label, layer, before);
  } else {
    layer = createObjectLayer(newName, objects);
    app.history.record(addLayer(app.doc, layer, label));
  }
  pickObjects(layer, objects.map((o) => o.id));
}

// ---------- Snapping ----------

/** What a drag can snap to: every object showing except the ones being dragged, and the picture. */
export function snapTargets(skip: Set<number>): SnapTargets {
  const rects: Rect[] = [];
  for (const layer of app.doc.layers) {
    if (layer.kind !== 'objects' || !layer.visible) continue;
    for (const o of layer.objects) if (!skip.has(o.id)) rects.push(objectBounds(o));
  }
  return { rects, canvas: app.doc.board ? null : frameOf(app.doc) };
}

/** Guides snap within this many view pixels. */
export const snapTolerance = () => 6 / app.viewport.zoom;

/** Snapping is on unless it's off in the View menu, or Ctrl is held. */
export const snapsNow = (e: { ctrlKey: boolean }) => app.snapping && !e.ctrlKey;

/** Shows a snap's guides and returns it, or clears the guides when snapping is off. */
export function guided(s: SnapResult | null): SnapResult {
  app.guides = s?.guides ?? [];
  return s ?? { dx: 0, dy: 0, guides: [] };
}

export function snapThePoint(q: Point, targets: SnapTargets, e: { ctrlKey: boolean }): Point {
  const s = guided(snapsNow(e) ? snapPoint(q, targets, snapTolerance()) : null);
  return { x: q.x + s.dx, y: q.y + s.dy };
}

// ---------- Drawing ----------

function newShape(toolId: string, id: number, b: Box, swap: boolean): ShapeObject {
  const st = settingsOf(toolId);
  return {
    id,
    type: 'shape',
    kind: toolId as ShapeKind,
    ...b,
    stroke: swap ? app.secondary : app.primary,
    fill: swap ? app.primary : app.secondary,
    width: st.width as number,
    filled: st.fill as boolean,
    dash: st.dash as Dash,
    opacity: (st.opacity as number) / 100,
    radius: settingsOf('rectangle').radius as number,
    sides: settingsOf('polygon').sides as number,
    points: settingsOf('star').points as number,
  };
}

function newLine(toolId: string, id: number, a: Point, b: Point, swap: boolean): LineObject {
  const st = settingsOf(toolId);
  return {
    id,
    type: 'line',
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    bend: 0,
    color: swap ? app.secondary : app.primary,
    width: st.width as number,
    dash: st.dash as Dash,
    opacity: (st.opacity as number) / 100,
    start: st.start as Head,
    end: st.end as Head,
  };
}

/** True once the pointer has moved far enough from where it went down to count as a drag. */
export const dragged = (p: Point, q: Point) => Math.hypot(q.x - p.x, q.y - p.y) * app.viewport.zoom >= 3;

/**
 * Shapes tool: drag out a shape (Shift keeps it square or round, Alt draws from the centre).
 * Alt+click without dragging picks a colour, as with the other tools that paint.
 */
export function shapeDrag(toolId: string, p: Point, e: PointerEvent, remember: (c: string) => void): ToolDrag {
  const targets = snapTargets(new Set());
  const a = snapThePoint(p, targets, e);
  app.guides = [];
  const swap = e.button === 2;
  const id = newObjectId();
  const boxTo = (q: Point, ev: PointerEvent): Box => {
    let dx = q.x - a.x;
    let dy = q.y - a.y;
    if (ev.shiftKey) {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * s;
      dy = Math.sign(dy || 1) * s;
    }
    const b = ev.altKey
      ? { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 }
      : { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
    const x = Math.round(b.x);
    const y = Math.round(b.y);
    return { x, y, w: Math.round(b.x + b.w) - x, h: Math.round(b.y + b.h) - y, angle: 0 };
  };
  return {
    cursor: 'default',
    move: (q, ev) => {
      if (!app.draft && !dragged(p, q)) return;
      // Square and from-the-centre shapes keep their shape rather than snap.
      const at = ev.shiftKey || ev.altKey ? (guided(null), q) : snapThePoint(q, targets, ev);
      app.draft = newShape(toolId, id, boxTo(at, ev), swap);
      changed();
    },
    up: () => {
      app.guides = [];
      const draft = app.draft as ShapeObject | null;
      app.draft = null;
      if (!draft) {
        if (e.altKey && !swap) pickColor(p, remember);
        return changed();
      }
      if (draft.w < 1 || draft.h < 1) return changed();
      addObjects([draft], `Add ${nameOf(draft)}`);
    },
  };
}

function pickColor(p: Point, remember: (c: string) => void): void {
  const c = colorAt(p.x, p.y, settingsOf('picker').sample as 'layer' | 'picture');
  if (!c) return;
  app.primary = c;
  colorSignal.emit();
  remember(c);
}

/** Lines and Arrows tool: drag from one end to the other. Shift turns it in 15° steps. */
export function lineDrag(toolId: string, p: Point, e: PointerEvent): ToolDrag {
  const targets = snapTargets(new Set());
  const a = snapThePoint(p, targets, e);
  app.guides = [];
  const swap = e.button === 2;
  const id = newObjectId();
  return {
    cursor: 'default',
    move: (q, ev) => {
      if (!app.draft && !dragged(p, q)) return;
      const b = ev.shiftKey ? (guided(null), snapAngle(a, q)) : snapThePoint(q, targets, ev);
      app.draft = newLine(toolId, id, a, b, swap);
      changed();
    },
    up: () => {
      app.guides = [];
      const draft = app.draft as LineObject | null;
      app.draft = null;
      if (!draft || Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) * app.viewport.zoom < 3) return changed();
      addObjects([draft], `Add ${nameOf(draft)}`);
    },
  };
}

// ---------- Handles and moving ----------

type ObjectHandle = EdgeHandle | 'rotate' | 'p1' | 'p2' | 'bend';

/** A picked object's handles in view pixels: a shape's or mark's box and turn handle, or a line's ends and middle. */
export function objectHandles(o: Drawn): { id: ObjectHandle; x: number; y: number }[] {
  const v = app.viewport;
  if (isBoxed(o)) {
    return [...EDGE_HANDLES, 'rotate' as const].map((id) => {
      const p = handlePoint(o, id, ROTATE_GAP / v.zoom);
      const s = v.toScreen(p.x, p.y);
      return { id, x: s.x, y: s.y };
    });
  }
  const m = lineMiddle(o);
  return [
    { id: 'p1', ...v.toScreen(o.x1, o.y1) },
    { id: 'p2', ...v.toScreen(o.x2, o.y2) },
    { id: 'bend', ...v.toScreen(m.x, m.y) },
  ];
}

/** The handle of the one picked object under a view point. */
function handleAt(sx: number, sy: number): { o: Drawn; layer: ObjectLayer; id: ObjectHandle } | null {
  const picked = pickedObjects();
  if (picked?.objects.length !== 1) return null;
  const o = picked.objects[0];
  const h = objectHandles(o).find((h) => Math.abs(sx - h.x) <= HIT && Math.abs(sy - h.y) <= HIT);
  return h ? { o, layer: picked.layer, id: h.id } : null;
}

export function objectCursor(sx: number, sy: number, p: Point): string | null {
  const h = handleAt(sx, sy);
  if (h) {
    if (isBoxed(h.o)) return handleCursor(h.o, h.id as EdgeHandle | 'rotate');
    return h.id === 'bend' ? 'grab' : 'move';
  }
  return objectAt(p) ? 'move' : null;
}

/**
 * Pressing with the Shapes, Lines or a Select tool: a picked object's handle resizes, turns or bends it;
 * an object picks it and drags it (with the others picked); Shift+click adds it to the pick or takes it out.
 * Null when the press missed every object.
 */
export function objectPress(sx: number, sy: number, p: Point, e: PointerEvent): ToolDrag | null {
  const h = e.button === 0 ? handleAt(sx, sy) : null;
  if (h) return handleDrag(h.layer, h.o, h.id, p);
  const found = objectAt(p);
  if (!found) return null;
  const { layer, obj } = found;
  const sel = app.objectSel;
  const sameLayer = sel?.layer === layer;
  const inPick = sameLayer && sel!.ids.includes(obj.id);
  if (e.shiftKey) {
    if (!sameLayer) pickObjects(layer, [obj.id]);
    else pickObjects(layer, inPick ? sel!.ids.filter((id) => id !== obj.id) : [...sel!.ids, obj.id]);
    return { move: () => {}, up: () => {} };
  }
  if (!inPick) pickObjects(layer, [obj.id]);
  return moveDrag(layer, app.objectSel!.ids, p, inPick ? obj.id : null);
}

/** Drags the picked objects, snapping their box to other objects, the picture and equal spacing. */
function moveDrag(layer: ObjectLayer, ids: number[], p: Point, narrowTo: number | null): ToolDrag {
  const before = layer.objects;
  const moving = before.filter((o) => ids.includes(o.id));
  const box = rectAround(moving.flatMap((o) => {
    const r = objectBounds(o);
    return [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }];
  }));
  const targets = snapTargets(new Set(ids));
  let moved = false;
  return {
    cursor: 'move',
    carry: { kind: 'objects', layer, ids },
    cancel: () => {
      layer.objects = before;
      app.guides = [];
      changed();
    },
    move: (q, ev) => {
      if (!moved && !dragged(p, q)) return;
      moved = true;
      let dx = Math.round(q.x - p.x);
      let dy = Math.round(q.y - p.y);
      // Shift keeps the move straight across or straight up and down.
      if (ev.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const s = guided(snapsNow(ev) ? snapRect({ ...box, x: box.x + dx, y: box.y + dy }, targets, snapTolerance(), { spacing: true }) : null);
      dx += ev.shiftKey && !dx ? 0 : s.dx;
      dy += ev.shiftKey && !dy ? 0 : s.dy;
      layer.objects = before.map((o) => (ids.includes(o.id) ? moveObject(o, dx, dy) : o));
      changed();
    },
    up: () => {
      app.guides = [];
      if (moved) record(labelFor('Move', moving.filter(isDrawn)), layer, before);
      // Clicking one of several picked objects without moving picks just that one.
      else if (narrowTo !== null && ids.length > 1) pickObjects(layer, [narrowTo]);
      changed();
    },
  };
}

function handleDrag(layer: ObjectLayer, o: Drawn, id: ObjectHandle, p: Point): ToolDrag {
  const before = layer.objects;
  const targets = snapTargets(new Set([o.id]));
  const set = (n: Drawn) => {
    layer.objects = before.map((x) => (x.id === o.id ? n : x));
    changed();
  };
  const done = (verb: string) => () => {
    app.guides = [];
    if (layer.objects !== before) record(`${verb} ${nameOf(o)}`, layer, before);
    changed();
  };

  if (o.type === 'line') {
    if (id === 'bend') {
      return {
        cursor: 'grabbing',
        move: (q) => {
          const bend = bendToward(o, q);
          // Close to straight snaps straight.
          set({ ...o, bend: Math.abs(bend) < SLOP / app.viewport.zoom ? 0 : bend });
        },
        up: done('Bend'),
      };
    }
    const fixed = id === 'p1' ? { x: o.x2, y: o.y2 } : { x: o.x1, y: o.y1 };
    return {
      cursor: 'move',
      move: (q, ev) => {
        const pt = ev.shiftKey ? (guided(null), snapAngle(fixed, q)) : snapThePoint(q, targets, ev);
        set(id === 'p1' ? { ...o, x1: pt.x, y1: pt.y } : { ...o, x2: pt.x, y2: pt.y });
      },
      up: done('Move end of'),
    };
  }

  const start: Box = { x: o.x, y: o.y, w: o.w, h: o.h, angle: o.angle };
  if (id === 'rotate') {
    return { cursor: 'grabbing', move: (q, ev) => set({ ...o, ...rotateBox(start, p, q, ev.shiftKey) }), up: done('Turn') };
  }
  const h = id as EdgeHandle;
  const [sx, sy] = HANDLE_SIDES[h];
  return {
    cursor: handleCursor(start, h),
    move: (q, ev) => {
      // Markers stay round.
      const ratio = ev.shiftKey || (o.type === 'mark' && o.kind === 'marker') ? start.w / start.h : null;
      const b = resizeBox(start, h, q, { ratio, round: start.angle === 0 });
      // Edges being dragged snap, when the shape isn't turned and is free to change shape.
      if (start.angle === 0 && !ratio && snapsNow(ev)) {
        const s = guided(snapRect(b, targets, snapTolerance(), { xs: sx ? [sx < 0 ? b.x : b.x + b.w] : [], ys: sy ? [sy < 0 ? b.y : b.y + b.h] : [] }));
        if (sx < 0 && b.w - s.dx >= 1) {
          b.x += s.dx;
          b.w -= s.dx;
        } else if (sx > 0) b.w = Math.max(1, b.w + s.dx);
        if (sy < 0 && b.h - s.dy >= 1) {
          b.y += s.dy;
          b.h -= s.dy;
        } else if (sy > 0) b.h = Math.max(1, b.h + s.dy);
      } else guided(null);
      set({ ...o, ...b });
    },
    up: done('Resize'),
  };
}

// ---------- Editing the picked objects ----------

export function deletePicked(): void {
  const picked = pickedObjects();
  if (!picked) return;
  const { layer, objects } = picked;
  const before = layer.objects;
  const kept = before.filter((o) => !objects.includes(o as Drawn));
  // The markers after a deleted one count down to fill the gap.
  const gone = objects.flatMap((o) => (o.type === 'mark' && o.kind === 'marker' ? [o.number] : []));
  const numbers = renumbered(kept, gone);
  layer.objects = kept.map((o) => (numbers.has(o.id) ? { ...(o as MarkObject), number: numbers.get(o.id)! } : o));
  app.objectSel = null;
  if (gone.length) markersChanged();
  record(objects.length === 1 ? `Delete ${nameOf(objects[0])}` : 'Delete shapes', layer, before);
  changed();
}

export function nudgePicked(dx: number, dy: number): void {
  changePicked('Nudge', (o) => moveObject(o, dx, dy), 'nudge');
}

/** Ctrl+D: copies of the picked objects, a little down and to the right, picked in their place. */
export function duplicatePicked(): void {
  const picked = pickedObjects();
  if (!picked) return;
  const copies = picked.objects.map((o) => ({ ...moveObject(o, COPY_OFFSET, COPY_OFFSET), id: newObjectId() }));
  addObjects(copies, 'Duplicate', picked.layer);
}

/** Bring to Front and Send to Back, within the objects' layer. */
export function reorderPicked(front: boolean): void {
  const picked = pickedObjects();
  if (!picked) return;
  const { layer, objects } = picked;
  const before = layer.objects;
  const rest = before.filter((o) => !objects.includes(o as Drawn));
  const after = front ? [...rest, ...objects] : [...objects, ...rest];
  if (after.every((o, i) => o === before[i])) return;
  layer.objects = after;
  record(front ? 'Bring to front' : 'Send to back', layer, before);
  changed();
}

function movePickedBy(label: string, moves: Point[]): void {
  const picked = pickedObjects();
  if (!picked) return;
  const byId = new Map(picked.objects.map((o, i) => [o.id, moves[i]]));
  changePicked(label, (o) => {
    const d = byId.get(o.id);
    return d && (d.x || d.y) ? moveObject(o, d.x, d.y) : null;
  });
  changed();
}

export function alignPicked(mode: AlignMode): void {
  const picked = pickedObjects();
  if (picked) movePickedBy('Align', alignMoves(picked.objects.map(objectBounds), mode));
}

export function distributePicked(axis: 'x' | 'y'): void {
  const picked = pickedObjects();
  if (picked) movePickedBy('Distribute', distributeMoves(picked.objects.map(objectBounds), axis));
}

export const pickedCount = () => pickedObjects()?.objects.length ?? 0;

// ---------- Copy and paste ----------

/**
 * Shapes and lines copied with Ctrl+C, and the clipboard's change count just after copying, so a paste
 * can tell they're still what's on the clipboard. Their picture goes on the clipboard too, for other apps.
 */
let copied: { objects: Drawn[]; layer: ObjectLayer; seq: number; pastes: number } | null = null;

/** The picked objects drawn on a canvas just big enough for them, as they look in their layer. */
export function pickedImage(): OffscreenCanvas | null {
  const picked = pickedObjects();
  if (!picked) return null;
  const board = isOpen(app.doc);
  const r = rectAround(picked.objects.flatMap((o) => {
    const b = board ? inkBounds(o) : objectPaintBounds(o);
    return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }];
  }));
  // A spotlight darkens everything, so keep to the picture. A whiteboard and a capture have no edge to keep to.
  const x = board ? Math.floor(r.x) : Math.max(0, Math.floor(r.x));
  const y = board ? Math.floor(r.y) : Math.max(0, Math.floor(r.y));
  const right = board ? Math.ceil(r.x + r.w) : Math.min(app.doc.width, Math.ceil(r.x + r.w));
  const bottom = board ? Math.ceil(r.y + r.h) : Math.min(app.doc.height, Math.ceil(r.y + r.h));
  const c = newCanvas(right - x, bottom - y);
  const ctx = ctxOf(c);
  ctx.translate(-x, -y);
  ctx.globalAlpha = picked.layer.opacity;
  for (const o of picked.objects) drawObject(ctx, o);
  return c;
}

export function rememberCopy(seq: number): void {
  const picked = pickedObjects();
  copied = picked ? { objects: picked.objects, layer: picked.layer, seq, pastes: 0 } : null;
}

export function copiedObjectsFor(seq: number): boolean {
  return !!copied && copied.seq === seq;
}

/** Pastes the copied objects, a step further down and to the right each time, and picks them. */
export function pasteCopied(): void {
  if (!copied) return;
  copied.pastes++;
  const d = COPY_OFFSET * copied.pastes;
  const objects = copied.objects.map((o) => ({ ...moveObject(o, d, d), id: newObjectId() }));
  addObjects(objects, objects.length === 1 ? `Paste ${nameOf(objects[0])}` : 'Paste shapes', copied.layer);
  toast(objects.length === 1 ? `Pasted the ${nameOf(objects[0])}` : `Pasted ${objects.length} shapes`);
}

// ---------- Painting over objects ----------

const offered = new Set<number>();

/**
 * Pixel tools paint on the pixel layer under an object layer, so shapes and text stay editable.
 * The first time that happens on a layer, says so, with a button to rasterize the layer instead.
 */
export function offerRasterize(rasterize: () => void): void {
  const layer = app.doc.activeLayer;
  if (layer.kind !== 'objects' || offered.has(layer.id) || !layer.objects.length) return;
  offered.add(layer.id);
  toast('Shapes and text stay editable, so painting goes on the layer under them.', 8000, { label: 'Rasterize layer', run: rasterize });
}

// ---------- Restyling ----------

type Restyle = (o: Drawn, v: OptionValue) => Drawn | null;

const markOf = (o: Drawn, kind: MarkObject['kind']): MarkObject | null => (o.type === 'mark' && o.kind === kind ? o : null);

/** A marker resized round its centre. */
function sizedMarker(o: MarkObject, size: number): MarkObject {
  return { ...o, x: o.x + o.w / 2 - size / 2, y: o.y + o.h / 2 - size / 2, w: size, h: size };
}

/** How each option changes a picked object. Options an object doesn't have leave it as it is. */
const RESTYLE: Record<string, Restyle> = {
  width: (o, v) => (o.type === 'mark' ? null : { ...o, width: o.type === 'line' ? Math.max(1, v as number) : (v as number) }),
  dash: (o, v) => (o.type === 'mark' ? null : { ...o, dash: v as Dash }),
  opacity: (o, v) => ({ ...o, opacity: (v as number) / 100 }),
  size: (o, v) => {
    if (o.type !== 'mark') return null;
    if (o.kind === 'highlight') return { ...o, width: v as number };
    return o.kind === 'marker' ? sizedMarker(o, v as number) : null;
  },
  tint: (o, v) => (markOf(o, 'highlight') ? { ...(o as MarkObject), color: TINTS[v as string] ?? TINTS.yellow } : null),
  strength: (o, v) => (markOf(o, 'blur') ? { ...(o as MarkObject), strength: v as number } : null),
  block: (o, v) => (markOf(o, 'pixelate') ? { ...(o as MarkObject), block: v as number } : null),
  dim: (o, v) => (markOf(o, 'spotlight') ? { ...(o as MarkObject), dim: v as number } : null),
  shape: (o, v) => (markOf(o, 'spotlight') ? { ...(o as MarkObject), round: v === 'ellipse' } : null),
  next: (o, v) => (markOf(o, 'marker') ? { ...(o as MarkObject), number: v as number } : null),
  fill: (o, v) => (o.type === 'shape' ? { ...o, filled: v as boolean, fill: v ? app.secondary : o.fill } : null),
  radius: (o, v) => (o.type === 'shape' && o.kind === 'rectangle' ? { ...o, radius: v as number } : null),
  sides: (o, v) => (o.type === 'shape' && o.kind === 'polygon' ? { ...o, sides: v as number } : null),
  points: (o, v) => (o.type === 'shape' && o.kind === 'star' ? { ...o, points: v as number } : null),
  start: (o, v) => (o.type === 'line' ? { ...o, start: v as Head } : null),
  end: (o, v) => (o.type === 'line' ? { ...o, end: v as Head } : null),
};

// The options bar changes the picked objects.
onOptionChange((toolId, key) => {
  const picked = pickedObjects();
  const first = firstPicked();
  const fn = RESTYLE[key];
  if (!picked || !first || !fn || toolId !== toolForObject(first)) return;
  const v = settingsOf(toolId)[key];
  changePicked(labelFor('Restyle', picked.objects), (o) => fn(o, v), `style:${key}`);
  // Giving a line an arrowhead makes it an arrow, whose options then show.
  pickObjects(picked.layer, app.objectSel?.ids ?? []);
});

// Colour 1 is the outline and line colour of the picked objects; colour 2 is a shape's fill.
let lastColors = { primary: app.primary, secondary: app.secondary };
colorSignal.on(() => {
  const was = lastColors;
  lastColors = { primary: app.primary, secondary: app.secondary };
  if (!pickedObjects()) return;
  const p1 = app.primary !== was.primary;
  const p2 = app.secondary !== was.secondary;
  changePicked(
    'Recolour',
    (o) => {
      if (o.type === 'mark') return o.kind === 'marker' && p1 ? { ...o, color: app.primary } : null;
      if (o.type === 'line') return p1 ? { ...o, color: app.primary } : null;
      return { ...o, stroke: p1 ? app.primary : o.stroke, fill: p2 ? app.secondary : o.fill };
    },
    'colour',
  );
});

// Changing tools lets go of the pick, so the options bar shows the new tool's settings.
onToolChange(() => {
  app.draft = null;
  app.guides = [];
  clearPicked();
});

// ---------- Markers ----------

let markerListener: () => void = () => {};

/** The marker tool's hook for when markers are deleted, so its next number follows. */
export function onMarkersChanged(fn: () => void): void {
  markerListener = fn;
}

function markersChanged(): void {
  markerListener();
}
