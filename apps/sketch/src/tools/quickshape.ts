/**
 * Clean up rough shapes (F18): draw with the brush or pencil and hold the pointer still for about half a
 * second, and a rough line, arrow, box or circle becomes a clean shape object (`recognize.ts` says which).
 * The shape takes the stroke's place at once; while the button is still down, moving the pointer resizes it
 * (a line's or arrow's end follows), and letting go keeps it. The clean-up is one undo step, and undoing it
 * brings the rough stroke back as it was drawn (the stroke is a step of its own just before it).
 */
import { withAlpha } from '../app/color';
import { app, changed, tabs, type Tab } from '../app/store';
import { settingsOf } from '../app/tools';
import type { Layer } from '../engine/document';
import { CompositeCommand, type Command } from '../engine/history';
import { newObjectId } from '../engine/objects';
import type { Head, LineObject, ShapeObject } from '../engine/shapes';
import { recognize, type Pt, type Recognized } from './recognize';
import { addObjectsStep, nameOf, pickObjects, type Drawn } from './shapes';
import { snapAngle } from './snap';
import type { Stroke } from './stroke';

/** How long the pointer has to stay still, and how far (screen pixels) it may drift while it does. */
export const HOLD_MS = 500;
export const STILL_PX = 4;
/** A stroke with more points than this is never matched (it is no rough shape, and keeping them all costs memory). */
const MAX_POINTS = 20000;
/** A stroke smaller than this on screen (corner to corner) is left alone, however it is shaped. */
const MIN_SCREEN = 24;

/** What the shape takes from the stroke it replaces. */
export interface Look {
  color: string;
  width: number;
  opacity: number;
}

/** Undoes what `inner` did when redone, and redoes it when undone. Its memory is `inner`'s, counted where that is recorded. */
class Undone implements Command {
  readonly bytes = 0;
  constructor(private readonly inner: Command) {}
  get label() {
    return this.inner.label;
  }
  apply(): void {
    this.inner.revert();
  }
  revert(): void {
    this.inner.apply();
  }
}

export class QuickShape {
  /** The picture the stroke is in: a timer or a late event must act on this one, not the tab showing by then. */
  private readonly tab: Tab = tabs.list[tabs.active];
  private points: Pt[];
  private tooLong = false;
  /** Where the pointer was (screen pixels) when it last moved more than `STILL_PX`. */
  private anchor: { x: number; y: number };
  private timer = 0;
  private over = false;
  private shape: Recognized | null = null;
  /** The rough stroke's change, taken back off the layer once the shape replaced it. */
  private strokeCmd: Command | null = null;
  private object: Drawn | null = null;
  private readonly id = newObjectId();
  /** The pointer now, and where it was when the shape appeared, in picture pixels. */
  private at: Pt;
  private grab: Pt;
  private shift: boolean;
  private readonly keys = (e: KeyboardEvent) => {
    if (e.key !== 'Shift' || e.repeat) return;
    this.shift = e.type === 'keydown';
    if (this.shape) this.show();
  };

  constructor(
    private readonly stroke: Stroke,
    private readonly layer: Layer,
    private readonly look: Look,
    start: Pt[],
    e: PointerEvent,
  ) {
    this.points = [...start];
    this.at = this.grab = start[start.length - 1];
    this.anchor = { x: e.clientX, y: e.clientY };
    this.shift = e.shiftKey;
    window.addEventListener('keydown', this.keys);
    window.addEventListener('keyup', this.keys);
  }

  /**
   * The pointer moved to `pts` (picture pixels). True once a shape has taken the stroke's place, when the
   * move resizes it and the caller must not add it to the stroke.
   */
  moved(ev: PointerEvent, pts: Pt[]): boolean {
    this.at = pts[pts.length - 1];
    this.shift = ev.shiftKey;
    if (this.shape) {
      this.show();
      return true;
    }
    if (this.points.length + pts.length > MAX_POINTS) this.tooLong = true;
    else this.points.push(...pts);
    // Moving on starts the wait again; a tremor of a pixel or two doesn't.
    if (Math.hypot(ev.clientX - this.anchor.x, ev.clientY - this.anchor.y) > STILL_PX) {
      this.anchor = { x: ev.clientX, y: ev.clientY };
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.hold(), HOLD_MS);
    }
    return false;
  }

  /** The pointer has stayed still: turn the stroke into a shape if it is clearly one. */
  private hold(): void {
    this.timer = 0;
    // A real mouse sends nothing while still, so this runs on its own clock, and the tab may have changed since.
    if (this.over || this.shape || this.tooLong || tabs.list[tabs.active] !== this.tab || !this.tab.doc.layers.includes(this.layer)) return;
    const found = recognize(this.points, { min: Math.max(4, MIN_SCREEN / this.tab.viewport.zoom) });
    if (!found) return;
    // The rough stroke comes off the layer: its change is finished so undo can put it back, then taken off.
    this.strokeCmd = this.stroke.finish();
    this.strokeCmd?.revert();
    app.liveStroke = null;
    this.shape = found;
    this.grab = this.at;
    this.show();
  }

  /** The shape as the pointer has moved it since it appeared. */
  private show(): void {
    const s = this.shape!;
    const dx = this.at.x - this.grab.x;
    const dy = this.at.y - this.grab.y;
    if (s.kind === 'line' || s.kind === 'arrow') {
      const end = { x: s.b.x + dx, y: s.b.y + dy };
      this.object = this.lineObject(s.a, this.shift ? snapAngle(s.a, end) : end, s.kind === 'arrow');
    } else {
      // The pointer moving away from the middle makes the shape bigger on that side; Shift keeps it square.
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      let hw = Math.max(0.5, s.w / 2 + Math.abs(this.at.x - cx) - Math.abs(this.grab.x - cx));
      let hh = Math.max(0.5, s.h / 2 + Math.abs(this.at.y - cy) - Math.abs(this.grab.y - cy));
      if (this.shift) hw = hh = Math.max(hw, hh);
      const x = Math.round(cx - hw);
      const y = Math.round(cy - hh);
      this.object = this.shapeObject(s.kind, { x, y, w: Math.round(cx + hw) - x, h: Math.round(cy + hh) - y });
    }
    app.draft = this.object;
    changed();
  }

  private shapeObject(kind: 'rectangle' | 'ellipse', b: { x: number; y: number; w: number; h: number }): ShapeObject {
    const { color, width, opacity } = this.look;
    return {
      id: this.id,
      type: 'shape',
      kind,
      ...b,
      angle: 0,
      stroke: color,
      width,
      // Hollow, as the Shapes tool's fill starts: the stored fill's colour with no opacity.
      fill: withAlpha(app.fillColor, 0),
      dash: 'solid',
      opacity,
      radius: settingsOf('rectangle').radius as number,
      sides: settingsOf('polygon').sides as number,
      points: settingsOf('star').points as number,
    };
  }

  private lineObject(a: Pt, b: Pt, arrow: boolean): LineObject {
    const { color, width, opacity } = this.look;
    // The head is the one the Arrow tool draws, unless it is set to have none.
    const head = settingsOf('arrow').end as Head;
    return {
      id: this.id,
      type: 'line',
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      bend: 0,
      color,
      width,
      dash: 'solid',
      opacity,
      start: 'none',
      end: arrow ? (head === 'none' ? 'filled' : head) : 'none',
    };
  }

  /**
   * The button went up. True when a shape had replaced the stroke, and it is now in the picture (the
   * caller has nothing left to do); false when the stroke is to be finished as usual.
   */
  finish(): boolean {
    this.over = true;
    clearTimeout(this.timer);
    window.removeEventListener('keydown', this.keys);
    window.removeEventListener('keyup', this.keys);
    const object = this.object;
    if (!this.shape || !object) return false;
    app.draft = null;
    this.tab.lastPoint = null;
    if (tabs.list[tabs.active] !== this.tab) {
      // Another picture came to the front mid-drag: this one keeps its stroke as drawn.
      if (this.strokeCmd) {
        this.strokeCmd.apply();
        this.tab.history.record(this.strokeCmd);
      }
      return true;
    }
    const label = `Clean up ${nameOf(object)}`;
    // The shape goes on the layer the stroke was painted on.
    const step = addObjectsStep([object], label, this.layer);
    if (!step) {
      // That layer was locked or hidden meanwhile: it keeps the stroke as drawn.
      if (this.strokeCmd) {
        this.strokeCmd.apply();
        app.history.record(this.strokeCmd);
      }
      changed();
      return true;
    }
    // The rough stroke is a step of its own (the one an ordinary stroke makes, joined to a whiteboard's growth),
    // and the clean-up takes its pixels off and puts the shape on, so undoing the clean-up gives the stroke back.
    if (this.strokeCmd) app.history.record(this.strokeCmd);
    app.history.record(this.strokeCmd ? new CompositeCommand(label, [new Undone(this.strokeCmd), step.cmd]) : step.cmd);
    pickObjects(step.layer, [object.id]);
    changed();
    return true;
  }
}
