import { useRef } from 'preact/hooks';
import { keysFor } from '../app/commandList';
import { prettyCombo } from '../app/keys';
import { tabs } from '../app/store';
import { closeTab, moveTab, switchTo, tearOff } from '../app/tabs';
import { Icon } from './icons';

/** How far the pointer moves before a press on a tab becomes a drag. */
const DRAG_PX = 5;
/** How far past the window's edge a tab is dragged to move it into a window of its own. */
const OUT_PX = 24;

const closeKeys = () => keysFor('tab.close').slice(0, 1).map(prettyCombo).join('');

/**
 * The open pictures, under the menu bar, once there are two or more (F14). Click a tab to show it,
 * drag it to move it along the strip or out of the window into a window of its own, middle-click or
 * its × to close it. A dot marks unsaved changes.
 */
export function TabStrip() {
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; x: number; y: number; moved: boolean } | null>(null);
  if (tabs.list.length < 2) return null;

  /** Where the tab at `from` goes with the pointer at `x`: past the middle of each tab it's dragged over. */
  const indexAt = (x: number, from: number): number => {
    let to = from;
    strip.current?.querySelectorAll<HTMLElement>('.tab').forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      if (i > from && x > mid) to = Math.max(to, i);
      if (i < from && x < mid) to = Math.min(to, i);
    });
    return to;
  };

  const outside = (e: PointerEvent) =>
    e.clientY < -OUT_PX || e.clientY > window.innerHeight + OUT_PX || e.clientX < -OUT_PX || e.clientX > window.innerWidth + OUT_PX;

  const down = (e: PointerEvent, index: number) => {
    if ((e.target as HTMLElement).closest('.tab-close')) return;
    if (e.button === 1) {
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    switchTo(index);
    drag.current = { index, x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
    d.moved = true;
    strip.current?.classList.toggle('tearing', outside(e));
    const to = indexAt(e.clientX, d.index);
    if (to !== d.index && !outside(e)) {
      moveTab(d.index, to);
      d.index = to;
    }
  };

  const up = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    strip.current?.classList.remove('tearing');
    if (d?.moved && outside(e)) void tearOff(d.index);
  };

  return (
    <div class="tabstrip" role="tablist" aria-label="Open pictures" ref={strip}>
      {tabs.list.map((t, i) => {
        const dirty = t.history.dirty && !t.quickCapture;
        const name = t.doc.board && t.file.name === 'Untitled' ? 'Whiteboard' : t.file.name;
        return (
          <div
            key={t.id}
            class={`tab${i === tabs.active ? ' active' : ''}${dirty ? ' dirty' : ''}`}
            role="tab"
            aria-selected={i === tabs.active}
            data-tab-index={i}
            data-tip={t.file.path ?? undefined}
            onPointerDown={(e) => down(e, i)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onAuxClick={(e) => e.button === 1 && void closeTab(i)}
          >
            <span class="tab-name">{name}</span>
            <span class="tab-end">
              {dirty && <span class="tab-dot" aria-label="Unsaved changes" />}
              <button
                type="button"
                class="tab-close"
                aria-label={`Close ${name}`}
                data-tip="Close tab"
                data-keys={i === tabs.active ? closeKeys() : undefined}
                onClick={() => void closeTab(i)}
              >
                <Icon name="close" size={14} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
