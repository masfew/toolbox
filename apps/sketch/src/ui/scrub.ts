/**
 * The maths of a drag label (a number you change by dragging its name left or right). No page code,
 * so Vitest can load it. One value step is `PX_PER_STEP` pixels of pointer movement, ten times as many
 * steps with Shift. The leftover part of a step is kept, so a slow drag still moves; each movement is applied
 * at the speed of the moment, so pressing or letting go of Shift mid-drag never makes the value jump.
 */

/** Pointer pixels per whole step of the value. */
export const PX_PER_STEP = 2;
/** Shift moves this many times as fast. */
export const SHIFT_SPEED = 10;
/** The pointer has to move this far before a press counts as a drag rather than a click. */
export const DRAG_START_PX = 3;

export interface Scrub {
  /** The whole value. */
  value: number;
  /** The part of a step not yet applied, between -1 and 1 (exclusive). */
  rest: number;
}

export function scrubStart(value: number): Scrub {
  return { value, rest: 0 };
}

/** The state after the pointer moves `dx` pixels (right is positive), clamped to min..max. */
export function scrubMove(s: Scrub, dx: number, shift: boolean, min: number, max: number): Scrub {
  const total = s.rest + (dx / PX_PER_STEP) * (shift ? SHIFT_SPEED : 1);
  const whole = Math.trunc(total);
  const value = Math.min(max, Math.max(min, s.value + whole));
  // At an end the leftover is dropped, so coming back from past the end starts at once.
  return { value, rest: value === s.value + whole ? total - whole : 0 };
}
