import type { JSX } from 'preact';
import { TINTS } from '../tools/registry';

/**
 * The small drawings that stand for a choice on a preview square and in its menu, one spec for each choice option's key.
 * They live here so the tool list stays free of page code.
 */
export interface PreviewSpec {
  /** What the square is called (tooltip and screen reader). */
  name: string;
  /** Whether the option's icon and name show beside the square (not for a drawing that says what it is). */
  label: boolean;
  draw: (value: string, size: number) => JSX.Element;
  /** The square is wide and shows the font's name, and the menu shows each name in its own font. */
  font?: boolean;
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

function brushType(value: string, size: number) {
  if (value === 'marker') return svg(size, <path d="M3.5 12.5 12.5 3.5" stroke-width="4" />);
  if (value === 'highlighter') return svg(size, <path d="M2 8h12" stroke-width="7" opacity="0.45" />);
  return svg(size, <path d="M3.5 12.5 12.5 3.5" stroke-width="3" stroke-linecap="round" />);
}

/** A stroke that widens, gets stronger, or stays the same as the pen presses harder. */
function pressure(value: string, size: number) {
  if (value === 'size') return svg(size, <path d="M2 8 14 5v6z" fill="currentColor" stroke="none" />);
  if (value === 'opacity') {
    return svg(
      size,
      <>
        <path d="M2 8h4" opacity="0.25" />
        <path d="M6 8h4" opacity="0.55" />
        <path d="M10 8h4" />
      </>,
    );
  }
  return svg(size, <path d="M2 8h12" />);
}

function eraseTo(value: string, size: number) {
  if (value === 'secondary') return svg(size, <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />);
  return svg(
    size,
    <>
      <rect x="3" y="3" width="10" height="10" rx="1.5" stroke-width="1.2" />
      <path d="M3.5 3.5H8V8H3.5zM8 8h4.5v4.5H8z" fill="currentColor" stroke="none" />
    </>,
  );
}

/** One sheet for the current layer, a stack of them for the whole picture. */
function sample(value: string, size: number) {
  const sheet = <path d="M8 2.5 14 6 8 9.5 2 6z" stroke-width="1.4" stroke-linejoin="round" />;
  if (value === 'picture') {
    return svg(
      size,
      <>
        {sheet}
        <path d="m2 9 6 3.5L14 9M2 11.5 8 15l6-3.5" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </>,
    );
  }
  return svg(size, sheet);
}

function ratio(value: string, size: number) {
  const box = (x: number, y: number, w: number, h: number, dash?: string) => <rect x={x} y={y} width={w} height={h} rx="1" stroke-width="1.4" stroke-dasharray={dash} />;
  if (value === 'free') return svg(size, box(2.5, 4, 11, 8, '2 1.7'));
  if (value === 'original') {
    return svg(
      size,
      <>
        {box(2.5, 3.5, 11, 9)}
        <path d="m4.5 11 2.75-3 2 2 1.25-1.25L12 10.5" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
      </>,
    );
  }
  if (value === '1:1') return svg(size, box(3, 3, 10, 10));
  if (value === '4:3') return svg(size, box(2, 3.5, 12, 9));
  return svg(size, box(1.5, 4.25, 13, 7.5));
}

function align(value: string, size: number) {
  const lines = value === 'center' ? 'M2 4h12M4 8h8M3 12h10' : value === 'right' ? 'M2 4h12M6 8h8M4 12h10' : 'M2 4h12M2 8h8M2 12h10';
  return svg(size, <path d={lines} stroke-width="1.6" stroke-linecap="round" />);
}

function tint(value: string, size: number) {
  return svg(size, <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill={TINTS[value] ?? TINTS.yellow} stroke="none" />);
}

function spotlightShape(value: string, size: number) {
  if (value === 'ellipse') return svg(size, <ellipse cx="8" cy="8" rx="6" ry="4.75" stroke-width="1.6" />);
  return svg(size, <rect x="2" y="3.25" width="12" height="9.5" rx="1" stroke-width="1.6" />);
}

function font(value: string, size: number) {
  return <span style={{ fontFamily: value, fontSize: `${size * 0.8}px`, lineHeight: 1 }}>Aa</span>;
}

export const PREVIEWS: Record<string, PreviewSpec> = {
  dash: { name: 'Line style', label: false, draw: lineStyle },
  start: { name: 'Start arrowhead', label: true, draw: (v, s) => head(v, s, true) },
  end: { name: 'End arrowhead', label: true, draw: (v, s) => head(v, s, false) },
  type: { name: 'Brush type', label: true, draw: brushType },
  pressure: { name: 'Pen pressure', label: true, draw: pressure },
  mode: { name: 'What the eraser leaves', label: true, draw: eraseTo },
  sample: { name: 'What it reads from', label: true, draw: sample },
  ratio: { name: 'Crop ratio', label: true, draw: ratio },
  align: { name: 'Align', label: false, draw: align },
  tint: { name: 'Highlighter colour', label: true, draw: tint },
  shape: { name: 'Spotlight shape', label: true, draw: spotlightShape },
  font: { name: 'Font', label: true, draw: font, font: true },
};
