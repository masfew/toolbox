/**
 * The parts of the mouse speed setting that need no page code, so Vitest can load them (`mouse.ts`
 * holds the rest). The slider's value and whether it's switched on are two separate settings:
 * switching it off keeps the value.
 */
import { loadPref } from './prefs';

/** Whether the saved setting is switched on. On unless saved as off, so earlier installs keep working as before. */
export function loadMouseOn(): boolean {
  return loadPref<unknown>('mouseSpeedOn', true) !== false;
}

/** Whether Left Ctrl brings in a different speed: it's on and the slider isn't at normal. */
export function mouseActive(on: boolean, offset: number): boolean {
  return on && offset !== 0;
}

/** What the app (Rust) is told. Off counts as normal, which never touches Windows' setting and puts the user's own speed back at once. */
export function effectiveOffset(on: boolean, offset: number): number {
  return on ? offset : 0;
}
