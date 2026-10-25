import { DEFAULT_TOOL, getSlot, getTool, mergeSettings, SLOTS, stepSize, type OptionValue, type ToolSettings, type ToolSpec } from '../tools/registry';
import { loadPref, savePref } from './prefs';
import { changed, toast } from './store';

interface SavedTools {
  /** The tool last used in each rail slot, so the slot shows and picks it. */
  slots?: Record<string, string>;
  settings?: Record<string, Record<string, unknown>>;
}

const saved = loadPref<SavedTools>('tools', {});

export const tools = {
  /** Every window starts with the brush, whatever was used last; a capture opens with it too (`openCapture`). */
  current: DEFAULT_TOOL,
  slots: Object.fromEntries(SLOTS.map((s) => [s.id, saved.slots?.[s.id] && s.tools.includes(saved.slots[s.id]) ? saved.slots[s.id] : s.tools[0]])),
  settings: {} as Record<string, ToolSettings>,
};

const toolListeners: ((from: string, to: string) => void)[] = [];
const optionListeners: ((toolId: string, key: string) => void)[] = [];

/** Runs before the current tool changes, so a tool can finish what it was doing. */
export function onToolChange(fn: (from: string, to: string) => void): void {
  toolListeners.push(fn);
}

/** Runs after a tool's option changes. */
export function onOptionChange(fn: (toolId: string, key: string) => void): void {
  optionListeners.push(fn);
}

function persist(): void {
  savePref('tools', { slots: tools.slots, settings: { ...saved.settings, ...tools.settings } });
}

export function currentTool(): ToolSpec {
  return getTool(tools.current);
}

export function settingsOf(id: string): ToolSettings {
  return (tools.settings[id] ??= mergeSettings(getTool(id), saved.settings?.[id]));
}

export function setOption(id: string, key: string, value: OptionValue): void {
  settingsOf(id)[key] = value;
  persist();
  for (const fn of optionListeners) fn(id, key);
  changed();
}

/** Sets several options without telling the option listeners (for loading a text box's settings into the bar). */
export function loadOptions(id: string, values: Record<string, OptionValue>): void {
  Object.assign(settingsOf(id), values);
  persist();
  changed();
}

export function selectTool(id: string): void {
  const tool = getTool(id);
  if (tool.id !== tools.current) for (const fn of toolListeners) fn(tools.current, tool.id);
  tools.current = tool.id;
  tools.slots[tool.slot] = tool.id;
  persist();
  changed();
}

/** A slot's shortcut: picks the slot's last tool, or the next one if the slot is already in use. */
export function selectSlot(slotId: string): void {
  const slot = getSlot(slotId);
  const active = getTool(tools.current).slot === slotId;
  const i = slot.tools.indexOf(tools.slots[slotId]);
  selectTool(active ? slot.tools[(i + 1) % slot.tools.length] : slot.tools[i]);
}

/** The current tool's brush-like size, if it has one. */
export function currentSize(): { value: number; min: number; max: number } | null {
  const tool = currentTool();
  const opt = tool.options.find((o) => o.key === tool.sizeKey);
  if (!opt || opt.kind !== 'range') return null;
  return { value: settingsOf(tool.id)[opt.key] as number, min: opt.min, max: opt.max };
}

export function setSize(value: number): void {
  const tool = currentTool();
  const s = currentSize();
  if (!s || !tool.sizeKey) return;
  setOption(tool.id, tool.sizeKey, Math.min(s.max, Math.max(s.min, Math.round(value))));
}

/** `[` and `]`. */
export function stepCurrentSize(dir: 1 | -1): void {
  const s = currentSize();
  if (s) setSize(stepSize(s.value, dir, s.min, s.max));
}

/** Called when a tool that isn't built yet is used on the canvas. */
export function notBuiltYet(tool: ToolSpec): void {
  toast(`The ${tool.name} tool isn't built yet. It comes in step ${tool.planned} of the plan.`);
}
