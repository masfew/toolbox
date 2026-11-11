import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { mouse, MOUSE_MAX, MOUSE_MIN, mousePercent, setMouseOn, setMouseSpeed, toggleMouseSpeed } from '../app/mouse';
import * as platform from '../platform';
import { Icon } from './icons';

function speedText(offset: number): string {
  return offset === 0 ? 'Normal' : `${mousePercent(offset)}%`;
}

/** The speed as the popover's heading shows it: a speed that's switched off says so. */
function valueText(): string {
  return !mouse.on && mouse.offset !== 0 ? `Off · ${speedText(mouse.offset)}` : speedText(mouse.offset);
}

function MouseSpeedPopover(props: { anchor: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.anchor.right + 8, top: props.anchor.top });

  // Beside the button in the tool rail, its bottom level with the button's, kept inside the window.
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ left: props.anchor.right + 8, top: Math.max(8, Math.min(props.anchor.bottom - r.height, window.innerHeight - r.height - 8)) });
  }, [props.anchor]);

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
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
    <div ref={ref} class="popover mouse-popover" role="dialog" aria-label="Mouse speed" style={{ left: `${pos.left}px`, top: `${pos.top}px` }}>
      <div class="mouse-head">
        <span class="mouse-title">Mouse speed</span>
        <span class="mouse-value">{valueText()}</span>
      </div>
      <input
        type="range"
        min={MOUSE_MIN}
        max={MOUSE_MAX}
        step={1}
        value={mouse.offset}
        aria-label="Mouse speed"
        aria-valuetext={speedText(mouse.offset)}
        list="mouse-normal"
        data-tip="Double-click for normal"
        // Taking hold of the slider switches a speed that's off back on, even without moving it.
        onPointerDown={() => {
          if (mouse.offset !== 0) setMouseOn(true);
        }}
        onInput={(e) => setMouseSpeed(Number((e.target as HTMLInputElement).value))}
        onDblClick={() => setMouseSpeed(0)}
      />
      {/* A tick mark at normal speed. */}
      <datalist id="mouse-normal">
        <option value="0" />
      </datalist>
      <div class="mouse-ends">
        <span>Slower</span>
        <span>Normal</span>
      </div>
      <p class="mouse-note">{platform.isTauri ? 'Only while you hold Left Ctrl. The rest of the time, drawing included, the mouse keeps its own speed.' : 'Works only in the Sketch app.'}</p>
      {platform.isTauri && mouse.offset !== 0 && (
        <p class="mouse-note">
          {mouse.on ? 'Click the button to switch this off and on. Hold it to see this again.' : 'Switched off, so Left Ctrl does nothing. Touching the slider switches it back on.'}
        </p>
      )}
      <button type="button" class="mouse-reset" disabled={mouse.offset === 0} onClick={() => setMouseSpeed(0)}>
        Reset to Normal
      </button>
    </div>
  );
}

/** The button in the tool rail that opens the mouse speed slider. It's coloured while the speed isn't normal. */
export function MouseSpeedButton() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // Pressing the button while open closes the popover on pointer-down; its click then mustn't reopen it.
  const closedAt = useRef(-Infinity);
  const holdTimer = useRef(0);
  // A press that held long enough to open the menu, or that closed it, mustn't also switch the speed when it's let go.
  const skipClick = useRef(false);
  const changed = mouse.on && mouse.offset !== 0;
  const tip = changed
    ? `Mouse speed with Left Ctrl held: ${speedText(mouse.offset)}`
    : mouse.offset !== 0
      ? `Mouse speed off (${speedText(mouse.offset)} with Left Ctrl held)`
      : 'Mouse speed with Left Ctrl held';
  const hint = mouse.offset === 0 ? 'Click to pick a speed' : mouse.on ? 'Click to turn off, hold for settings' : 'Click to turn on, hold for settings';
  const justClosed = () => performance.now() - closedAt.current < 500;
  const open = (el: HTMLElement) => {
    if (justClosed()) return;
    setAnchor(el.getBoundingClientRect());
  };
  return (
    <>
      <button
        type="button"
        class={`rail-btn mouse-btn${changed ? ' changed' : ''}${anchor ? ' on' : ''}`}
        aria-label={tip}
        aria-pressed={mouse.offset !== 0 ? mouse.on : undefined}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        data-tip={anchor ? undefined : platform.isTauri ? `${tip}\n${hint}` : tip}
        data-tip-side="right"
        onPointerDown={(e) => {
          clearTimeout(holdTimer.current);
          // The popover closes itself on this same press, just before this runs.
          skipClick.current = justClosed();
          if (e.button !== 0 || skipClick.current) return;
          const el = e.currentTarget as HTMLElement;
          holdTimer.current = window.setTimeout(() => {
            skipClick.current = true;
            open(el);
          }, 400);
        }}
        onPointerUp={() => clearTimeout(holdTimer.current)}
        onPointerLeave={() => clearTimeout(holdTimer.current)}
        onClick={(e) => {
          // A keyboard click (detail 0) never follows a press, so a skip left by an earlier press doesn't apply.
          const skip = skipClick.current && e.detail !== 0;
          skipClick.current = false;
          if (skip || justClosed()) return;
          // Nothing to switch on while the speed is normal, so a click opens the menu to pick one.
          if (!toggleMouseSpeed()) open(e.currentTarget as HTMLElement);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          open(e.currentTarget as HTMLElement);
        }}
      >
        <Icon name="mouse" size={20} />
        <span
          class="corner"
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation();
            open((e.currentTarget as HTMLElement).parentElement!);
          }}
        />
      </button>
      {anchor && (
        <MouseSpeedPopover
          anchor={anchor}
          onClose={() => {
            closedAt.current = performance.now();
            setAnchor(null);
          }}
        />
      )}
    </>
  );
}
