/**
 * The Clean up rough shapes setting (F18), kept apart from the app's state so a test can load it in plain
 * node. It is on unless someone turned it off: an install from before it existed has nothing saved under
 * `cleanUp`, and a value that isn't `false` (missing, junk, damaged) counts as on.
 */
import { loadPref } from './prefs';

export const CLEAN_UP_PREF = 'cleanUp';

export const sanitizeCleanUp = (value: unknown): boolean => value !== false;

export const loadCleanUp = (): boolean => sanitizeCleanUp(loadPref<unknown>(CLEAN_UP_PREF, true));
