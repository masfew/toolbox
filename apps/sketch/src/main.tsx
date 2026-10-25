import { render } from 'preact';
import './styles.css';
import * as actions from './app/actions';
import { installShortcuts } from './app/shortcuts';
import { app, changed, tabHooks, tabs } from './app/store';
import * as platform from './platform';
import { flushPrefs } from './app/prefs';
import { flatten } from './engine/document';
import { flattenArea, frameOf, pictureArea } from './engine/board';
import { App } from './ui/App';
import { runCommand, startCaptureKey } from './app/commandList';
import { onLaunch, startWindow } from './app/launch';
import { autosaveSoon } from './app/recovery';
import { closeTab, confirmCloseAll, discardAll } from './app/tabs';
import { startUpdates, update } from './app/update';
import { mouse, startMouseSpeed } from './app/mouse';
import { startTheme } from './app/theme';

// Windows 11's Mica shows through the window's see-through parts; elsewhere the colours stay solid.
void platform.micaEnabled().then((on) => document.documentElement.classList.toggle('mica', on));
startTheme();

tabHooks.historyChanged = (tab) => {
  changed();
  autosaveSoon(tab);
};

render(<App />, document.getElementById('root')!);
// For checking the picture from the browser pane's console while developing, and for the checks of the built app.
const exposeState = () => ((window as unknown as { sketch: unknown }).sketch = { app, tabs, closeTab, flatten, flattenArea, frameOf, pictureArea, run: runCommand, update, mouse });
if (import.meta.env.DEV) exposeState();
else void platform.testHooks().then((on) => on && exposeState());
installShortcuts();

platform.onFileDrop((items, x, y) => {
  const view = document.querySelector('canvas.view')!.getBoundingClientRect();
  void actions.dropFiles(items, x - view.left, y - view.top);
});

platform.onCloseRequested(async () => {
  // Asks about each tab with unsaved changes. A capture opened from its notification is thrown away
  // without asking (F9).
  if (!(await confirmCloseAll())) return false;
  await discardAll();
  flushPrefs();
  return true;
});
window.addEventListener('pagehide', flushPrefs);
window.addEventListener('beforeunload', (e) => {
  if (!platform.isTauri && tabs.list.some((t) => t.history.dirty)) e.preventDefault();
});

void startWindow();
platform.onLaunch((launch) => void onLaunch(launch));
// A hidden window (F12) checks for updates only once it's shown; most close unseen.
void platform.windowShown().then(startUpdates);
startMouseSpeed();
void startCaptureKey();
