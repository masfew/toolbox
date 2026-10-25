import { deleteLayer, LayerPropsCommand, mergeDown, moveLayer, setLayerProp, addLayer, type LayerProps } from '../engine/commands';
import { createLayer, nextLayerName, type Layer } from '../engine/document';
import { settle } from './actions';
import { growBoardForObjects } from './board';
import { loadPref, savePref } from './prefs';
import { app, changed, toast } from './store';

/**
 * The layers panel's actions (step 5.1): add, delete, reorder, rename, hide, lock, opacity and merge down.
 * Changing which layer is current isn't a history step; everything else is.
 */

/** Paste onto a new layer instead of the current one. Off unless the user turns it on. */
export const layerPrefs = { pasteNewLayer: loadPref('pasteNewLayer', false) };

export function togglePasteNewLayer(): void {
  layerPrefs.pasteNewLayer = !layerPrefs.pasteNewLayer;
  savePref('pasteNewLayer', layerPrefs.pasteNewLayer);
  changed();
}

/** Why a layer can't be painted or changed now, or null when it can. */
export function blockedReason(layer: Layer): string | null {
  if (layer.locked) return `${layer.name} is locked. Unlock it in the Layers panel to change it.`;
  if (!layer.visible) return `${layer.name} is hidden. Show it in the Layers panel to change it.`;
  return null;
}

/** For pixel tools: says why the layer they'd paint on can't be changed, and returns true, or returns false. */
export function paintBlocked(): boolean {
  const why = blockedReason(app.doc.paintLayer);
  if (why) toast(why, 4000);
  return !!why;
}

export function selectLayer(index: number): void {
  if (index === app.doc.active || index < 0 || index >= app.doc.layers.length) return;
  settle();
  app.doc.active = index;
  changed();
}

export function newLayer(): void {
  settle();
  const doc = app.doc;
  app.history.record(addLayer(doc, createLayer(nextLayerName(doc), doc.width, doc.height), 'New layer'));
  if (!app.panelOpen.layers) showLayers();
  changed();
}

function showLayers(): void {
  app.panelOpen = { ...app.panelOpen, layers: true };
  app.showPanel = true;
  savePref('panelOpen', app.panelOpen);
  savePref('showPanel', app.showPanel);
}

/** A picture always keeps at least one pixel layer, for the pixel tools to paint on. */
export function canDeleteLayer(index = app.doc.active): boolean {
  const layers = app.doc.layers;
  return layers.length > 1 && (layers[index].kind === 'objects' || layers.some((l, i) => i !== index && l.kind === 'pixel'));
}

export function removeLayer(index = app.doc.active): void {
  settle();
  if (!canDeleteLayer(index)) {
    toast(app.doc.layers.length === 1 ? 'A picture needs at least one layer.' : 'A picture needs at least one pixel layer to paint on.');
    return;
  }
  if (app.objectSel?.layer === app.doc.layers[index]) app.objectSel = null;
  app.history.record(deleteLayer(app.doc, index));
  changed();
}

/** Moves a layer to another place in the stack; 0 is the bottom. */
export function moveLayerTo(from: number, to: number): void {
  const n = app.doc.layers.length;
  to = Math.max(0, Math.min(n - 1, to));
  if (from === to) return;
  settle();
  app.history.record(moveLayer(app.doc, from, to));
  changed();
}

export function moveCurrentLayer(dir: 1 | -1): void {
  moveLayerTo(app.doc.active, app.doc.active + dir);
}

/** Why the current layer can't be merged down, or null when it can. */
export function mergeDownBlocked(index = app.doc.active): string | null {
  if (index === 0) return 'The bottom layer has nothing under it to merge with.';
  const upper = app.doc.layers[index];
  const lower = app.doc.layers[index - 1];
  return blockedReason(upper) ?? blockedReason(lower);
}

export function mergeCurrentDown(): void {
  settle();
  const why = mergeDownBlocked();
  if (why) return toast(why, 4000);
  const doc = app.doc;
  if (app.objectSel && (app.objectSel.layer === doc.activeLayer || app.objectSel.layer === doc.layers[doc.active - 1])) app.objectSel = null;
  // Shapes and text off a whiteboard's canvas would be cut off if they become pixels.
  growBoardForObjects([doc.activeLayer, doc.layers[doc.active - 1]].flatMap((l) => (l.kind === 'objects' ? l.objects : [])));
  app.history.record(mergeDown(doc, doc.active));
  changed();
}

let joinable: { key: string; cmd: LayerPropsCommand; at: number } | null = null;

/**
 * Changes a layer's name, visibility, lock or opacity as a history step. A run of opacity changes to
 * the same layer (a slider drag) within a second and a half is one step.
 */
export function setLayer<K extends keyof LayerProps>(layer: Layer, key: K, value: LayerProps[K]): void {
  if (key === 'locked' || key === 'visible') settle();
  const join = key === 'opacity' ? `${layer.id}:opacity` : null;
  const now = performance.now();
  const last = joinable;
  if (join && last?.key === join && app.history.top === last.cmd && app.history.dirty && now - last.at < 1500) {
    Object.assign(layer, { [key]: value });
    last.cmd.after = { ...last.cmd.after, [key]: value };
    last.at = now;
    changed();
    return;
  }
  const labels: Record<keyof LayerProps, string> = {
    name: 'Rename layer',
    visible: value ? 'Show layer' : 'Hide layer',
    locked: value ? 'Lock layer' : 'Unlock layer',
    opacity: 'Layer opacity',
  };
  const cmd = setLayerProp(layer, key, value, labels[key]);
  if (!cmd) return;
  // Picked shapes on a layer that's now hidden or locked are let go.
  if ((key === 'visible' || key === 'locked') && app.objectSel?.layer === layer && (!layer.visible || layer.locked)) app.objectSel = null;
  app.history.record(cmd);
  joinable = join ? { key: join, cmd, at: now } : null;
}
