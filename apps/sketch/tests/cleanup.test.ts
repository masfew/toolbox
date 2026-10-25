import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLEAN_UP_PREF, loadCleanUp, sanitizeCleanUp } from '../src/app/cleanUpPref';
import { savePref } from '../src/app/prefs';

afterEach(() => vi.unstubAllGlobals());

/** A stand-in for the WebView's local storage. */
function storage(items: Record<string, string>) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => items[k] ?? null,
    setItem: (k: string, v: string) => {
      items[k] = v;
    },
  });
  return items;
}

describe('the saved Clean up rough shapes setting', () => {
  it('is on for a fresh install', () => {
    storage({});
    expect(loadCleanUp()).toBe(true);
  });

  it('is on for an install that never saved one', () => {
    // Settings saved by an earlier version: other keys, but no `sketch.cleanUp`.
    const items = storage({ 'sketch.theme': '"dark"', 'sketch.openIn': '"here"', 'sketch.pointer': '{"shape":"dot"}', 'sketch.tools': '{}' });
    expect(loadCleanUp()).toBe(true);
    // Reading it writes nothing: the key is only saved once someone changes it.
    expect(Object.keys(items)).not.toContain(`sketch.${CLEAN_UP_PREF}`);
  });

  it('is on with no storage at all, or storage holding junk', () => {
    expect(loadCleanUp()).toBe(true);
    for (const junk of ['{not json', '"off"', '0', 'null', '[]', '{"on":false}']) {
      storage({ 'sketch.cleanUp': junk });
      expect(loadCleanUp(), junk).toBe(true);
    }
    for (const junk of [undefined, null, 0, 1, 'false', '', [], {}]) expect(sanitizeCleanUp(junk)).toBe(true);
  });

  it('keeps being off once switched off, and on once switched back', () => {
    const items = storage({});
    savePref('cleanUp', false, 0);
    expect(items['sketch.cleanUp']).toBe('false');
    expect(loadCleanUp()).toBe(false);
    savePref('cleanUp', true, 0);
    expect(loadCleanUp()).toBe(true);
  });
});
