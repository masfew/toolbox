import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as actions from '../app/actions';
import type { ColorTarget } from '../app/colorTargets';
import { hsvToRgb, opaqueHex, parseHex, rgbToHsv, SWATCHES, toHex, type HSV } from '../app/color';
import { app, changed, toast } from '../app/store';
import { Icon } from './icons';

/** Calls `onMove` with the pointer's position inside `el` (0 to 1 each way) while dragging. */
function dragIn(e: PointerEvent, onMove: (x: number, y: number) => void): void {
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const at = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect();
    onMove(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
  };
  at(e);
  const move = (ev: PointerEvent) => at(ev);
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

/**
 * A small colour picker that opens under a colour button: a colour square, hue and opacity, hex, recent
 * colours and swatches. It edits `target`; `noColour` adds a No Colour button (opacity 0%) before the picker button.
 */
export function ColorPopover(props: { target: ColorTarget; noColour?: boolean; anchor: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const initial = useRef(props.target.read());
  const start = parseHex(props.target.read()) ?? { r: 0, g: 0, b: 0, a: 1 };
  // Hue is kept here, so it doesn't jump when the colour turns grey or black.
  const [hsv, setHsv] = useState<HSV>(rgbToHsv(start));
  const [alpha, setAlpha] = useState(start.a);
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [pos, setPos] = useState({ left: props.anchor.left, top: props.anchor.bottom + 6 });

  const apply = (next: HSV, a: number) => {
    setHsv(next);
    setAlpha(a);
    props.target.write(toHex(hsvToRgb(next, a)));
  };

  const applyHex = (hex: string) => {
    const c = parseHex(hex);
    if (!c) return false;
    const next = rgbToHsv(c);
    apply(c.r === c.g && c.g === c.b ? { ...next, h: hsv.h } : next, c.a);
    return true;
  };

  /** Starts or ends waiting for a press on the picture, which sets this popover's colour. */
  const setPicking = (on: boolean) => {
    const into = on ? props.target.id : null;
    if (app.pickInto === into) return;
    app.pickInto = into;
    changed();
  };

  const close = () => {
    setPicking(false);
    const now = props.target.read();
    if (now.toLowerCase() !== initial.current.toLowerCase()) actions.rememberColor(now);
    props.onClose();
  };

  // Keep the popover inside the window.
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(props.anchor.left, window.innerWidth - r.width - 8)),
      top: props.anchor.bottom + 6 + r.height > window.innerHeight - 8 ? Math.max(8, props.anchor.top - r.height - 6) : props.anchor.bottom + 6,
    });
  }, [props.anchor]);

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      // The picker button waits for a press on the picture, which the picture takes as the pick.
      if (app.pickInto && (e.target as HTMLElement).closest?.('canvas.view')) return;
      // A click on the colour button itself also lands here, so it closes and the button's own click finds it closed.
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Esc ends picking first, and the next one closes the popover.
        if (app.pickInto) setPicking(false);
        else close();
      }
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', key, true);
    };
  });

  const color = props.target.read();
  const picking = app.pickInto === props.target.id;
  const solid = opaqueHex(color);
  const hueColor = toHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));

  // The popover can go without close() (a tool with no colours takes its place), so picking ends with it.
  useEffect(
    () => () => {
      if (app.pickInto) {
        app.pickInto = null;
        changed();
      }
    },
    [],
  );

  // A colour picked from the picture sets the app's colour; the square, hue and opacity follow it.
  useEffect(() => {
    if (color.toLowerCase() === toHex(hsvToRgb(hsv, alpha)).toLowerCase()) return;
    const c = parseHex(color);
    if (!c) return;
    const next = rgbToHsv(c);
    setHsv(c.r === c.g && c.g === c.b ? { ...next, h: hsv.h } : next);
    setAlpha(c.a);
  }, [color]);

  const swatch = (c: string, label: string) => (
    <button
      type="button"
      key={c}
      class={`swatch-btn${c.toLowerCase() === color.toLowerCase() ? ' on' : ''}`}
      style={{ '--c': c }}
      data-tip={label}
      aria-label={label}
      onClick={() => applyHex(c)}
    />
  );

  return (
    <div class="popover color-popover" ref={ref} style={{ left: `${pos.left}px`, top: `${pos.top}px` }} role="dialog" aria-label={props.target.label}>
      <div class="sv" style={{ background: hueColor }} onPointerDown={(e) => dragIn(e, (x, y) => apply({ h: hsv.h, s: x, v: 1 - y }, alpha))}>
        <div class="sv-white" />
        <div class="sv-black" />
        <span class="sv-dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: solid }} />
      </div>
      <div class="slider hue" onPointerDown={(e) => dragIn(e, (x) => apply({ ...hsv, h: x * 360 }, alpha))} aria-label="Hue">
        <span class="thumb" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
      <div class="slider alpha" style={{ '--c': solid }} onPointerDown={(e) => dragIn(e, (x) => apply(hsv, Math.round(x * 100) / 100))} aria-label="Opacity">
        <span class="thumb" style={{ left: `${alpha * 100}%` }} />
      </div>
      <div class={`color-row${props.noColour ? ' has-none' : ''}`}>
        <span class="preview" style={{ '--c': color }} />
        <input
          type="text"
          class="hex"
          spellcheck={false}
          aria-label="Hex colour"
          value={hexDraft ?? color.toUpperCase()}
          onInput={(e) => setHexDraft((e.target as HTMLInputElement).value)}
          onBlur={() => {
            if (hexDraft !== null) applyHex(hexDraft);
            setHexDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (hexDraft !== null && !applyHex(hexDraft)) toast('Type a colour as hex, like #FF8800.');
              setHexDraft(null);
            }
          }}
        />
        <span class="alpha-pct">{Math.round(alpha * 100)}%</span>
        {props.noColour && (
          <button
            type="button"
            class="icon-btn small no-colour"
            data-tip="No Colour"
            aria-label="No Colour"
            data-no-colour
            onClick={() => apply(hsv, 0)}
          >
            <span />
          </button>
        )}
        <button
          type="button"
          class={`icon-btn${picking ? ' on' : ''}`}
          data-tip="Pick a colour from the picture"
          aria-label="Pick a colour from the picture"
          aria-pressed={picking}
          onClick={() => setPicking(!picking)}
        >
          <Icon name="picker" size={16} />
        </button>
      </div>
      {app.recentColors.length > 0 && (
        <>
          <div class="pop-label">Recent</div>
          <div class="swatches">{app.recentColors.map((c) => swatch(c, c.toUpperCase()))}</div>
        </>
      )}
      <div class="pop-label">Colours</div>
      <div class="swatches">{SWATCHES.map((c) => swatch(c, c.toUpperCase()))}</div>
    </div>
  );
}
