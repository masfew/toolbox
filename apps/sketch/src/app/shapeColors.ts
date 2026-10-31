/**
 * The fill and outline colours the shape and line tools keep of their own, apart from colours 1 and 2.
 * Saved between sessions. No page code, so Vitest can load it.
 */

import { parseHex } from './color';
import { loadPref, savePref } from './prefs';

export const SHAPE_COLORS_PREF = 'shapeColors';

/** White, so raising the opacity gives a white fill; fully see-through, so shapes start hollow. */
export const DEFAULT_FILL = '#ffffff00';
export const DEFAULT_OUTLINE = '#000000';

export interface ShapeColors {
  fill: string;
  outline: string;
}

/** Saved colours where they are readable hex, the defaults for the rest. */
export function sanitizeShapeColors(raw: unknown): ShapeColors {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const ok = (v: unknown, d: string) => (typeof v === 'string' && parseHex(v) ? v.toLowerCase() : d);
  return { fill: ok(r.fill, DEFAULT_FILL), outline: ok(r.outline, DEFAULT_OUTLINE) };
}

export const loadShapeColors = (): ShapeColors => sanitizeShapeColors(loadPref<unknown>(SHAPE_COLORS_PREF, null));

/** Saves both colours. Bursts (dragging in the colour picker) are written once, a moment later. */
export function saveShapeColors(c: ShapeColors): void {
  savePref(SHAPE_COLORS_PREF, { fill: c.fill, outline: c.outline });
}
