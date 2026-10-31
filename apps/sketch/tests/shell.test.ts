import { describe, expect, it } from 'vitest';
import { hsvToRgb, isClear, parseHex, pushRecent, rgbToHsv, toHex, withAlpha } from '../src/app/color';
import { DEFAULT_FILL, DEFAULT_OUTLINE, sanitizeShapeColors } from '../src/app/shapeColors';
import { comboOf, fromWindowsHotkey, isCaptureHotkey, isWindowsHotkey, keyMap, prettyCombo, resolveBindings, type KeyLike } from '../src/app/keys';
import { matchScore, searchCommands } from '../src/app/search';
import { getTool, mergeSettings, SLOTS, stepSize, TOOLS } from '../src/tools/registry';

const key = (code: string, key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('key combos', () => {
  it('names keys by position, with modifiers in a fixed order', () => {
    expect(comboOf(key('KeyS', 'S', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+S');
    expect(comboOf(key('KeyB', 'b'))).toBe('B');
    expect(comboOf(key('Slash', '?', { shiftKey: true }))).toBe('Shift+/');
    expect(comboOf(key('BracketLeft', '['))).toBe('[');
    expect(comboOf(key('Digit1', '!', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+1');
    expect(comboOf(key('Equal', '+', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+=');
    expect(comboOf(key('F6', 'F6'))).toBe('F6');
    expect(comboOf(key('Comma', ',', { ctrlKey: true }))).toBe('Ctrl+,');
  });

  it('goes by the character when the key position is missing', () => {
    expect(comboOf(key('', '?', { shiftKey: true }))).toBe('Shift+/');
    expect(comboOf(key('', '?'))).toBe('Shift+/');
    expect(comboOf(key('', ']'))).toBe(']');
    expect(comboOf(key('', 'b'))).toBe('B');
  });

  it("lets capture keys be Print Screen, which a Start menu shortcut can't be", () => {
    expect(comboOf(key('PrintScreen', 'PrintScreen'))).toBe('PrintScreen');
    expect(isCaptureHotkey('PrintScreen')).toBe(true);
    expect(isCaptureHotkey('Ctrl+Shift+PrintScreen')).toBe(true);
    expect(isCaptureHotkey('Ctrl+Alt+S')).toBe(true);
    expect(isCaptureHotkey('Alt+Shift+S')).toBe(true);
    expect(isCaptureHotkey('Ctrl+Alt+Shift+F5')).toBe(true);
    expect(isWindowsHotkey('Alt+Shift+S')).toBe(false);
    expect(isCaptureHotkey('Alt+S')).toBe(false);
    expect(isCaptureHotkey('Ctrl+S')).toBe(false);
    expect(isCaptureHotkey('Alt+Shift+[')).toBe(false);
    expect(isCaptureHotkey('S')).toBe(false);
    expect(isWindowsHotkey('PrintScreen')).toBe(false);
    expect(prettyCombo('Ctrl+PrintScreen')).toBe('Ctrl+Print Screen');
    expect(fromWindowsHotkey('PrintScreen')).toBe('PrintScreen');
    expect(fromWindowsHotkey('Alt+Ctrl+S')).toBe('Ctrl+Alt+S');
  });

  it('ignores a modifier pressed on its own', () => {
    expect(comboOf(key('ShiftLeft', 'Shift', { shiftKey: true }))).toBeNull();
    expect(comboOf(key('ControlLeft', 'Control', { ctrlKey: true }))).toBeNull();
  });

  it('shows combos the way people expect', () => {
    expect(prettyCombo('Shift+/')).toBe('?');
    expect(prettyCombo('Ctrl+Shift+S')).toBe('Ctrl+Shift+S');
    expect(prettyCombo('Escape')).toBe('Esc');
  });

  it('takes a key the user moved away from the command that had it by default', () => {
    const defaults = { a: ['B'], b: ['P'], c: ['Ctrl+Z'] };
    const b = resolveBindings(defaults, { b: ['B'] });
    expect(b).toEqual({ a: [], b: ['B'], c: ['Ctrl+Z'] });
    expect(keyMap(b).get('B')).toBe('b');
    expect(keyMap(b).get('P')).toBeUndefined();
  });

  it('keeps a cleared shortcut cleared', () => {
    expect(resolveBindings({ a: ['B'] }, { a: [] })).toEqual({ a: [] });
  });
});

describe('command search', () => {
  it('ranks the start of a name above a match inside it', () => {
    expect(matchScore('sav', 'Save As…')!).toBeGreaterThan(matchScore('sav', 'Autosave')!);
  });

  it('finds commands from scattered letters', () => {
    expect(matchScore('svas', 'Save As…')).not.toBeNull();
    expect(matchScore('xyz', 'Save As…')).toBeNull();
  });

  it('matches extra words and keeps list order for ties', () => {
    const list = [
      { label: 'Open…', group: 'File' },
      { label: 'Save As…', group: 'File', keywords: 'export png' },
      { label: 'Save', group: 'File' },
    ];
    expect(searchCommands('export', list).map((c) => c.label)).toEqual(['Save As…']);
    expect(searchCommands('save', list).map((c) => c.label)).toEqual(['Save', 'Save As…']);
    expect(searchCommands('', list).map((c) => c.label)).toEqual(['Open…', 'Save As…', 'Save']);
  });
});

describe('colours', () => {
  it('reads and writes hex colours, with opacity only when needed', () => {
    expect(parseHex('#ff8800')).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseHex('f80')).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseHex('#ff880080')!.a).toBeCloseTo(128 / 255);
    expect(parseHex('#zz0000')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(toHex({ r: 255, g: 136, b: 0, a: 1 })).toBe('#ff8800');
    expect(toHex({ r: 255, g: 136, b: 0, a: 0.5 })).toBe('#ff880080');
  });

  it('round-trips through hue, saturation and value', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ff8800', '#7f7f7f', '#3f48cc', '#000000', '#ffffff']) {
      expect(toHex(hsvToRgb(rgbToHsv(parseHex(hex)!)))).toBe(hex);
    }
  });

  it('tells a see-through colour from one that shows, and changes a colour’s opacity', () => {
    expect(isClear('#ffffff00')).toBe(true);
    expect(isClear('#ff000001')).toBe(false);
    expect(isClear('#ff0000')).toBe(false);
    expect(isClear('junk')).toBe(true);
    expect(withAlpha('#ff8800', 0)).toBe('#ff880000');
    expect(withAlpha('#ff880040', 1)).toBe('#ff8800');
  });

  it('keeps the shape fill and outline that read as hex, and starts with a black outline and no fill', () => {
    expect(sanitizeShapeColors(null)).toEqual({ fill: DEFAULT_FILL, outline: DEFAULT_OUTLINE });
    expect(DEFAULT_FILL).toBe('#ffffff00');
    expect(sanitizeShapeColors({ fill: '#AABBCC80', outline: 'blue' })).toEqual({ fill: '#aabbcc80', outline: DEFAULT_OUTLINE });
    expect(sanitizeShapeColors({ fill: 5, outline: '#123456' })).toEqual({ fill: DEFAULT_FILL, outline: '#123456' });
    expect(sanitizeShapeColors('x')).toEqual({ fill: DEFAULT_FILL, outline: DEFAULT_OUTLINE });
  });

  it('keeps recent colours unique, newest first', () => {
    expect(pushRecent(['#000000', '#ff0000'], '#FF0000')).toEqual(['#ff0000', '#000000']);
    expect(pushRecent(Array.from({ length: 10 }, (_, i) => `#00000${i}`), '#ffffff')).toHaveLength(10);
  });
});

describe('tools', () => {
  it('puts every tool in exactly one slot, and every slot tool exists', () => {
    const inSlots = SLOTS.flatMap((s) => s.tools);
    expect(new Set(inSlots).size).toBe(inSlots.length);
    expect([...inSlots].sort()).toEqual(TOOLS.map((t) => t.id).sort());
    for (const t of TOOLS) expect(SLOTS.find((s) => s.id === t.slot)!.tools).toContain(t.id);
  });

  it('gives every tool shortcut its own key', () => {
    const keys = SLOTS.flatMap((s) => (s.key ? [s.key] : []));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('points each size key at a range option', () => {
    for (const t of TOOLS) if (t.sizeKey) expect(t.options.find((o) => o.key === t.sizeKey)?.kind).toBe('range');
  });

  it('keeps saved settings that still fit and drops the rest', () => {
    const brush = getTool('brush');
    const s = mergeSettings(brush, { size: 500, opacity: 40, type: 'spray', smoothing: 'yes', extra: 1 });
    expect(s.size).toBe(200);
    expect(s.opacity).toBe(40);
    expect(s.type).toBe('round');
    expect(s.smoothing).toBe(true);
    expect('extra' in s).toBe(false);
    expect(mergeSettings(brush, undefined).size).toBe(4);
  });

  it('gives shapes the fill and outline buttons and no Fill toggle, and lines their one colour button', () => {
    for (const id of ['rectangle', 'ellipse', 'polygon', 'star']) {
      const t = getTool(id);
      expect(t.options[0].kind).toBe('shapeColors');
      expect(t.options.some((o) => o.key === 'fill' || o.kind === 'colors')).toBe(false);
      // The old Fill toggle in saved settings is dropped.
      expect('fill' in mergeSettings(t, { fill: true, width: 5 })).toBe(false);
      expect(mergeSettings(t, { fill: true, width: 5 }).width).toBe(5);
    }
    for (const id of ['arrow', 'line']) expect(getTool(id).options[0].kind).toBe('lineColor');
    // Brush, text and the rest still share colours 1 and 2.
    for (const id of ['brush', 'pencil', 'text', 'fill', 'picker', 'marker', 'callout']) expect(getTool(id).options[0].kind).toBe('colors');
    for (const t of TOOLS) expect(t.options.filter((o) => o.kind === 'colors' || o.kind === 'shapeColors' || o.kind === 'lineColor').length).toBeLessThanOrEqual(1);
  });

  it('steps sizes by about a quarter, at least one pixel, within limits', () => {
    expect(stepSize(1, 1, 1, 200)).toBe(2);
    expect(stepSize(40, 1, 1, 200)).toBe(50);
    expect(stepSize(50, -1, 1, 200)).toBe(40);
    expect(stepSize(1, -1, 1, 200)).toBe(1);
    expect(stepSize(190, 1, 1, 200)).toBe(200);
  });
});
