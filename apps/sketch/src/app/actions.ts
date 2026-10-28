import { checkSize, createLayer, ctxOf, DEFAULT_HEIGHT, DEFAULT_WIDTH, flatten, newCanvas, nextLayerName, PaintDocument } from '../engine/document';
import {
  addLayer,
  cropTo,
  flattenLayers,
  flipPicture,
  rasterizeLayer,
  rasterizeObjects,
  replaceWithImage,
  resizeCanvas,
  rotatePicture,
  scalePicture,
} from '../engine/commands';
import { BOARD_BACKGROUND, exportArea, flattenArea, isOpen, newBoard, objectsBounds, pictureArea } from '../engine/board';
import { CompositeCommand, type Command } from '../engine/history';
import { trimBounds } from '../engine/pixels';
import { boundsOf } from '../tools/box';
import {
  cancelSelection,
  deleteSelection,
  flipSelection,
  isTransformed,
  matrixOf,
  pasteSelection,
  placeSelection,
  rotateSelection,
  selectionImage,
} from '../tools/selection';
import { commitText } from '../tools/text';
import { copiedObjectsFor, deletePicked, pasteCopied, pickedImage, pickedObjects, rememberCopy } from '../tools/shapes';
import {
  decodeImage,
  encodeDocument,
  encodePng,
  formatFromName,
  FORMATS,
  isPictureName,
  OPEN_FILTERS,
  readDocument,
  withExtension,
} from '../io/formats';
import * as platform from '../platform';
import { pushRecent } from './color';
import { fitView, growBoard, growBoardForNext, growBoardForObjects, settleEdges } from './board';
import { blockedReason, layerPrefs } from './layers';
import { savePref } from './prefs';
import { app, changed, colorSignal, docSignal, openModal, tabs, toast, type FileFormat, type FileInfo, type Overlay } from './store';
import { addTab, closeTab, currentTab } from './tabs';
import { currentTool, selectTool } from './tools';
import { MAX_ZOOM } from '../view/viewport';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function updateTitle(): void {
  const mark = app.history.dirty ? '*' : '';
  platform.setTitle(`${app.file.name}${mark} - Sketch`);
}

function setDocument(doc: PaintDocument, file: typeof app.file, baseLabel: string, isNew: boolean): void {
  app.selection = null;
  app.textEdit = null;
  app.objectSel = null;
  app.draft = null;
  app.lastPoint = null;
  app.doc = doc;
  app.file = file;
  app.docIsNew = isNew;
  app.quickCapture = false;
  app.flattenOk = false;
  app.history.reset(baseLabel);
  // A whiteboard has no edges to crop.
  if (doc.board && currentTool().id === 'crop') selectTool('select-rect');
  fitView(1);
  docSignal.emit();
  changed();
}

/** Finishes anything in progress: text being typed is saved, and the selection or a pasted picture is placed. */
export function settle(): void {
  commitText();
  placeSelection();
}

/** Asks about unsaved changes. Resolves true when it's fine to throw the current picture away. */
export async function confirmLoseChanges(): Promise<boolean> {
  settle();
  if (!app.history.dirty) return true;
  const choice = await openModal('unsaved');
  if (choice === 'cancel') return false;
  if (choice === 'save') return save();
  return true;
}

/** True while the window holds a New picture nobody has touched, so a file or paste can go in it. */
export function isUntouched(): boolean {
  return app.docIsNew && app.history.position === 0 && !app.history.dirty && !app.selection && !app.textEdit;
}

/**
 * Gets the window ready for a new or opened picture (F14): an untouched New picture is used as it is,
 * otherwise a new tab opens after the one showing.
 */
export function intoNewTab(): void {
  settle();
  if (!isUntouched()) addTab();
}

/** Ctrl+N: a New picture in a tab of its own. */
export function newPicture(): void {
  if (isUntouched()) return;
  intoNewTab();
  setDocument(new PaintDocument(DEFAULT_WIDTH, DEFAULT_HEIGHT), { path: null, name: 'Untitled', format: null }, 'New picture', true);
}

/**
 * An endless board for diagrams and notes, in a tab of its own. It's never swapped for a pasted or
 * opened picture the way an untouched New picture is.
 */
export function newWhiteboard(): void {
  intoNewTab();
  setDocument(newBoard(), { path: null, name: 'Untitled', format: null }, 'New whiteboard', false);
}

/** Opens a picture's bytes: in a new tab, or (`here`) in place of the picture showing, which the caller has asked about. */
export async function openFromBytes(bytes: Uint8Array, name: string, path: string | null, here = false): Promise<void> {
  try {
    const doc = await readDocument(bytes);
    if (!here) intoNewTab();
    setDocument(doc, { path, name, format: formatFromName(name) }, `Opened ${name}`, false);
    if (path) platform.addRecent(path);
  } catch (e) {
    toast(errorText(e), 5000);
  }
}

/** Ctrl+O: the picture opens in a new tab. */
export async function openFile(): Promise<void> {
  settle();
  try {
    const picked = await platform.pickFileToOpen(OPEN_FILTERS);
    if (picked) await openFromBytes(picked.bytes, picked.name, picked.path);
  } catch (e) {
    toast(errorText(e), 5000);
  }
}

/** Puts an autosaved picture back: its `.sktch` bytes, or else the file it had open. False if there's nothing to show. */
export async function openRecovered(bytes: Uint8Array | null, meta: { file: FileInfo; dirty: boolean; docIsNew: boolean; blank?: boolean }): Promise<boolean> {
  if (bytes) {
    setDocument(await readDocument(bytes), meta.file, 'Brought back from autosave', meta.docIsNew);
    if (meta.dirty) app.history.markUnsaved();
    return true;
  }
  // An empty window kept by a restart: this window, as it is, takes its place.
  if (!meta.file.path) return !!meta.blank;
  let fileBytes: Uint8Array;
  try {
    fileBytes = await platform.readPath(meta.file.path);
  } catch {
    // The file was moved or deleted since; there's nothing to reopen.
    return false;
  }
  await openFromBytes(fileBytes, meta.file.name, meta.file.path, true);
  return true;
}

/** Opens a file from disk: in a new tab, or (`here`) in place of the picture showing. */
export async function openPath(path: string, here = false): Promise<void> {
  try {
    await openFromBytes(await platform.readPath(path), platform.baseName(path), path, here);
  } catch (e) {
    toast(`Couldn't open ${platform.baseName(path)}: ${errorText(e)}`, 5000);
  }
}

// ---------- Saving ----------

async function writeAs(format: FileFormat, quality: number, path: string | null, name: string): Promise<boolean> {
  try {
    const bytes = await encodeDocument(app.doc, format, quality);
    if (path) {
      await platform.writePath(path, bytes);
      platform.addRecent(path);
    } else platform.download(name, bytes);
    app.file = { path, name, format };
    app.quickCapture = false;
    app.lastQuality = quality;
    app.history.markSaved();
    toast(`Saved ${name}`);
    return true;
  } catch (e) {
    toast(`Couldn't save: ${errorText(e)}`, 5000);
    return false;
  }
}

/** Whether a flat picture file would lose something: layers, editable shapes and text, or a whiteboard. */
export function needsSketchFile(doc: PaintDocument): boolean {
  return doc.layers.length > 1 || doc.board || doc.layers.some((l) => l.objects.length > 0);
}

/** Ctrl+S: saves to the open file in its format, or asks where when there isn't one. */
export async function save(): Promise<boolean> {
  settle();
  const f = app.file;
  if (!f.path || !f.format || !FORMATS[f.format].writable) return saveAs();
  if (f.format !== 'sktch' && needsSketchFile(app.doc) && !app.flattenOk) {
    const choice = await openModal('keep-layers');
    if (choice === 'cancel') return false;
    if (choice === 'sktch') return saveAs('sktch');
    app.flattenOk = true;
  }
  return writeAs(f.format, app.lastQuality, f.path, f.name);
}

/** Ctrl+Shift+S: picks a format and quality, then where to save. */
export async function saveAs(initial?: FileFormat): Promise<boolean> {
  settle();
  const current = app.file.format && FORMATS[app.file.format].writable ? app.file.format : null;
  const start = initial ?? current ?? (needsSketchFile(app.doc) ? 'sktch' : 'png');
  const picked = await openModal('save-as', { initial: start });
  if (!picked) return false;
  const name = withExtension(app.file.name === 'Untitled' ? 'Untitled' : app.file.name, picked.format);
  const target = await platform.pickSavePath(name, [{ name: FORMATS[picked.format].label, extensions: [FORMATS[picked.format].ext] }]);
  if (!target) return false;
  if (target === 'download') return writeAs(picked.format, picked.quality, null, name);
  return writeAs(picked.format, picked.quality, target, platform.baseName(target));
}

// ---------- Paste ----------

/**
 * Pastes an image as a floating selection on the current layer (or a new layer, when Paste onto New Layer
 * is on). `at` is a view point to centre it on (a drop); otherwise it goes at the top-left of the part of
 * the picture on screen, like Paint. A locked or hidden current layer refuses it, saying why.
 */
export async function pasteImage(bitmap: ImageBitmap | OffscreenCanvas, at?: { x: number; y: number }): Promise<void> {
  settle();
  app.objectSel = null;
  const doc = app.doc;
  const tooBig = checkSize(Math.max(doc.width, bitmap.width), Math.max(doc.height, bitmap.height));
  if (tooBig) return toast(tooBig, 5000);

  if (app.docIsNew && app.history.position === 0 && !isOpen(doc)) {
    // Pasting into a fresh picture: the picture becomes the image.
    app.history.record(replaceWithImage(doc, bitmap, 'Paste'));
    app.viewport.fit(doc.width, doc.height, 1);
    changed();
    return;
  }
  const blocked = layerPrefs.pasteNewLayer ? null : blockedReason(doc.activeLayer);
  if (blocked) return toast(blocked, 4000);
  if (isOpen(doc)) return pasteOnBoard(bitmap, at);

  let pending: Command | null = null;
  if (bitmap.width > doc.width || bitmap.height > doc.height) {
    pending = resizeCanvas(doc, Math.max(doc.width, bitmap.width), Math.max(doc.height, bitmap.height), 'Resize canvas');
  }
  pending = withNewLayer(pending);
  const image = newCanvas(bitmap.width, bitmap.height);
  ctxOf(image).drawImage(bitmap, 0, 0);
  let x = 0;
  let y = 0;
  if (at) {
    // Centred on the drop point, kept inside the picture.
    const p = app.viewport.toDoc(at.x, at.y);
    x = Math.round(Math.min(Math.max(0, p.x - image.width / 2), doc.width - image.width));
    y = Math.round(Math.min(Math.max(0, p.y - image.height / 2), doc.height - image.height));
  } else if (!pending) {
    // At the top-left of the part of the picture on screen, like Paint.
    const tl = app.viewport.toDoc(0, 0);
    x = Math.min(Math.max(0, Math.floor(tl.x)), doc.width - image.width);
    y = Math.min(Math.max(0, Math.floor(tl.y)), doc.height - image.height);
  }
  pasteSelection(image, x, y, pending);
}

/** With Paste onto New Layer on, adds the layer the paste goes on, as part of the paste's pending step. */
function withNewLayer(pending: Command | null): Command | null {
  if (!layerPrefs.pasteNewLayer) return pending;
  const doc = app.doc;
  const add = addLayer(doc, createLayer(nextLayerName(doc), doc.width, doc.height), 'Paste');
  return pending ? new CompositeCommand('Paste', [pending, add]) : add;
}

/**
 * A paste on a whiteboard or a capture lands in the middle of the view (or centred on `at`, a view point),
 * and the canvas grows to hold it.
 */
function pasteOnBoard(bitmap: ImageBitmap | OffscreenCanvas, at?: { x: number; y: number }): void {
  const v = app.viewport;
  const centre = () => (at ? v.toDoc(at.x, at.y) : v.toDoc(v.width / 2, v.height / 2));
  const c = centre();
  const pending = withNewLayer(growBoard({ x: c.x - bitmap.width / 2, y: c.y - bitmap.height / 2, w: bitmap.width, h: bitmap.height }));
  const image = newCanvas(bitmap.width, bitmap.height);
  ctxOf(image).drawImage(bitmap, 0, 0);
  // The view moved if the board grew up or left, so find the point again.
  const m = centre();
  pasteSelection(image, Math.round(m.x - image.width / 2), Math.round(m.y - image.height / 2), pending);
}

/** Colour 1 for marking up a screen capture: the palette's red. */
export const CAPTURE_COLOR = '#ed1c24';

/**
 * A screen capture opens on a canvas of its own size, with the brush in red ready for marking it up.
 * Its edges are open, as in the Snipping Tool: arrows, writing and circles can run past it, and copies
 * grow to hold them. `quick`: opened by clicking its notification, so it closes without asking until
 * it's saved.
 */
export async function openCapture(id: number, quick = false): Promise<void> {
  const image = await platform.captureTake(id);
  if (!image) return;
  settle();
  const tooBig = checkSize(image.width, image.height);
  if (app.docIsNew && app.history.position === 0 && !tooBig) {
    const doc = app.doc;
    app.history.record(replaceWithImage(doc, image, 'Paste', true));
    app.viewport.fit(doc.width, doc.height, 1);
    changed();
  } else await pasteImage(image);
  app.quickCapture = quick;
  toast(`Captured ${image.width} × ${image.height}. It's on the clipboard too.`);
  image.close();
  selectTool('brush');
  setColor('primary', CAPTURE_COLOR);
}

export function captureScreen(): void {
  settle();
  void platform.captureScreen().catch((e) => toast(`Couldn't capture the screen: ${errorText(e)}`, 5000));
}

async function pasteBytes(bytes: Uint8Array): Promise<void> {
  const bitmap = await decodeImage(bytes);
  await pasteImage(bitmap);
  bitmap.close();
}

function imageUrlFrom(text: string, html: string): string | null {
  const src = /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
  if (src && /^(https?:|data:image\/)/i.test(src)) return src.replace(/&amp;/g, '&');
  const t = text.trim();
  if (/^data:image\//i.test(t) || /^https?:\/\/\S+$/i.test(t)) return t;
  return null;
}

/** Pastes shapes copied in Sketch, if they're still what's on the clipboard. */
async function pasteShapes(): Promise<boolean> {
  if (!copiedObjectsFor(await platform.clipboardSeq())) return false;
  settle();
  pasteCopied();
  return true;
}

export async function pasteFromEvent(e: ClipboardEvent): Promise<void> {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  const data = e.clipboardData;
  if (!data) return;
  e.preventDefault();
  // The browser empties clipboardData once this handler first waits, so read everything now.
  const text = data.getData('text/plain');
  const html = data.getData('text/html');
  const images = [...data.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
  const files = [...data.files].filter((f) => isPictureName(f.name));
  try {
    if (await pasteShapes()) return;
    for (const file of [...images, ...files]) {
      if (file) return await pasteBytes(new Uint8Array(await file.arrayBuffer()));
    }
    const paths = (await platform.clipboardFilePaths()).filter(isPictureName);
    if (paths.length) return await pasteBytes(await platform.readPath(paths[0]));
    await pasteLink(text, html);
  } catch (err) {
    toast(`Couldn't paste: ${errorText(err)}`, 5000);
  }
}

/** Paste from the menu or the command palette, where there's no paste event. */
export async function pasteFromClipboard(): Promise<void> {
  try {
    if (await pasteShapes()) return;
    // Files copied in Explorer come first, in the same order as the paste event.
    const paths = (await platform.clipboardFilePaths()).filter(isPictureName);
    if (paths.length) return await pasteBytes(await platform.readPath(paths[0]));
    const clip = await platform.readClipboard();
    if (clip.image) {
      await pasteImage(clip.image);
      clip.image.close();
      return;
    }
    await pasteLink(clip.text, clip.html);
  } catch (err) {
    toast(`Couldn't paste: ${errorText(err)}`, 5000);
  }
}

async function pasteLink(text: string, html: string): Promise<void> {
  const url = imageUrlFrom(text, html);
  if (url) {
    const bytes = url.startsWith('data:') ? new Uint8Array(await (await fetch(url)).arrayBuffer()) : await platform.fetchUrl(url);
    return await pasteBytes(bytes);
  }
  toast('Nothing to paste. The clipboard has no picture.');
}

// ---------- Copy ----------

/**
 * Ctrl+C copies the selection, or the picked shapes, or the whole picture when nothing is selected.
 * Ctrl+Shift+C (and the Copy button) always copies the whole picture. True once something was copied.
 */
export async function copy(wholePicture: boolean): Promise<boolean> {
  commitText();
  try {
    let source: OffscreenCanvas;
    let what: string;
    const sel = app.selection;
    const picked = !wholePicture && !sel ? pickedObjects() : null;
    if (picked) {
      // The shapes stay editable when pasted back into Sketch; other apps get their picture.
      source = pickedImage()!;
      await platform.copyPng(await encodePng(source));
      rememberCopy(await platform.clipboardSeq());
      const n = picked.objects.length;
      toast(n === 1 ? 'Copied the shape' : `Copied ${n} shapes`);
      return true;
    }
    if (sel && !wholePicture) {
      source = selectionImage(sel);
      what = sel.pasted ? 'pasted image' : 'selection';
    } else {
      // A whiteboard copies what's on it, on its white, as it exports. A capture copies itself and
      // everything drawn round it, see-through past its edges.
      const doc = app.doc;
      const extra = sel?.image ? boundsOf(sel) : null;
      const area = doc.board ? exportArea(doc, extra) : doc.edges ? pictureArea(doc, extra) : null;
      if (doc.board && !area) {
        toast("The whiteboard is empty, so there's nothing to copy yet.");
        return false;
      }
      source = area ? flattenArea(doc, area, doc.board ? BOARD_BACKGROUND : null) : flatten(doc);
      if (sel?.image) {
        const ctx = ctxOf(source);
        ctx.setTransform(new DOMMatrix().translateSelf(-(area?.x ?? 0), -(area?.y ?? 0)).multiplySelf(matrixOf(sel)));
        ctx.imageSmoothingEnabled = isTransformed(sel);
        ctx.drawImage(sel.image, 0, 0);
      }
      what = doc.board ? 'whiteboard' : 'picture';
    }
    await platform.copyPng(await encodePng(source));
    toast(`Copied the ${what} (${source.width} × ${source.height})`);
    return true;
  } catch (e) {
    toast(`Couldn't copy: ${errorText(e)}`, 5000);
    return false;
  }
}

// ---------- Drag and drop ----------

/**
 * A drop on the picture pastes the image there, as a floating selection on the current layer, as Ctrl+V
 * does; a drop beside it opens the file.
 */
export async function dropFiles(items: platform.DroppedItem[], viewX: number, viewY: number): Promise<void> {
  const item = items.find((i) => isPictureName(i.name));
  if (!item) return toast('Drop a picture file (PNG, JPEG, WebP, BMP, GIF or .sktch).');
  const p = app.viewport.toDoc(viewX, viewY);
  // A whiteboard has no edge, so a drop anywhere on it lands on it.
  const onPicture = app.doc.board || (p.x >= 0 && p.y >= 0 && p.x < app.doc.width && p.y < app.doc.height);
  try {
    if (!onPicture || formatFromName(item.name) === 'sktch') return await openFromBytes(await item.read(), item.name, item.path);
    const bitmap = await decodeImage(await item.read());
    await pasteImage(bitmap, { x: viewX, y: viewY });
    bitmap.close();
  } catch (e) {
    toast(errorText(e), 5000);
  }
}

// ---------- Undo and view ----------

/** Ctrl+Z: a selection or pasted picture not yet placed is cancelled first; text being typed is saved, then undone. */
export function undo(): void {
  if (cancelSelection()) return;
  commitText();
  app.history.undo();
}

export function redo(): void {
  settle();
  app.history.redo();
}

export function jumpTo(position: number): void {
  cancelSelection();
  commitText();
  app.history.jumpTo(position);
}

// ---------- Selection and whole-picture changes ----------

/**
 * Ctrl+X: copies the selection or the picked shapes, then clears or deletes them. On a screen capture
 * with neither, it copies the whole capture and closes its tab (the window, when it's the last one),
 * so marking up a capture ends in one key. Closing asks about unsaved changes unless it's a quick capture.
 */
export async function cut(): Promise<void> {
  if (app.selection) {
    await copy(false);
    deleteSelection();
  } else if (pickedObjects()) {
    await copy(false);
    deletePicked();
  } else if (app.doc.edges) {
    const tab = currentTab();
    if (await copy(true)) await closeTab(tabs.list.indexOf(tab));
  }
}

// ---------- Rasterize and flatten ----------

/** Draws the current layer's shapes and text into its pixels, so painting can go over them. */
export function rasterizeCurrentLayer(): void {
  settle();
  const doc = app.doc;
  const layer = doc.activeLayer;
  if (!layer.objects.length) return toast(`${layer.name} has no shapes or text to rasterize.`);
  const why = blockedReason(layer);
  if (why) return toast(why, 4000);
  if (app.objectSel?.layer === layer) app.objectSel = null;
  // Shapes and text off a whiteboard's or capture's canvas would be cut off.
  growBoardForObjects(layer.objects);
  const cmd = rasterizeLayer(doc, doc.active);
  if (!cmd) return;
  app.history.record(cmd);
  toast('The shapes and text are pixels now. Undo turns them back into shapes.');
  changed();
}

/** Draws the picked shapes into the pixels of their layer. */
export function rasterizePicked(): void {
  const picked = pickedObjects();
  if (!picked) return;
  const n = picked.objects.length;
  growBoardForObjects(picked.objects);
  const cmd = rasterizeObjects(app.doc, picked.layer, picked.objects.map((o) => o.id), n === 1 ? 'Rasterize shape' : 'Rasterize shapes');
  if (!cmd) return;
  app.objectSel = null;
  app.history.record(cmd);
  changed();
}

/** Merges every layer that's showing into one layer of pixels. */
export function flattenImage(): void {
  settle();
  const layers = app.doc.layers;
  if (layers.length === 1 && !layers[0].objects.length && layers[0].visible) return toast('The picture is already one layer.');
  // Shapes and text off a whiteboard's or capture's canvas would be cut off.
  if (isOpen(app.doc)) growBoardForNext(objectsBounds(app.doc.layers.flatMap((l) => (l.visible ? l.objects : []))));
  app.history.record(flattenLayers(app.doc));
  changed();
}

/** Keeps the zoom where it was, unless the picture no longer fits; then fits it. */
function afterResize(): void {
  fitView(app.viewport.zoom);
  changed();
}

/** Ctrl+Shift+X: crops the picture to the selection's box. */
export function cropToSelection(): void {
  const sel = app.selection;
  if (!sel) return;
  const b = boundsOf(sel);
  settle();
  const x0 = Math.max(0, b.x);
  const y0 = Math.max(0, b.y);
  const x1 = Math.min(app.doc.width, b.x + b.w);
  const y1 = Math.min(app.doc.height, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return;
  app.history.record(cropTo(app.doc, x0, y0, x1 - x0, y1 - y0, 'Crop to selection'));
  app.docIsNew = false;
  afterResize();
}

/**
 * Records a change made in the picture's own size, after the capture's shrinking to what's drawn
 * (`settleEdges`) when there was one, as one step.
 */
function recordWithSettled(settled: Command | null, cmd: Command): void {
  app.history.record(settled ? new CompositeCommand(cmd.label, [settled, cmd]) : cmd);
}

export async function resizePicture(): Promise<void> {
  settle();
  // A capture drawn round shrinks to what's drawn first, so the dialog shows the size a copy has.
  const settled = settleEdges();
  const r = await openModal('resize');
  if (!r || (r.width === app.doc.width && r.height === app.doc.height)) {
    settled?.revert();
    return changed();
  }
  recordWithSettled(settled, scalePicture(app.doc, r.width, r.height, r.pixelArt));
  app.docIsNew = false;
  afterResize();
}

export async function canvasSize(): Promise<void> {
  settle();
  const settled = settleEdges();
  const r = await openModal('canvas-size');
  if (!r || (r.width === app.doc.width && r.height === app.doc.height)) {
    settled?.revert();
    return changed();
  }
  const dx = Math.round((r.width - app.doc.width) * r.ax);
  const dy = Math.round((r.height - app.doc.height) * r.ay);
  recordWithSettled(settled, resizeCanvas(app.doc, r.width, r.height, 'Canvas size', dx, dy));
  app.docIsNew = false;
  afterResize();
}

/** Crops away a border that's empty or one flat colour. */
export function trimToContent(): void {
  settle();
  const doc = app.doc;
  const data = ctxOf(flatten(doc)).getImageData(0, 0, doc.width, doc.height).data;
  const b = trimBounds(data, doc.width, doc.height);
  if (!b) return toast('The picture is all one colour, so there is nothing to trim to.');
  if (b.w === doc.width && b.h === doc.height) return toast('There is no empty border to trim.');
  app.history.record(cropTo(doc, b.x, b.y, b.w, b.h, 'Trim to content'));
  app.docIsNew = false;
  toast(`Trimmed to ${b.w} × ${b.h}`);
  afterResize();
}

/** Turns the selection, or the whole picture when nothing is selected. */
export function rotate(dir: 1 | -1): void {
  if (app.selection) return rotateSelection(dir);
  commitText();
  app.history.record(rotatePicture(app.doc, dir));
  afterResize();
}

/** Flips the selection, or the whole picture when nothing is selected. */
export function flip(axis: 'h' | 'v'): void {
  if (app.selection) return flipSelection(axis);
  commitText();
  app.history.record(flipPicture(app.doc, axis));
  changed();
}

export function zoomStep(dir: 1 | -1): void {
  app.viewport.step(dir);
  changed();
}

/** Ctrl+0: fits the picture in the window, or zooms to fit everything on a whiteboard. */
export function zoomFit(): void {
  fitView(app.doc.board ? 1 : MAX_ZOOM);
  changed();
}

export function zoomActual(): void {
  const v = app.viewport;
  v.setZoomAt(1, v.width / 2, v.height / 2);
  changed();
}

export function toggleGrid(): void {
  app.showGrid = !app.showGrid;
  changed();
}

export function toggleSnapping(): void {
  app.snapping = !app.snapping;
  savePref('snapping', app.snapping);
  changed();
}

export function togglePanel(): void {
  app.showPanel = !app.showPanel;
  savePref('showPanel', app.showPanel);
  changed();
}

export function setPanelSection(id: string, open: boolean): void {
  app.panelOpen = { ...app.panelOpen, [id]: open };
  if (open) app.showPanel = true;
  savePref('panelOpen', app.panelOpen);
  savePref('showPanel', app.showPanel);
  changed();
}

/** Opens the palette, the shortcuts sheet or settings; the same call again closes it. */
export function toggleOverlay(which: Overlay): void {
  app.overlay = app.overlay === which ? null : which;
  changed();
}

// ---------- Colours ----------

export function setColor(which: 'primary' | 'secondary', color: string): void {
  app[which] = color;
  colorSignal.emit();
  changed();
}

/** Remembers a colour in the recent list (when the colour picker closes on a new colour). */
export function rememberColor(color: string): void {
  app.recentColors = pushRecent(app.recentColors, color);
  savePref('recentColors', app.recentColors);
  changed();
}

export function swapColors(): void {
  [app.primary, app.secondary] = [app.secondary, app.primary];
  colorSignal.emit();
  changed();
}
