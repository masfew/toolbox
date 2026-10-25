/**
 * Several pictures in one window (F14). Each is a `Tab` in `store.ts` with its own document, undo
 * history, view and autosave slot; `app` reads and writes the one showing. The tab strip
 * (`ui/TabStrip.tsx`) shows once there are two.
 */
import * as platform from '../platform';
import { commitText } from '../tools/text';
import { placeSelection } from '../tools/selection';
import { confirmLoseChanges } from './actions';
import { discard, letGo, placesChanged } from './recovery';
import { app, changed, createTab, docSignal, tabs, toast, type Tab } from './store';

export const currentTab = (): Tab => tabs.list[tabs.active];

/** Lets go of everything that belongs to the picture showing and isn't kept with it: text being typed, a selection, picked shapes. */
function leave(): void {
  commitText();
  placeSelection();
  app.objectSel = null;
  app.draft = null;
  app.guides = [];
  app.marquee = null;
  app.resizePreview = null;
  app.sizePreview = null;
}

/** The view's size now, from the canvas itself (the tab showing may not have seen the last change). */
function viewSize(fallback: Tab): { w: number; h: number } {
  const r = document.querySelector('canvas.view')?.getBoundingClientRect();
  return r && r.width > 0 ? { w: r.width, h: r.height } : { w: fallback.viewport.width, h: fallback.viewport.height };
}

/** Gives `to` the view's size, keeping its picture where it was relative to the middle if the window changed size meanwhile. */
function sizeView(to: Tab, from: Tab): void {
  const v = to.viewport;
  const { w, h } = viewSize(from);
  if (v.width === w && v.height === h) return;
  v.panX += (w - v.width) / 2;
  v.panY += (h - v.height) / 2;
  v.width = w;
  v.height = h;
}

/** Shows tab `index`. */
export function switchTo(index: number): void {
  if (index === tabs.active || index < 0 || index >= tabs.list.length) return;
  leave();
  sizeView(tabs.list[index], currentTab());
  tabs.active = index;
  placesChanged();
  docSignal.emit();
  changed();
}

/** Ctrl+Tab and Ctrl+Shift+Tab: the next or previous tab, round the ends. */
export function stepTab(dir: 1 | -1): void {
  const n = tabs.list.length;
  if (n > 1) switchTo((tabs.active + dir + n) % n);
}

/**
 * A new tab with a New picture, after the one showing, and shows it. The caller puts a picture in it
 * (`actions.setDocument` fits the view once it's there).
 */
export function addTab(): Tab {
  const tab = createTab();
  const size = viewSize(currentTab());
  tab.viewport.width = size.w;
  tab.viewport.height = size.h;
  leave();
  tabs.list.splice(tabs.active + 1, 0, tab);
  tabs.active += 1;
  orderChanged();
  docSignal.emit();
  changed();
  return tab;
}

/** Tab order and the tab showing are kept in each slot, so a reorder, a new tab or a close rewrites them. */
function orderChanged(): void {
  placesChanged();
}

/** Takes a tab out of the list, showing the one next to it. */
function remove(tab: Tab): void {
  const i = tabs.list.indexOf(tab);
  if (i < 0) return;
  const wasActive = i === tabs.active;
  if (wasActive) leave();
  tabs.list.splice(i, 1);
  if (i < tabs.active || (wasActive && tabs.active >= tabs.list.length)) tabs.active -= 1;
  if (wasActive) sizeView(currentTab(), tab);
  orderChanged();
  docSignal.emit();
  changed();
}

/**
 * Closes a tab, asking about unsaved changes as closing a window does (a capture opened from its
 * notification closes without asking, F9). The last tab closes the window, which asks the same way.
 */
export async function closeTab(index = tabs.active): Promise<void> {
  if (tabs.list.length <= 1) return platform.closeWindow();
  const tab = tabs.list[index];
  if (!tab) return;
  if (!tab.quickCapture && tab.history.dirty) {
    switchTo(index);
    if (!(await confirmLoseChanges())) return;
  }
  await discard(tab);
  remove(tab);
}

/** Asks about every tab with unsaved changes, showing each in turn. True when the window can close. */
export async function confirmCloseAll(): Promise<boolean> {
  for (let i = 0; i < tabs.list.length; i++) {
    const tab = tabs.list[i];
    if (tab.quickCapture || !tab.history.dirty) continue;
    switchTo(i);
    if (!(await confirmLoseChanges())) return false;
  }
  return true;
}

/** Every tab's slot goes: the window is closing. */
export async function discardAll(): Promise<void> {
  await Promise.all(tabs.list.map((t) => discard(t)));
}

/** Drags a tab to a new place in the strip. */
export function moveTab(from: number, to: number): void {
  const n = tabs.list.length;
  if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
  const showing = currentTab();
  const [tab] = tabs.list.splice(from, 1);
  tabs.list.splice(to, 0, tab);
  tabs.active = tabs.list.indexOf(showing);
  orderChanged();
  changed();
}

/**
 * A tab dragged out of the window opens in a window of its own. The new window reopens it from its
 * autosave slot, as after a restart, so its undo history stays behind.
 */
export async function tearOff(index: number): Promise<void> {
  const tab = tabs.list[index];
  if (!tab || tabs.list.length <= 1 || !platform.isTauri) return;
  if (index === tabs.active) leave();
  const slot = await letGo(tab);
  try {
    await platform.openWindow({ recover: slot });
  } catch (e) {
    tab.auto.stopped = false;
    toast(`Couldn't open a new window: ${e instanceof Error ? e.message : String(e)}`, 5000);
    return;
  }
  remove(tab);
}
