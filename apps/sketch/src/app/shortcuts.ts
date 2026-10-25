import { applyCrop, resetCrop } from '../tools/crop';
import { cancelSelection, deleteSelection, nudgeSelection, placeSelection } from '../tools/selection';
import { clearPicked, deletePicked, nudgePicked } from '../tools/shapes';
import { isTyping } from '../view/input';
import * as actions from './actions';
import { commandForKey, isEnabled } from './commandList';
import { comboOf } from './keys';
import { app } from './store';
import { currentTool } from './tools';

/** Keys that only mean something while there's a selection or a pasted picture. They can't be changed. */
function selectionKey(key: string, shift: boolean): boolean {
  const step = shift ? 10 : 1;
  if (key === 'Enter') placeSelection();
  else if (key === 'Escape') cancelSelection();
  else if (key === 'Delete') deleteSelection();
  else if (key === 'ArrowLeft') nudgeSelection(-step, 0);
  else if (key === 'ArrowRight') nudgeSelection(step, 0);
  else if (key === 'ArrowUp') nudgeSelection(0, -step);
  else if (key === 'ArrowDown') nudgeSelection(0, step);
  else return false;
  return true;
}

/** Keys for picked shapes and lines: Delete or Backspace deletes them, Esc lets go, arrows nudge them. */
function objectKey(key: string, shift: boolean): boolean {
  const step = shift ? 10 : 1;
  if (key === 'Delete' || key === 'Backspace') deletePicked();
  else if (key === 'Escape') clearPicked();
  else if (key === 'ArrowLeft') nudgePicked(-step, 0);
  else if (key === 'ArrowRight') nudgePicked(step, 0);
  else if (key === 'ArrowUp') nudgePicked(0, -step);
  else if (key === 'ArrowDown') nudgePicked(0, step);
  else return false;
  return true;
}

/** Enter crops and Esc starts the crop box again, while the crop tool is in use. */
function cropKey(key: string): boolean {
  if (key === 'Enter') applyCrop();
  else if (key === 'Escape') return resetCrop();
  else return false;
  return true;
}

/** Keyboard shortcuts, looked up in the command list. Ctrl+V is left to the browser so it fires the paste event. */
export function installShortcuts(): void {
  window.addEventListener('keydown', (e) => {
    // Dialogs, the palette, the shortcuts sheet, settings and open menus handle their own keys.
    if (app.modal || app.overlay || e.defaultPrevented) return;
    if (isTyping(e)) return;

    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (app.selection && plain && selectionKey(e.key, e.shiftKey)) {
      e.preventDefault();
      return;
    }
    if (app.objectSel && plain && objectKey(e.key, e.shiftKey)) {
      e.preventDefault();
      return;
    }
    if (currentTool().id === 'crop' && plain && cropKey(e.key)) {
      e.preventDefault();
      return;
    }

    const combo = comboOf(e);
    if (!combo) return;
    const cmd = commandForKey(combo);
    if (!cmd) return;
    if (cmd.id === 'edit.paste' && combo === 'Ctrl+V') return;
    e.preventDefault();
    if (e.repeat && cmd.repeat === false) return;
    if (isEnabled(cmd)) cmd.run();
  });

  document.addEventListener('paste', (e) => {
    if (!app.modal && !app.overlay) void actions.pasteFromEvent(e);
  });
}
