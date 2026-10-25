import { app, changed } from '../app/store';
import { currentTool, onOptionChange, onToolChange, settingsOf } from '../app/tools';
import { frameOf } from '../engine/board';
import { cropTo } from '../engine/commands';
import { EDGE_HANDLES, handleCursor, handlePoint, insideBox, moveBox, resizeBox, type Box, type EdgeHandle, type Point } from './box';
import type { ToolDrag } from './drag';

const HIT = 7;

/** Width over height for the ratio option, or null for any shape. */
function ratio(): number | null {
  const r = settingsOf('crop').ratio as string;
  if (r === 'original') {
    const f = frameOf(app.doc);
    return f.w / f.h;
  }
  const m = /^(\d+):(\d+)$/.exec(r);
  return m ? Number(m[1]) / Number(m[2]) : null;
}

/** Where the crop box starts: the picture, which on a capture grown past its edges is the capture itself. */
function full(): Box {
  return { ...frameOf(app.doc), angle: 0 };
}

/** The largest box of the chosen shape that fits in `b`, centred on it. */
function fitRatio(b: Box): Box {
  const r = ratio();
  if (!r) return b;
  let w = b.w;
  let h = Math.round(w / r);
  if (h > b.h) {
    h = b.h;
    w = Math.round(h * r);
  }
  return { x: Math.round(b.x + (b.w - w) / 2), y: Math.round(b.y + (b.h - h) / 2), w: Math.max(1, w), h: Math.max(1, h), angle: 0 };
}

function setBox(box: Box): void {
  app.crop = { box, docW: app.doc.width, docH: app.doc.height };
  changed();
}

/** The crop box, starting again from the whole picture when the picture has changed size. */
export function cropBox(): Box {
  const c = app.crop;
  if (!c || c.docW !== app.doc.width || c.docH !== app.doc.height) {
    const box = fitRatio(full());
    app.crop = { box, docW: app.doc.width, docH: app.doc.height };
    return box;
  }
  return c.box;
}

/** Keeps a box inside the picture. */
function clampBox(b: Box): Box {
  const W = app.doc.width;
  const H = app.doc.height;
  const x0 = Math.max(0, Math.min(b.x, W - 1));
  const y0 = Math.max(0, Math.min(b.y, H - 1));
  const x1 = Math.max(x0 + 1, Math.min(W, b.x + b.w));
  const y1 = Math.max(y0 + 1, Math.min(H, b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, angle: 0 };
}

export function cropIsWhole(): boolean {
  const b = cropBox();
  return b.x === 0 && b.y === 0 && b.w === app.doc.width && b.h === app.doc.height;
}

/** Enter, or the Crop button: keeps what's in the box. */
export function applyCrop(): void {
  const b = cropBox();
  if (cropIsWhole()) return;
  app.history.record(cropTo(app.doc, b.x, b.y, b.w, b.h));
  // Keep what was kept where it was on screen.
  const v = app.viewport;
  v.panX += b.x * v.zoom;
  v.panY += b.y * v.zoom;
  app.docIsNew = false;
  setBox(fitRatio(full()));
}

/** Esc: back to the whole picture. */
export function resetCrop(): boolean {
  if (cropIsWhole()) return false;
  setBox(fitRatio(full()));
  return true;
}

export function cropHandles(): { id: EdgeHandle; x: number; y: number }[] {
  const b = cropBox();
  const v = app.viewport;
  return EDGE_HANDLES.map((id) => {
    const p = handlePoint(b, id);
    const s = v.toScreen(p.x, p.y);
    return { id, x: s.x, y: s.y };
  });
}

function hit(sx: number, sy: number, p: Point): EdgeHandle | 'inside' | null {
  for (const h of cropHandles()) if (Math.abs(sx - h.x) <= HIT && Math.abs(sy - h.y) <= HIT) return h.id;
  return insideBox(cropBox(), p.x, p.y) ? 'inside' : null;
}

export function cropCursor(sx: number, sy: number, p: Point): string {
  const h = hit(sx, sy, p);
  if (h === 'inside') return 'move';
  return h ? handleCursor(cropBox(), h) : 'default';
}

/** Drag a handle to resize the box, inside it to move it, or outside it to draw a new one. */
export function cropDrag(sx: number, sy: number, p: Point): ToolDrag {
  const start = cropBox();
  const h = hit(sx, sy, p);
  const clampPoint = (q: Point) => ({ x: Math.min(app.doc.width, Math.max(0, q.x)), y: Math.min(app.doc.height, Math.max(0, q.y)) });
  if (h === 'inside') {
    return {
      cursor: 'move',
      move: (q) => {
        const b = moveBox(start, q.x - p.x, q.y - p.y, true);
        b.x = Math.min(app.doc.width - b.w, Math.max(0, b.x));
        b.y = Math.min(app.doc.height - b.h, Math.max(0, b.y));
        setBox(b);
      },
      up: () => {},
    };
  }
  if (h) {
    return {
      cursor: handleCursor(start, h),
      move: (q) => setBox(clampBox(resizeBox(start, h, clampPoint(q), { ratio: ratio(), round: true }))),
      up: () => {},
    };
  }
  // A new box, from the press to the pointer.
  const a = clampPoint(p);
  return {
    move: (q) => {
      const b = clampPoint(q);
      const corner: Box = { x: Math.round(a.x), y: Math.round(a.y), w: 0, h: 0, angle: 0 };
      const handle: EdgeHandle = `${b.y < a.y ? 'n' : 's'}${b.x < a.x ? 'w' : 'e'}` as EdgeHandle;
      setBox(clampBox(resizeBox(corner, handle, b, { ratio: ratio(), round: true })));
    },
    up: () => {},
  };
}

onToolChange((_, to) => {
  if (to === 'crop') setBox(fitRatio(full()));
  else app.crop = null;
});

onOptionChange((toolId, key) => {
  if (toolId === 'crop' && key === 'ratio' && currentTool().id === 'crop') setBox(fitRatio(cropBox()));
});
