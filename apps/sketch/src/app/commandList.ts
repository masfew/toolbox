import { getTool, SLOTS, TOOLS } from '../tools/registry';
import * as platform from '../platform';
import * as actions from './actions';
import * as layers from './layers';
import { adjustNow, adjustWithDialog } from './adjust';
import { cleanUp, toggleCleanUp } from './cleanUp';
import { removeBackground } from './cutout';
import { fromWindowsHotkey, isCaptureHotkey, keyMap, resolveBindings } from './keys';
import { loadPref, savePref } from './prefs';
import { app, changed, openModal, tabs } from './store';
import { closeTab, stepTab } from './tabs';
import { restartToUpdate, update } from './update';
import { mouse, setMouseSpeed } from './mouse';
import { currentTool, selectSlot, selectTool, stepCurrentSize, tools } from './tools';
import { applyCrop, cropIsWhole } from '../tools/crop';
import { deleteSelection, selectAll } from '../tools/selection';
import { alignPicked, deletePicked, distributePicked, duplicatePicked, pickedCount, reorderPicked } from '../tools/shapes';

export type MenuName = 'File' | 'Edit' | 'Image' | 'Adjust' | 'View' | 'Tools' | 'Help';

/**
 * One action the app can do. Menus, keyboard shortcuts, the command palette and the shortcuts
 * sheet are all built from this one list.
 */
export interface AppCommand {
  id: string;
  label: string;
  group: MenuName;
  /** Default keys; the user can change them in Settings. */
  keys?: string[];
  run: () => void;
  enabled?: () => boolean;
  /** Left out of the menus, the palette, the tool rail and the shortcuts for now (on a whiteboard, the ones for a picture's size). */
  hidden?: () => boolean;
  checked?: () => boolean;
  /** Not built yet: the plan step that builds it. Shown greyed out, with the step. */
  planned?: string;
  /** Extra words the command palette matches on. */
  keywords?: string;
  /** Icon name from `ui/icons.tsx`. */
  icon?: string;
  /** Held keys repeat; tool keys shouldn't. */
  repeat?: boolean;
}

/** True on a whiteboard, which has no fixed size to crop, resize or trim. */
const onBoard = () => app.doc.board;

export const COMMANDS: AppCommand[] = [
  // File
  { id: 'file.new', label: 'New', group: 'File', keys: ['Ctrl+N'], run: () => void actions.newPicture(), keywords: 'blank picture' },
  {
    id: 'file.newBoard',
    label: 'New Whiteboard',
    group: 'File',
    keys: ['Ctrl+Alt+N'],
    run: () => void actions.newWhiteboard(),
    keywords: 'board endless infinite canvas diagram notes',
  },
  {
    id: 'file.capture',
    label: 'Capture Screen',
    group: 'File',
    run: actions.captureScreen,
    enabled: () => platform.isTauri,
    keywords: 'screenshot snip snipping tool print screen region window grab',
    icon: 'capture',
  },
  { id: 'file.open', label: 'Open…', group: 'File', keys: ['Ctrl+O'], run: () => void actions.openFile() },
  { id: 'file.save', label: 'Save', group: 'File', keys: ['Ctrl+S'], run: () => void actions.save() },
  { id: 'file.saveAs', label: 'Save As…', group: 'File', keys: ['Ctrl+Shift+S'], run: () => void actions.saveAs(), keywords: 'export png jpeg webp bmp sktch' },
  // Tabs (F14). Ctrl+W stays Resize, as in Paint, so a tab closes with Ctrl+F4, Windows' key for closing a document.
  { id: 'tab.close', label: 'Close Tab', group: 'File', keys: ['Ctrl+F4'], run: () => void closeTab(), keywords: 'close picture document' },
  { id: 'tab.next', label: 'Next Tab', group: 'View', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], run: () => stepTab(1), enabled: () => tabs.list.length > 1, keywords: 'switch picture' },
  { id: 'tab.prev', label: 'Previous Tab', group: 'View', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], run: () => stepTab(-1), enabled: () => tabs.list.length > 1, keywords: 'switch picture' },
  { id: 'app.settings', label: 'Settings…', group: 'File', keys: ['Ctrl+,'], run: () => actions.toggleOverlay('settings'), keywords: 'preferences shortcuts keys', icon: 'settings' },

  // Edit
  { id: 'edit.undo', label: 'Undo', group: 'Edit', keys: ['Ctrl+Z'], run: actions.undo, enabled: () => app.history.canUndo || !!app.selection || !!app.textEdit, icon: 'undo' },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], run: actions.redo, enabled: () => app.history.canRedo, icon: 'redo' },
  { id: 'edit.copy', label: 'Copy', group: 'Edit', keys: ['Ctrl+C'], run: () => void actions.copy(false) },
  { id: 'edit.copyPicture', label: 'Copy Whole Picture', group: 'Edit', keys: ['Ctrl+Shift+C'], run: () => void actions.copy(true), keywords: 'merged clipboard' },
  { id: 'edit.paste', label: 'Paste', group: 'Edit', keys: ['Ctrl+V'], run: () => void actions.pasteFromClipboard(), keywords: 'clipboard' },
  {
    id: 'edit.pasteNewLayer',
    label: 'Paste onto New Layer',
    group: 'Edit',
    run: layers.togglePasteNewLayer,
    checked: () => layers.layerPrefs.pasteNewLayer,
    keywords: 'clipboard layers option',
  },
  // On a capture with nothing selected, Cut copies the whole capture and closes it.
  {
    id: 'edit.cut',
    label: 'Cut',
    group: 'Edit',
    keys: ['Ctrl+X'],
    run: () => void actions.cut(),
    enabled: () => !!app.selection || pickedCount() > 0 || !!app.doc.edges,
    keywords: 'copy close capture screenshot',
  },
  { id: 'edit.selectAll', label: 'Select All', group: 'Edit', keys: ['Ctrl+A'], run: () => (actions.settle(), selectTool(tools.slots.select), selectAll()) },
  {
    id: 'edit.delete',
    label: 'Delete Selection',
    group: 'Edit',
    keys: ['Delete'],
    run: () => (app.selection ? deleteSelection() : deletePicked()),
    enabled: () => !!app.selection || pickedCount() > 0,
    keywords: 'clear erase remove shape',
  },
  { id: 'edit.duplicate', label: 'Duplicate', group: 'Edit', keys: ['Ctrl+D'], run: duplicatePicked, enabled: () => pickedCount() > 0, keywords: 'copy shape' },
  { id: 'edit.front', label: 'Bring to Front', group: 'Edit', keys: ['Ctrl+Shift+]'], run: () => reorderPicked(true), enabled: () => pickedCount() > 0, keywords: 'order arrange shape' },
  { id: 'edit.back', label: 'Send to Back', group: 'Edit', keys: ['Ctrl+Shift+['], run: () => reorderPicked(false), enabled: () => pickedCount() > 0, keywords: 'order arrange shape' },
  { id: 'edit.rasterize', label: 'Rasterize Shapes', group: 'Edit', run: actions.rasterizePicked, enabled: () => pickedCount() > 0, keywords: 'flatten pixels shape merge down' },
  { id: 'arrange.left', label: 'Align Left', group: 'Edit', run: () => alignPicked('left'), enabled: () => pickedCount() > 1, keywords: 'line up shapes', icon: 'align-left' },
  { id: 'arrange.hcentre', label: 'Align Centres', group: 'Edit', run: () => alignPicked('hcentre'), enabled: () => pickedCount() > 1, keywords: 'line up shapes middle center horizontal', icon: 'align-hcentre' },
  { id: 'arrange.right', label: 'Align Right', group: 'Edit', run: () => alignPicked('right'), enabled: () => pickedCount() > 1, keywords: 'line up shapes', icon: 'align-right' },
  { id: 'arrange.top', label: 'Align Tops', group: 'Edit', run: () => alignPicked('top'), enabled: () => pickedCount() > 1, keywords: 'line up shapes', icon: 'align-top' },
  { id: 'arrange.vcentre', label: 'Align Middles', group: 'Edit', run: () => alignPicked('vcentre'), enabled: () => pickedCount() > 1, keywords: 'line up shapes centre center vertical', icon: 'align-vcentre' },
  { id: 'arrange.bottom', label: 'Align Bottoms', group: 'Edit', run: () => alignPicked('bottom'), enabled: () => pickedCount() > 1, keywords: 'line up shapes', icon: 'align-bottom' },
  { id: 'arrange.spaceX', label: 'Space Evenly Across', group: 'Edit', run: () => distributePicked('x'), enabled: () => pickedCount() > 2, keywords: 'distribute horizontal gaps shapes', icon: 'distribute-x' },
  { id: 'arrange.spaceY', label: 'Space Evenly Down', group: 'Edit', run: () => distributePicked('y'), enabled: () => pickedCount() > 2, keywords: 'distribute vertical gaps shapes', icon: 'distribute-y' },
  { id: 'edit.swapColors', label: 'Swap Colours', group: 'Edit', keys: ['X'], run: actions.swapColors, keywords: 'primary secondary color', repeat: false },
  { id: 'edit.sizeDown', label: 'Smaller Tool Size', group: 'Edit', keys: ['['], run: () => stepCurrentSize(-1), keywords: 'brush size decrease' },
  { id: 'edit.sizeUp', label: 'Bigger Tool Size', group: 'Edit', keys: [']'], run: () => stepCurrentSize(1), keywords: 'brush size increase' },

  // Image
  { id: 'image.crop', label: 'Crop to Selection', group: 'Image', keys: ['Ctrl+Shift+X'], run: actions.cropToSelection, enabled: () => !!app.selection, hidden: onBoard },
  {
    id: 'image.applyCrop',
    label: 'Crop',
    group: 'Image',
    run: applyCrop,
    enabled: () => currentTool().id === 'crop' && !cropIsWhole(),
    hidden: onBoard,
    keywords: 'apply crop box keep',
    icon: 'crop',
  },
  { id: 'image.resize', label: 'Resize…', group: 'Image', keys: ['Ctrl+W'], run: () => void actions.resizePicture(), hidden: onBoard, keywords: 'scale image size pixels percent' },
  { id: 'image.canvasSize', label: 'Canvas Size…', group: 'Image', run: () => void actions.canvasSize(), hidden: onBoard, keywords: 'expand border' },
  { id: 'image.trim', label: 'Trim to Content', group: 'Image', run: actions.trimToContent, hidden: onBoard, keywords: 'auto crop borders' },
  // On a whiteboard these turn the selection only.
  { id: 'image.rotateRight', label: 'Rotate Right 90°', group: 'Image', run: () => actions.rotate(1), enabled: () => !onBoard() || !!app.selection, keywords: 'turn clockwise selection' },
  { id: 'image.rotateLeft', label: 'Rotate Left 90°', group: 'Image', run: () => actions.rotate(-1), enabled: () => !onBoard() || !!app.selection, keywords: 'turn anticlockwise counterclockwise selection' },
  { id: 'image.flipH', label: 'Flip Horizontal', group: 'Image', run: () => actions.flip('h'), enabled: () => !onBoard() || !!app.selection, keywords: 'mirror selection' },
  { id: 'image.flipV', label: 'Flip Vertical', group: 'Image', run: () => actions.flip('v'), enabled: () => !onBoard() || !!app.selection, keywords: 'mirror selection' },
  { id: 'image.flatten', label: 'Flatten', group: 'Image', run: actions.flattenImage, keywords: 'merge layers rasterize shapes text' },
  {
    id: 'image.rasterizeLayer',
    label: 'Rasterize Layer',
    group: 'Image',
    run: actions.rasterizeCurrentLayer,
    enabled: () => app.doc.activeLayer.kind === 'objects',
    keywords: 'flatten shapes text pixels',
  },
  { id: 'image.newLayer', label: 'New Layer', group: 'Image', keys: ['Ctrl+Shift+N'], run: layers.newLayer, keywords: 'add layers', icon: 'layer-new' },
  { id: 'image.deleteLayer', label: 'Delete Layer', group: 'Image', run: () => layers.removeLayer(), enabled: () => layers.canDeleteLayer(), keywords: 'remove layers' },
  { id: 'image.mergeDown', label: 'Merge Layer Down', group: 'Image', keys: ['Ctrl+E'], run: layers.mergeCurrentDown, enabled: () => !layers.mergeDownBlocked(), keywords: 'combine layers' },
  { id: 'layer.up', label: 'Move Layer Up', group: 'Image', keys: ['Ctrl+]'], run: () => layers.moveCurrentLayer(1), enabled: () => app.doc.active < app.doc.layers.length - 1, keywords: 'order layers raise' },
  { id: 'layer.down', label: 'Move Layer Down', group: 'Image', keys: ['Ctrl+['], run: () => layers.moveCurrentLayer(-1), enabled: () => app.doc.active > 0, keywords: 'order layers lower' },
  { id: 'adjust.brightness', label: 'Brightness and Contrast…', group: 'Adjust', run: () => void adjustWithDialog('brightness'), keywords: 'adjust lighter darker' },
  { id: 'adjust.hue', label: 'Hue and Saturation…', group: 'Adjust', run: () => void adjustWithDialog('hue'), keywords: 'adjust colour color vivid' },
  { id: 'adjust.bw', label: 'Black and White', group: 'Adjust', run: () => adjustNow({ kind: 'bw' }), keywords: 'adjust greyscale grayscale monochrome' },
  { id: 'adjust.invert', label: 'Invert Colours', group: 'Adjust', keys: ['Ctrl+Shift+I'], run: () => adjustNow({ kind: 'invert' }), keywords: 'adjust negative' },
  { id: 'adjust.autoLevel', label: 'Auto Level', group: 'Adjust', keys: ['Ctrl+Shift+L'], run: () => adjustNow('auto'), keywords: 'adjust levels contrast fix colour cast' },
  {
    id: 'adjust.removeBackground',
    label: 'Remove Background',
    group: 'Adjust',
    run: () => void removeBackground(),
    keywords: 'cut out cutout subject person object isolate transparent erase backdrop',
  },

  // View
  { id: 'view.zoomIn', label: 'Zoom In', group: 'View', keys: ['Ctrl+=', 'Ctrl+Shift+='], run: () => actions.zoomStep(1), icon: 'zoom-in' },
  { id: 'view.zoomOut', label: 'Zoom Out', group: 'View', keys: ['Ctrl+-'], run: () => actions.zoomStep(-1), icon: 'zoom-out' },
  { id: 'view.fit', label: 'Fit to Window', group: 'View', keys: ['Ctrl+0'], run: actions.zoomFit, icon: 'fit', keywords: 'zoom to fit everything whiteboard' },
  { id: 'view.actual', label: 'Actual Size', group: 'View', keys: ['Ctrl+1'], run: actions.zoomActual, keywords: '100%' },
  { id: 'view.grid', label: 'Pixel Grid', group: 'View', keys: ["Ctrl+'"], run: actions.toggleGrid, checked: () => app.showGrid, keywords: 'shows from 800%' },
  { id: 'view.snapping', label: 'Snap to Shapes', group: 'View', run: actions.toggleSnapping, checked: () => app.snapping, keywords: 'smart guides align snapping magnet hold ctrl to skip' },
  { id: 'view.panel', label: 'Side Panel', group: 'View', keys: ['F6'], run: actions.togglePanel, checked: () => app.showPanel, keywords: 'layers history sidebar', icon: 'panel' },
  {
    id: 'view.mouseReset',
    label: 'Reset Mouse Speed',
    group: 'View',
    run: () => setMouseSpeed(0),
    enabled: () => mouse.offset !== 0,
    keywords: 'pointer sensitivity normal slower faster cursor ctrl',
    icon: 'mouse',
  },
  { id: 'view.palette', label: 'Command Palette', group: 'View', keys: ['Ctrl+K'], run: () => actions.toggleOverlay('palette'), keywords: 'search find action', icon: 'search' },

  // Help
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', group: 'Help', keys: ['Shift+/'], run: () => actions.toggleOverlay('shortcuts'), keywords: 'keys help cheat sheet', icon: 'keyboard' },
  { id: 'help.about', label: 'About Sketch', group: 'Help', run: () => void openModal('about'), keywords: 'version build commit' },
  {
    id: 'app.update',
    label: 'Restart to Update',
    group: 'Help',
    run: () => void restartToUpdate(),
    // Only while a new version is ready (F6.4); Sketch otherwise picks it up at the next start.
    hidden: () => !update.ready,
    enabled: () => !update.restarting,
    keywords: 'install new version upgrade update restart',
  },

  {
    id: 'tools.cleanUp',
    label: 'Turn Shape Clean-Up On/Off',
    group: 'Tools',
    run: toggleCleanUp,
    checked: () => cleanUp.on,
    keywords: 'clean up rough shapes quickshape snap hold still straighten line arrow box circle ellipse rectangle',
  },

  // Tools: one per rail slot with its key, plus one per tool for the palette.
  ...SLOTS.filter((s) => s.tools.length > 1 || s.key).map(
    (s): AppCommand => ({
      id: `slot.${s.id}`,
      label: s.tools.length > 1 ? `${s.name} (next tool)` : `${getTool(s.tools[0]).name} Tool`,
      group: 'Tools',
      keys: s.key ? [s.key] : undefined,
      run: () => selectSlot(s.id),
      hidden: s.id === 'crop' ? onBoard : undefined,
      repeat: false,
      icon: getTool(s.tools[0]).icon,
    }),
  ),
  ...TOOLS.filter((t) => getSlotSize(t.slot) > 1).map(
    (t): AppCommand => ({
      id: `tool.${t.id}`,
      label: `${t.name} Tool`,
      group: 'Tools',
      run: () => selectTool(t.id),
      checked: () => tools.current === t.id,
      repeat: false,
      icon: t.icon,
    }),
  ),
];

function getSlotSize(slotId: string): number {
  return SLOTS.find((s) => s.id === slotId)!.tools.length;
}

export const commandById = new Map(COMMANDS.map((c) => [c.id, c]));

export function isEnabled(c: AppCommand): boolean {
  return !c.planned && !c.hidden?.() && (c.enabled?.() ?? true);
}

export function isHidden(c: AppCommand): boolean {
  return !!c.hidden?.();
}

/** A menu's items as they show now: hidden commands left out, with no separators doubled or at the ends. */
export function menuItems(name: MenuName): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of MENUS.find((m) => m.name === name)!.items) {
    if (item === '-') {
      if (out.length && out.at(-1) !== '-') out.push(item);
    } else if (!isHidden(commandById.get(item)!)) out.push(item);
  }
  if (out.at(-1) === '-') out.pop();
  return out;
}

/** A tool rail slot is hidden with its command (the crop slot on a whiteboard). */
export function slotHidden(slotId: string): boolean {
  const c = commandById.get(`slot.${slotId}`);
  return !!c && isHidden(c);
}

/** Runs a command if it's available now. */
export function runCommand(id: string): void {
  const c = commandById.get(id);
  if (c && isEnabled(c)) c.run();
}

// ---------- Key bindings ----------

const DEFAULT_KEYS: Record<string, string[]> = Object.fromEntries(COMMANDS.map((c) => [c.id, c.keys ?? []]));

/**
 * Capture Screen's shortcut is the one capture key: the capture helper holds it anywhere in Windows,
 * with Sketch open or closed (`platform.setShortcut('capture')`). It lives in the helper's settings,
 * never in `overrides`, and only joins `bindings` so menus and Settings show it.
 */
export const CAPTURE_ID = 'file.capture';
let captureKey: string | null = null;

/** The user's changed shortcuts, by command id. */
let overrides = loadPref<Record<string, string[]>>('keys', {});
let bindings = resolveBindings(DEFAULT_KEYS, overrides);
let byKey = keyMap(bindings);

function rebuild(): void {
  const { [CAPTURE_ID]: _, ...saved } = overrides;
  overrides = saved;
  bindings = resolveBindings(DEFAULT_KEYS, captureKey ? { ...overrides, [CAPTURE_ID]: [captureKey] } : overrides);
  byKey = keyMap(bindings);
  savePref('keys', overrides, 0);
  changed();
}

/**
 * Reads the capture key from the helper as the window starts. Until 22 Oct 2026 Capture Screen also
 * had an in-app shortcut of its own, apart from the Windows-wide key; when only that one is set and
 * Windows can hold it, it becomes the capture key.
 */
export async function startCaptureKey(): Promise<void> {
  const old = overrides[CAPTURE_ID]?.[0];
  let key = await platform
    .shortcut('capture')
    .then((k) => (k ? fromWindowsHotkey(k) : null))
    .catch(() => null);
  if (!key && old && isCaptureHotkey(old)) key = await platform.setShortcut('capture', old).then(() => old, () => null);
  captureKey = key;
  rebuild();
}

export function keysFor(id: string): string[] {
  return bindings[id] ?? [];
}

export function commandForKey(combo: string): AppCommand | undefined {
  const id = byKey.get(combo);
  return id ? commandById.get(id) : undefined;
}

export function isCustomised(id: string): boolean {
  return id === CAPTURE_ID ? captureKey !== null : id in overrides;
}

/** `overrides` with `combo` taken off every command but `id`, so it's only `id`'s. */
function freeKey(id: string, combo: string): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [cid, keys] of Object.entries(overrides)) next[cid] = keys.filter((k) => k !== combo);
  // A default key taken from another command: that command now keeps only its other keys.
  for (const [cid, keys] of Object.entries(bindings)) {
    if (cid !== id && keys.includes(combo) && !(cid in next)) next[cid] = keys.filter((k) => k !== combo);
  }
  return next;
}

/** Gives a command one key, in place of its others. The key is taken off whichever command had it. */
export function setKey(id: string, combo: string): void {
  if (combo === captureKey) void setCaptureKey(null);
  overrides = { ...freeKey(id, combo), [id]: [combo] };
  rebuild();
}

/** Sets or removes the capture key. Rejects with the reason when Windows or another app has the keys. */
export async function setCaptureKey(combo: string | null): Promise<void> {
  await platform.setShortcut('capture', combo);
  if (combo) overrides = freeKey(CAPTURE_ID, combo);
  captureKey = combo;
  rebuild();
}

export function clearKey(id: string): void {
  if (id === CAPTURE_ID) return void setCaptureKey(null);
  overrides = { ...overrides, [id]: [] };
  rebuild();
}

export function resetKey(id: string): void {
  if (id === CAPTURE_ID) return void setCaptureKey(null);
  const { [id]: _, ...rest } = overrides;
  overrides = rest;
  rebuild();
}

export function resetAllKeys(): void {
  overrides = {};
  if (captureKey) void setCaptureKey(null);
  rebuild();
}

/** Which command, other than `id`, a key is given to now. */
export function keyOwner(combo: string, exceptId?: string): AppCommand | undefined {
  for (const [cid, keys] of Object.entries(bindings)) if (cid !== exceptId && keys.includes(combo)) return commandById.get(cid);
  return undefined;
}

// ---------- Menus ----------

export type MenuItem = string | '-';

export const MENUS: { name: MenuName; items: MenuItem[] }[] = [
  { name: 'File', items: ['file.new', 'file.newBoard', 'file.capture', 'file.open', '-', 'file.save', 'file.saveAs', '-', 'tab.close', '-', 'app.settings'] },
  {
    name: 'Edit',
    items: [
      'edit.undo',
      'edit.redo',
      '-',
      'edit.cut',
      'edit.copy',
      'edit.copyPicture',
      'edit.paste',
      'edit.pasteNewLayer',
      'edit.delete',
      '-',
      'edit.selectAll',
      'edit.duplicate',
      'edit.front',
      'edit.back',
      'edit.rasterize',
      '-',
      'edit.swapColors',
    ],
  },
  {
    name: 'Image',
    items: [
      'image.crop',
      'image.resize',
      'image.canvasSize',
      'image.trim',
      '-',
      'image.rotateRight',
      'image.rotateLeft',
      'image.flipH',
      'image.flipV',
      '-',
      'image.newLayer',
      'image.deleteLayer',
      'image.mergeDown',
      'image.rasterizeLayer',
      'image.flatten',
    ],
  },
  { name: 'Adjust', items: ['adjust.brightness', 'adjust.hue', '-', 'adjust.bw', 'adjust.invert', 'adjust.autoLevel', '-', 'adjust.removeBackground'] },
  { name: 'View', items: ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.actual', '-', 'view.grid', 'view.snapping', 'view.panel', '-', 'view.palette'] },
  { name: 'Help', items: ['help.shortcuts', '-', 'help.about', 'app.update'] },
];
