import { useEffect, useRef, useState } from 'preact/hooks';
import * as actions from '../app/actions';
import { commandById, isEnabled, keysFor, menuItems, MENUS, runCommand, type MenuName } from '../app/commandList';
import { prettyCombo } from '../app/keys';
import { app } from '../app/store';
import { Icon } from './icons';

function keyText(id: string): string {
  return keysFor(id).slice(0, 1).map(prettyCombo).join('');
}

/** How long the Copy button says "Copied" after a click. */
const COPIED_MS = 1500;

/** Copies the whole picture, merged, like Ctrl+Shift+C, and says so on the button for a moment. */
function CopyButton() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const click = () =>
    void actions.copy(true).then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    });
  return (
    <button
      type="button"
      class={`icon-btn copy-btn${copied ? ' copied' : ''}`}
      aria-label="Copy picture"
      data-tip="Copy the whole picture"
      data-keys={keyText('edit.copyPicture')}
      onClick={click}
    >
      <Icon name={copied ? 'check' : 'copy'} />
      {copied && <span>Copied</span>}
    </button>
  );
}

function MenuList(props: { name: MenuName; onDone: () => void; focusIndex: number; setFocusIndex: (i: number) => void }) {
  return (
    <div class="menu" role="menu" aria-label={props.name}>
      {menuItems(props.name).map((item, i) => {
        if (item === '-') return <div class="menu-sep" role="separator" key={i} />;
        const c = commandById.get(item)!;
        const enabled = isEnabled(c);
        const checked = c.checked?.();
        return (
          <button
            type="button"
            role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={checked}
            aria-disabled={!enabled}
            key={item}
            data-command={item}
            class={`menu-item${enabled ? '' : ' disabled'}${props.focusIndex === i ? ' focus' : ''}`}
            onPointerEnter={() => props.setFocusIndex(i)}
            onClick={() => {
              if (!enabled) return;
              props.onDone();
              runCommand(item);
            }}
          >
            <span class="menu-check">{checked && <Icon name="check" size={14} />}</span>
            <span class="label">{c.label}</span>
            {c.planned ? <span class="step">step {c.planned}</span> : <span class="keys">{keyText(item)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** File, Edit, Image, View and Help menus, built from the command list, plus undo, redo, the Copy button and the panel button. */
export function MenuBar() {
  const [open, setOpen] = useState<MenuName | null>(null);
  const [focus, setFocus] = useState(-1);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt + a menu's first letter opens it, as in Windows apps.
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !app.modal && !app.overlay) {
        const m = MENUS.find((m) => e.code === `Key${m.name[0]}`);
        if (m) {
          e.preventDefault();
          setOpen(m.name);
          setFocus(-1);
          return;
        }
      }
      if (!open) return;
      const items = menuItems(open);
      const step = (dir: 1 | -1) => {
        let i = focus;
        for (let n = 0; n < items.length; n++) {
          i = (i + dir + items.length) % items.length;
          if (items[i] !== '-') return setFocus(i);
        }
      };
      const across = (dir: 1 | -1) => {
        const i = MENUS.findIndex((m) => m.name === open);
        setOpen(MENUS[(i + dir + MENUS.length) % MENUS.length].name);
        setFocus(-1);
      };
      let handled = true;
      if (e.key === 'Escape') setOpen(null);
      else if (e.key === 'ArrowDown') step(1);
      else if (e.key === 'ArrowUp') step(-1);
      else if (e.key === 'ArrowRight') across(1);
      else if (e.key === 'ArrowLeft') across(-1);
      else if (e.key === 'Enter' && focus >= 0 && items[focus] !== '-') {
        const id = items[focus];
        const c = commandById.get(id)!;
        if (isEnabled(c)) {
          setOpen(null);
          runCommand(id);
        }
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const outside = (e: PointerEvent) => {
      if (open && !bar.current?.contains(e.target as Node)) setOpen(null);
    };
    const blur = () => setOpen(null);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', blur);
    };
  }, [open, focus]);

  const h = app.history;
  const undo = commandById.get('edit.undo')!;
  const redo = commandById.get('edit.redo')!;

  return (
    <div class="menubar" ref={bar}>
      <div class="menus" role="menubar">
        {MENUS.map((m) => (
          <div class="menu-wrap" key={m.name}>
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === m.name}
              class={`menu-title${open === m.name ? ' open' : ''}`}
              onClick={() => {
                setOpen(open === m.name ? null : m.name);
                setFocus(-1);
              }}
              onPointerEnter={() => {
                if (open && open !== m.name) {
                  setOpen(m.name);
                  setFocus(-1);
                }
              }}
            >
              {m.name}
            </button>
            {open === m.name && <MenuList name={m.name} focusIndex={focus} setFocusIndex={setFocus} onDone={() => setOpen(null)} />}
          </div>
        ))}
      </div>
      <div class="quick">
        <button
          type="button"
          class="icon-btn"
          disabled={!isEnabled(undo)}
          aria-label="Undo"
          data-tip={h.undoLabel ? `Undo ${h.undoLabel}` : 'Undo'}
          data-keys={keyText('edit.undo')}
          onClick={() => runCommand('edit.undo')}
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          class="icon-btn"
          disabled={!isEnabled(redo)}
          aria-label="Redo"
          data-tip={h.redoLabel ? `Redo ${h.redoLabel}` : 'Redo'}
          data-keys={keyText('edit.redo')}
          onClick={() => runCommand('edit.redo')}
        >
          <Icon name="redo" />
        </button>
      </div>
      <div class="quick right">
        <CopyButton />
        <button
          type="button"
          class={`icon-btn${app.showPanel ? ' on' : ''}`}
          aria-pressed={app.showPanel}
          aria-label="Side panel"
          data-tip={app.showPanel ? 'Hide layers and history' : 'Show layers and history'}
          data-keys={keyText('view.panel')}
          onClick={() => runCommand('view.panel')}
        >
          <Icon name="panel" />
        </button>
      </div>
    </div>
  );
}
