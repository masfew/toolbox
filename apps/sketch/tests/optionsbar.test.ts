import { describe, expect, it } from 'vitest';
import { PREVIEWS } from '../src/ui/previews';
import { hasIcon } from '../src/ui/icons';
import { getTool, TOOLS, type OptionSpec } from '../src/tools/registry';

/** What a tool's bar lists, with a bar for each group break: `Fill | Outline px Line | Corners px | Opacity %`. */
function layout(id: string): string {
  const out: string[] = [];
  getTool(id).options.forEach((o, i) => {
    if (i === 0 || o.group) out.push('|');
    out.push(o.kind === 'range' ? `${o.label}${o.control === 'drag' ? '~' : '='}` : o.label);
  });
  return out.join(' ');
}

const ranges = (id: string) => getTool(id).options.filter((o): o is Extract<OptionSpec, { kind: 'range' }> => o.kind === 'range');

describe('options bar parts', () => {
  it('makes every range option a drag label, except the four Size sliders', () => {
    const sliders: string[] = [];
    for (const t of TOOLS) {
      for (const o of ranges(t.id)) {
        if (o.control !== 'drag') sliders.push(`${t.id}.${o.key}`);
        else expect(hasIcon(o.icon ?? ''), `${t.id}.${o.key} icon ${o.icon}`).toBe(true);
      }
    }
    expect(sliders.sort()).toEqual(['brush.size', 'eraser.size', 'highlight.size', 'pencil.size']);
  });

  it('gives each shape and line tool the planned order', () => {
    expect(layout('rectangle')).toBe('| Fill Outline~ Line | Corners~ | Opacity~');
    expect(layout('ellipse')).toBe('| Fill Outline~ Line | Opacity~');
    expect(layout('polygon')).toBe('| Fill Outline~ Line | Sides~ | Opacity~');
    expect(layout('star')).toBe('| Fill Outline~ Line | Points~ | Opacity~');
    expect(layout('arrow')).toBe('| Colour Width~ Line | Start End | Opacity~');
    expect(layout('line')).toBe('| Colour Width~ Line | Start End | Opacity~');
  });

  it('draws line style and the arrowheads as preview squares, with a drawing for every choice', () => {
    for (const id of ['rectangle', 'ellipse', 'polygon', 'star', 'arrow', 'line']) {
      const previews = getTool(id).options.filter((o) => o.kind === 'choice' && o.display === 'preview');
      expect(previews.map((o) => o.key)).toEqual(id === 'arrow' || id === 'line' ? ['dash', 'start', 'end'] : ['dash']);
    }
    for (const t of TOOLS) {
      for (const o of t.options) {
        if (o.kind !== 'choice' || o.display !== 'preview') continue;
        const spec = PREVIEWS[o.key];
        expect(spec, `${t.id}.${o.key}`).toBeTruthy();
        for (const c of o.choices) expect(spec.draw(c.value, 16)).toBeTruthy();
      }
    }
  });

  it('keeps the Size sliders for sizeKey and the keys that change them', () => {
    for (const t of TOOLS) if (t.sizeKey) expect(t.options.find((o) => o.key === t.sizeKey)?.kind).toBe('range');
  });

  it('never makes a stray divider', () => {
    // The bar draws one after the tool name itself, and one before each option flagged `group`.
    for (const t of TOOLS) {
      expect(t.options[0].group, `${t.id} first option`).toBeFalsy();
      // Each option is a control of its own, so a divider always has one on each side.
      expect(t.options.length).toBeGreaterThan(0);
      const keys = t.options.map((o) => o.key);
      expect(new Set(keys).size, `${t.id} option keys`).toBe(keys.length);
    }
  });

  it('puts group breaks where the plan says for the other tools', () => {
    expect(layout('brush')).toBe('| Colours Size= | Opacity~ | Type Smoothing Pen pressure');
    expect(layout('pencil')).toBe('| Colours Size=');
    expect(layout('text')).toBe('| Colours | Font Size~ | Bold Italic Align | Outline Background');
    expect(layout('fill')).toBe('| Colours Tolerance~ | All matching Sample');
    expect(layout('marker')).toBe('| Colours Size~ | Number~');
    expect(layout('picker')).toBe('| Colours | Sample');
    expect(layout('blur')).toBe('| Strength~');
    expect(layout('pixelate')).toBe('| Block size~');
    expect(layout('spotlight')).toBe('| Dim~ | Shape');
    expect(layout('callout')).toBe('| Colours Text size~');
    expect(layout('magic-wand')).toBe('| Tolerance~ | Transparent | Remove Background');
  });
});
