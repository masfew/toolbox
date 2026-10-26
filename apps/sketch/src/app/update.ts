/**
 * In-app updates (Silent Updates, F6; the Rust side is `src-tauri/src/update.rs`): checks for a newer
 * build at start, on focus, every few minutes, and whenever a build script says a build started or
 * finished (`scripts/ping-sketch.mjs`) or a fetch brought new commits (F16); a check is also what
 * starts a background build, or for a release install a download of the new release. A finished
 * build waits as a new version folder that the next start of Sketch opens. While one builds, the
 * status bar shows a spinner by the version number; once it's ready, a small icon (F11) and the Help
 * menu's Restart to Update; Sketch also restarts into it by itself while nobody is using the PC.
 */
import * as platform from '../platform';
import { flushAll, slotId } from './recovery';
import { app, changed, toast } from './store';

/** A fallback: builds tell Sketch when they start and finish. */
const CHECK_EVERY_MS = 5 * 60_000;
/** While a build runs, in case its "finished" message is missed. */
const CHECK_WHILE_BUILDING_MS = 10_000;

export const update = {
  /** A newer version staged and waiting for Sketch to restart. */
  ready: null as platform.ReadyUpdate | null,
  /** The newer commit being built while no update is ready yet. */
  building: null as string | null,
  /** True from Restart to Update until Sketch closes. */
  restarting: false,
};

/** Builds from a git checkout and release builds get updates; dev servers and the browser build don't. */
const enabled = platform.isTauri && !import.meta.env.DEV && !!__SKETCH_BUILD__.commit && (!!__SKETCH_BUILD__.repo || __SKETCH_BUILD__.channel === 'release');

let timer: ReturnType<typeof setTimeout> | undefined;

async function check(): Promise<void> {
  try {
    const status = await platform.updateStatus();
    const was = `${update.ready?.commit}|${update.building}`;
    update.ready = status.ready;
    update.building = status.ready ? null : status.building;
    if (was !== `${update.ready?.commit}|${update.building}`) changed();
  } catch (e) {
    console.warn('Update check failed', e);
  }
  schedule();
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void check(), update.building ? CHECK_WHILE_BUILDING_MS : CHECK_EVERY_MS);
}

/**
 * In the middle of something a restart would lose or cut short: a dialog, typing, a stroke or drag,
 * a pasted or moved selection not yet placed, a crop or an adjustment being previewed.
 */
function busy(): boolean {
  return !!(app.modal || app.textEdit || app.liveStroke || app.marquee || app.draft || app.selection || app.crop || app.adjustPreview);
}

export function startUpdates(): void {
  if (!enabled) return;
  // After start-up has finished, so the check never slows the first frame.
  timer = setTimeout(() => void check(), 4000);
  window.addEventListener('focus', () => void check());
  platform.onUpdateCheck(() => void check());
  platform.onUpdatePrepare(async (quiet) => {
    if (quiet && busy()) return void platform.updateWindowSaved(null, true);
    // Every tab is saved, even with nothing in it, so the window and its tabs come back too.
    await flushAll(true);
    await platform.updateWindowSaved(slotId(), false);
  });
  platform.onUpdateFailed((message) => {
    update.restarting = false;
    changed();
    toast(message, 6000);
  });
  void platform.updateStartNote().then((note) => {
    if (note.fallback) toast("Sketch couldn't open its newest version, so it opened the one before.", 8000);
  });
}

/** Restart to Update: every window saves itself, then Sketch restarts into the new version with its pictures back. */
export async function restartToUpdate(): Promise<void> {
  if (!update.ready || update.restarting) return;
  update.restarting = true;
  changed();
  try {
    await platform.updateRestart();
  } catch (e) {
    update.restarting = false;
    changed();
    toast(e instanceof Error ? e.message : String(e), 6000);
    void check();
  }
}
