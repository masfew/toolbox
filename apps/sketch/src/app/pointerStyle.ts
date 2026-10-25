/**
 * The pointer over the picture (F17): what can be picked, how a saved choice is read, and the small
 * cursor pictures for the dot and the crosshair. Nothing here touches the page, so it can be tested alone.
 */

export type PointerShape = 'arrow' | 'dot' | 'cross' | 'circle';

export const POINTER_SHAPES: { value: PointerShape; label: string }[] = [
  { value: 'arrow', label: 'Normal arrow' },
  { value: 'dot', label: 'Small dot' },
  { value: 'cross', label: 'Thin crosshair' },
  { value: 'circle', label: 'Brush size circle' },
];

/** The dot's width and the crosshair's length, in pixels. */
export const DOT_SIZE = { min: 2, max: 32, default: 6 };
export const CROSS_SIZE = { min: 7, max: 65, default: 15 };

export interface PointerPrefs {
  shape: PointerShape;
  /** Whether the eraser has a pointer of its own. */
  eraserOwn: boolean;
  eraserShape: PointerShape;
  dotSize: number;
  crossSize: number;
  /** `'auto'` is light with a dark edge, which shows on any picture; otherwise a `#rrggbb` colour. */
  color: string;
}

/** Windows' normal arrow, the same as before this setting existed. */
export const DEFAULT_POINTER: PointerPrefs = {
  shape: 'arrow',
  eraserOwn: false,
  eraserShape: 'circle',
  dotSize: DOT_SIZE.default,
  crossSize: CROSS_SIZE.default,
  color: 'auto',
};

const shapeOr = (v: unknown, fallback: PointerShape): PointerShape => (POINTER_SHAPES.some((s) => s.value === v) ? (v as PointerShape) : fallback);
const sizeOr = (v: unknown, r: { min: number; max: number; default: number }): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, Math.round(v))) : r.default;

/**
 * Reads a saved pointer setting. Anything missing or wrong falls back to the default, so an install
 * from before this setting existed (nothing saved) keeps Windows' arrow, and so does a damaged value.
 */
export function sanitizePointer(raw: unknown): PointerPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    shape: shapeOr(r.shape, DEFAULT_POINTER.shape),
    eraserOwn: r.eraserOwn === true,
    eraserShape: shapeOr(r.eraserShape, DEFAULT_POINTER.eraserShape),
    dotSize: sizeOr(r.dotSize, DOT_SIZE),
    crossSize: sizeOr(r.crossSize, CROSS_SIZE),
    color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color.toLowerCase() : 'auto',
  };
}

/** The tools that show the chosen pointer over the picture. Select, Crop, pan and the colour picker keep their own. */
export const POINTER_TOOLS: ReadonlySet<string> = new Set([
  'pencil',
  'brush',
  'eraser',
  'fill',
  'rectangle',
  'ellipse',
  'polygon',
  'star',
  'arrow',
  'line',
  'text',
  'highlight',
  'blur',
  'pixelate',
  'marker',
  'callout',
  'spotlight',
]);

/** The tools whose size the circle can show. The others get a dot where a circle was picked. */
export const CIRCLE_TOOLS: ReadonlySet<string> = new Set(['pencil', 'brush', 'eraser']);

/** The shape a tool shows: the eraser's own when it has one. */
export function shapeFor(p: PointerPrefs, toolId: string): PointerShape {
  if (!POINTER_TOOLS.has(toolId)) return 'arrow';
  return toolId === 'eraser' && p.eraserOwn ? p.eraserShape : p.shape;
}

/** What a shape is drawn as for a tool: the circle becomes a dot for tools with no brush size. */
export function drawnShape(shape: PointerShape, toolId: string): PointerShape {
  return shape === 'circle' && !CIRCLE_TOOLS.has(toolId) ? 'dot' : shape;
}

const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

/** The pointer's colour and the edge round it, which is dark for a light colour and light for a dark one. */
export function pointerColors(color: string): { fill: string; edge: string } {
  if (color === 'auto') return { fill: '#ffffff', edge: '#000000' };
  return { fill: color, edge: luminance(color) > 0.5 ? '#000000' : '#ffffff' };
}

export interface PointerImage {
  svg: string;
  w: number;
  h: number;
  /** The pixel that is the pointer's position. */
  hot: number;
}

/** The dot (a filled circle) or the crosshair (two one-pixel lines) with an edge, centred in a small picture. */
export function pointerImage(kind: 'dot' | 'cross', size: number, color: string): PointerImage {
  const { fill, edge } = pointerColors(color);
  if (kind === 'dot') {
    const d = Math.max(DOT_SIZE.min, Math.round(size));
    const w = d + 4;
    const c = w / 2;
    return {
      w,
      h: w,
      hot: Math.floor(c),
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 ${w} ${w}"><circle cx="${c}" cy="${c}" r="${d / 2 + 1}" fill="${edge}" fill-opacity="0.85"/><circle cx="${c}" cy="${c}" r="${d / 2}" fill="${fill}"/></svg>`,
    };
  }
  // An odd length puts the lines on the middle pixel.
  const len = Math.max(CROSS_SIZE.min, Math.round(size)) | 1;
  const w = len + 4;
  const m = (w - 1) / 2;
  const line = (x: number, y: number, lw: number, lh: number, f: string, o = 1) =>
    `<rect x="${x}" y="${y}" width="${lw}" height="${lh}" fill="${f}" fill-opacity="${o}" shape-rendering="crispEdges"/>`;
  return {
    w,
    h: w,
    hot: m,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 ${w} ${w}">` +
      line(1, m - 1, w - 2, 3, edge, 0.85) +
      line(m - 1, 1, 3, w - 2, edge, 0.85) +
      line(2, m, len, 1, fill) +
      line(m, 2, 1, len, fill) +
      `</svg>`,
  };
}

/** The picture as a data address, for an image tag. */
export const imageUrl = (img: PointerImage): string => `data:image/svg+xml,${encodeURIComponent(img.svg)}`;

/** A CSS `cursor` value for the dot or the crosshair. The browser draws it itself, so it moves with the system pointer and never lags. */
export function pointerCursor(kind: 'dot' | 'cross', size: number, color: string): string {
  const img = pointerImage(kind, size, color);
  return `url("${imageUrl(img)}") ${img.hot} ${img.hot}, ${kind === 'cross' ? 'crosshair' : 'default'}`;
}

/** The circle's width on screen for a brush of `size` pixels at `zoom`; small ones stay big enough to see. */
export const MIN_RING = 6;
export const ringWidth = (size: number, zoom: number): number => Math.max(MIN_RING, size * zoom);
