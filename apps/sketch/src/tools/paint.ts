import { cleanUp } from '../app/cleanUp';
import { app, changed } from '../app/store';
import { settingsOf } from '../app/tools';
import type { Point } from './box';
import { pressureOf, type ToolDrag } from './drag';
import { QuickShape, type Look } from './quickshape';
import { NIB_ALPHA, Stroke, type Nib, type StrokeSpec } from './stroke';

export const PAINT_TOOLS = ['pencil', 'brush', 'eraser'];

/** Tools whose rough lines, arrows, boxes and circles clean up when the pointer is held still (F18). The eraser's don't. */
const CLEAN_UP_TOOLS = ['pencil', 'brush'];

function specFor(toolId: string, button: number): StrokeSpec {
  const st = settingsOf(toolId);
  const color = button === 2 ? app.secondary : app.primary;
  if (toolId === 'pencil') {
    return { nib: 'pencil', color, size: st.size as number, opacity: 1, smoothing: false, pressure: 'off', label: 'Pencil' };
  }
  if (toolId === 'eraser') {
    return {
      nib: 'eraser',
      color: st.mode === 'secondary' ? app.secondary : 'clear',
      size: st.size as number,
      opacity: 1,
      smoothing: false,
      pressure: 'off',
      label: 'Eraser',
    };
  }
  return {
    nib: st.type as Nib,
    color,
    size: st.size as number,
    opacity: (st.opacity as number) / 100,
    smoothing: st.smoothing as boolean,
    pressure: st.pressure as StrokeSpec['pressure'],
    label: st.type === 'marker' ? 'Marker' : st.type === 'highlighter' ? 'Highlighter' : 'Brush stroke',
  };
}

/** What a clean shape keeps of the stroke it replaces: its colour, its width and how see-through it is. */
function lookOf(spec: StrokeSpec): Look {
  return { color: spec.color, width: Math.max(1, spec.size), opacity: spec.opacity * NIB_ALPHA[spec.nib] };
}

/** Brush, pencil and eraser. Shift+click draws a straight line from where the last stroke ended. */
export function paintDrag(toolId: string, p: Point, e: PointerEvent): ToolDrag {
  const layer = app.doc.paintLayer;
  const at = { x: p.x, y: p.y, p: pressureOf(e) };
  const last = app.lastPoint;
  const fromLast = e.shiftKey && last && last.layerId === layer.id;
  const spec = specFor(toolId, e.button);
  const stroke = new Stroke(layer, spec, fromLast ? { x: last.x, y: last.y, p: at.p } : at);
  if (fromLast) stroke.lineTo(at);
  // Holding still at the end of the stroke may turn it into a clean shape (F18), unless Settings has that off.
  const quick = cleanUp.on && CLEAN_UP_TOOLS.includes(toolId) ? new QuickShape(stroke, layer, lookOf(spec), fromLast ? [{ x: last.x, y: last.y }, at] : [at], e) : null;
  app.liveStroke = stroke.live;
  app.requestRender();
  return {
    move: (_, ev, toDoc) => {
      const events = ev.getCoalescedEvents?.() ?? [];
      const moves = events.length ? events : [ev];
      const where = moves.map((pt) => toDoc(pt));
      // Once a clean shape has replaced the stroke, moving resizes the shape instead.
      if (quick?.moved(ev, where)) return;
      moves.forEach((pt, i) => stroke.to({ x: where[i].x, y: where[i].y, p: pressureOf(pt) }));
      app.requestRender();
    },
    up: () => {
      if (quick?.finish()) return;
      const cmd = stroke.finish();
      app.liveStroke = null;
      app.lastPoint = { layerId: layer.id, x: stroke.last.x, y: stroke.last.y };
      if (cmd) app.history.record(cmd);
      else changed();
    },
  };
}
