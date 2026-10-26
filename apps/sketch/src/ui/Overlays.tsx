import { useEffect, useRef, useState } from 'preact/hooks';
import * as actions from '../app/actions';
import {
  CAPTURE_ID,
  clearKey,
  COMMANDS,
  commandById,
  isCustomised,
  isEnabled,
  isHidden,
  keyOwner,
  keysFor,
  resetAllKeys,
  resetKey,
  runCommand,
  setCaptureKey,
  setKey,
  type AppCommand,
} from '../app/commandList';
import { comboOf, fromWindowsHotkey, isCaptureHotkey, isWindowsHotkey, prettyCombo } from '../app/keys';
import { setOpenIn, windowPrefs, type OpenIn } from '../app/launch';
import { cleanUp, setCleanUp } from '../app/cleanUp';
import { pointerPrefs, setPointer } from '../app/pointer';
import { CROSS_SIZE, DOT_SIZE, imageUrl, POINTER_SHAPES, pointerImage, type PointerShape } from '../app/pointerStyle';
import * as platform from '../platform';
import { loadPref, savePref } from '../app/prefs';
import { searchCommands } from '../app/search';
import { app } from '../app/store';
import { setTheme, themePrefs, type Theme } from '../app/theme';
import { Icon } from './icons';
import logo from '../../src-tauri/icons/128x128.png';

function closeOverlay(): void {
  if (app.overlay) actions.toggleOverlay(app.overlay);
}

function Keys(props: { id: string; all?: boolean }) {
  const keys = keysFor(props.id);
  return (
    <span class="keys">
      {(props.all ? keys : keys.slice(0, 1)).map((k) => (
        <kbd key={k}>{prettyCombo(k)}</kbd>
      ))}
    </span>
  );
}

// ---------- Command palette ----------

let recent = loadPref<string[]>('paletteRecent', []);

function Palette() {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const all = COMMANDS.filter((c) => (!c.id.startsWith('slot.') || c.keys) && !isHidden(c));
  let results: AppCommand[];
  if (query.trim()) {
    results = searchCommands(query, all);
  } else {
    const recents = recent.map((id) => commandById.get(id)).filter((c): c is AppCommand => !!c);
    results = [...recents, ...all.filter((c) => !recents.includes(c))];
  }
  // Things that work now come before things that aren't built yet.
  results = [...results.filter((c) => !c.planned), ...results.filter((c) => c.planned)];
  const sel = Math.min(index, results.length - 1);

  useEffect(() => {
    list.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel, query]);

  const run = (c: AppCommand | undefined) => {
    if (!c || !isEnabled(c)) return;
    recent = [c.id, ...recent.filter((id) => id !== c.id)].slice(0, 5);
    savePref('paletteRecent', recent);
    closeOverlay();
    runCommand(c.id);
  };

  return (
    <div class="scrim light" onPointerDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      <div class="palette" role="dialog" aria-label="Command palette">
        <div class="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            type="text"
            placeholder="Type a command, like “save as” or “brush”"
            value={query}
            spellcheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              const combo = comboOf(e);
              if (e.key === 'Escape' || (combo && keysFor('view.palette').includes(combo))) {
                e.preventDefault();
                closeOverlay();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((sel + 1) % Math.max(1, results.length));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((sel - 1 + results.length) % Math.max(1, results.length));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(results[sel]);
              }
            }}
          />
        </div>
        <div class="palette-list" id="palette-list" role="listbox" ref={list}>
          {results.length === 0 && <div class="palette-empty">No command matches “{query}”.</div>}
          {results.map((c, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === sel}
              aria-disabled={!isEnabled(c)}
              key={c.id}
              class={`palette-item${i === sel ? ' sel' : ''}${isEnabled(c) ? '' : ' disabled'}`}
              onPointerMove={() => i !== sel && setIndex(i)}
              onClick={() => run(c)}
            >
              <span class="pi-icon">{c.icon && <Icon name={c.icon} size={16} />}</span>
              <span class="pi-group">{c.group}</span>
              <span class="pi-label">{c.label}</span>
              {c.planned ? <span class="step">step {c.planned}</span> : <Keys id={c.id} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Shortcuts sheet ----------

/** Keys that don't belong to a command, so can't be changed. */
const FIXED_KEYS: { keys: string; what: string }[] = [
  { keys: 'Space + drag, or middle drag', what: 'Pan' },
  { keys: 'Wheel, Shift + wheel', what: 'Scroll up and down, left and right' },
  { keys: 'Ctrl + wheel, or pinch', what: 'Zoom around the pointer' },
  { keys: 'Alt + right-drag', what: 'Change the tool size' },
  { keys: 'Left click, right click', what: 'Paint with colour 1, colour 2' },
  { keys: 'Shift + click', what: 'Straight line from where the last stroke ended' },
  { keys: 'Alt + click', what: 'Pick a colour from the picture' },
  { keys: 'Enter, Esc', what: 'Place or cancel a selection or pasted picture' },
  { keys: 'Arrows (Shift for 10 px)', what: 'Nudge a selection or pasted picture' },
  { keys: 'Shift + drag a handle', what: 'Keep the shape; turn in 15° steps' },
  { keys: 'Enter, Esc (Crop tool)', what: 'Crop, or start the crop box again' },
  { keys: 'Esc or Ctrl+Enter (typing)', what: 'Finish the text' },
  { keys: 'Alt + menu letter', what: 'Open a menu (Alt+F for File)' },
];

function ShortcutsSheet() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = comboOf(e);
      if (e.key === 'Escape' || (combo && keysFor('help.shortcuts').includes(combo))) {
        e.preventDefault();
        closeOverlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const groups = ['Tools', 'File', 'Edit', 'Image', 'Adjust', 'View', 'Help'] as const;
  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      <div class="sheet" role="dialog" aria-label="Keyboard shortcuts">
        <header>
          <h2>Keyboard Shortcuts</h2>
          <button type="button" class="link" onClick={() => actions.toggleOverlay('settings')}>
            Change shortcuts
          </button>
          <button type="button" class="icon-btn" aria-label="Close" onClick={closeOverlay}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div class="sheet-cols">
          {groups.map((g) => {
            const cmds = COMMANDS.filter((c) => c.group === g && keysFor(c.id).length > 0 && !c.planned);
            if (!cmds.length) return null;
            return (
              <section key={g}>
                <h3>{g}</h3>
                {cmds.map((c) => (
                  <div class="sheet-row" key={c.id}>
                    <span>{c.label}</span>
                    <Keys id={c.id} all />
                  </div>
                ))}
              </section>
            );
          })}
          <section>
            <h3>Mouse and Context</h3>
            {FIXED_KEYS.map((k) => (
              <div class="sheet-row" key={k.what}>
                <span>{k.what}</span>
                <span class="keys">
                  <kbd>{k.keys}</kbd>
                </span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------- Settings ----------

function ShortcutRow(props: { c: AppCommand; recording: boolean; onRecord: (on: boolean) => void }) {
  const { c } = props;
  const keys = keysFor(c.id);
  return (
    <div class={`key-row${props.recording ? ' recording' : ''}`} data-command={c.id}>
      <span class="kr-label">
        {c.label}
        {c.planned && <span class="step">step {c.planned}</span>}
      </span>
      <button type="button" class="key-btn" onClick={() => props.onRecord(!props.recording)} aria-label={`Change shortcut for ${c.label}`}>
        {props.recording ? 'Press keys…' : keys.length ? keys.map((k) => <kbd key={k}>{prettyCombo(k)}</kbd>) : <span class="none">None</span>}
      </button>
      <span class="kr-actions">
        {keys.length > 0 && !props.recording && (
          <button type="button" class="link" onClick={() => clearKey(c.id)}>
            Remove
          </button>
        )}
        {isCustomised(c.id) && !props.recording && (
          <button type="button" class="link" onClick={() => resetKey(c.id)}>
            Reset
          </button>
        )}
      </span>
    </div>
  );
}

/** The paste key, which works anywhere in Windows because it lives on a Start menu shortcut. */
function PasteShortcutRow(props: { label: string; recording: boolean; onRecord: (on: boolean) => void; onError: (e: string | null) => void }) {
  const [hotkey, setHotkey] = useState<string | null>(null);
  const { recording, onRecord, onError } = props;

  useEffect(() => {
    void platform.shortcut('paste').then((k) => setHotkey(k ? fromWindowsHotkey(k) : null));
  }, []);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return onRecord(false);
      const combo = comboOf(e);
      if (!combo) return;
      if (!isWindowsHotkey(combo)) {
        onError(`Windows needs Ctrl with Alt or Shift and a letter, number or F key, like Ctrl+Alt+V. ${prettyCombo(combo)} won't work.`);
        return;
      }
      onRecord(false);
      platform
        .setShortcut('paste', combo)
        .then(() => {
          setHotkey(combo);
          onError(null);
        })
        .catch((err) => onError(`Couldn't make the shortcut: ${String(err)}`));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  const remove = () =>
    platform
      .setShortcut('paste', null)
      .then(() => setHotkey(null))
      .catch((err) => onError(`Couldn't remove the shortcut: ${String(err)}`));

  return (
    <div class="general-row" data-shortcut="paste">
      <span>{props.label}</span>
      <button type="button" class="key-btn" onClick={() => onRecord(!recording)} aria-label="Change the paste shortcut">
        {recording ? 'Press keys…' : hotkey ? <kbd>{prettyCombo(hotkey)}</kbd> : <span class="none">Off</span>}
      </button>
      {hotkey && !recording && (
        <button type="button" class="link" onClick={remove}>
          Remove
        </button>
      )}
    </div>
  );
}

/** What happens once a capture is picked. */
function CaptureAfterRow(props: { options: platform.CaptureOptions; onChange: (o: platform.CaptureOptions) => void; onError: (e: string | null) => void }) {
  const { options } = props;
  const set = (change: platform.CaptureChange) => {
    props.onChange({ ...options, ...change });
    platform.setCaptureOptions(change).catch((err) => props.onError(`Couldn't change capture: ${String(err)}`));
  };
  return (
    <>
      <label class="general-row">
        <span>After a capture</span>
        <select data-setting="captureAfter" value={options.after} onChange={(e) => set({ after: (e.target as HTMLSelectElement).value as platform.CaptureAfter })}>
          <option value="notify">Copy it and show a notification</option>
          <option value="open">Open it in Sketch</option>
        </select>
      </label>
      {options.after === 'notify' && (
        <label class="general-row">
          <span>Press Left Shift to open the capture</span>
          <input type="checkbox" data-setting="captureShiftOpen" checked={options.shiftOpen} onChange={(e) => set({ shiftOpen: (e.target as HTMLInputElement).checked })} />
        </label>
      )}
      <label class="general-row">
        <span>Hide Sketch when capturing</span>
        <input type="checkbox" data-setting="captureHide" checked={options.hide} onChange={(e) => set({ hide: (e.target as HTMLInputElement).checked })} />
      </label>
    </>
  );
}

/** The capture helper keeps Sketch up to date while it's closed (1.5.0). An open Sketch updates itself either way. */
function BackgroundUpdatesRow(props: { options: platform.CaptureOptions; onChange: (o: platform.CaptureOptions) => void; onError: (e: string | null) => void }) {
  const { options } = props;
  return (
    <label class="general-row">
      <span>Update in the background when Sketch is closed</span>
      <input
        type="checkbox"
        data-setting="backgroundUpdates"
        checked={options.updates}
        onChange={(e) => {
          const updates = (e.target as HTMLInputElement).checked;
          props.onChange({ ...options, updates });
          platform.setCaptureOptions({ updates }).catch((err) => props.onError(`Couldn't change background updates: ${String(err)}`));
        }}
      />
    </label>
  );
}

/** "Windows uses Print Screen…" comes with a button that opens the Windows setting to change. */
function PrintScreenButton(props: { text: string | null | undefined }) {
  if (!props.text?.startsWith('Windows uses Print Screen')) return null;
  return (
    <>
      {' '}
      <button type="button" class="link" onClick={() => platform.openKeyboardSettings()}>
        Open Windows Settings
      </button>
    </>
  );
}

/** What a pointer looks like on a light and a dark patch, drawn from the same picture the cursor is made from. */
function PointerPreview(props: { shape: PointerShape }) {
  const { shape } = props;
  const p = pointerPrefs;
  return (
    <span class="pointer-preview" data-shape={shape} aria-hidden="true">
      {['light', 'dark'].map((tone) => (
        <span key={tone} class={`patch ${tone}`}>
          {shape === 'arrow' ? (
            <svg width="14" height="20" viewBox="0 0 14 20">
              <path d="M1.5 1.5v14l3.6-3.2 2.4 5.4 2.2-1-2.4-5.3h4.9z" fill={tone === 'light' ? '#000' : '#fff'} stroke={tone === 'light' ? '#fff' : '#000'} stroke-linejoin="round" />
            </svg>
          ) : shape === 'circle' ? (
            <span class="ring-sample" />
          ) : (
            <img src={imageUrl(pointerImage(shape, shape === 'dot' ? p.dotSize : p.crossSize, p.color))} alt="" />
          )}
        </span>
      ))}
    </span>
  );
}

function ShapeSelect(props: { setting: string; value: PointerShape; onPick: (v: PointerShape) => void }) {
  return (
    <select data-setting={props.setting} value={props.value} onChange={(e) => props.onPick((e.target as HTMLSelectElement).value as PointerShape)}>
      {POINTER_SHAPES.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

/** The pointer over the picture (F17): Windows' normal arrow, or a dot, a crosshair or the brush-size circle. */
function PointerSettings() {
  const p = pointerPrefs;
  const [custom, setCustom] = useState(p.color === 'auto' ? '#ff3b30' : p.color);
  const shapes = p.eraserOwn ? [p.shape, p.eraserShape] : [p.shape];
  // A circle picked for a tool with no brush size shows as a dot, so the dot's size counts too.
  const dotUsed = shapes.some((s) => s === 'dot' || s === 'circle');
  const crossUsed = shapes.includes('cross');
  return (
    <>
      <label class="general-row">
        <span>Pointer over the picture</span>
        <ShapeSelect setting="pointer" value={p.shape} onPick={(shape) => setPointer({ shape })} />
        <PointerPreview shape={p.shape} />
      </label>
      {dotUsed && (
        <label class="general-row">
          <span>Dot size</span>
          <input type="range" data-setting="pointerDotSize" min={DOT_SIZE.min} max={DOT_SIZE.max} value={p.dotSize} onInput={(e) => setPointer({ dotSize: Number((e.target as HTMLInputElement).value) })} />
          <span class="num-out">{p.dotSize} px</span>
        </label>
      )}
      {crossUsed && (
        <label class="general-row">
          <span>Crosshair size</span>
          <input type="range" data-setting="pointerCrossSize" min={CROSS_SIZE.min} max={CROSS_SIZE.max} value={p.crossSize} onInput={(e) => setPointer({ crossSize: Number((e.target as HTMLInputElement).value) })} />
          <span class="num-out">{p.crossSize} px</span>
        </label>
      )}
      {(dotUsed || crossUsed) && (
        <label class="general-row">
          <span>Dot and crosshair colour</span>
          <select
            data-setting="pointerColorMode"
            value={p.color === 'auto' ? 'auto' : 'custom'}
            onChange={(e) => setPointer({ color: (e.target as HTMLSelectElement).value === 'auto' ? 'auto' : custom })}
          >
            <option value="auto">Automatic (light with a dark edge)</option>
            <option value="custom">Pick a colour</option>
          </select>
          {p.color !== 'auto' && (
            <input
              type="color"
              data-setting="pointerColor"
              value={p.color}
              onInput={(e) => {
                const c = (e.target as HTMLInputElement).value;
                setCustom(c);
                setPointer({ color: c });
              }}
            />
          )}
        </label>
      )}
      <label class="general-row">
        <span>Different pointer for the eraser</span>
        <input type="checkbox" data-setting="pointerEraserOwn" checked={p.eraserOwn} onChange={(e) => setPointer({ eraserOwn: (e.target as HTMLInputElement).checked })} />
      </label>
      {p.eraserOwn && (
        <label class="general-row">
          <span>Eraser pointer</span>
          <ShapeSelect setting="pointerEraser" value={p.eraserShape} onPick={(eraserShape) => setPointer({ eraserShape })} />
          <PointerPreview shape={p.eraserShape} />
        </label>
      )}
    </>
  );
}

/** Settings for fitting into Windows: light or dark, where files from Explorer open, the pointer, the paste key, what a capture does and background updates. */
function GeneralSettings() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capture, setCapture] = useState<platform.CaptureOptions | null>(null);
  useEffect(() => void platform.captureOptions().then(setCapture), []);
  const shown = error ?? capture?.error;

  return (
    <div class="general">
      <h3>General</h3>
      <label class="general-row">
        <span>Colour theme</span>
        <select data-setting="theme" value={themePrefs.theme} onChange={(e) => setTheme((e.target as HTMLSelectElement).value as Theme)}>
          <option value="system">Same as Windows</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label class="general-row">
        <span>Open files from Explorer in</span>
        <select data-setting="openIn" value={windowPrefs.openIn} onChange={(e) => setOpenIn((e.target as HTMLSelectElement).value as OpenIn)}>
          <option value="window">A new tab</option>
          <option value="here">The tab showing</option>
        </select>
      </label>
      <PointerSettings />
      <label class="general-row">
        <span>Clean up rough shapes</span>
        <input type="checkbox" data-setting="cleanUp" checked={cleanUp.on} onChange={(e) => setCleanUp((e.target as HTMLInputElement).checked)} />
      </label>
      {platform.isTauri && (
        <>
          {capture && <CaptureAfterRow options={capture} onChange={setCapture} onError={setError} />}
          <PasteShortcutRow label="Open Sketch with the clipboard picture pasted" recording={recording} onRecord={setRecording} onError={setError} />
          <p class="hint">
            {shown ?? "The paste key and Capture Screen's shortcut (under File below) work anywhere in Windows, even when Sketch is closed. Capture Screen's can be Print Screen."}
            <PrintScreenButton text={shown} />
          </p>
          {capture && <BackgroundUpdatesRow options={capture} onChange={setCapture} onError={setError} />}
        </>
      )}
    </div>
  );
}

function Settings() {
  const [recording, setRecordingState] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState<string | null>(null);
  // The key listener reads this, so it's ready the moment a shortcut is clicked.
  const rec = useRef<string | null>(null);
  const setRecording = (id: string | null) => {
    rec.current = id;
    setRecordingState(id);
  };

  useEffect(() => {
    const takenNote = (combo: string, owner: AppCommand | undefined) =>
      owner ? `${prettyCombo(combo)} was taken from “${owner.label}”, which now has ${keysFor(owner.id).map(prettyCombo).join(', ') || 'no shortcut'}.` : null;
    const onKey = (e: KeyboardEvent) => {
      const id = rec.current;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        // Windows sends Print Screen to the page only as it's let go; only the capture key can have it.
        if ((e.type === 'keyup') !== (e.key === 'PrintScreen')) return;
        if (e.key === 'Escape') return setRecording(null);
        const combo = comboOf(e);
        if (!combo) return;
        const owner = keyOwner(combo, id);
        if (id === CAPTURE_ID) {
          if (!isCaptureHotkey(combo)) {
            setNote(`Capture Screen's shortcut works anywhere in Windows, so it needs Print Screen, or two of Ctrl, Alt and Shift with a letter, number or F key, like Alt+Shift+S. ${prettyCombo(combo)} won't work.`);
            return;
          }
          setRecording(null);
          setCaptureKey(combo).then(
            () => setNote(takenNote(combo, owner)),
            (err) => setNote(String(err)),
          );
          return;
        }
        if (e.key === 'PrintScreen') return;
        setKey(id, combo);
        setNote(takenNote(combo, owner));
        setRecording(null);
        return;
      }
      if (e.type === 'keydown' && e.key === 'Escape') {
        e.preventDefault();
        closeOverlay();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, []);

  const shown = filter.trim() ? searchCommands(filter, COMMANDS) : COMMANDS;
  const groups = ['Tools', 'File', 'Edit', 'Image', 'Adjust', 'View', 'Help'] as const;

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && !recording && closeOverlay()}>
      <div class="sheet settings" role="dialog" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={closeOverlay}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div class="settings-scroll">
        <GeneralSettings />
        <div class="settings-head">
          <h3>Keyboard Shortcuts</h3>
          <input type="text" class="filter" placeholder="Find a command" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          <button type="button" class="link" onClick={resetAllKeys}>
            Reset all
          </button>
        </div>
        <p class="hint">Click a shortcut, then press the new keys. Esc cancels.</p>
        {note && (
          <p class="note">
            {note}
            <PrintScreenButton text={note} />
          </p>
        )}
        <div class="key-list">
          {groups.map((g) => {
            const cmds = shown.filter((c) => c.group === g);
            if (!cmds.length) return null;
            return (
              <section key={g}>
                <h4>{g}</h4>
                {cmds.map((c) => (
                  <ShortcutRow key={c.id} c={c} recording={recording === c.id} onRecord={(on) => setRecording(on ? c.id : null)} />
                ))}
              </section>
            );
          })}
        </div>
        {/* About: no heading, just the logo with the name and version under the last section's line. */}
        <div class="settings-about">
          <img class="settings-about-logo" src={logo} alt="" />
          <div>
            <div class="settings-about-name">Sketch</div>
            <div class="settings-about-version">Version {__SKETCH_BUILD__.version}</div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

export function Overlays() {
  switch (app.overlay) {
    case 'palette':
      return <Palette />;
    case 'shortcuts':
      return <ShortcutsSheet />;
    case 'settings':
      return <Settings />;
    default:
      return null;
  }
}
