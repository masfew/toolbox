import { setColor, setShapeColor } from './actions';
import { app, type ColorTargetId } from './store';

/**
 * A colour the colour popover (and its picker button) edits: how to read it, how to set it, and what the
 * popover calls itself. Setting one does everything a change of it should (picked shapes follow the fill
 * and outline, text being typed follows colours 1 and 2).
 */
export interface ColorTarget {
  id: ColorTargetId;
  label: string;
  read: () => string;
  write: (color: string) => void;
}

export const COLOR_TARGETS: Record<ColorTargetId, ColorTarget> = {
  primary: { id: 'primary', label: 'Colour 1', read: () => app.primary, write: (c) => setColor('primary', c) },
  secondary: { id: 'secondary', label: 'Colour 2', read: () => app.secondary, write: (c) => setColor('secondary', c) },
  fill: { id: 'fill', label: 'Fill colour', read: () => app.fillColor, write: (c) => setShapeColor('fill', c) },
  outline: { id: 'outline', label: 'Outline colour', read: () => app.outlineColor, write: (c) => setShapeColor('outline', c) },
};

/** A line's one colour button is the same stored outline colour, under its own name. */
export const LINE_TARGET: ColorTarget = { ...COLOR_TARGETS.outline, label: 'Line colour' };
