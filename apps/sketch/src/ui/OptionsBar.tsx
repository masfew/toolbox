import { Fragment, type Ref } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as actions from '../app/actions';
import { COLOR_TARGETS, LINE_TARGET, type ColorTarget } from '../app/colorTargets';
import { isClear } from '../app/color';
import { commandById, isEnabled, keysFor, runCommand } from '../app/commandList';
import { prettyCombo } from '../app/keys';
import { type ColorTargetId } from '../app/store';
import { currentTool, setOption, settingsOf } from '../app/tools';
import { getTool, type OptionSpec, type ToolSettings } from '../tools/registry';
import { optionsToolId, pickedCount } from '../tools/shapes';
import { ColorPopover } from './ColorPopover';
import { Icon } from './icons';
import { PreviewOption } from './PreviewOption';
import { PREVIEWS } from './previews';
import { DRAG_START_PX, scrubMove, scrubStart, type Scrub } from './scrub';

export const FONTS = ['Segoe UI', 'Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Georgia', 'Impact', 'Segoe Print', 'Times New Roman', 'Verdana'];

function plannedTip(o: OptionSpec): string | undefined {
  return o.planned ? `${o.hint ? o.hint + '. ' : ''}Comes in step ${o.planned}.` : o.hint;
}

interface ColorButtonSpec {
  target: ColorTarget;
  tip: string;
  /** A solid square of the colour, or a ring in it (an outline). */
  look: 'solid' | 'ring';
  /** Whether its picker offers No Colour (the shape and line colours). */
  noColour: boolean;
}

/**
 * Colour buttons for the three colour option kinds: colours 1 and 2 with the swap arrows between;
 * the shapes' fill and outline likewise; a line's one colour. A see-through colour shows the checkerboard with a red slash.
 */
function ColorButtons(props: { kind: 'colors' | 'shapeColors' | 'lineColor' }) {
  const [open, setOpen] = useState<{ id: ColorTargetId; anchor: DOMRect } | null>(null);
  // Pressing the open button closes the popover on pointer-down; its click then mustn't reopen it.
  // The time starts at -Infinity: the page's clock starts at 0, so a start of 0 could swallow a first click.
  const closed = useRef<{ id: string; at: number }>({ id: '', at: -Infinity });
  const swapKeys = keysFor('edit.swapColors').map(prettyCombo).join(', ');
  const specs: ColorButtonSpec[] =
    props.kind === 'colors'
      ? [
          { target: COLOR_TARGETS.primary, tip: 'Colour 1 (left click)', look: 'solid', noColour: false },
          { target: COLOR_TARGETS.secondary, tip: 'Colour 2 (right click)', look: 'solid', noColour: false },
        ]
      : props.kind === 'shapeColors'
        ? [
            { target: COLOR_TARGETS.fill, tip: 'Fill colour', look: 'solid', noColour: true },
            { target: COLOR_TARGETS.outline, tip: 'Outline colour', look: 'ring', noColour: true },
          ]
        : [{ target: LINE_TARGET, tip: 'Line colour', look: 'solid', noColour: true }];
  const button = (s: ColorButtonSpec) => {
    const color = s.target.read();
    return (
      <button
        type="button"
        class={`sw${open?.id === s.target.id ? ' open' : ''}`}
        data-tip={s.tip}
        aria-label={s.tip}
        data-color={s.target.id}
        onClick={(e) => {
          if (closed.current.id === s.target.id && performance.now() - closed.current.at < 500) return;
          setOpen({ id: s.target.id, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() });
        }}
      >
        <span class={`${s.look}${isClear(color) ? ' clear' : ''}`} style={{ '--c': color }} />
      </button>
    );
  };
  const swap = (tip: string, run: () => void) => (
    <button type="button" class="icon-btn small" data-tip={tip} data-keys={swapKeys} aria-label={tip} onClick={run}>
      <Icon name="swap" size={14} />
    </button>
  );
  const shown = specs.find((s) => s.target.id === open?.id);
  return (
    <div class={`opt colors${props.kind === 'colors' ? '' : ' shape-colors'}`}>
      {props.kind === 'shapeColors' && <span class="opt-label">Fill</span>}
      {props.kind === 'lineColor' && <span class="opt-label">Colour</span>}
      {button(specs[0])}
      {props.kind === 'colors' && swap('Swap colours', actions.swapPrimarySecondary)}
      {props.kind === 'shapeColors' && swap('Swap fill and outline colours', actions.swapShapeColors)}
      {specs[1] && button(specs[1])}
      {open && shown && (
        <ColorPopover
          target={shown.target}
          noColour={shown.noColour}
          anchor={open.anchor}
          onClose={() => {
            closed.current = { id: shown.target.id, at: performance.now() };
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}

type RangeSpec = Extract<OptionSpec, { kind: 'range' }>;

/**
 * The box of a number option, shared by the slider and the drag label. Typed numbers apply at once (clicking the
 * canvas starts a stroke before the box loses focus); arrows change it by 1, Shift by 10; Enter or Escape finishes.
 */
function NumberBox(props: { toolId: string; o: RangeSpec; value: number; inputRef?: Ref<HTMLInputElement> }) {
  const { o, toolId } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const typed = (text: string) => {
    setDraft(text);
    const n = Number(text);
    if (text.trim() && Number.isFinite(n)) setOption(toolId, o.key, Math.min(o.max, Math.max(o.min, Math.round(n))));
  };
  const commit = () => setDraft(null);
  return (
    <input
      ref={props.inputRef}
      type="text"
      inputMode="numeric"
      class="num"
      value={draft ?? String(props.value)}
      disabled={!!o.planned}
      aria-label={`${o.label} value`}
      onInput={(e) => typed((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
          setOption(toolId, o.key, Math.min(o.max, Math.max(o.min, props.value + step)));
          setDraft(null);
        }
      }}
    />
  );
}

function RangeOption(props: { toolId: string; o: RangeSpec; value: number }) {
  const { o, toolId } = props;
  return (
    <label class="opt range" data-tip={plannedTip(o)}>
      <span class="opt-label">{o.label}</span>
      <input
        type="range"
        min={o.min}
        max={o.max}
        value={props.value}
        disabled={!!o.planned}
        aria-label={o.label}
        onInput={(e) => setOption(toolId, o.key, Number((e.target as HTMLInputElement).value))}
      />
      <NumberBox toolId={toolId} o={o} value={props.value} />
      {o.unit && <span class="unit">{o.unit}</span>}
    </label>
  );
}

/**
 * A number with no slider: an icon and name you drag left or right (1 per 2 px, Shift ten times as fast),
 * and a box you can type in. A press that doesn't move puts the cursor in the box. The drag locks the pointer so
 * it never stops at the screen edge; where the window can't lock it, the drag follows the pointer (captured) instead.
 * `data-lock` on the label says which: pending, locked or fallback.
 */
function ScrubOption(props: { toolId: string; o: RangeSpec; value: number }) {
  const { o, toolId } = props;
  const box = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Ends the drag in progress (also when the bar goes away mid-drag, so the pointer is never left locked).
  const end = useRef<(() => void) | null>(null);
  const latest = useRef(props.value);
  latest.current = props.value;
  useEffect(() => () => end.current?.(), []);

  const down = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary || o.planned) return;
    end.current?.();
    const el = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    let lastX = startX;
    let state: Scrub | null = null;
    let applied = latest.current;
    let wasLocked = false;
    const lockChange = () => {
      if (document.pointerLockElement === el) {
        wasLocked = true;
        el.dataset.lock = 'locked';
      } else if (wasLocked) finish(); // Escape in the lock ends the drag
    };
    const lockError = () => (el.dataset.lock = 'fallback');
    const move = (ev: PointerEvent) => {
      // Locked, the pointer stays put and only `movementX` moves; otherwise it follows the captured pointer.
      const dx = document.pointerLockElement === el ? ev.movementX : ev.clientX - lastX;
      lastX = ev.clientX;
      if (!state) {
        if (Math.abs(ev.clientX - startX) < DRAG_START_PX) return;
        state = scrubStart(applied);
        el.dataset.lock = 'pending';
        try {
          const asked = el.requestPointerLock() as unknown as Promise<void> | undefined;
          asked?.catch?.(lockError);
        } catch {
          lockError();
        }
        setDragging(true);
        return;
      }
      state = scrubMove(state, dx, ev.shiftKey, o.min, o.max);
      if (state.value !== applied) {
        applied = state.value;
        setOption(toolId, o.key, applied);
      }
    };
    const up = () => {
      const click = !state;
      finish();
      if (click) {
        box.current?.focus();
        box.current?.select();
      }
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.removeEventListener('pointerlockchange', lockChange);
      document.removeEventListener('pointerlockerror', lockError);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {}
      if (document.pointerLockElement === el) document.exitPointerLock();
      delete el.dataset.lock;
      end.current = null;
      setDragging(false);
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.addEventListener('pointerlockchange', lockChange);
    document.addEventListener('pointerlockerror', lockError);
    end.current = finish;
  };

  return (
    <div class={`opt range drag${dragging ? ' dragging' : ''}${o.planned ? ' planned' : ''}`} data-tip={plannedTip(o)}>
      <span class="scrub" role="presentation" onPointerDown={down}>
        <Icon name={o.icon ?? ''} size={16} />
        {o.label}
      </span>
      <label class="val">
        <NumberBox toolId={toolId} o={o} value={props.value} inputRef={box} />
        {o.unit && <span class="unit">{o.unit}</span>}
      </label>
    </div>
  );
}

function Option(props: { toolId: string; o: OptionSpec; settings: ToolSettings }) {
  const { o, toolId, settings } = props;
  const value = settings[o.key];
  switch (o.kind) {
    case 'colors':
    case 'shapeColors':
    case 'lineColor':
      return <ColorButtons kind={o.kind} />;
    case 'range':
      return o.control === 'drag' ? <ScrubOption toolId={toolId} o={o} value={value as number} /> : <RangeOption toolId={toolId} o={o} value={value as number} />;
    case 'toggle':
      return (
        <button
          type="button"
          class={`opt toggle${value ? ' on' : ''}`}
          aria-pressed={!!value}
          disabled={!!o.planned}
          data-tip={plannedTip(o)}
          onClick={() => setOption(toolId, o.key, !value)}
        >
          {o.label}
        </button>
      );
    case 'choice':
      if (o.display === 'preview' && PREVIEWS[o.key]) return <PreviewOption toolId={toolId} o={o} value={value as string} />;
      if (o.choices.length <= 2) {
        return (
          <div class="opt choice" role="radiogroup" aria-label={o.label} data-tip={plannedTip(o)}>
            <span class="opt-label">{o.label}</span>
            <div class="segmented">
              {o.choices.map((c) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={value === c.value}
                  key={c.value}
                  class={value === c.value ? 'on' : ''}
                  disabled={!!o.planned}
                  onClick={() => setOption(toolId, o.key, c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        );
      }
      return (
        <label class="opt select" data-tip={plannedTip(o)}>
          <span class="opt-label">{o.label}</span>
          <select value={value as string} disabled={!!o.planned} onChange={(e) => setOption(toolId, o.key, (e.target as HTMLSelectElement).value)}>
            {o.choices.map((c) => (
              <option value={c.value} key={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      );
    case 'action': {
      const c = commandById.get(o.command);
      return (
        <button type="button" class="opt action" disabled={!c || !isEnabled(c)} data-tip={o.hint} onClick={() => runCommand(o.command)}>
          {o.label}
        </button>
      );
    }
    case 'font':
      return (
        <label class="opt select" data-tip={plannedTip(o)}>
          <span class="opt-label">{o.label}</span>
          <select value={value as string} disabled={!!o.planned} onChange={(e) => setOption(toolId, o.key, (e.target as HTMLSelectElement).value)}>
            {(FONTS.includes(value as string) ? FONTS : [value as string, ...FONTS]).map((f) => (
              <option value={f} key={f} style={{ fontFamily: f }}>
                {f}
              </option>
            ))}
          </select>
        </label>
      );
  }
}

const ARRANGE = ['arrange.left', 'arrange.hcentre', 'arrange.right', 'arrange.top', 'arrange.vcentre', 'arrange.bottom', 'arrange.spaceX', 'arrange.spaceY'];

/** A thin divider between groups of controls. */
function Divider() {
  return <span class="sep" role="separator" aria-orientation="vertical" />;
}

/** Buttons to line up several picked shapes, and to space three or more evenly. */
function ArrangeButtons() {
  if (pickedCount() < 2) return null;
  return (
    <>
      <Divider />
      <div class="opt arrange" role="group" aria-label="Line up">
        {ARRANGE.map((id) => {
          const c = commandById.get(id)!;
          if (!isEnabled(c)) return null;
          return (
            <button type="button" key={id} class="icon-btn small" data-tip={c.label} aria-label={c.label} onClick={() => runCommand(id)}>
              <Icon name={c.icon!} size={16} />
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * The bar under the menus: only the current tool's settings, built from the tool's option list.
 * While shapes are picked it shows the first one's settings, and changing them changes the shapes.
 */
export function OptionsBar() {
  const tool = getTool(optionsToolId(currentTool().id));
  const settings = settingsOf(tool.id);
  return (
    <div class="options" role="toolbar" aria-label={`${tool.name} options`}>
      <span class="tool-name">
        <Icon name={tool.icon} size={16} />
        {tool.name}
      </span>
      {tool.options.map((o, i) => (
        <Fragment key={`${tool.id}.${o.key}`}>
          {(i === 0 || o.group) && <Divider />}
          <Option toolId={tool.id} o={o} settings={settings} />
        </Fragment>
      ))}
      <ArrangeButtons />
      {tool.planned && <span class="planned-note">This tool comes in step {tool.planned}</span>}
    </div>
  );
}
