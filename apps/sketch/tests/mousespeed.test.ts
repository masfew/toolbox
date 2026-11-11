import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectiveOffset, loadMouseOn, mouseActive } from '../src/app/mouseState';

afterEach(() => vi.unstubAllGlobals());

/** A stand-in for the WebView's local storage. */
function storage(items: Record<string, string>) {
  vi.stubGlobal('localStorage', { getItem: (k: string) => items[k] ?? null, setItem: () => {} });
}

describe('the mouse speed switch', () => {
  it('is on for an install that never saved it, so earlier installs behave as before', () => {
    storage({ 'sketch.mouseSpeed': '-4' });
    expect(loadMouseOn()).toBe(true);
  });

  it('reads back what was saved, and falls back to on for junk', () => {
    storage({ 'sketch.mouseSpeedOn': 'false' });
    expect(loadMouseOn()).toBe(false);
    storage({ 'sketch.mouseSpeedOn': 'true' });
    expect(loadMouseOn()).toBe(true);
    storage({ 'sketch.mouseSpeedOn': '{oops' });
    expect(loadMouseOn()).toBe(true);
  });

  it('lets Left Ctrl bring in a speed only while it is on and not at normal', () => {
    expect(mouseActive(true, -4)).toBe(true);
    expect(mouseActive(false, -4)).toBe(false);
    expect(mouseActive(true, 0)).toBe(false);
    expect(mouseActive(false, 0)).toBe(false);
  });

  it('tells the app normal (0) while off, and the slider value while on', () => {
    expect(effectiveOffset(true, -4)).toBe(-4);
    expect(effectiveOffset(false, -4)).toBe(0);
    expect(effectiveOffset(true, 0)).toBe(0);
  });
});
