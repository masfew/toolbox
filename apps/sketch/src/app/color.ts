/** Colours are kept as hex strings: "#rrggbb", or "#rrggbbaa" when not fully opaque. */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  /** 0 to 1. */
  a: number;
}

export interface HSV {
  /** 0 to 360. */
  h: number;
  /** 0 to 1. */
  s: number;
  /** 0 to 1. */
  v: number;
}

/** Reads "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa", with or without the "#". Null if it isn't one. */
export function parseHex(text: string): RGBA | null {
  let h = text.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

export function toHex(c: RGBA): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return c.a >= 1 ? base : base + hex2(c.a * 255);
}

/** The same colour at another opacity (0 to 1). A colour that isn't hex becomes black. */
export function withAlpha(text: string, a: number): string {
  const c = parseHex(text) ?? { r: 0, g: 0, b: 0, a: 1 };
  return toHex({ ...c, a });
}

/** True for a colour with no opacity at all ("No Colour"). Hex that can't be read counts as clear too. */
export function isClear(text: string): boolean {
  const c = parseHex(text);
  return !c || c.a <= 0;
}

/** The colour without its opacity, for swatches and CSS gradients. */
export function opaqueHex(text: string): string {
  const c = parseHex(text) ?? { r: 0, g: 0, b: 0, a: 1 };
  return toHex({ ...c, a: 1 });
}

export function rgbToHsv({ r, g, b }: RGBA): HSV {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: HSV, a = 1): RGBA {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return { r: f(5), g: f(3), b: f(1), a };
}

/** Paint's colour row, so the familiar colours are one click away. */
export const SWATCHES = [
  '#000000', '#7f7f7f', '#880015', '#ed1c24', '#ff7f27', '#fff200', '#22b14c', '#00a2e8', '#3f48cc', '#a349a4',
  '#ffffff', '#c3c3c3', '#b97a57', '#ffaec9', '#ffc90e', '#efe4b0', '#b5e61d', '#99d9ea', '#7092be', '#c8bfe7',
];

/** Puts a colour at the front of the recent list, without repeats, keeping at most `max`. */
export function pushRecent(recent: string[], color: string, max = 10): string[] {
  const c = color.toLowerCase();
  return [c, ...recent.filter((r) => r.toLowerCase() !== c)].slice(0, max);
}
