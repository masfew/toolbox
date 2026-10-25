import { useEffect, useRef, useState } from 'preact/hooks';
import { keysFor, runCommand, slotHidden } from '../app/commandList';
import { prettyCombo } from '../app/keys';
import { selectTool, tools } from '../app/tools';
import { getSlot, getTool, RAIL_GROUPS } from '../tools/registry';
import { Icon } from './icons';
import { MouseSpeedButton } from './MouseSpeed';

function slotKeys(slotId: string): string {
  return keysFor(`slot.${slotId}`).map(prettyCombo).join(', ');
}

function toolTip(toolId: string): string {
  const t = getTool(toolId);
  return t.planned ? `${t.name} (comes in step ${t.planned})` : t.name;
}

/** The slim tool rail. Slots with several tools open a small flyout on a long press, a right click or the corner arrow. */
export function ToolRail() {
  const [flyout, setFlyout] = useState<{ slot: string; top: number } | null>(null);
  const holdTimer = useRef(0);

  useEffect(() => {
    if (!flyout) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.('.flyout')) setFlyout(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setFlyout(null);
      }
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc, true);
    };
  }, [flyout]);

  const openFlyout = (slotId: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setFlyout({ slot: slotId, top: r.top });
  };

  const current = getTool(tools.current);

  return (
    <nav class="rail" aria-label="Tools">
      {RAIL_GROUPS.map((group, gi) => (
        <div class="rail-group" key={gi}>
          {group.filter((slotId) => !slotHidden(slotId)).map((slotId) => {
            const slot = getSlot(slotId);
            const toolId = tools.slots[slotId];
            const multi = slot.tools.length > 1;
            const active = current.slot === slotId;
            return (
              <button
                type="button"
                key={slotId}
                class={`rail-btn${active ? ' active' : ''}${getTool(toolId).planned ? ' planned' : ''}`}
                aria-pressed={active}
                aria-label={getTool(toolId).name}
                data-tip={toolTip(toolId)}
                data-keys={slotKeys(slotId)}
                data-tip-side="right"
                data-tool={toolId}
                onPointerDown={(e) => {
                  if (!multi || e.button !== 0) return;
                  const el = e.currentTarget as HTMLElement;
                  holdTimer.current = window.setTimeout(() => openFlyout(slotId, el), 400);
                }}
                onPointerUp={() => clearTimeout(holdTimer.current)}
                onPointerLeave={() => clearTimeout(holdTimer.current)}
                onClick={() => {
                  if (!flyout) selectTool(toolId);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (multi) openFlyout(slotId, e.currentTarget as HTMLElement);
                }}
              >
                <Icon name={getTool(toolId).icon} size={20} />
                {multi && (
                  <span
                    class="corner"
                    aria-hidden="true"
                    onClick={(e) => {
                      e.stopPropagation();
                      openFlyout(slotId, (e.currentTarget as HTMLElement).parentElement!);
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
      ))}
      {/* Mouse speed and the command palette, under the tools. */}
      <div class="rail-group">
        <MouseSpeedButton />
        <button
          type="button"
          class="rail-btn"
          aria-label="Command palette"
          data-tip="Find any action"
          data-keys={keysFor('view.palette').slice(0, 1).map(prettyCombo).join('')}
          data-tip-side="right"
          onClick={() => runCommand('view.palette')}
        >
          <Icon name="search" size={20} />
        </button>
      </div>
      {flyout && (
        <div class="flyout" style={{ top: `${flyout.top}px` }} role="menu">
          {getSlot(flyout.slot).tools.map((id) => {
            const t = getTool(id);
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={tools.current === id}
                key={id}
                class={`menu-item${tools.current === id ? ' checked' : ''}${t.planned ? ' planned' : ''}`}
                data-tool={id}
                onClick={() => {
                  selectTool(id);
                  setFlyout(null);
                }}
              >
                <Icon name={t.icon} />
                <span class="label">{t.name}</span>
                {t.planned && <span class="step">step {t.planned}</span>}
              </button>
            );
          })}
        </div>
      )}
    </nav>
  );
}
