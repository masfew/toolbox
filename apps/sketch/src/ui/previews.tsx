import type { JSX } from 'preact';

/**
 * The small drawings that stand for a choice (line style, arrowheads) on a preview square and in its menu.
 * They live here, keyed by the option's key, so the tool list stays free of page code.
 */
export interface PreviewSpec {
  /** What the square is called (tooltip and screen reader). */
  name: string;
  /** Whether the option's own label shows beside the square (Start, End; not the line style). */
  label: boolean;
  draw: (value: string, size: number) => JSX.Element;
}

function svg(size: number, children: JSX.Element) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">
      {children}
    </svg>
  );
}

function lineStyle(value: string, size: number) {
  if (value === 'dashed') return svg(size, <path d="M2 8h12" stroke-dasharray="3.5 2.2" />);
  if (value === 'dotted') return svg(size, <path d="M2.5 8h11.5" stroke-dasharray="0.01 3.6" stroke-linecap="round" />);
  return svg(size, <path d="M2 8h12" />);
}

/** A line with a head at one end; the start heads are the end heads turned round. */
function head(value: string, size: number, start: boolean) {
  const shape =
    value === 'open' ? (
      <>
        <path d="M2 8h11" stroke-width="2" />
        <path d="M8.5 3.5 13.5 8l-5 4.5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </>
    ) : value === 'filled' ? (
      <>
        <path d="M2 8h7" stroke-width="2" />
        <path d="M8 3.5 14.5 8 8 12.5z" fill="currentColor" stroke-width="1" stroke-linejoin="round" />
      </>
    ) : value === 'dot' ? (
      <>
        <path d="M2 8h9" stroke-width="2" />
        <circle cx="12.5" cy="8" r="2.6" fill="currentColor" stroke="none" />
      </>
    ) : (
      <path d="M2 8h12" stroke-width="2" />
    );
  return svg(size, start ? <g transform="translate(16 0) scale(-1 1)">{shape}</g> : shape);
}

export const PREVIEWS: Record<string, PreviewSpec> = {
  dash: { name: 'Line style', label: false, draw: lineStyle },
  start: { name: 'Start arrowhead', label: true, draw: (v, s) => head(v, s, true) },
  end: { name: 'End arrowhead', label: true, draw: (v, s) => head(v, s, false) },
};
