/**
 * The mouse speed slider (the Rust side is `src-tauri/src/mouse.rs`): slows the mouse down while
 * Left Ctrl is held, never past the user's own speed. The setting is in steps of Windows' own pointer speed, counted from
 * the user's own speed; 0 is normal and never touches the Windows setting.
 */
import * as platform from '../platform';
import { loadPref, savePref } from './prefs';
import { changed } from './store';

export const MOUSE_MIN = -6;
export const MOUSE_MAX = 0;

/** How far the pointer moves for each mouse movement at each Windows speed (1 to 20), with "Enhance pointer precision" off. */
const MULTIPLIER = [0, 1 / 32, 1 / 16, 1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5];

const clampOffset = (n: number) => Math.min(MOUSE_MAX, Math.max(MOUSE_MIN, Math.round(n) || 0));

export const mouse = {
  offset: clampOffset(loadPref('mouseSpeed', 0)),
  /** The user's own Windows pointer speed; null until known, and in the browser build. */
  base: null as number | null,
};

/** The mouse speed with Left Ctrl held as a percentage of the user's own, for an offset. */
export function mousePercent(offset = mouse.offset): number {
  const base = mouse.base ?? 10;
  const speed = Math.min(20, Math.max(1, base + offset));
  return Math.round((100 * MULTIPLIER[speed]) / MULTIPLIER[base]);
}

async function send(): Promise<void> {
  try {
    const info = await platform.mouseSpeedSet(mouse.offset);
    if (info && info.base !== mouse.base) {
      mouse.base = info.base;
      changed();
    }
  } catch (e) {
    console.warn('Mouse speed failed', e);
  }
}

export function setMouseSpeed(offset: number): void {
  const next = clampOffset(offset);
  if (next === mouse.offset) return;
  mouse.offset = next;
  savePref('mouseSpeed', next, 0);
  changed();
  void send();
}

/**
 * Holding Left Ctrl brings in the slider's speed, the only way it applies.
 * Key repeats count, so a window that takes focus with Ctrl already down picks it up. Rust ends the
 * hold itself when Left Ctrl comes up or Sketch loses focus, so a missed key-up can't keep it.
 */
function watchCtrl(): void {
  let held = false;
  const set = (on: boolean) => {
    if (on === held) return;
    held = on;
    platform.mouseCtrl(on);
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'ControlLeft' && mouse.offset !== 0) set(true);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'ControlLeft') set(false);
  });
  window.addEventListener('blur', () => set(false));
}

/** At start: hands the saved setting to the app, and follows changes made in Sketch's other windows. */
export function startMouseSpeed(): void {
  void send();
  watchCtrl();
  window.addEventListener('storage', (e) => {
    if (e.key !== 'sketch.mouseSpeed') return;
    mouse.offset = clampOffset(loadPref('mouseSpeed', 0));
    changed();
  });
}
