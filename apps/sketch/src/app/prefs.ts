/**
 * Settings kept between sessions in the WebView's local storage.
 * Reads and writes never throw: if storage is blocked or holds junk, the app uses its defaults.
 */

const PREFIX = 'sketch.';

export function loadPref<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

const pending = new Map<string, { timer: number; value: unknown }>();

function write(name: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the setting just isn't remembered.
  }
}

/** Saves a setting. Bursts of changes (dragging a slider) are written once, a moment later. */
export function savePref(name: string, value: unknown, delayMs = 300): void {
  const old = pending.get(name);
  if (old) clearTimeout(old.timer);
  pending.delete(name);
  if (delayMs <= 0) return write(name, value);
  const timer = window.setTimeout(() => {
    pending.delete(name);
    write(name, value);
  }, delayMs);
  pending.set(name, { timer, value });
}

/** Runs `fn` when another window saves the setting (every window shares the same storage). */
export function onPrefChanged<T>(name: string, fallback: T, fn: (value: T) => void): void {
  window.addEventListener('storage', (e) => {
    if (e.key === PREFIX + name) fn(loadPref(name, fallback));
  });
}

/** Writes any settings still waiting, before the window closes. */
export function flushPrefs(): void {
  for (const [name, p] of pending) {
    clearTimeout(p.timer);
    write(name, p.value);
  }
  pending.clear();
}
