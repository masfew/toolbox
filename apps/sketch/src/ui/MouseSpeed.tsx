import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { mouse, MOUSE_MAX, MOUSE_MIN, mousePercent, setMouseSpeed } from '../app/mouse';
import * as platform from '../platform';
import { Icon } from './icons';

function speedText(offset: number): string {
  return offset === 0 ? 'Normal' : `${mousePercent(offset)}%`;
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
        <span class="mouse-value">{speedText(mouse.offset)}</span>
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
      <button type="button" class="mouse-reset" disabled={mouse.offset === 0} onClick={() => setMouseSpeed(0)}>
        Reset to Normal
      </button>
    </div>
  );
}

/** The button in the tool rail that opens the mouse speed slider. It's coloured, with a notice icon, while the speed isn't normal. */
export function MouseSpeedButton() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // Pressing the button while open closes the popover on pointer-down; its click then mustn't reopen it.
  const closedAt = useRef(-Infinity);
  const changed = mouse.offset !== 0;
  const tip = changed ? `Mouse speed with Left Ctrl held: ${speedText(mouse.offset)}` : 'Mouse speed with Left Ctrl held';
  return (
    <>
      <button
        type="button"
        class={`rail-btn mouse-btn${changed ? ' changed' : ''}${anchor ? ' on' : ''}`}
        aria-label={tip}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        data-tip={anchor ? undefined : tip}
        data-tip-side="right"
        onClick={(e) => {
          if (performance.now() - closedAt.current < 500) return;
          setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
      >
        <Icon name="mouse" size={20} />
        {changed && <Icon name="alert" size={11} class="mouse-badge" />}
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
