import { useRef, useState } from 'preact/hooks';
import * as actions from '../app/actions';
import { commandById, isEnabled, keysFor, runCommand } from '../app/commandList';
import { prettyCombo } from '../app/keys';
import { app } from '../app/store';
import { currentTool, setOption, settingsOf } from '../app/tools';
import { getTool, type OptionSpec, type ToolSettings } from '../tools/registry';
import { optionsToolId, pickedCount } from '../tools/shapes';
import { ColorPopover } from './ColorPopover';
import { Icon } from './icons';

export const FONTS = ['Segoe UI', 'Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Georgia', 'Impact', 'Segoe Print', 'Times New Roman', 'Verdana'];

function plannedTip(o: OptionSpec): string | undefined {
  return o.planned ? `${o.hint ? o.hint + '. ' : ''}Comes in step ${o.planned}.` : o.hint;
}

function ColorChips() {
  const [open, setOpen] = useState<{ which: 'primary' | 'secondary'; anchor: DOMRect } | null>(null);
  // Pressing the open chip closes the popover on pointer-down; its click then mustn't reopen it.
  const closed = useRef({ which: '', at: 0 });
  const swapKeys = keysFor('edit.swapColors').map(prettyCombo).join(', ');
  const chip = (which: 'primary' | 'secondary', tip: string) => (
    <button
      type="button"
      class={`chip ${which}${open?.which === which ? ' open' : ''}`}
      data-tip={tip}
      aria-label={tip}
      data-color={which}
      onClick={(e) => {
        if (closed.current.which === which && performance.now() - closed.current.at < 500) return;
        setOpen({ which, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() });
      }}
    >
      <span style={{ background: app[which] }} />
    </button>
  );
  return (
    <div class="opt colors">
      {chip('primary', 'Colour 1 (left click)')}
      {chip('secondary', 'Colour 2 (right click)')}
      <button type="button" class="icon-btn small" data-tip="Swap colours" data-keys={swapKeys} aria-label="Swap colours" onClick={actions.swapColors}>
        <Icon name="swap" size={14} />
      </button>
      {open && (
        <ColorPopover
          which={open.which}
          anchor={open.anchor}
          onClose={() => {
            closed.current = { which: open.which, at: performance.now() };
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}

function RangeOption(props: { toolId: string; o: Extract<OptionSpec, { kind: 'range' }>; value: number }) {
  const { o, toolId } = props;
  const [draft, setDraft] = useState<string | null>(null);
  // Typed numbers apply at once: clicking the canvas starts a stroke before the box loses focus.
  const typed = (text: string) => {
    setDraft(text);
    const n = Number(text);
    if (text.trim() && Number.isFinite(n)) setOption(toolId, o.key, Math.min(o.max, Math.max(o.min, Math.round(n))));
  };
  const commit = () => setDraft(null);
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
      <input
        type="text"
        inputMode="numeric"
        class="num"
        value={draft ?? String(props.value)}
        disabled={!!o.planned}
        aria-label={`${o.label} value`}
        onInput={(e) => typed((e.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
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
      {o.unit && <span class="unit">{o.unit}</span>}
    </label>
  );
}

function Option(props: { toolId: string; o: OptionSpec; settings: ToolSettings }) {
  const { o, toolId, settings } = props;
  const value = settings[o.key];
  switch (o.kind) {
    case 'colors':
      return <ColorChips />;
    case 'range':
      return <RangeOption toolId={toolId} o={o} value={value as number} />;
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

/** Buttons to line up several picked shapes, and to space three or more evenly. */
function ArrangeButtons() {
  if (pickedCount() < 2) return null;
  return (
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
      {tool.options.map((o) => (
        <Option key={`${tool.id}.${o.key}`} toolId={tool.id} o={o} settings={settings} />
      ))}
      <ArrangeButtons />
      {tool.planned && <span class="planned-note">This tool comes in step {tool.planned}</span>}
    </div>
  );
}
