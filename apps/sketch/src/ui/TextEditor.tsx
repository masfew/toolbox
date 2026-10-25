import { useLayoutEffect, useRef } from 'preact/hooks';
import { opaqueHex } from '../app/color';
import { app } from '../app/store';
import { layoutText } from '../engine/objects';
import { commitText, updateText } from '../tools/text';

/** Space between the text and the dashed frame you drag to move it, in view pixels. */
const FRAME = 6;

/**
 * Typing into a text box. The picture draws the text (with its outline and box); this box over it
 * holds the caret and the typing, with see-through letters laid out the same way.
 */
export function TextEditor() {
  const te = app.textEdit;
  const area = useRef<HTMLTextAreaElement>(null);
  const editing = te?.obj.id;

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    // The box grows after each letter, so it mustn't stay scrolled from before it grew.
    el.scrollLeft = 0;
    el.scrollTop = 0;
    // Keep typing here after a click on the options bar, unless a box there is being typed in.
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body || a.tagName === 'BUTTON') el.focus();
  });

  if (!te) return null;
  const o = te.obj;
  const v = app.viewport;
  const z = v.zoom;
  const layout = layoutText(o);
  const pos = v.toScreen(o.x, o.y);
  const off = (o.box ? layout.pad * z : 0) + FRAME;

  const startMove = (e: PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const x0 = o.x;
    const y0 = o.y;
    const move = (ev: PointerEvent) => updateText({ x: Math.round(x0 + (ev.clientX - sx) / z), y: Math.round(y0 + (ev.clientY - sy) / z) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      area.current?.focus();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      class="text-edit"
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        padding: `${off - 1}px`,
        transform: `rotate(${o.angle}rad) translate(${-off}px, ${-off}px)`,
      }}
      onPointerDown={startMove}
    >
      <textarea
        ref={area}
        value={o.text}
        spellcheck={false}
        aria-label="Text"
        wrap={o.width === null ? 'off' : 'soft'}
        style={{
          fontFamily: `"${o.font}", sans-serif`,
          fontSize: `${o.size * z}px`,
          fontWeight: o.bold ? 'bold' : 'normal',
          fontStyle: o.italic ? 'italic' : 'normal',
          lineHeight: `${layout.lineHeight * z}px`,
          width: `${layout.width * z + (o.width === null ? 2 : 0)}px`,
          height: `${Math.max(layout.lineHeight, layout.height) * z}px`,
          textAlign: o.align,
          whiteSpace: o.width === null ? 'pre' : 'pre-wrap',
          caretColor: opaqueHex(o.color),
        }}
        onInput={(e) => updateText({ text: (e.target as HTMLTextAreaElement).value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
            e.preventDefault();
            commitText();
          }
        }}
      />
    </div>
  );
}
