import { Channel, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';

/** True inside the Tauri app; false in a plain browser (used for testing the drawing code). */
export const isTauri = '__TAURI_INTERNALS__' in window;

export interface PickedFile {
  name: string;
  path: string | null;
  bytes: Uint8Array;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function readPath(path: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>('read_file', { path });
  return new Uint8Array(buf);
}

export async function pickFileToOpen(filters: FileFilter[]): Promise<PickedFile | null> {
  if (isTauri) {
    const path = await openDialog({ multiple: false, directory: false, filters });
    if (typeof path !== 'string') return null;
    return { name: baseName(path), path, bytes: await readPath(path) };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = filters.flatMap((f) => f.extensions.map((e) => '.' + e)).join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Asks where to save. In the browser there's no path; the file is downloaded instead. */
export async function pickSavePath(defaultName: string, filters: FileFilter[]): Promise<string | null | 'download'> {
  if (!isTauri) return 'download';
  const path = await saveDialog({ defaultPath: defaultName, filters });
  return path ?? null;
}

export async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  await invoke('write_file', bytes, { headers: { path: encodeURIComponent(path) } });
}

export function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- Remove Background (F13) ----------

/** The cutout model's input and mask size, in pixels each way. */
export const CUTOUT_SIZE = 320;
/** What the cutout add-on downloads: ONNX Runtime and the model. */
export const CUTOUT_DOWNLOAD_MB = 193;

/** True once the cutout add-on is downloaded. */
export async function cutoutReady(): Promise<boolean> {
  return isTauri ? invoke<boolean>('cutout_ready') : false;
}

/** Downloads the cutout add-on; `onProgress` gets how far it has got, 0 to 1. Rejects with "cancelled" after `cancelCutoutDownload`. */
export async function installCutout(onProgress: (share: number) => void): Promise<void> {
  const progress = new Channel<number>();
  progress.onmessage = (n) => onProgress(n / 1000);
  await invoke('cutout_install', { progress });
}

export async function cancelCutoutDownload(): Promise<void> {
  if (isTauri) await invoke('cutout_cancel');
}

/**
 * How much of each pixel is the object in front, one byte per pixel, from raw RGBA at
 * CUTOUT_SIZE × CUTOUT_SIZE. That's small enough to send raw (400 KB, a few ms).
 */
export async function cutoutMask(rgba: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('cutout_mask', rgba));
}

/**
 * Puts a PNG on the clipboard, keeping transparency. The app sends a PNG rather than raw pixels:
 * handing a 4K picture's raw pixels to Rust took 0.3 s.
 */
export async function copyPng(png: Uint8Array): Promise<void> {
  if (isTauri) {
    await invoke('copy_png', png);
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as BlobPart], { type: 'image/png' }) })]);
}

/**
 * A number that changes whenever anything is put on the clipboard, so the app can tell whether what it
 * copied is still there. The browser build has no way to tell, so it always says 0.
 */
export async function clipboardSeq(): Promise<number> {
  return isTauri ? invoke<number>('clipboard_seq') : 0;
}

export async function clipboardFilePaths(): Promise<string[]> {
  return isTauri ? invoke<string[]>('clipboard_file_paths') : [];
}

export interface ClipboardRead {
  image: ImageBitmap | null;
  text: string;
  html: string;
}

/** Reads the clipboard without a paste event, for Paste in the menu and the command palette. */
export async function readClipboard(): Promise<ClipboardRead> {
  if (isTauri) {
    const raw = new Uint8Array(await invoke<ArrayBuffer>('read_clipboard_image'));
    let image: ImageBitmap | null = null;
    if (raw.length > 8) {
      const view = new DataView(raw.buffer, raw.byteOffset, 8);
      const width = view.getUint32(0, true);
      const height = view.getUint32(4, true);
      const pixels = new Uint8ClampedArray(raw.buffer, raw.byteOffset + 8, width * height * 4);
      image = await createImageBitmap(new ImageData(pixels, width, height));
    }
    return { image, text: image ? '' : await invoke<string>('read_clipboard_text'), html: '' };
  }
  const out: ClipboardRead = { image: null, text: '', html: '' };
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type && !out.image) out.image = await createImageBitmap(await item.getType(type));
    if (item.types.includes('text/plain')) out.text = await (await item.getType('text/plain')).text();
    if (item.types.includes('text/html')) out.html = await (await item.getType('text/html')).text();
  }
  return out;
}

/** True when the window has the Windows 11 Mica background behind the page's see-through parts. */
export async function micaEnabled(): Promise<boolean> {
  return isTauri ? invoke<boolean>('mica_enabled') : false;
}

/** Sets the window's frame and Mica to light or dark, or back to following Windows with null. */
export async function setWindowTheme(theme: 'light' | 'dark' | null): Promise<void> {
  if (isTauri) await getCurrentWindow().setTheme(theme);
}

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };
const EyeDropperApi = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;

/** True where the WebView can pick a colour from anywhere on screen. */
export const canPickScreenColor = !!EyeDropperApi;

/** Picks a colour from anywhere on screen. Null if cancelled with Esc. */
export async function pickScreenColor(): Promise<string | null> {
  if (!EyeDropperApi) throw new Error('Picking colours from the screen needs a newer WebView2.');
  try {
    return (await new EyeDropperApi().open()).sRGBHex;
  } catch {
    return null;
  }
}

export async function fetchUrl(url: string): Promise<Uint8Array> {
  if (isTauri) return new Uint8Array(await invoke<ArrayBuffer>('fetch_url', { url }));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The link returned ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------- Launches and windows ----------

/** What a window starts with: a file to open, the clipboard to paste, a screen capture, or an autosave to reopen. */
export interface Launch {
  file: string | null;
  paste: boolean;
  recover: string | null;
  capture: number | null;
  /** Started by the capture shortcut: the screen is still being picked (see `captureWait`). */
  capturing: boolean;
  /** The capture was opened by clicking its notification, so closing it won't ask about saving. */
  quick: boolean;
  /**
   * Sketch restarted into a new version: 'quiet' brings the windows back without the focus and with no
   * messages, 'front' as usual. The window shows once its picture is back, so it can go back where it was.
   */
  restart: 'quiet' | 'front' | null;
  /**
   * F12: started hidden with a capture as its notification showed. The window stays hidden until the
   * notification is clicked (`hiddenWait`), so the click shows it at once, and closes if it never is.
   */
  hidden: boolean;
}

const NO_LAUNCH: Launch = { file: null, paste: false, recover: null, capture: null, capturing: false, quick: false, restart: null, hidden: false };

// Asked for once, as the page loads, so `appReady` knows before the first frame whether to wait.
const launch: Promise<Launch> = isTauri ? invoke<Launch>('launch_info') : Promise.resolve(NO_LAUNCH);

export function launchInfo(): Promise<Launch> {
  return launch;
}

let releaseWindow = () => {};
const windowReleased = new Promise<void>((r) => (releaseWindow = r));

/**
 * Lets a window started by the capture shortcut show itself once the capture is open in it, one
 * reopened by a restart once its picture is back, or a hidden one once its notification is clicked.
 */
export function showWindowNow(): void {
  releaseWindow();
}

/** Resolves once the window is on screen (at once for windows that don't wait to show). */
export async function windowShown(): Promise<void> {
  const l = await launch;
  if (l.capturing || l.restart || l.hidden) await windowReleased;
}

/** A later launch of Sketch (a file opened from Explorer, the paste shortcut) that came to this window. */
export function onLaunch(handler: (launch: Launch) => void): void {
  if (isTauri) void getCurrentWebviewWindow().listen<Launch>('launch', (e) => handler(e.payload));
}

export async function openWindow(launch: Partial<Launch>): Promise<void> {
  if (isTauri) await invoke('open_window', { launch: { ...NO_LAUNCH, ...launch } });
}

/** Freezes the screen for picking an area, a window or a whole screen, with Sketch's windows hidden if that setting is on. */
export async function captureScreen(): Promise<void> {
  if (isTauri) await invoke('capture_screen');
}

/**
 * For a window started by the capture shortcut: the capture's id once picked, and whether it was
 * opened by clicking its notification. Cancelling quits Sketch.
 */
export async function captureWait(): Promise<{ id: number; quick: boolean } | null> {
  return isTauri ? invoke<{ id: number; quick: boolean } | null>('capture_wait') : null;
}

/**
 * For a hidden window (F12): resolves once its capture's notification is clicked. If the notification
 * goes without a click, it never resolves and the window closes.
 */
export async function hiddenWait(): Promise<void> {
  if (isTauri) await invoke<boolean>('hidden_wait');
}

/** A capture's picture, once; null when it's gone. */
export async function captureTake(id: number): Promise<ImageBitmap | null> {
  const raw = new Uint8Array(await invoke<ArrayBuffer>('capture_take', { id }));
  if (raw.length <= 8) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, 8);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const pixels = new Uint8ClampedArray(raw.buffer, raw.byteOffset + 8, width * height * 4);
  return createImageBitmap(new ImageData(pixels, width, height));
}

export async function bringToFront(): Promise<void> {
  if (isTauri) await invoke('bring_to_front');
}

/** True when a check started the app and wants to read its state. */
export async function testHooks(): Promise<boolean> {
  return isTauri ? invoke<boolean>('test_hooks') : false;
}

/** Adds a file to Windows' recent files, which Sketch's jump list shows. */
export function addRecent(path: string): void {
  if (isTauri) void invoke('add_recent', { path });
}

/**
 * Keys that work anywhere in Windows: open Sketch with the clipboard pasted (a Start menu shortcut),
 * or capture the screen (held by the capture helper, sketch-capture.exe).
 */
export type ShortcutKind = 'paste' | 'capture';

/** Sets, changes or removes the keys. Refuses keys Windows or another app already holds. */
export async function setShortcut(kind: ShortcutKind, keys: string | null): Promise<void> {
  if (isTauri) await invoke('set_shortcut', { kind, keys });
}

export async function shortcut(kind: ShortcutKind): Promise<string | null> {
  return isTauri ? invoke<string | null>('shortcut', { kind }) : null;
}

/** What happens once a capture is picked: copied with a notification that opens it, or opened in Sketch. */
export type CaptureAfter = 'notify' | 'open';

export interface CaptureOptions {
  after: CaptureAfter;
  /** Sketch hides its windows before a capture taken while it's open. Off by default. */
  hide: boolean;
  /** A tap of Left Shift within a second of the notification opens the capture (F16). On by default. */
  shiftOpen: boolean;
  /** Why the capture keys aren't working right now, if they aren't. */
  error: string | null;
}

export async function captureOptions(): Promise<CaptureOptions | null> {
  return isTauri ? invoke<CaptureOptions>('capture_options') : null;
}

/** Changes the capture settings given; the others stay as they are. */
export async function setCaptureOptions(change: { after?: CaptureAfter; hide?: boolean; shiftOpen?: boolean }): Promise<void> {
  if (isTauri) await invoke('capture_options_set', { after: change.after ?? null, hide: change.hide ?? null, shiftOpen: change.shiftOpen ?? null });
}

/** Windows Settings' keyboard page, where Windows' own use of Print Screen is turned off. */
export function openKeyboardSettings(): void {
  if (isTauri) void invoke('open_keyboard_settings');
}

/**
 * Sets the mouse speed while drawing, in steps of Windows' pointer speed from the user's own (0 for
 * normal). Returns the user's own speed (1 to 20), or null in the browser build.
 */
export async function mouseSpeedSet(offset: number): Promise<{ base: number } | null> {
  return isTauri ? invoke<{ base: number } | null>('mouse_speed_set', { offset }) : null;
}

/** Says Left Ctrl went down or came up, since the slider's speed applies only while it's held. */
export function mouseCtrl(on: boolean): void {
  if (isTauri) void invoke('mouse_ctrl', { on }).catch((e) => console.warn('Mouse speed failed', e));
}

// ---------- Autosave ----------

export interface RecoverySlot {
  id: string;
  meta: string;
  has_picture: boolean;
}

/** Autosaves left by an earlier run. Only the first window to ask in a run gets them. */
export async function recoveryOrphans(): Promise<RecoverySlot[]> {
  return isTauri ? invoke<RecoverySlot[]>('recovery_orphans') : [];
}

/** One slot, for a window opened to reopen it. */
export async function recoverySlot(id: string): Promise<RecoverySlot | null> {
  return isTauri ? invoke<RecoverySlot | null>('recovery_slot', { id }) : null;
}

export async function recoveryClaim(id: string): Promise<void> {
  if (isTauri) await invoke('recovery_claim', { id });
}

export async function recoveryRead(id: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('recovery_read', { id }));
}

/** Saves this window's state; `picture` is the `.sktch` bytes, or empty when nothing is unsaved. */
export async function recoveryWrite(id: string, meta: string, picture: Uint8Array): Promise<void> {
  if (isTauri) await invoke('recovery_write', picture, { headers: { slot: id, meta: encodeURIComponent(meta) } });
}

/** Rewrites only a slot's saved state, keeping its picture. */
export async function recoveryMeta(id: string, meta: string): Promise<void> {
  if (isTauri) await invoke('recovery_meta', { id, meta });
}

export async function recoveryDelete(id: string): Promise<void> {
  if (isTauri) await invoke('recovery_delete', { id });
}

// ---------- Updates ----------

export interface ReadyUpdate {
  commit: string;
  subject: string;
}

export interface UpdateStatus {
  /** A newer version staged and waiting for Sketch to restart. */
  ready: ReadyUpdate | null;
  building: string | null;
}

export function updateStatus(repo: string, path: string, commit: string): Promise<UpdateStatus> {
  return invoke<UpdateStatus>('update_status', { repo, path, commit });
}

/** Restart to Update: every window saves itself, then Sketch restarts into the new version. */
export function updateRestart(): Promise<void> {
  return invoke('update_restart');
}

/** This window has saved itself into `slot` for a restart, or is `busy`, which calls a quiet restart off. */
export function updateWindowSaved(slot: string | null, busy: boolean): Promise<void> {
  return invoke('update_window_saved', { slot, busy });
}

/** `fallback`: the version folder the launcher couldn't start, when it opened an older one instead. */
export function updateStartNote(): Promise<{ fallback: string | null }> {
  return invoke('update_start_note');
}

/** Every window is asked to save itself before Sketch restarts into a new version; `quiet` for the restart while nobody is using the PC. */
export function onUpdatePrepare(handler: (quiet: boolean) => void): void {
  if (isTauri) void getCurrentWebviewWindow().listen<{ quiet: boolean }>('update-prepare', (e) => handler(e.payload.quiet));
}

/** A build for an update started or finished (`--update-check` from the build scripts): check now. */
export function onUpdateCheck(handler: () => void): void {
  if (isTauri) void getCurrentWebviewWindow().listen('update-check', () => handler());
}

export function onUpdateFailed(handler: (message: string) => void): void {
  if (isTauri) void getCurrentWebviewWindow().listen<string>('update-failed', (e) => handler(e.payload));
}

export function setTitle(title: string): void {
  document.title = title;
  if (isTauri) void getCurrentWindow().setTitle(title);
}

/** Shows the window (it starts hidden so it never flashes white) and reports start-up for the speed check. */
export async function appReady(): Promise<void> {
  if (!isTauri) return;
  // Started by the capture shortcut: stay hidden while the screen is picked, so the window neither
  // covers the overlay nor takes its keys. Reopened by a restart: stay hidden until the picture is
  // back, so the window shows where that picture's window was. Started hidden with a capture: stay
  // hidden until its notification is clicked.
  const l = await launch;
  await windowShown();
  await invoke('show_window');
  if (l.hidden) {
    // When the shown capture's first frame starts, for timing the click (`npm run perf`).
    requestAnimationFrame(() => ((window as unknown as { sketchShownAt?: number }).sketchShownAt = performance.timeOrigin + performance.now()));
  }
  // A window opened for something the user just asked for (a capture's notification or Left Shift, a
  // file from Explorer, the paste key) comes to the front. Showing it isn't enough: after a Left
  // Shift tap no process has the right to take the foreground, so until 24 Oct 2026 such windows
  // opened behind the app in front. `bring_to_front` takes it anyway. Restarts stay where they were.
  if (l.hidden || (!l.restart && !l.recover && (l.file || l.paste || l.capture !== null || l.capturing))) await invoke('bring_to_front');
  await invoke('app_ready');
}

let closeCheck: () => Promise<boolean> = async () => true;

/** Runs `canClose` when the user closes the window; the window closes only if it resolves true. */
export function onCloseRequested(canClose: () => Promise<boolean>): void {
  closeCheck = canClose;
  if (isTauri) {
    const win = getCurrentWindow();
    void win.onCloseRequested(async (event) => {
      event.preventDefault();
      if (await canClose()) await win.destroy();
    });
  }
}

/** Closes the window as its close button does, asking first. (The page may destroy its window, but not ask it to close.) */
export async function closeWindow(): Promise<void> {
  if (isTauri && (await closeCheck())) await getCurrentWindow().destroy();
}


export interface DroppedItem {
  name: string;
  read: () => Promise<Uint8Array>;
  path: string | null;
}

/** Calls back with dropped files and the drop point in CSS pixels relative to the window. */
export function onFileDrop(handler: (items: DroppedItem[], x: number, y: number) => void): void {
  if (isTauri) {
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      const dpr = window.devicePixelRatio || 1;
      const items = event.payload.paths.map((p) => ({ name: baseName(p), path: p, read: () => readPath(p) }));
      handler(items, event.payload.position.x / dpr, event.payload.position.y / dpr);
    });
    return;
  }
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    const items = files.map((f) => ({ name: f.name, path: null, read: async () => new Uint8Array(await f.arrayBuffer()) }));
    if (items.length) handler(items, e.clientX, e.clientY);
  });
}
