import { rasterizeCurrentLayer, rememberColor, settle } from '../app/actions';
import { clampView, growBoardForPointer } from '../app/board';
import { paintBlocked } from '../app/layers';
import { pointerCss, pointerShapeOf } from '../app/pointer';
import { ringWidth } from '../app/pointerStyle';
import { app, changed, cursorSignal, tabs, uiSignal } from '../app/store';
import { carryTo, HOVER_MS, markTarget, tabAt } from '../app/tabDrag';
import { currentSize, currentTool, notBuiltYet, setSize, settingsOf } from '../app/tools';
import { isOpen } from '../engine/board';
import { MAX_SIZE } from '../engine/document';
import { resizeCanvas } from '../engine/commands';
import type { Point } from '../tools/box';
import { cropCursor, cropDrag } from '../tools/crop';
import type { ToolDrag } from '../tools/drag';
import { fillAt, pickDrag, PICKER_CURSOR } from '../tools/fill';
import { PAINT_TOOLS, paintDrag } from '../tools/paint';
import { freeSelectDrag, isSelectTool, rectSelectDrag, selectionCursor, selectionDrag, wandSelect } from '../tools/selection';
import { calloutDrag, tailDrag, tailHandleAt } from '../tools/callout';
import { highlightDrag, markBoxDrag, markerDrag } from '../tools/marks';
import { clearPicked, isObjectTool, LINE_TOOLS, lineDrag, objectCursor, objectPress, offerRasterize, SHAPE_TOOLS, shapeDrag } from '../tools/shapes';
import { commitText, textDrag } from '../tools/text';
import { hitHandle, type HandleEdge, type Renderer } from './renderer';

type Drag =
  | { kind: 'pan'; startX: number; startY: number; panX: number; panY: number }
  | { kind: 'resize'; edge: HandleEdge }
  | { kind: 'size'; startX: number; startSize: number }
  | { kind: 'tool'; tool: ToolDrag };

const CURSORS: Record<HandleEdge, string> = { r: 'ew-resize', b: 'ns-resize', rb: 'nwse-resize' };

/** Tools that paint with the colours, where Alt+click picks a colour. */
function usesColors(): boolean {
  return currentTool().options.some((o) => o.kind === 'colors');
}

/** Handles mouse, pen and wheel input on the view canvas. */
export class CanvasController {
  private drag: Drag | null = null;
  private spaceDown = false;
  private altDown = false;
  private last: { sx: number; sy: number } | null = null;
  /** A carried selection or shapes resting on another tab, which switches to it after a moment (F14.3). */
  private hover: { index: number; at: { clientX: number; clientY: number }; timer: number } | null = null;
  /** The brush size (picture pixels) while the size circle stands in for the pointer, else null (F17). */
  private ring: number | null = null;
  /** The cursor last handed to the canvas, so an unchanged one isn't set again on every move. */
  private cursorNow = '';

  constructor(
    private readonly el: HTMLCanvasElement,
    private readonly renderer: Renderer,
    private readonly ringEl: HTMLElement | null = null,
  ) {
    // The pointer follows a brush size, zoom, tool or setting change at once, without the mouse moving.
    uiSignal.on(() => (this.drag ? this.syncRing() : this.updateCursor()));
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('pointerleave', () => {
      this.last = null;
      this.syncRing();
      if (!this.drag) {
        app.cursor = null;
        cursorSignal.emit();
      }
    });
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e)) {
        e.preventDefault();
        this.spaceDown = true;
        this.updateCursor();
      }
      if (e.key === 'Alt' && !this.altDown) {
        this.altDown = true;
        this.updateCursor();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.updateCursor();
      }
      if (e.key === 'Alt') {
        this.altDown = false;
        this.updateCursor();
      }
    });
    window.addEventListener('blur', () => {
      this.spaceDown = false;
      this.altDown = false;
    });
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toDoc = (e: { clientX: number; clientY: number }): Point => {
    const s = this.local(e);
    return app.viewport.toDoc(s.x, s.y);
  };

  private down(e: PointerEvent): void {
    const s = this.local(e);
    const v = app.viewport;
    let p = v.toDoc(s.x, s.y);
    // Before a tool puts pixels on a whiteboard or a capture, its canvas grows to hold what's on
    // screen. That can move the canvas's pixels, so the point is worked out again.
    const ink = () => {
      if (!isOpen(app.doc)) return;
      growBoardForPointer(s.x, s.y);
      p = v.toDoc(s.x, s.y);
    };
    this.el.setPointerCapture(e.pointerId);

    if (e.button === 1 || this.spaceDown) {
      this.drag = { kind: 'pan', startX: s.x, startY: s.y, panX: v.panX, panY: v.panY };
      e.preventDefault();
      this.updateCursor();
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;

    // A callout's round handle moves the point it points at, even while it's being typed in.
    if (e.button === 0) {
      const d = tailDrag(s.x, s.y);
      if (d) return this.startTool(d);
    }

    // A click on the picture finishes the text being typed.
    if (app.textEdit) {
      commitText();
      return;
    }

    const tool = currentTool();
    if (app.selection && e.button === 0) {
      const d = selectionDrag(s.x, s.y, p);
      if (d) return this.startTool(d);
    }

    // Shapes and lines: the picked one's handles, then any shape or line under the pointer.
    // The select tools pick them too. A selection of pixels or a pasted picture is placed first.
    if (!app.selection && (isObjectTool(tool.id) || (isSelectTool(tool.id) && !e.altKey))) {
      const d = objectPress(s.x, s.y, p, e);
      if (d) return this.startTool(d);
    }
    clearPicked();

    const edge = e.button === 0 && tool.id !== 'crop' ? hitHandle(s.x, s.y) : null;
    if (edge) {
      settle();
      this.drag = { kind: 'resize', edge };
      app.resizePreview = { w: app.doc.width, h: app.doc.height };
      changed();
      return;
    }

    if (app.selection) {
      // Clicking outside a selection or a pasted picture places it, as in Paint.
      settle();
      if (!isSelectTool(tool.id) || e.button !== 0) return;
    }

    // Alt + right-drag sets the tool's size, with a circle showing it.
    const size = currentSize();
    if (e.altKey && e.button === 2 && size) {
      this.ring = null;
      this.syncRing();
      this.drag = { kind: 'size', startX: s.x, startSize: size.value };
      app.sizePreview = { x: s.x, y: s.y, size: size.value };
      this.renderer.request();
      return;
    }

    // Alt + click picks a colour with any tool that paints. The Shapes tool picks on a click, as Alt + drag draws from the centre.
    if (e.altKey && e.button === 0 && usesColors() && !SHAPE_TOOLS.includes(tool.id)) {
      return this.startTool(pickDrag(p, e.button, settingsOf('picker').sample as 'layer' | 'picture', rememberColor));
    }

    if (tool.planned) {
      notBuiltYet(tool);
      return;
    }

    // New shapes and mark-up go on the current layer, so a locked or hidden one refuses them, as for painting.
    if (isObjectTool(tool.id) && !(e.altKey && SHAPE_TOOLS.includes(tool.id)) && paintBlocked()) return;
    if (SHAPE_TOOLS.includes(tool.id)) return this.startTool(shapeDrag(tool.id, p, e, rememberColor));
    if (LINE_TOOLS.includes(tool.id)) return this.startTool(lineDrag(tool.id, p, e));
    if (PAINT_TOOLS.includes(tool.id)) {
      if (paintBlocked()) return;
      offerRasterize(rasterizeCurrentLayer);
      ink();
      return this.startTool(paintDrag(tool.id, p, e));
    }
    switch (tool.id) {
      case 'fill':
        if (paintBlocked()) return;
        offerRasterize(rasterizeCurrentLayer);
        ink();
        void fillAt(p, e.button);
        return;
      case 'picker':
        return this.startTool(pickDrag(p, e.button, settingsOf('picker').sample as 'layer' | 'picture', rememberColor));
      case 'select-rect':
        if (e.button === 0) (ink(), this.startTool(rectSelectDrag(p)));
        return;
      case 'select-free':
        if (e.button === 0) (ink(), this.startTool(freeSelectDrag(p)));
        return;
      case 'magic-wand':
        if (e.button === 0) (ink(), void wandSelect(p));
        return;
      case 'crop':
        if (e.button === 0) this.startTool(cropDrag(s.x, s.y, p));
        return;
      case 'text':
        return this.startTool(textDrag(p, e.button));
      case 'callout':
        return this.startTool(calloutDrag(p, e));
      case 'highlight':
        if (e.button === 0) this.startTool(highlightDrag(p, e));
        return;
      case 'marker':
        return this.startTool(markerDrag(p, e.button));
      case 'blur':
      case 'pixelate':
      case 'spotlight':
        if (e.button === 0) this.startTool(markBoxDrag(tool.id, p, e));
        return;
    }
  }

  private startTool(tool: ToolDrag): void {
    this.drag = { kind: 'tool', tool };
    if (tool.cursor) {
      this.ring = null;
      this.setCursor(this.dragCursor(tool.cursor));
      this.syncRing();
    }
  }

  private move(e: PointerEvent): void {
    const s = this.local(e);
    this.last = { sx: s.x, sy: s.y };
    const v = app.viewport;
    const p = v.toDoc(s.x, s.y);
    app.cursor = { x: Math.floor(p.x), y: Math.floor(p.y) };
    cursorSignal.emit();
    this.placeRing();

    const d = this.drag;
    if (!d) {
      this.updateCursor();
      return;
    }
    switch (d.kind) {
      case 'pan':
        v.panX = d.panX + (s.x - d.startX);
        v.panY = d.panY + (s.y - d.startY);
        clampView();
        // The text box being typed in is part of the page, so it needs the interface to follow.
        if (app.textEdit) changed();
        else this.renderer.request();
        break;
      case 'resize': {
        const w = d.edge === 'b' ? app.doc.width : Math.round(p.x);
        const h = d.edge === 'r' ? app.doc.height : Math.round(p.y);
        app.resizePreview = { w: clampSize(w), h: clampSize(h) };
        changed();
        break;
      }
      case 'size': {
        // The circle's edge follows the mouse.
        setSize(d.startSize + ((s.x - d.startX) * 2) / v.zoom);
        if (app.sizePreview) app.sizePreview.size = currentSize()?.value ?? d.startSize;
        break;
      }
      case 'tool':
        d.tool.move(p, e, this.toDoc);
        this.watchTabs(e, d.tool);
        break;
    }
  }

  /** While a selection or shapes are moved, resting on another tab carries them onto it. */
  private watchTabs(e: PointerEvent, tool: ToolDrag): void {
    const index = tool.carry && tabs.list.length > 1 ? tabAt(e.clientX, e.clientY) : -1;
    const at = { clientX: e.clientX, clientY: e.clientY };
    if (this.hover && this.hover.index === index) {
      this.hover.at = at;
      return;
    }
    this.stopHover();
    if (index < 0) return;
    markTarget(index);
    const hover = {
      index,
      at,
      timer: window.setTimeout(() => {
        this.stopHover();
        const d = this.drag;
        if (d?.kind !== 'tool') return;
        const next = carryTo(index, d.tool, hover.at, this.toDoc);
        if (next) this.startTool(next);
      }, HOVER_MS),
    };
    this.hover = hover;
  }

  private stopHover(): void {
    if (!this.hover) return;
    clearTimeout(this.hover.timer);
    this.hover = null;
    markTarget(-1);
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.stopHover();
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'tool') {
      d.tool.up(this.toDoc(e), e);
    } else if (d.kind === 'size') {
      app.sizePreview = null;
      changed();
    } else if (d.kind === 'resize') {
      const r = app.resizePreview;
      app.resizePreview = null;
      if (r && (r.w !== app.doc.width || r.h !== app.doc.height)) {
        app.history.record(resizeCanvas(app.doc, r.w, r.h));
        app.docIsNew = false;
      }
      changed();
    }
    this.updateCursor();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const v = app.viewport;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? v.height : 1;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+wheel and trackpad pinch both arrive here.
      const s = this.local(e);
      v.zoomBy(Math.exp(-e.deltaY * unit * 0.002), s.x, s.y);
    } else if (e.shiftKey && e.deltaX === 0) {
      v.panX -= e.deltaY * unit;
    } else {
      v.panX -= e.deltaX * unit;
      v.panY -= e.deltaY * unit;
    }
    clampView();
    changed();
  }

  private updateCursor(): void {
    this.ring = null;
    this.setCursor(this.cursorFor());
    this.syncRing();
  }

  private setCursor(c: string): void {
    if (c === this.cursorNow) return;
    this.cursorNow = c;
    this.el.style.cursor = c;
  }

  /**
   * The pointer the setting picks for the tool showing, or `fallback` (the arrow, the text I-beam) when
   * that's the arrow, the tool isn't a drawing tool, or the pointer is off the picture. A dot or crosshair
   * is a CSS cursor; the circle hides the system pointer and sets `ring` for `syncRing` to draw.
   */
  private chosen(fallback: string, p: Point | null): string {
    const tool = currentTool();
    const shape = pointerShapeOf(tool.id);
    if (shape === 'arrow') return fallback;
    // A picture has an edge to be over; a whiteboard and a capture are drawn on all over.
    if (!p || !(isOpen(app.doc) || (p.x >= 0 && p.y >= 0 && p.x < app.doc.width && p.y < app.doc.height))) return fallback;
    if (shape === 'circle') {
      const size = currentSize();
      if (!size) return pointerCss('dot');
      this.ring = size.value;
      return 'none';
    }
    return pointerCss(shape);
  }

  /** A drag's own cursor, except that the arrow and I-beam of drawing a shape or text give way to the chosen pointer. */
  private dragCursor(c: string): string {
    if (c !== 'default' && c !== 'text') return c;
    const at = this.last;
    return this.chosen(c, at ? app.viewport.toDoc(at.sx, at.sy) : null);
  }

  /** Shows the size circle where `ring` says, at the mouse, or hides it. */
  private syncRing(): void {
    const el = this.ringEl;
    if (!el) return;
    if (this.ring === null || !this.last) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    const w = ringWidth(this.ring, app.viewport.zoom);
    el.style.width = el.style.height = `${w}px`;
    el.hidden = false;
    this.placeRing();
  }

  private placeRing(): void {
    const el = this.ringEl;
    if (!el || this.ring === null || !this.last) return;
    const w = ringWidth(this.ring, app.viewport.zoom);
    el.style.transform = `translate(${this.last.sx - w / 2}px, ${this.last.sy - w / 2}px)`;
  }

  private cursorFor(): string {
    const d = this.drag;
    if (d?.kind === 'pan') return 'grabbing';
    if (d?.kind === 'resize') return CURSORS[d.edge];
    if (d?.kind === 'tool' && d.tool.cursor) return this.dragCursor(d.tool.cursor);
    if (this.spaceDown) return 'grab';
    const tool = currentTool();
    const at = this.last;
    if (!at) return 'default';
    const p = app.viewport.toDoc(at.sx, at.sy);
    if (app.textEdit) return 'default';
    if (app.selection) {
      const c = selectionCursor(at.sx, at.sy, p);
      if (c) return c;
    }
    if (tool.id !== 'crop') {
      const edge = hitHandle(at.sx, at.sy);
      if (edge) return CURSORS[edge];
    }
    if (isObjectTool(tool.id) || (isSelectTool(tool.id) && !app.selection)) {
      const c = objectCursor(at.sx, at.sy, p);
      if (c) return c;
    }
    if (app.selection && !isSelectTool(tool.id)) return 'default';
    if (tool.planned) return 'not-allowed';
    if ((this.altDown && usesColors()) || tool.id === 'picker') return PICKER_CURSOR;
    if (tool.id === 'text') return this.chosen('text', p);
    if (tailHandleAt(at.sx, at.sy)) return 'grab';
    if (tool.id === 'crop') return cropCursor(at.sx, at.sy, p);
    return this.chosen('default', p);
  }
}

function clampSize(n: number): number {
  return Math.min(MAX_SIZE, Math.max(1, n));
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
