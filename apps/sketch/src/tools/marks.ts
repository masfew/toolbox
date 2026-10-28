import { app, changed, docSignal } from '../app/store';
import { loadOptions, onToolChange, settingsOf } from '../app/tools';
import { pathBox, type MarkKind, type MarkObject } from '../engine/marks';
import { newObjectId } from '../engine/objects';
import type { Point } from './box';
import type { ToolDrag } from './drag';
import { snapAngle } from './snap';
import { addObjects, dragged, guided, onMarkersChanged, snapTargets, snapThePoint, TINTS } from './shapes';

/**
 * The Mark-Up tools (step 5.2): highlighter, blur, pixelate, numbered markers and the spotlight.
 * They draw marks (`engine/marks.ts`), which are objects, so they're picked, moved, resized and
 * restyled like shapes afterwards. Callouts are in `callout.ts`.
 */


function newMark(kind: MarkKind, box: { x: number; y: number; w: number; h: number }): MarkObject {
  const st = settingsOf(kind);
  return {
    id: newObjectId(),
    type: 'mark',
    kind,
    ...box,
    angle: 0,
    color: app.primary,
    opacity: 1,
    width: 20,
    path: [],
    strength: (st.strength as number) ?? 70,
    block: (st.block as number) ?? 14,
    number: 1,
    dim: (st.dim as number) ?? 60,
    round: st.shape === 'ellipse',
  };
}

const nameOf = (kind: MarkKind) => ({ highlight: 'highlight', blur: 'blur', pixelate: 'pixelate', marker: 'marker', spotlight: 'spotlight' })[kind];

/** Blur, pixelate and spotlight: drag out a box (Shift keeps it square, Alt draws from the centre). */
export function markBoxDrag(kind: MarkKind, p: Point, e: PointerEvent): ToolDrag {
  const targets = snapTargets(new Set());
  const a = snapThePoint(p, targets, e);
  app.guides = [];
  const id = newObjectId();
  const boxTo = (q: Point, ev: PointerEvent) => {
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
    return { x, y, w: Math.round(b.x + b.w) - x, h: Math.round(b.y + b.h) - y };
  };
  return {
    cursor: 'default',
    move: (q, ev) => {
      if (!app.draft && !dragged(p, q)) return;
      const at = ev.shiftKey || ev.altKey ? (guided(null), q) : snapThePoint(q, targets, ev);
      app.draft = { ...newMark(kind, boxTo(at, ev)), id };
      changed();
    },
    up: () => {
      app.guides = [];
      const draft = app.draft as MarkObject | null;
      app.draft = null;
      if (!draft || draft.w < 2 || draft.h < 2) return changed();
      addObjects([draft], `Add ${nameOf(kind)}`);
    },
  };
}

/** Highlighter: draw freehand, or a straight stroke with Shift. The stroke becomes one mark. */
export function highlightDrag(p: Point, e: PointerEvent): ToolDrag {
  const st = settingsOf('highlight');
  const width = st.size as number;
  const points: Point[] = [p];
  const id = newObjectId();
  const draft = (pts: Point[]): MarkObject => ({
    ...newMark('highlight', { x: 0, y: 0, w: 1, h: 1 }),
    ...pathBox(pts, width),
    id,
    width,
    color: TINTS[st.tint as string] ?? TINTS.yellow,
    opacity: (st.opacity as number) / 100,
  });
  let straight = e.shiftKey;
  app.draft = draft(points);
  changed();
  return {
    cursor: 'default',
    move: (q, ev) => {
      straight = ev.shiftKey;
      if (straight) {
        app.draft = draft([p, snapAngle(p, q)]);
      } else {
        const last = points[points.length - 1];
        if (Math.hypot(q.x - last.x, q.y - last.y) * app.viewport.zoom < 2) return;
        points.push(q);
        app.draft = draft(points);
      }
      changed();
    },
    up: () => {
      const mark = app.draft as MarkObject | null;
      app.draft = null;
      if (!mark) return changed();
      addObjects([mark], 'Add highlight');
    },
  };
}

// ---------- Numbered markers ----------

/** Every marker in the picture. */
function markers(): MarkObject[] {
  return app.doc.layers.flatMap((l) => l.objects.filter((o): o is MarkObject => o.type === 'mark' && o.kind === 'marker'));
}

/** Sets the marker tool's next number to one more than the highest marker in the picture. */
function syncNext(): void {
  const top = Math.max(0, ...markers().map((m) => m.number));
  loadOptions('marker', { next: Math.min(99, top + 1) });
}

/**
 * Numbered marker: a click puts the next number there, and dragging before letting go moves it.
 * The number is the one on the options bar, unless a marker already has it (as when the bar shows a
 * picked marker's number); then it's one more than the highest.
 */
export function markerDrag(p: Point, button: number): ToolDrag {
  const st = settingsOf('marker');
  const size = st.size as number;
  const taken = markers().map((m) => m.number);
  const number = taken.includes(st.next as number) ? Math.max(0, ...taken) + 1 : (st.next as number);
  const at = (q: Point) => ({ x: Math.round(q.x - size / 2), y: Math.round(q.y - size / 2), w: size, h: size });
  const id = newObjectId();
  app.draft = { ...newMark('marker', at(p)), id, number, color: button === 2 ? app.secondary : app.primary };
  changed();
  return {
    cursor: 'move',
    move: (q) => {
      app.draft = { ...(app.draft as MarkObject), ...at(q) };
      changed();
    },
    up: () => {
      const mark = app.draft as MarkObject | null;
      app.draft = null;
      if (!mark) return changed();
      addObjects([mark], `Add marker ${number}`);
      loadOptions('marker', { next: Math.min(99, number + 1) });
    },
  };
}

// The next number follows the picture: a new or opened picture, deleted markers, and picking the tool.
docSignal.on(syncNext);
onMarkersChanged(syncNext);
onToolChange((_, to) => to === 'marker' && syncNext());
