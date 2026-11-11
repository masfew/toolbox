/**
 * The mouse speed slider (the Rust side is `src-tauri/src/mouse.rs`): slows the mouse down while
 * Left Ctrl is held, never past the user's own speed. The setting is in steps of Windows' own pointer speed, counted from
 * the user's own speed; 0 is normal and never touches the Windows setting. It can also be switched off
 * (the button in the tool rail), which keeps the value but makes Left Ctrl do nothing.
 */
import * as platform from '../platform';
import { effectiveOffset, loadMouseOn, mouseActive } from './mouseState';
import { loadPref, savePref } from './prefs';
import { changed } from './store';

export const MOUSE_MIN = -6;
export const MOUSE_MAX = 0;

/** How far the pointer moves for each mouse movement at each Windows speed (1 to 20), with "Enhance pointer precision" off. */
const MULTIPLIER = [0, 1 / 32, 1 / 16, 1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5];

const clampOffset = (n: number) => Math.min(MOUSE_MAX, Math.max(MOUSE_MIN, Math.round(n) || 0));

export const mouse = {
  offset: clampOffset(loadPref('mouseSpeed', 0)),
  /** Whether the speed applies at all. Off keeps `offset`. */
  on: loadMouseOn(),
  /** The user's own Windows pointer speed; null until known, and in the browser build. */
  base: null as number | null,
};

/** The mouse speed with Left Ctrl held as a percentage of the user's own, for an offset. */
export function mousePercent(offset = mouse.offset): number {
  const base = mouse.base ?? 10;
  const speed = Math.min(20, Math.max(1, base + offset));
  return Math.round((100 * MULTIPLIER[speed]) / MULTIPLIER[base]);
}

/** Tells the app the speed to use: while switched off it gets normal (0), so it never changes Windows' setting. */
async function send(): Promise<void> {
  try {
    const info = await platform.mouseSpeedSet(effectiveOffset(mouse.on, mouse.offset));
    if (info && info.base !== mouse.base) {
      mouse.base = info.base;
      changed();
    }
  } catch (e) {
    console.warn('Mouse speed failed', e);
  }
}

let held = false;
const setHeld = (on: boolean) => {
  if (on === held) return;
  held = on;
  platform.mouseCtrl(on);
};

/** Switching off (or going to normal) with Left Ctrl held ends the hold. */
function endHoldIfInactive(): void {
  if (!mouseActive(mouse.on, mouse.offset)) setHeld(false);
}

/** Switches the speed on or off, keeping the slider's value. */
export function setMouseOn(on: boolean): void {
  if (on === mouse.on) return;
  mouse.on = on;
  savePref('mouseSpeedOn', on, 0);
  endHoldIfInactive();
  changed();
  void send();
}

/** Clicking the button: switches it on or off. At normal there's nothing to switch, so this does nothing and returns false. */
export function toggleMouseSpeed(): boolean {
  if (mouse.offset === 0) return false;
  setMouseOn(!mouse.on);
  return true;
}

/** Picking a speed switches the speed on, if it was off; going back to normal leaves it as it was. */
export function setMouseSpeed(offset: number): void {
  const next = clampOffset(offset);
  if (next !== 0 && !mouse.on) setMouseOn(true);
  if (next === mouse.offset) return;
  mouse.offset = next;
  savePref('mouseSpeed', next, 0);
  endHoldIfInactive();
  changed();
  void send();
}

/**
 * Holding Left Ctrl brings in the slider's speed, the only way it applies, and only while it's on.
 * Key repeats count, so a window that takes focus with Ctrl already down picks it up. Rust ends the
 * hold itself when Left Ctrl comes up or Sketch loses focus, so a missed key-up can't keep it.
 */
function watchCtrl(): void {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'ControlLeft' && mouseActive(mouse.on, mouse.offset)) setHeld(true);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'ControlLeft') setHeld(false);
  });
  window.addEventListener('blur', () => setHeld(false));
}

/** At start: hands the saved setting to the app, and follows changes made in Sketch's other windows. */
export function startMouseSpeed(): void {
  void send();
  watchCtrl();
  window.addEventListener('storage', (e) => {
    if (e.key !== 'sketch.mouseSpeed' && e.key !== 'sketch.mouseSpeedOn') return;
    mouse.offset = clampOffset(loadPref('mouseSpeed', 0));
    mouse.on = loadMouseOn();
    endHoldIfInactive();
    changed();
  });
}
