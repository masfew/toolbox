import { app, changed } from '../app/store';
import { settingsOf } from '../app/tools';
import type { Point } from './box';
import { pressureOf, type ToolDrag } from './drag';
import { Stroke, type Nib, type StrokeSpec } from './stroke';

export const PAINT_TOOLS = ['pencil', 'brush', 'eraser'];

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

/** Brush, pencil and eraser. Shift+click draws a straight line from where the last stroke ended. */
export function paintDrag(toolId: string, p: Point, e: PointerEvent): ToolDrag {
  const layer = app.doc.paintLayer;
  const at = { x: p.x, y: p.y, p: pressureOf(e) };
  const last = app.lastPoint;
  const fromLast = e.shiftKey && last && last.layerId === layer.id;
  const stroke = new Stroke(layer, specFor(toolId, e.button), fromLast ? { x: last.x, y: last.y, p: at.p } : at);
  if (fromLast) stroke.lineTo(at);
  app.liveStroke = stroke.live;
  app.requestRender();
  return {
    move: (_, ev, toDoc) => {
      const events = ev.getCoalescedEvents?.() ?? [];
      for (const pt of events.length ? events : [ev]) {
        const q = toDoc(pt);
        stroke.to({ x: q.x, y: q.y, p: pressureOf(pt) });
      }
      app.requestRender();
    },
    up: () => {
      const cmd = stroke.finish();
      app.liveStroke = null;
      app.lastPoint = { layerId: layer.id, x: stroke.last.x, y: stroke.last.y };
      if (cmd) app.history.record(cmd);
      else changed();
    },
  };
}
