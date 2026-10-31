import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { setOption } from '../app/tools';
import type { OptionSpec } from '../tools/registry';
import { Icon } from './icons';
import { PREVIEWS, type PreviewSpec } from './previews';

type ChoiceOption = Extract<OptionSpec, { kind: 'choice' }>;

/** The menu under a preview square: each choice with its drawing and name, the current one ticked. */
function ChoiceMenu(props: { o: ChoiceOption; spec: PreviewSpec; value: string; anchor: DOMRect; anchorEl: HTMLElement | null; onPick: (value: string) => void; onClose: (refocus: boolean) => void }) {
  const { o, spec } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.anchor.left, top: props.anchor.bottom + 6 });
  const items = () => [...ref.current!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];

  // Keep the menu inside the window, and put focus on the current choice.
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(props.anchor.left, window.innerWidth - r.width - 8)),
      top: props.anchor.bottom + 6 + r.height > window.innerHeight - 8 ? Math.max(8, props.anchor.top - r.height - 6) : props.anchor.bottom + 6,
    });
    (items().find((el) => el.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
  }, [props.anchor]);

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      // A press on the square itself is its own click, which closes the menu.
      if (!ref.current?.contains(t) && !props.anchorEl?.contains(t)) props.onClose(false);
    };
    const key = (e: KeyboardEvent) => {
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const go = (i: number) => list[(i + list.length) % list.length]?.focus();
      let handled = true;
      if (e.key === 'ArrowDown') go(at + 1);
      else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(-1);
      else if (e.key === 'Enter' || e.key === ' ') {
        if (at >= 0) props.onPick(o.choices[at].value);
      } else if (e.key === 'Escape') props.onClose(true);
      else if (e.key === 'Tab') {
        props.onClose(true);
        handled = false;
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', key, true);
    };
  });

  return (
    <div ref={ref} class="popover choice-menu" role="menu" aria-label={spec.name} style={{ left: `${pos.left}px`, top: `${pos.top}px` }}>
      {o.choices.map((c) => (
        <button type="button" key={c.value} class="item" role="menuitemradio" aria-checked={c.value === props.value} tabIndex={-1} data-value={c.value} onClick={() => props.onPick(c.value)}>
          <span class="box">{spec.draw(c.value, 16)}</span>
          <span class="grow">{c.label}</span>
          {c.value === props.value && <Icon name="check" size={14} class="tick" />}
        </button>
      ))}
    </div>
  );
}

/**
 * A square that shows the chosen value and opens a short menu of the choices (line style, arrowheads).
 * The menu opens under the square: Up and Down move, Enter or Space picks, Escape closes.
 */
export function PreviewOption(props: { toolId: string; o: ChoiceOption; value: string }) {
  const { o, toolId } = props;
  const spec = PREVIEWS[o.key];
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const current = o.choices.find((c) => c.value === props.value) ?? o.choices[0];
  // The menu can go without closing (a tool change takes the bar away); nothing else is left to clean up.
  const close = (refocus: boolean) => {
    setAnchor(null);
    if (refocus) btn.current?.focus();
  };
  return (
    <div class="opt preview" data-preview={o.key}>
      {spec.label && <span class="opt-label">{o.label}</span>}
      <button
        ref={btn}
        type="button"
        class={`sw${anchor ? ' open' : ''}`}
        data-tip={o.planned ? `Comes in step ${o.planned}.` : spec.name}
        aria-label={`${spec.name}, ${current.label.toLowerCase()}`}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        disabled={!!o.planned}
        onClick={(e) => setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        {spec.draw(current.value, 18)}
      </button>
      {anchor && (
        <ChoiceMenu
          o={o}
          spec={spec}
          value={props.value}
          anchor={anchor}
          anchorEl={btn.current}
          onPick={(v) => {
            setOption(toolId, o.key, v);
            close(true);
          }}
          onClose={close}
        />
      )}
    </div>
  );
}
