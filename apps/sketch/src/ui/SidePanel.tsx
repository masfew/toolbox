import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as actions from '../app/actions';
import { keysFor } from '../app/commandList';
import { prettyCombo } from '../app/keys';
import { canDeleteLayer, mergeDownBlocked, moveLayerTo, newLayer, removeLayer, selectLayer, setLayer, mergeCurrentDown, moveCurrentLayer } from '../app/layers';
import { app } from '../app/store';
import { drawLayer, type Layer } from '../engine/document';
import { Icon } from './icons';

function Section(props: { id: string; title: string; children: ComponentChildren; extra?: ComponentChildren }) {
  const open = !!app.panelOpen[props.id];
  return (
    <section class={`panel-section${open ? ' open' : ''}`}>
      <h2>
        <button type="button" aria-expanded={open} onClick={() => actions.setPanelSection(props.id, !open)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          {props.title}
        </button>
        {props.extra}
      </h2>
      {open && props.children}
    </section>
  );
}

const THUMB_H = 28;

/** A small picture of one layer, redrawn whenever the panel is. */
function Thumb(props: { layer: Layer }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = app.doc;
  const w = Math.max(8, Math.min(48, Math.round((THUMB_H * doc.width) / doc.height)));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(THUMB_H * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(c.width / doc.width, 0, 0, c.height / doc.height, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    // At full strength and whether it's hidden or not, so you can see what's on it.
    drawLayer(ctx, { ...props.layer, opacity: 1 });
  });
  return <canvas class="layer-thumb" ref={ref} style={{ width: `${w}px`, height: `${THUMB_H}px` }} aria-hidden="true" />;
}

function LayerName(props: { layer: Layer; editing: boolean; onDone: () => void }) {
  const { layer } = props;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.editing) input.current?.select();
  }, [props.editing]);
  if (!props.editing) return <span class="layer-name">{layer.name}</span>;
  const finish = (save: boolean) => {
    const name = input.current?.value.trim() ?? '';
    if (save && name) setLayer(layer, 'name', name);
    props.onDone();
  };
  return (
    <input
      ref={input}
      class="layer-rename"
      defaultValue={layer.name}
      aria-label="Layer name"
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

/** Dragging a row this many pixels starts moving the layer. */
const DRAG_START = 4;

/**
 * Layers, top layer first: click to make one current, double-click its name to rename it, drag to move
 * it. The eye hides it and the lock stops it being changed. Opacity and the buttons under the list
 * work on the current layer.
 */
function LayerList() {
  const doc = app.doc;
  const list = useRef<HTMLOListElement>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  // Top layer first, as in every layers panel.
  const rows = doc.layers.map((layer, i) => ({ layer, i })).reverse();

  /** The stack position a pointer at `y` would drop on: the row it's over. */
  const indexAt = (y: number): number => {
    const items = [...(list.current?.children ?? [])] as HTMLElement[];
    for (let r = 0; r < items.length; r++) {
      const b = items[r].getBoundingClientRect();
      if (y < b.bottom) return doc.layers.length - 1 - r;
    }
    return 0;
  };

  const press = (e: PointerEvent, i: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input')) return;
    selectLayer(i);
    const startY = e.clientY;
    let moving = false;
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientY - startY) < DRAG_START) return;
      moving = true;
      setDrag({ from: i, to: indexAt(ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (moving && ev.type === 'pointerup') moveLayerTo(i, indexAt(ev.clientY));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const current = doc.activeLayer;
  const mergeWhy = mergeDownBlocked();
  const keyTip = (id: string) => keysFor(id).slice(0, 1).map(prettyCombo).join('') || undefined;
  return (
    <div class="layers-wrap">
      <ol class="layers" ref={list}>
        {rows.map(({ layer, i }) => {
          const target = drag && drag.to === i && drag.from !== i ? (drag.to > drag.from ? ' drop-above' : ' drop-below') : '';
          return (
            <li
              key={layer.id}
              class={`layer-row${i === doc.active ? ' current' : ''}${layer.visible ? '' : ' hidden'}${drag?.from === i ? ' dragging' : ''}${target}`}
              onPointerDown={(e) => press(e, i)}
              onDblClick={(e) => !(e.target as HTMLElement).closest('button') && setRenaming(layer.id)}
              aria-current={i === doc.active ? 'true' : undefined}
            >
              <button
                type="button"
                class="icon-btn small layer-eye"
                aria-pressed={layer.visible}
                aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
                data-tip={layer.visible ? 'Hide layer' : 'Show layer'}
                onClick={() => setLayer(layer, 'visible', !layer.visible)}
              >
                <Icon name={layer.visible ? 'eye' : 'eye-off'} size={15} />
              </button>
              <Thumb layer={layer} />
              <LayerName layer={layer} editing={renaming === layer.id} onDone={() => setRenaming(null)} />
              {layer.kind === 'objects' && <Icon name="shapes" size={13} class="layer-kind" />}
              <button
                type="button"
                class={`icon-btn small layer-lock${layer.locked ? ' on' : ''}`}
                aria-pressed={layer.locked}
                aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`}
                data-tip={layer.locked ? 'Unlock layer' : 'Lock layer'}
                onClick={() => setLayer(layer, 'locked', !layer.locked)}
              >
                <Icon name={layer.locked ? 'lock' : 'lock-open'} size={14} />
              </button>
            </li>
          );
        })}
      </ol>
      <label class="layer-opacity">
        <span>Opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(current.opacity * 100)}
          aria-label="Layer opacity"
          onInput={(e) => setLayer(current, 'opacity', Number((e.target as HTMLInputElement).value) / 100)}
        />
        <span class="num-out">{Math.round(current.opacity * 100)}%</span>
      </label>
      <div class="layer-buttons" role="toolbar" aria-label="Layer actions">
        <button type="button" class="icon-btn small" aria-label="New layer" data-tip="New layer" data-keys={keyTip('image.newLayer')} onClick={newLayer}>
          <Icon name="layer-new" size={16} />
        </button>
        <button type="button" class="icon-btn small" aria-label="Move layer up" data-tip="Move layer up" data-keys={keyTip('layer.up')} disabled={doc.active === doc.layers.length - 1} onClick={() => moveCurrentLayer(1)}>
          <Icon name="arrow-up" size={16} />
        </button>
        <button type="button" class="icon-btn small" aria-label="Move layer down" data-tip="Move layer down" data-keys={keyTip('layer.down')} disabled={doc.active === 0} onClick={() => moveCurrentLayer(-1)}>
          <Icon name="arrow-down" size={16} />
        </button>
        <button type="button" class="icon-btn small" aria-label="Merge layer down" data-tip={mergeWhy ?? 'Merge layer down'} data-keys={keyTip('image.mergeDown')} disabled={!!mergeWhy} onClick={mergeCurrentDown}>
          <Icon name="merge-down" size={16} />
        </button>
        <button type="button" class="icon-btn small" aria-label="Delete layer" data-tip="Delete layer" disabled={!canDeleteLayer()} onClick={() => removeLayer()}>
          <Icon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}

function HistoryList() {
  const entries = app.history.entries();
  return (
    <ol class="history">
      {entries.map((e, i) => (
        <li key={i}>
          <button
            type="button"
            class={`${e.current ? 'current' : ''} ${e.undone ? 'undone' : ''}`}
            disabled={e.position === null}
            onClick={() => e.position !== null && actions.jumpTo(e.position)}
          >
            {e.label}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** The panel on the right: layers and history. It can be hidden from the View menu, its button or F6. */
export function SidePanel() {
  return (
    <aside class="panel" aria-label="Layers and history">
      <Section
        id="layers"
        title="Layers"
        extra={
          <button type="button" class="icon-btn small panel-add" aria-label="New layer" data-tip="New layer" onClick={newLayer}>
            <Icon name="plus" size={15} />
          </button>
        }
      >
        <LayerList />
      </Section>
      <Section id="history" title="History">
        <HistoryList />
      </Section>
    </aside>
  );
}
