/**
 * Autosave and recovery. Each tab keeps a slot in the data folder (see `src-tauri/src/recovery.rs`)
 * saying what it has open, plus the picture as `.sktch` while it has unsaved changes. A few seconds
 * after each change the slot is rewritten. Slots left behind by a crash or by an update are reopened
 * when Sketch next starts, each window's tabs together again (F14).
 */
import { encodeDocument } from '../io/formats';
import * as platform from '../platform';
import { app, newSlotId, tabs, toast, type FileInfo, type Tab } from './store';

interface SlotMeta {
  file: FileInfo;
  dirty: boolean;
  docIsNew: boolean;
  savedAt: string;
  /** A window with nothing in it, kept by a restart into a new version so the window comes back too. */
  blank?: boolean;
  /** The window the tab was in (an id made when the window opened), so its tabs come back together. Missing before F14. */
  group?: string;
  /** The tab's place in its window. */
  order?: number;
  /** The tab that was showing. */
  active?: boolean;
}

/** How long after a change the autosave runs. */
const DELAY_MS = 3000;

/** This window, in its tabs' slots. */
const group = newSlotId().replace(/^s-/, 'g-');
/** Set while a hidden window waits for its capture's notification to be clicked (F12). */
let held = false;

const current = () => tabs.list[tabs.active];

/** Called on every history change and new picture: saves the tab a few seconds later. */
export function autosaveSoon(tab: Tab = current()): void {
  const a = tab.auto;
  if (!platform.isTauri || a.stopped || held || a.timer) return;
  a.timer = window.setTimeout(() => {
    a.timer = 0;
    // Not in the middle of a stroke or a drag: try again in a moment.
    if (tab === current() && (app.liveStroke || app.marquee || app.draft)) return autosaveSoon(tab);
    void flush(tab);
  }, DELAY_MS);
}

/** Holds autosaves back (`on`), or lets them go again and saves what was held. */
export function holdAutosave(on: boolean): void {
  held = on;
  if (!on) for (const tab of tabs.list) autosaveSoon(tab);
}

async function write(tab: Tab, keepBlank: boolean): Promise<void> {
  const a = tab.auto;
  const revision = tab.history.revision;
  const dirty = tab.history.dirty;
  const blank = !dirty && !tab.file.path;
  const place = { group, order: tabs.list.indexOf(tab), active: tab === current() };
  if (revision === a.written && !(keepBlank && blank)) return;
  if (blank && keepBlank) {
    const meta: SlotMeta = { file: tab.file, dirty, docIsNew: tab.docIsNew, savedAt: new Date().toISOString(), blank: true, ...place };
    a.meta = JSON.stringify(meta);
    await platform.recoveryWrite(a.slot, a.meta, new Uint8Array(0));
  } else if (blank) {
    // A clean picture with no file (a blank New picture) has nothing worth keeping.
    a.meta = null;
    await platform.recoveryDelete(a.slot);
    await platform.recoveryClaim(a.slot);
  } else {
    const meta: SlotMeta = { file: tab.file, dirty, docIsNew: tab.docIsNew, savedAt: new Date().toISOString(), ...place };
    const picture = dirty ? await encodeDocument(tab.doc, 'sktch') : new Uint8Array(0);
    a.meta = JSON.stringify(meta);
    await platform.recoveryWrite(a.slot, a.meta, picture);
  }
  a.written = revision;
}

let placesTimer = 0;

/**
 * Tabs were reordered, closed or switched: a moment later each slot's `.json` is rewritten with its
 * tab's place and whether it's showing, without saving the picture again, so a crash brings the
 * window back as it was.
 */
export function placesChanged(): void {
  clearTimeout(placesTimer);
  placesTimer = window.setTimeout(() => {
    for (const tab of tabs.list) {
      const a = tab.auto;
      if (!a.meta || a.stopped || a.running) continue;
      const meta = { ...(JSON.parse(a.meta) as SlotMeta), group, order: tabs.list.indexOf(tab), active: tab === current() };
      const text = JSON.stringify(meta);
      if (text === a.meta) continue;
      a.meta = text;
      void platform.recoveryMeta(a.slot, text).catch((e) => console.warn('Autosave failed', e));
    }
  }, 500);
}

/** The slot of the tab showing, which a restart into a new version hands to the new Sketch to place the window by. */
export function slotId(): string {
  return current().auto.slot;
}

/** Saves a tab's state now. `keepBlank` (before a restart into a new version, or moving the tab to a window of its own) keeps even an empty tab's slot, so it comes back. */
export async function flush(tab: Tab = current(), keepBlank = false): Promise<void> {
  const a = tab.auto;
  clearTimeout(a.timer);
  a.timer = 0;
  if (!platform.isTauri) return;
  // One write at a time; a change during a write gets its own write after it.
  while (a.running) await a.running;
  a.running = write(tab, keepBlank)
    .catch((e) => console.warn('Autosave failed', e))
    .finally(() => (a.running = null));
  await a.running;
}

/** Saves every tab now. Tab order and which one shows are in each slot, so this writes them all. */
export async function flushAll(keepBlank = false): Promise<void> {
  for (const tab of tabs.list) tab.auto.written = -1;
  await Promise.all(tabs.list.map((t) => flush(t, keepBlank)));
}

/** The tab is closing and its picture was saved or thrown away: its slot goes. */
export async function discard(tab: Tab = current()): Promise<void> {
  const a = tab.auto;
  a.stopped = true;
  clearTimeout(a.timer);
  while (a.running) await a.running;
  await platform.recoveryDelete(a.slot);
}

/** The tab is moving to a window of its own, which takes its slot over: this window stops writing it. */
export async function letGo(tab: Tab): Promise<string> {
  await flush(tab, true);
  tab.auto.stopped = true;
  clearTimeout(tab.auto.timer);
  return tab.auto.slot;
}

/** Parses a slot's saved state; null (and the slot goes) when it's damaged. */
export async function metaOf(s: platform.RecoverySlot): Promise<SlotMeta | null> {
  try {
    return JSON.parse(s.meta) as SlotMeta;
  } catch {
    await platform.recoveryDelete(s.id);
    return null;
  }
}

/**
 * Reopens a slot in the tab showing, which takes it over. `open` puts a document in the tab, as
 * `actions.setDocument` does. Returns false when there was nothing to reopen.
 */
export async function restore(
  s: platform.RecoverySlot,
  open: (bytes: Uint8Array | null, meta: SlotMeta) => Promise<boolean>,
  quiet = false,
): Promise<boolean> {
  const meta = await metaOf(s);
  if (!meta) return false;
  try {
    if (!(await open(s.has_picture ? await platform.recoveryRead(s.id) : null, meta))) {
      await platform.recoveryDelete(s.id);
      return false;
    }
  } catch (e) {
    // A damaged autosave would fail the same way every time, so it goes.
    toast(`Couldn't bring back ${meta.file.name}: ${e instanceof Error ? e.message : String(e)}`, 6000);
    await platform.recoveryDelete(s.id);
    return false;
  }
  const a = current().auto;
  if (a.slot !== s.id) await platform.recoveryDelete(a.slot);
  a.slot = s.id;
  a.written = -1;
  a.meta = s.meta;
  a.stopped = false;
  await platform.recoveryClaim(a.slot);
  // A slot from another window (a crash, a restart, a tab moved here) is rewritten as this window's.
  if (meta.group !== group) autosaveSoon();
  if (s.has_picture && !quiet) toast(`Brought back ${meta.file.name} with its unsaved changes.`, 4000);
  return true;
}

/**
 * Slots in windows: each window's tabs together, in tab order, windows in the order the slots came
 * (a restart sorts them by window). Slots from before F14 are a window each.
 */
export async function groupSlots(slots: platform.RecoverySlot[]): Promise<{ slots: platform.RecoverySlot[]; metas: SlotMeta[] }[]> {
  const groups = new Map<string, { slots: platform.RecoverySlot[]; metas: SlotMeta[] }>();
  for (const s of slots) {
    const meta = await metaOf(s);
    if (!meta) continue;
    const key = meta.group ?? s.id;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { slots: [], metas: [] }));
    g.slots.push(s);
    g.metas.push(meta);
  }
  return [...groups.values()].map((g) => {
    const order = g.slots.map((_, i) => i).sort((a, b) => (g.metas[a].order ?? 0) - (g.metas[b].order ?? 0));
    return { slots: order.map((i) => g.slots[i]), metas: order.map((i) => g.metas[i]) };
  });
}

export type { SlotMeta };
