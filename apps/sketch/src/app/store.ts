import type { Adjustment } from '../engine/adjust';
import { DEFAULT_HEIGHT, DEFAULT_WIDTH, PaintDocument, type Layer } from '../engine/document';
import { History } from '../engine/history';
import type { SketchObject } from '../engine/objects';
import type { Box, Point } from '../tools/box';
import type { Selection } from '../tools/selection';
import type { Guide } from '../tools/snap';
import type { LiveStroke } from '../tools/stroke';
import type { TextEdit } from '../tools/text';
import { Viewport } from '../view/viewport';
import { loadPref } from './prefs';
import { loadShapeColors } from './shapeColors';

export type ColorTargetId = 'primary' | 'secondary' | 'fill' | 'outline';

const savedShapeColors = loadShapeColors();

export type FileFormat = 'png' | 'jpeg' | 'webp' | 'bmp' | 'gif' | 'sktch';

export interface FileInfo {
  /** Full path on disk; null for a new picture, or in the browser build. */
  path: string | null;
  name: string;
  format: FileFormat | null;
}

export type ModalSpec =
  | { kind: 'unsaved'; resolve: (v: 'save' | 'discard' | 'cancel') => void }
  | { kind: 'about'; resolve: (v: null) => void }
  | { kind: 'keep-layers'; resolve: (v: 'sktch' | 'flatten' | 'cancel') => void }
  | { kind: 'save-as'; initial: FileFormat; resolve: (v: { format: FileFormat; quality: number } | null) => void }
  | { kind: 'resize'; resolve: (v: { width: number; height: number; pixelArt: boolean } | null) => void }
  | { kind: 'canvas-size'; resolve: (v: { width: number; height: number; ax: number; ay: number } | null) => void }
  | { kind: 'adjust'; adjust: 'brightness' | 'hue'; preview: (a: Adjustment | null) => void; resolve: (v: Adjustment | null) => void }
  | { kind: 'cutout-download'; resolve: (v: boolean) => void };

export type Overlay = 'palette' | 'shortcuts' | 'settings';

export class Signal {
  private listeners = new Set<() => void>();
  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Re-renders the interface. */
export const uiSignal = new Signal();
/** Fires on pointer moves, so only the status bar re-renders. */
export const cursorSignal = new Signal();
/** Fires when colour 1 or 2 changes, so text being typed can follow it. */
export const colorSignal = new Signal();
/** Fires when the shape and line fill or outline colour changes, so picked shapes and lines can follow it. */
export const shapeColorSignal = new Signal();
/** Fires when a new picture is made or opened. */
export const docSignal = new Signal();

/** Autosave of one tab (`recovery.ts`): its slot in the data folder and what was last written there. */
export interface TabAutosave {
  slot: string;
  timer: number;
  /** The history revision last written, or -1 for none. */
  written: number;
  running: Promise<void> | null;
  /** Set while the tab is closing, so a late autosave doesn't bring a deleted slot back. */
  stopped: boolean;
  /** What the slot's `.json` says now, so a change of tab order or of the tab showing rewrites only that (`recovery.ts`). */
  meta: string | null;
}

/**
 * One open picture (F14). A window holds a list of them, shown as tabs once there are two. `app.doc`,
 * `app.history`, `app.viewport` and the rest below are the current tab's, so everything else works on
 * whichever picture is showing.
 */
export interface Tab {
  /** Unique within the window, for the tab strip. */
  id: number;
  doc: PaintDocument;
  history: History;
  viewport: Viewport;
  file: FileInfo;
  docIsNew: boolean;
  quickCapture: boolean;
  flattenOk: boolean;
  lastQuality: number;
  lastPoint: { layerId: number; x: number; y: number } | null;
  crop: { box: Box; docW: number; docH: number } | null;
  auto: TabAutosave;
}

/** Called on every history change of any tab; `main.tsx` adds autosaving. */
export const tabHooks = {
  historyChanged: (_tab: Tab) => changed(),
};

let nextTabId = 1;

export function newSlotId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A tab holding a fresh New picture. */
export function createTab(): Tab {
  const tab: Tab = {
    id: nextTabId++,
    doc: new PaintDocument(DEFAULT_WIDTH, DEFAULT_HEIGHT),
    history: new History(),
    viewport: new Viewport(),
    file: { path: null, name: 'Untitled', format: null },
    docIsNew: true,
    quickCapture: false,
    flattenOk: false,
    lastQuality: 0.9,
    lastPoint: null,
    crop: null,
    auto: { slot: newSlotId(), timer: 0, written: -1, running: null, stopped: false, meta: null },
  };
  tab.history.onChange = () => tabHooks.historyChanged(tab);
  return tab;
}

/** The window's open pictures, in tab order, and which one is showing. */
export const tabs = {
  list: [createTab()],
  active: 0,
};

const cur = () => tabs.list[tabs.active];

export const app = {
  get doc() {
    return cur().doc;
  },
  set doc(v: PaintDocument) {
    cur().doc = v;
  },
  get history() {
    return cur().history;
  },
  get viewport() {
    return cur().viewport;
  },
  get file() {
    return cur().file;
  },
  set file(v: FileInfo) {
    cur().file = v;
  },
  /** True while the picture is a fresh New picture (pasting into it takes the image's size). */
  get docIsNew() {
    return cur().docIsNew;
  },
  set docIsNew(v: boolean) {
    cur().docIsNew = v;
  },
  /** A capture opened by clicking its notification and not saved since: closing it doesn't ask about saving. */
  get quickCapture() {
    return cur().quickCapture;
  },
  set quickCapture(v: boolean) {
    cur().quickCapture = v;
  },
  /** The user chose to flatten layers when saving to a flat format, so don't ask again. */
  get flattenOk() {
    return cur().flattenOk;
  },
  set flattenOk(v: boolean) {
    cur().flattenOk = v;
  },
  /** JPEG and WebP quality last chosen in Save As (0 to 1). */
  get lastQuality() {
    return cur().lastQuality;
  },
  set lastQuality(v: number) {
    cur().lastQuality = v;
  },
  /** The crop tool's box, and the picture size it was made for. */
  get crop() {
    return cur().crop;
  },
  set crop(v: { box: Box; docW: number; docH: number } | null) {
    cur().crop = v;
  },
  /** Where the last brush, pencil or eraser stroke ended, for Shift+click lines. */
  get lastPoint() {
    return cur().lastPoint;
  },
  set lastPoint(v: { layerId: number; x: number; y: number } | null) {
    cur().lastPoint = v;
  },
  /** The selected area, or a pasted picture that hasn't been placed yet. */
  selection: null as Selection | null,
  /** Text being typed. */
  textEdit: null as TextEdit | null,
  /** Shapes and lines picked for moving, restyling or lining up. They're always in one layer. */
  objectSel: null as { layer: Layer; ids: number[] } | null,
  /** A shape or line being drawn, shown on top until it's added. */
  draft: null as SketchObject | null,
  /** Smart guides shown while dragging, in picture pixels. */
  guides: [] as Guide[],
  /** Snap to other objects and the picture while dragging. Ctrl turns it off for one drag. */
  snapping: loadPref('snapping', true),
  /** A selection or text box being dragged out: a rectangle, or the freehand outline so far. */
  marquee: null as { rect?: { x: number; y: number; w: number; h: number }; points?: Point[] } | null,
  /**
   * An adjustment being tried in its dialog: the whole layer drawn through `filter`, or `part` (the
   * changed area) drawn over it at (x, y).
   */
  adjustPreview: null as { layer: Layer; filter: string | null; part: OffscreenCanvas | null; x: number; y: number } | null,
  /** A see-through brush stroke in progress, drawn over its layer until it ends. */
  liveStroke: null as LiveStroke | null,
  primary: '#000000',
  secondary: '#ffffff',
  /** The fill and outline of shapes, and the outline (line colour) of lines, kept apart from colours 1 and 2. */
  fillColor: savedShapeColors.fill,
  outlineColor: savedShapeColors.outline,
  recentColors: loadPref<string[]>('recentColors', []),
  /** Set while the colour popover's picker button waits for a press on the picture: the colour that press sets. */
  pickInto: null as ColorTargetId | null,
  showGrid: true,
  /** The side panel with layers and history. */
  showPanel: loadPref('showPanel', true),
  /** Which side panel sections are open. Layers starts closed, so people who don't use them never see them. */
  panelOpen: loadPref<Record<string, boolean>>('panelOpen', { layers: false, history: true }),
  /** Full-window overlays that aren't questions: the command palette, the shortcuts sheet and settings. */
  overlay: null as Overlay | null,
  /** A size being set with Alt + right-drag: where it started on screen, shown as a circle. */
  sizePreview: null as { x: number; y: number; size: number } | null,
  cursor: null as { x: number; y: number } | null,
  /** Canvas size shown while dragging a resize handle. */
  resizePreview: null as { w: number; h: number } | null,
  toast: null as { text: string; id: number; action?: ToastAction } | null,
  modal: null as ModalSpec | null,
  requestRender: () => {},
};

export function changed(): void {
  uiSignal.emit();
  app.requestRender();
}

export interface ToastAction {
  label: string;
  run: () => void;
}

let toastTimer = 0;
let toastId = 0;
/** A short message over the status bar, with an optional button. */
export function toast(text: string, ms = 2600, action?: ToastAction): void {
  app.toast = { text, id: ++toastId, action };
  uiSignal.emit();
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    app.toast = null;
    uiSignal.emit();
  }, ms);
}

export function openModal<T extends ModalSpec['kind']>(
  kind: T,
  extra: Omit<Extract<ModalSpec, { kind: T }>, 'kind' | 'resolve'> = {} as never,
): Promise<Parameters<Extract<ModalSpec, { kind: T }>['resolve']>[0]> {
  return new Promise((resolve) => {
    app.modal = {
      ...extra,
      kind,
      resolve: (v: unknown) => {
        app.modal = null;
        uiSignal.emit();
        resolve(v as never);
      },
    } as ModalSpec;
    uiSignal.emit();
  });
}
