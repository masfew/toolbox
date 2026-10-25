/**
 * Every tool, the rail slot it sits in, and the options it shows on the options bar.
 * The rail, the options bar, the shortcuts and the command palette are all built from these lists.
 *
 * `planned` marks a tool or option that isn't built yet, with the plan step that builds it.
 * It still has its place in the window; it just shows as not ready.
 */

export interface OptionBase {
  key: string;
  label: string;
  planned?: string;
  /** Short help shown as the control's tooltip. */
  hint?: string;
}

export type OptionSpec =
  /** The primary and secondary colour chips. The colours are shared by every tool. */
  | (OptionBase & { kind: 'colors' })
  | (OptionBase & { kind: 'range'; min: number; max: number; default: number; unit?: string })
  | (OptionBase & { kind: 'choice'; choices: { value: string; label: string }[]; default: string })
  | (OptionBase & { kind: 'toggle'; default: boolean })
  | (OptionBase & { kind: 'font'; default: string })
  /** A button that runs a command from the command list. */
  | (OptionBase & { kind: 'action'; command: string });

export type OptionValue = number | string | boolean;
export type ToolSettings = Record<string, OptionValue>;

export interface ToolSpec {
  id: string;
  name: string;
  /** Icon name, mapped to a picture in `ui/icons.tsx`. */
  icon: string;
  slot: string;
  options: OptionSpec[];
  /** The option that `[`, `]` and Alt + right-drag change. */
  sizeKey?: string;
  planned?: string;
}

export interface SlotSpec {
  id: string;
  name: string;
  /** Single-key shortcut. Pressing it again cycles through the slot's tools. */
  key?: string;
  tools: string[];
}

const colors: OptionSpec = { kind: 'colors', key: 'colors', label: 'Colours', hint: 'Left click paints with the first colour, right click with the second. X swaps them.' };
const opacity = (planned?: string): OptionSpec => ({ kind: 'range', key: 'opacity', label: 'Opacity', min: 1, max: 100, default: 100, unit: '%', planned });
const dash = (planned?: string): OptionSpec => ({
  kind: 'choice',
  key: 'dash',
  label: 'Line',
  default: 'solid',
  planned,
  choices: [
    { value: 'solid', label: 'Solid' },
    { value: 'dashed', label: 'Dashed' },
    { value: 'dotted', label: 'Dotted' },
  ],
});
const sample: OptionSpec = {
  kind: 'choice',
  key: 'sample',
  label: 'Sample',
  default: 'layer',
  choices: [
    { value: 'layer', label: 'Current layer' },
    { value: 'picture', label: 'Whole picture' },
  ],
};
const transparentSel: OptionSpec = {
  kind: 'toggle',
  key: 'transparent',
  label: 'Transparent',
  default: false,
  hint: 'Leave out the second colour when moving the selection, as Paint does',
};

const removeBackground: OptionSpec = {
  kind: 'action',
  key: 'removeBackground',
  label: 'Remove Background',
  command: 'adjust.removeBackground',
  hint: 'Cut out the person or object in front, onto a new layer',
};
const heads = [
  { value: 'none', label: 'None' },
  { value: 'open', label: 'Open' },
  { value: 'filled', label: 'Filled' },
  { value: 'dot', label: 'Dot' },
];

function shape(id: string, name: string, icon: string, extra: OptionSpec[]): ToolSpec {
  return {
    id,
    name,
    icon,
    slot: 'shapes',
    sizeKey: 'width',
    options: [
      colors,
      { kind: 'range', key: 'width', label: 'Outline', min: 0, max: 50, default: 3, unit: 'px' },
      { kind: 'toggle', key: 'fill', label: 'Fill', default: false, hint: 'Fill with the second colour' },
      dash(),
      opacity(),
      ...extra,
    ],
  };
}

function line(id: string, name: string, icon: string, startHead: string, endHead: string): ToolSpec {
  return {
    id,
    name,
    icon,
    slot: 'lines',
    sizeKey: 'width',
    options: [
      colors,
      { kind: 'range', key: 'width', label: 'Width', min: 1, max: 50, default: 4, unit: 'px' },
      { kind: 'choice', key: 'start', label: 'Start', default: startHead, choices: heads },
      { kind: 'choice', key: 'end', label: 'End', default: endHead, choices: heads },
      dash(),
      opacity(),
    ],
  };
}

export const TOOLS: ToolSpec[] = [
  { id: 'select-rect', name: 'Rectangle Select', icon: 'select-rect', slot: 'select', options: [transparentSel, removeBackground] },
  { id: 'select-free', name: 'Freehand Select', icon: 'select-free', slot: 'select', options: [transparentSel, removeBackground] },
  {
    id: 'magic-wand',
    name: 'Magic Wand',
    icon: 'magic-wand',
    slot: 'select',
    options: [{ kind: 'range', key: 'tolerance', label: 'Tolerance', min: 0, max: 100, default: 32, unit: '%' }, transparentSel, removeBackground],
  },
  {
    id: 'crop',
    name: 'Crop',
    icon: 'crop',
    slot: 'crop',
    options: [
      {
        kind: 'choice',
        key: 'ratio',
        label: 'Ratio',
        default: 'free',
        choices: [
          { value: 'free', label: 'Free' },
          { value: 'original', label: 'Original' },
          { value: '1:1', label: '1:1' },
          { value: '4:3', label: '4:3' },
          { value: '16:9', label: '16:9' },
        ],
      },
      { kind: 'action', key: 'apply', label: 'Crop', command: 'image.applyCrop', hint: 'Keep what is in the box (Enter)' },
    ],
  },
  {
    id: 'pencil',
    name: 'Pencil',
    icon: 'pencil',
    slot: 'pencil',
    sizeKey: 'size',
    options: [colors, { kind: 'range', key: 'size', label: 'Size', min: 1, max: 16, default: 1, unit: 'px' }],
  },
  {
    id: 'brush',
    name: 'Brush',
    icon: 'brush',
    slot: 'brush',
    sizeKey: 'size',
    options: [
      colors,
      { kind: 'range', key: 'size', label: 'Size', min: 1, max: 200, default: 4, unit: 'px' },
      opacity(),
      {
        kind: 'choice',
        key: 'type',
        label: 'Type',
        default: 'round',
        choices: [
          { value: 'round', label: 'Round' },
          { value: 'marker', label: 'Marker' },
          { value: 'highlighter', label: 'Highlighter' },
        ],
      },
      { kind: 'toggle', key: 'smoothing', label: 'Smoothing', default: true },
      {
        kind: 'choice',
        key: 'pressure',
        label: 'Pen pressure',
        default: 'size',
        choices: [
          { value: 'size', label: 'Size' },
          { value: 'opacity', label: 'Opacity' },
          { value: 'off', label: 'Off' },
        ],
      },
    ],
  },
  {
    id: 'eraser',
    name: 'Eraser',
    icon: 'eraser',
    slot: 'eraser',
    sizeKey: 'size',
    options: [
      { kind: 'range', key: 'size', label: 'Size', min: 1, max: 200, default: 16, unit: 'px' },
      {
        kind: 'choice',
        key: 'mode',
        label: 'Erase to',
        default: 'transparent',
        choices: [
          { value: 'transparent', label: 'Transparent' },
          { value: 'secondary', label: 'Second colour' },
        ],
      },
    ],
  },
  {
    id: 'fill',
    name: 'Fill',
    icon: 'fill',
    slot: 'fill',
    options: [
      colors,
      { kind: 'range', key: 'tolerance', label: 'Tolerance', min: 0, max: 100, default: 16, unit: '%' },
      { kind: 'toggle', key: 'global', label: 'All matching', default: false, hint: 'Fill every pixel of the clicked colour, not just the connected area' },
      sample,
    ],
  },
  { id: 'picker', name: 'Colour Picker', icon: 'picker', slot: 'picker', options: [colors, sample] },
  {
    id: 'text',
    name: 'Text',
    icon: 'text',
    slot: 'text',
    sizeKey: 'size',
    options: [
      colors,
      { kind: 'font', key: 'font', label: 'Font', default: 'Segoe UI' },
      { kind: 'range', key: 'size', label: 'Size', min: 6, max: 200, default: 24, unit: 'px' },
      { kind: 'toggle', key: 'bold', label: 'Bold', default: false },
      { kind: 'toggle', key: 'italic', label: 'Italic', default: false },
      {
        kind: 'choice',
        key: 'align',
        label: 'Align',
        default: 'left',
        choices: [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Centre' },
          { value: 'right', label: 'Right' },
        ],
      },
      { kind: 'toggle', key: 'outline', label: 'Outline', default: false },
      { kind: 'toggle', key: 'box', label: 'Background', default: false, hint: 'A box behind the text, for labels on busy screenshots' },
    ],
  },
  shape('rectangle', 'Rectangle', 'rectangle', [{ kind: 'range', key: 'radius', label: 'Corners', min: 0, max: 200, default: 0, unit: 'px' }]),
  shape('ellipse', 'Ellipse', 'ellipse', []),
  shape('polygon', 'Polygon', 'polygon', [{ kind: 'range', key: 'sides', label: 'Sides', min: 3, max: 12, default: 5 }]),
  shape('star', 'Star', 'star', [{ kind: 'range', key: 'points', label: 'Points', min: 4, max: 12, default: 5 }]),
  line('arrow', 'Arrow', 'arrow', 'none', 'filled'),
  line('line', 'Line', 'line', 'none', 'none'),
  {
    id: 'highlight',
    name: 'Highlighter',
    icon: 'highlighter',
    slot: 'annotate',
    sizeKey: 'size',
    options: [
      {
        kind: 'choice',
        key: 'tint',
        label: 'Colour',
        default: 'yellow',
        hint: 'Highlighter colours darken what is under them, so text stays readable',
        choices: [
          { value: 'yellow', label: 'Yellow' },
          { value: 'green', label: 'Green' },
          { value: 'blue', label: 'Blue' },
          { value: 'pink', label: 'Pink' },
          { value: 'orange', label: 'Orange' },
        ],
      },
      { kind: 'range', key: 'size', label: 'Size', min: 4, max: 100, default: 20, unit: 'px' },
      opacity(),
    ],
  },
  {
    id: 'blur',
    name: 'Blur',
    icon: 'blur',
    slot: 'annotate',
    options: [{ kind: 'range', key: 'strength', label: 'Strength', min: 10, max: 100, default: 70, unit: '%', hint: 'Even the lowest strength hides small text for good' }],
  },
  {
    id: 'pixelate',
    name: 'Pixelate',
    icon: 'pixelate',
    slot: 'annotate',
    options: [{ kind: 'range', key: 'block', label: 'Block size', min: 6, max: 64, default: 14, unit: 'px' }],
  },
  {
    id: 'marker',
    name: 'Numbered Marker',
    icon: 'marker',
    slot: 'annotate',
    sizeKey: 'size',
    options: [
      colors,
      { kind: 'range', key: 'size', label: 'Size', min: 16, max: 96, default: 28, unit: 'px' },
      { kind: 'range', key: 'next', label: 'Number', min: 1, max: 99, default: 1, hint: 'The next marker gets this number. Markers count up by themselves.' },
    ],
  },
  {
    id: 'callout',
    name: 'Callout',
    icon: 'callout',
    slot: 'annotate',
    sizeKey: 'size',
    options: [colors, { kind: 'range', key: 'size', label: 'Text size', min: 8, max: 96, default: 18, unit: 'px' }],
  },
  {
    id: 'spotlight',
    name: 'Spotlight',
    icon: 'spotlight',
    slot: 'annotate',
    options: [
      { kind: 'range', key: 'dim', label: 'Dim', min: 10, max: 90, default: 60, unit: '%' },
      {
        kind: 'choice',
        key: 'shape',
        label: 'Shape',
        default: 'rect',
        choices: [
          { value: 'rect', label: 'Rectangle' },
          { value: 'ellipse', label: 'Ellipse' },
        ],
      },
    ],
  },
];

export const SLOTS: SlotSpec[] = [
  { id: 'select', name: 'Select', key: 'M', tools: ['select-rect', 'select-free', 'magic-wand'] },
  { id: 'crop', name: 'Crop', key: 'C', tools: ['crop'] },
  { id: 'pencil', name: 'Pencil', key: 'P', tools: ['pencil'] },
  { id: 'brush', name: 'Brush', key: 'B', tools: ['brush'] },
  { id: 'eraser', name: 'Eraser', key: 'E', tools: ['eraser'] },
  { id: 'fill', name: 'Fill', key: 'G', tools: ['fill'] },
  { id: 'picker', name: 'Colour Picker', key: 'I', tools: ['picker'] },
  { id: 'text', name: 'Text', key: 'T', tools: ['text'] },
  { id: 'shapes', name: 'Shapes', key: 'U', tools: ['rectangle', 'ellipse', 'polygon', 'star'] },
  { id: 'lines', name: 'Lines and Arrows', key: 'A', tools: ['arrow', 'line'] },
  { id: 'annotate', name: 'Mark-Up', tools: ['highlight', 'blur', 'pixelate', 'marker', 'callout', 'spotlight'] },
];

/** Rail groups, split by a thin line. */
export const RAIL_GROUPS: string[][] = [
  ['select', 'crop'],
  ['pencil', 'brush', 'eraser', 'fill', 'picker', 'text'],
  ['shapes', 'lines', 'annotate'],
];

export const DEFAULT_TOOL = 'brush';

const toolById = new Map(TOOLS.map((t) => [t.id, t]));
const slotById = new Map(SLOTS.map((s) => [s.id, s]));

export function getTool(id: string): ToolSpec {
  return toolById.get(id) ?? toolById.get(DEFAULT_TOOL)!;
}

export function getSlot(id: string): SlotSpec {
  return slotById.get(id)!;
}

export function hasTool(id: string): boolean {
  return toolById.has(id);
}

/**
 * A tool's settings: its saved values where they still fit its options, defaults for the rest.
 * Values that no longer fit (a removed choice, a number out of range, the wrong type) are dropped.
 */
export function mergeSettings(tool: ToolSpec, saved: Record<string, unknown> | undefined): ToolSettings {
  const out: ToolSettings = {};
  for (const o of tool.options) {
    if (o.kind === 'colors' || o.kind === 'action') continue;
    const v = saved?.[o.key];
    if (o.kind === 'range') {
      out[o.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(o.max, Math.max(o.min, Math.round(v))) : o.default;
    } else if (o.kind === 'choice') {
      out[o.key] = typeof v === 'string' && o.choices.some((c) => c.value === v) ? v : o.default;
    } else if (o.kind === 'toggle') {
      out[o.key] = typeof v === 'boolean' ? v : o.default;
    } else {
      out[o.key] = typeof v === 'string' && v.trim() ? v : o.default;
    }
  }
  return out;
}

/** The next size up or down for `[` and `]`: about 25% a step, at least 1 pixel. */
export function stepSize(size: number, dir: 1 | -1, min: number, max: number): number {
  const next = dir > 0 ? Math.max(size + 1, Math.round(size * 1.25)) : Math.min(size - 1, Math.round(size / 1.25));
  return Math.min(max, Math.max(min, next));
}
