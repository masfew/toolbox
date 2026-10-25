/**
 * Light or dark: the same as Windows, or always one of them. The page's colours come from `html.dark`,
 * and the window's frame and Mica are told too, so a dark page never sits in a light window.
 */
import * as platform from '../platform';
import { loadPref, onPrefChanged, savePref } from './prefs';
import { changed } from './store';

export type Theme = 'system' | 'light' | 'dark';

export const themePrefs = {
  theme: loadPref<Theme>('theme', 'system'),
};

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const listeners: (() => void)[] = [];

export function isDark(): boolean {
  return themePrefs.theme === 'system' ? systemDark.matches : themePrefs.theme === 'dark';
}

/** Runs `fn` after the colours change, for things drawn from them (the canvas). */
export function onThemeChange(fn: () => void): void {
  listeners.push(fn);
}

function apply(): void {
  const dark = isDark();
  if (document.documentElement.classList.contains('dark') === dark) return;
  document.documentElement.classList.toggle('dark', dark);
  for (const fn of listeners) fn();
}

function applyWindow(): void {
  void platform.setWindowTheme(themePrefs.theme === 'system' ? null : themePrefs.theme);
}

export function setTheme(value: Theme): void {
  themePrefs.theme = value;
  savePref('theme', value, 0);
  applyWindow();
  apply();
  changed();
}

/** Called once, before the first render, so the page draws in the right colours from the start. */
export function startTheme(): void {
  apply();
  if (themePrefs.theme !== 'system') applyWindow();
  // In "system", Windows changing (or the window's frame following it after a forced theme) shows here.
  systemDark.addEventListener('change', apply);
  // Another window changed it.
  onPrefChanged<Theme>('theme', 'system', (value) => {
    themePrefs.theme = value;
    applyWindow();
    apply();
    changed();
  });
}
