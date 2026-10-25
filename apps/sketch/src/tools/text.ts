import { app, changed, colorSignal } from '../app/store';
import { loadOptions, onOptionChange, onToolChange, settingsOf } from '../app/tools';
import { addLayer, ObjectsCommand } from '../engine/commands';
import { createObjectLayer, objectLayerForNew, type ObjectLayer } from '../engine/document';
import { hitObject, LINE_HEIGHT, newObjectId, objectBounds, type SketchObject, type TextAlign, type TextObject } from '../engine/objects';
import type { Point } from './box';
import type { ToolDrag } from './drag';
import { snapsNow, snapTargets, snapTolerance } from './shapes';
import { snapRect } from './snap';

/** Text being typed: a new text box, or one already in a layer. */
export interface TextEdit {
  layer: ObjectLayer | null;
  original: TextObject | null;
  obj: TextObject;
  /** The name for a new layer, if one is needed for a new text box. */
  newLayer?: string;
}

/** The text tool's option keys that are also text box settings. */
const STYLE_KEYS = ['font', 'size', 'bold', 'italic', 'align', 'outline', 'box'] as const;

function styleFromOptions(): Pick<TextObject, (typeof STYLE_KEYS)[number]> {
  const st = settingsOf('text');
  return {
    font: st.font as string,
    size: st.size as number,
    bold: st.bold as boolean,
    italic: st.italic as boolean,
    align: st.align as TextAlign,
    outline: st.outline as boolean,
    box: st.box as boolean,
  };
}

/** The topmost text box under a picture point, in a layer that's showing. */
export function textAt(x: number, y: number, slop = 0): { layer: ObjectLayer; obj: TextObject } | null {
  const layers = app.doc.layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer.kind !== 'objects' || !layer.visible || layer.locked) continue;
    for (let j = layer.objects.length - 1; j >= 0; j--) {
      const obj = layer.objects[j];
      if (obj.type === 'text' && hitObject(obj, x, y, slop)) return { layer, obj };
    }
  }
  return null;
}

export function startEdit(edit: TextEdit): void {
  app.textEdit = edit;
  // The options bar shows the box's own settings while it's being typed in.
  const o = edit.obj;
  // A callout keeps its background and no outline; the Text tool's other settings still change it.
  if (o.tail) loadOptions('callout', { size: o.size });
  loadOptions('text', { font: o.font, size: o.size, bold: o.bold, italic: o.italic, align: o.align, ...(o.tail ? {} : { outline: o.outline, box: o.box }) });
  changed();
}

/** Finishes typing: saves the text box, or removes it when it's empty. */
export function commitText(): void {
  const te = app.textEdit;
  if (!te) return;
  app.textEdit = null;
  const obj = { ...te.obj, text: te.obj.text.replace(/\s+$/, '') };
  const empty = !obj.text.trim();
  if (te.original && te.layer) {
    const layer = te.layer;
    const before = layer.objects;
    if (!before.some((o) => o.id === obj.id)) return changed();
    let after: readonly SketchObject[];
    let label: string;
    if (empty) {
      after = before.filter((o) => o.id !== obj.id);
      label = obj.tail ? 'Delete callout' : 'Delete text';
    } else if (JSON.stringify(obj) === JSON.stringify(te.original)) {
      return changed();
    } else {
      after = before.map((o) => (o.id === obj.id ? obj : o));
      label = obj.tail ? 'Edit callout' : 'Edit text';
    }
    layer.objects = after;
    app.history.record(new ObjectsCommand(label, layer, before, after));
  } else if (!empty) {
    const layer = objectLayerForNew(app.doc);
    const label = obj.tail ? 'Add callout' : 'Add text';
    if (layer) {
      const before = layer.objects;
      layer.objects = [...before, obj];
      app.history.record(new ObjectsCommand(label, layer, before, layer.objects));
    } else {
      app.history.record(addLayer(app.doc, createObjectLayer(te.newLayer ?? 'Text', [obj]), label));
    }
  }
  changed();
}

/** Changes the text box being typed in. */
export function updateText(patch: Partial<TextObject>): void {
  const te = app.textEdit;
  if (!te) return;
  te.obj = { ...te.obj, ...patch };
  changed();
}

/**
 * Text tool, pressing on the picture: on a text box, a click edits it and a drag moves it.
 * Elsewhere, a click starts a text box that grows as you type, and a drag makes a box that wraps.
 */
export function textDrag(p: Point, button: number): ToolDrag {
  const found = textAt(p.x, p.y, 4 / app.viewport.zoom);
  if (found) {
    const { layer, obj } = found;
    const before = layer.objects;
    const box = objectBounds(obj);
    const targets = snapTargets(new Set([obj.id]));
    let moved = false;
    return {
      cursor: 'move',
      move: (q, ev) => {
        let dx = Math.round(q.x - p.x);
        let dy = Math.round(q.y - p.y);
        if (!moved && Math.hypot(dx, dy) * app.viewport.zoom < 4) return;
        moved = true;
        // Text snaps to shapes, other text and the picture, like shapes do.
        const s = snapsNow(ev) ? snapRect({ ...box, x: box.x + dx, y: box.y + dy }, targets, snapTolerance(), { spacing: true }) : null;
        app.guides = s?.guides ?? [];
        dx += s?.dx ?? 0;
        dy += s?.dy ?? 0;
        layer.objects = before.map((o) => (o.id === obj.id ? { ...o, x: obj.x + dx, y: obj.y + dy } : o));
        changed();
      },
      up: () => {
        app.guides = [];
        if (moved) app.history.record(new ObjectsCommand(obj.tail ? 'Move callout' : 'Move text', layer, before, layer.objects));
        else startEdit({ layer, original: obj, obj: { ...obj } });
      },
    };
  }

  const style = styleFromOptions();
  const color = button === 2 ? app.secondary : app.primary;
  const accent = button === 2 ? app.primary : app.secondary;
  const rectTo = (q: Point) => ({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) });
  return {
    cursor: 'text',
    move: (q) => {
      app.marquee = { rect: rectTo(q) };
      changed();
    },
    up: (q) => {
      app.marquee = null;
      const r = rectTo(q);
      const isBox = r.w * app.viewport.zoom >= 8;
      const obj: TextObject = {
        id: newObjectId(),
        type: 'text',
        ...style,
        // A click puts the middle of the first line at the pointer.
        x: Math.round(isBox ? r.x : p.x),
        y: Math.round(isBox ? r.y : p.y - (style.size * LINE_HEIGHT) / 2),
        width: isBox ? Math.max(style.size, Math.round(r.w)) : null,
        angle: 0,
        text: '',
        color,
        accent,
        tail: null,
      };
      startEdit({ layer: null, original: null, obj });
    },
  };
}

// The options bar and the colours change the text box being typed in.
onOptionChange((toolId, key) => {
  if (toolId !== 'text' || !app.textEdit || !(STYLE_KEYS as readonly string[]).includes(key)) return;
  if (app.textEdit.obj.tail && (key === 'outline' || key === 'box')) return;
  updateText({ [key]: settingsOf('text')[key] } as Partial<TextObject>);
});
colorSignal.on(() => {
  if (app.textEdit) updateText({ color: app.primary, accent: app.secondary });
});

onToolChange(() => commitText());
