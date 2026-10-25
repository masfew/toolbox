/**
 * What a window does when it opens, and when Sketch is launched again while it runs: open a file,
 * paste the clipboard, open a screen capture, or bring back autosaved pictures from an earlier run.
 */
import * as platform from '../platform';
import * as actions from './actions';
import { loadPref, savePref } from './prefs';
import { groupSlots, holdAutosave, restore, type SlotMeta } from './recovery';
import { changed, tabs } from './store';
import { addTab, switchTo } from './tabs';

/** 'window' (the name from before F14) opens a new tab in the window used last; 'here' opens in place of its picture. */
export type OpenIn = 'window' | 'here';

export const windowPrefs = {
  /** Where files opened from Explorer go while Sketch is running: a new tab, or in place of the picture showing. */
  openIn: loadPref<OpenIn>('openIn', 'window'),
};

export function setOpenIn(value: OpenIn): void {
  windowPrefs.openIn = value;
  savePref('openIn', value, 0);
  changed();
}

/** Opens what the launch asked for in the tab showing, which is untouched or was asked about. */
async function run(launch: platform.Launch): Promise<void> {
  if (launch.file) await actions.openPath(launch.file, true);
  else if (launch.paste) await actions.pasteFromClipboard();
  else if (launch.capture !== null) await actions.openCapture(launch.capture, launch.quick);
}

/** The window has just opened. */
export async function startWindow(): Promise<void> {
  let launch = await platform.launchInfo();
  if (launch.capturing) {
    // The capture shortcut started Sketch: the screen is frozen and being picked.
    const waited = await platform.captureWait();
    launch = { ...launch, capture: waited?.id ?? null, quick: waited?.quick ?? false };
    try {
      await startWith(launch);
    } finally {
      platform.showWindowNow();
    }
    return;
  }
  if (launch.hidden) {
    // F12: started hidden as the capture's notification showed. The capture opens now, so clicking
    // the notification only shows the window. Nothing is autosaved before then, since the window
    // closes if the click never comes.
    holdAutosave(true);
    await run(launch);
    await platform.hiddenWait();
    platform.showWindowNow();
    holdAutosave(false);
    await reopenLeftovers(launch);
    return;
  }
  if (launch.restart) {
    // Shown once its picture is back, where that picture's window was.
    try {
      await startWith(launch);
    } finally {
      platform.showWindowNow();
    }
    return;
  }
  await startWith(launch);
}

async function startWith(launch: platform.Launch): Promise<void> {
  const quiet = launch.restart === 'quiet';
  if (launch.recover) {
    // One window's tabs, from a restart, or a tab moved out of another window.
    const slots = [];
    for (const id of launch.recover.split(',')) {
      const slot = await platform.recoverySlot(id);
      if (slot) slots.push(slot);
    }
    for (const g of await groupSlots(slots)) await restoreTabs(g.slots, g.metas, quiet);
    return;
  }
  await reopenLeftovers(launch);
  await run(launch);
}

/**
 * Reopens slots as tabs of this window: the first in the tab showing (an untouched New picture), the
 * rest in tabs after it, then shows the one that was showing. False when none could be reopened.
 */
async function restoreTabs(slots: platform.RecoverySlot[], metas: SlotMeta[], quiet: boolean): Promise<boolean> {
  let any = false;
  let show = -1;
  for (let i = 0; i < slots.length; i++) {
    if (any) addTab();
    if (await restore(slots[i], actions.openRecovered, quiet)) {
      any = true;
      if (metas[i].active) show = tabs.active;
    } else if (any) await closeEmpty();
  }
  if (show >= 0) switchTo(show);
  return any;
}

/** Drops the empty tab a slot that couldn't be reopened was meant for. */
async function closeEmpty(): Promise<void> {
  const i = tabs.active;
  tabs.list.splice(i, 1);
  tabs.active = i - 1;
  changed();
}

/**
 * Pictures left by an earlier run, each window's tabs together: the first window's in this one (unless
 * it was opened for something), the rest in windows of their own.
 */
async function reopenLeftovers(launch: platform.Launch): Promise<void> {
  const quiet = launch.restart === 'quiet';
  const groups = await groupSlots(await platform.recoveryOrphans());
  let here = !launch.file && !launch.paste && launch.capture === null;
  for (const g of groups) {
    if (here && (await restoreTabs(g.slots, g.metas, quiet))) here = false;
    else if (!here) await platform.openWindow({ recover: g.slots.map((s) => s.id).join(','), restart: launch.restart });
  }
}

/** Sketch was launched again (a file from Explorer, the paste shortcut) or a capture was picked, and this was the window used last. */
export async function onLaunch(launch: platform.Launch): Promise<void> {
  if (!launch.file && !launch.paste && launch.capture === null) {
    await platform.bringToFront();
    return;
  }
  // A paste or capture always gets a picture of its own, in a new tab (F14); a file follows the
  // setting. An untouched New picture is used as it is.
  await platform.bringToFront();
  if (!actions.isUntouched()) {
    if (launch.file && windowPrefs.openIn === 'here') {
      if (!(await actions.confirmLoseChanges())) return;
    } else actions.intoNewTab();
  }
  await run(launch);
}
