/**
 * Clean up rough shapes (F18): drawing with the brush or pencil and holding still at the end of the stroke
 * turns a rough line, arrow, box or circle into a clean shape (`tools/paint.ts`). This is the setting that
 * turns it on and off. Saved as `cleanUp` and shared by every window.
 */
import { CLEAN_UP_PREF, loadCleanUp, sanitizeCleanUp } from './cleanUpPref';
import { onPrefChanged, savePref } from './prefs';
import { changed } from './store';

export const cleanUp = { on: loadCleanUp() };

export function setCleanUp(on: boolean): void {
  cleanUp.on = on;
  savePref(CLEAN_UP_PREF, on, 0);
  changed();
}

export const toggleCleanUp = () => setCleanUp(!cleanUp.on);

/** Called once at start: another window changing the setting reaches this one. */
export function startCleanUp(): void {
  onPrefChanged<unknown>(CLEAN_UP_PREF, true, (value) => {
    cleanUp.on = sanitizeCleanUp(value);
    changed();
  });
}
