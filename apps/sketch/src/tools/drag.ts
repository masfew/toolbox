import type { ObjectLayer } from '../engine/document';
import type { Point } from './box';

export type ToDoc = (e: { clientX: number; clientY: number }) => Point;

/** What a tool does while the pointer is held down after pressing on the picture. */
export interface ToolDrag {
  move(p: Point, e: PointerEvent, toDoc: ToDoc): void;
  up(p: Point, e: PointerEvent): void;
  /** The cursor while dragging. */
  cursor?: string;
  /**
   * Set while moving a selection or picked shapes, which can be carried onto another tab (F14.3):
   * the selection, or the shapes' layer and ids.
   */
  carry?: { kind: 'selection' } | { kind: 'objects'; layer: ObjectLayer; ids: number[] };
  /** Puts back what the drag has moved so far, as if it never started. */
  cancel?(): void;
}

/** Pen pressure from 0 to 1; a mouse or touch always gives 1. */
export function pressureOf(e: PointerEvent): number {
  if (e.pointerType !== 'pen') return 1;
  return e.pressure > 0 ? e.pressure : 0.5;
}
