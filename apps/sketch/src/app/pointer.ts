/**
 * The pointer over the picture (F17): Windows' normal arrow unless someone picks a dot, a crosshair or
 * the brush-size circle in Settings. Saved as the `pointer` setting and shared by every window; an install
 * from before it existed has none saved and keeps the arrow (`sanitizePointer`).
 */
import { loadPref, onPrefChanged, savePref } from './prefs';
import { drawnShape, pointerCursor, sanitizePointer, shapeFor, type PointerPrefs, type PointerShape } from './pointerStyle';
import { changed } from './store';

export const pointerPrefs: PointerPrefs = sanitizePointer(loadPref<unknown>('pointer', null));

export function setPointer(change: Partial<PointerPrefs>): void {
  Object.assign(pointerPrefs, sanitizePointer({ ...pointerPrefs, ...change }));
  savePref('pointer', pointerPrefs, 0);
  changed();
}

/** Called once at start: another window changing the setting reaches this one. */
export function startPointer(): void {
  onPrefChanged<unknown>('pointer', null, (value) => {
    Object.assign(pointerPrefs, sanitizePointer(value));
    changed();
  });
}

/** What a tool shows over the picture: `circle` is the size circle, drawn by the page (`input.ts`); the rest are CSS cursors. */
export function pointerShapeOf(toolId: string): PointerShape {
  return drawnShape(shapeFor(pointerPrefs, toolId), toolId);
}

const cache = new Map<string, string>();

/** The CSS cursor for a dot or crosshair in the saved size and colour, built once per setting. */
export function pointerCss(kind: 'dot' | 'cross'): string {
  const size = kind === 'dot' ? pointerPrefs.dotSize : pointerPrefs.crossSize;
  const key = `${kind}/${size}/${pointerPrefs.color}`;
  let css = cache.get(key);
  if (css === undefined) {
    if (cache.size > 40) cache.clear();
    cache.set(key, (css = pointerCursor(kind, size, pointerPrefs.color)));
  }
  return css;
}
