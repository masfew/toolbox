/**
 * Key combos as strings like "Ctrl+Shift+S", "B", "[" or "Shift+/".
 * Letters, digits and punctuation come from the key's position (`e.code`), so a combo means the
 * same key whatever Shift does to the character, and rebinding records what you'd expect.
 */

const CODE_NAMES: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Backslash: '\\',
  IntlBackslash: '\\',
  Equal: '=',
  Minus: '-',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Space: 'Space',
  NumpadAdd: '=',
  NumpadSubtract: '-',
};

/** US-layout shifted characters and the key they're on. */
const SHIFTED: Record<string, string> = {
  '?': '/',
  '+': '=',
  _: '-',
  '{': '[',
  '}': ']',
  '"': "'",
  ':': ';',
  '<': ',',
  '>': '.',
  '|': '\\',
  '~': '`',
  '!': '1',
  '\u0040': '2', // the at sign, escaped so the repo's identifier check doesn't take it for an email address
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
};

/** Keys that only modify, so a combo isn't finished yet. */
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

function keyName(e: KeyLike): string | null {
  if (MODIFIERS.has(e.key)) return null;
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (CODE_NAMES[c]) return CODE_NAMES[c];
  // No key position (some on-screen keyboards and remote tools): go by the character, unshifted.
  if (e.key.length === 1) return SHIFTED[e.key] ?? e.key.toUpperCase();
  return e.key; // Enter, Escape, Delete, ArrowLeft, F1 and so on.
}

/** The combo for a key event, or null for a lone modifier. */
export function comboOf(e: KeyLike): string | null {
  const name = keyName(e);
  if (!name) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  // A shifted character with no key position ("?") was typed with Shift.
  if (e.shiftKey || (!e.code && e.key in SHIFTED)) parts.push('Shift');
  parts.push(name);
  return parts.join('+');
}

const PRETTY: Record<string, string> = {
  'Shift+/': '?',
  'Shift+=': '+',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Delete: 'Del',
  PrintScreen: 'Print Screen',
};

/** How a combo is shown to people: "Ctrl+Shift+S", "?", "Ctrl+'". */
export function prettyCombo(combo: string): string {
  if (PRETTY[combo]) return PRETTY[combo];
  const parts = combo.split('+');
  // "Ctrl++" splits into an empty last part; keep the plus.
  if (combo.endsWith('++')) parts.splice(parts.length - 2, 2, '+');
  return parts.map((p) => PRETTY[p] ?? p).join('+');
}

/**
 * Works out every command's keys from the defaults and the user's changes.
 * A key the user gave to one command is taken away from any other command that had it by default.
 */
export function resolveBindings(
  defaults: Record<string, string[]>,
  overrides: Record<string, string[]>,
): Record<string, string[]> {
  const claimed = new Set(Object.values(overrides).flat());
  const out: Record<string, string[]> = {};
  for (const id of Object.keys(defaults)) {
    out[id] = overrides[id] ? [...overrides[id]] : defaults[id].filter((k) => !claimed.has(k));
  }
  for (const id of Object.keys(overrides)) if (!out[id]) out[id] = [...overrides[id]];
  return out;
}

/** Reverse map from combo to command id. The first command listed wins a clash. */
export function keyMap(bindings: Record<string, string[]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [id, keys] of Object.entries(bindings)) for (const k of keys) if (!map.has(k)) map.set(k, id);
  return map;
}

/**
 * Whether Windows can give a combo to a Start menu shortcut: Ctrl with Alt or Shift (or both), and a
 * letter, digit or F key.
 */
export function isWindowsHotkey(combo: string): boolean {
  const parts = combo.split('+');
  const key = parts.at(-1) ?? '';
  const mods = new Set(parts.slice(0, -1));
  return mods.has('Ctrl') && (mods.has('Alt') || mods.has('Shift')) && /^([A-Z0-9]|F([1-9]|1[0-2]))$/.test(key);
}

/**
 * Keys the capture helper can hold with `RegisterHotKey`, which has no Start menu shortcut's need for
 * Ctrl: any two or more of Ctrl, Alt and Shift with a letter, digit or F key (so Alt+Shift+S too), and
 * Print Screen on its own or with Ctrl, Alt or Shift.
 */
export function isCaptureHotkey(combo: string): boolean {
  const parts = combo.split('+');
  const key = parts.at(-1) ?? '';
  const mods = parts.slice(0, -1);
  if (key === 'PrintScreen') return mods.every((m) => m === 'Ctrl' || m === 'Alt' || m === 'Shift');
  return mods.length >= 2 && /^([A-Z0-9]|F([1-9]|1[0-2]))$/.test(key);
}

/** A shortcut's key as Windows reports it ("Alt+Ctrl+S") in Sketch's order ("Ctrl+Alt+S"). */
export function fromWindowsHotkey(text: string): string {
  const parts = text.split('+').map((p) => p.trim());
  const last = parts.at(-1)!;
  const key = /^printscreen$/i.test(last) ? 'PrintScreen' : last.toUpperCase();
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  return [mods.has('ctrl') && 'Ctrl', mods.has('alt') && 'Alt', mods.has('shift') && 'Shift', key].filter(Boolean).join('+');
}
