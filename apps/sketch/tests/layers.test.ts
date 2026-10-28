import { strToU8, zipSync, type Zippable } from 'fflate';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addLayer, mergeDown, rasterizeLayer, rasterizeObjects } from '../src/engine/commands';
import { createLayer, ctxOf, flatten, PaintDocument, type Layer } from '../src/engine/document';
import type { ShapeObject, SketchObject } from '../src/engine/objects';
import { readDocument, sketchFiles } from '../src/io/formats';
import { fakePng, installFakeCanvas, pixel } from './fakeCanvas';

// Objects are drawn as boxes in their colour, so tests can tell where each one went.
vi.mock('../src/engine/objects', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/engine/objects')>();
  type Ctx = OffscreenCanvasRenderingContext2D;
  const paint = (ctx: Ctx, o: SketchObject) => {
    const b = real.objectBounds(o);
    ctx.fillStyle = (o.type === 'shape' ? o.stroke : o.color) ?? '#000000';
    ctx.fillRect(b.x, b.y, b.w, b.h);
  };
  return {
    ...real,
    drawObject: paint,
    drawObjects: (ctx: Ctx, objects: readonly SketchObject[], backdrop?: Ctx) => {
      for (const o of objects) {
        paint(ctx, o);
        if (backdrop) paint(backdrop, o);
      }
    },
  };
});

beforeAll(installFakeCanvas);
afterAll(() => vi.unstubAllGlobals());

let nextId = 1000;
function rect(x: number, y: number, w: number, h: number, stroke: string): ShapeObject {
  return { id: nextId++, type: 'shape', kind: 'rectangle', x, y, w, h, angle: 0, stroke, width: 2, fill: '#ffffff', filled: false, dash: 'solid', opacity: 1, radius: 0, sides: 5, points: 5 };
}

function paint(layer: Layer, x: number, y: number, w: number, h: number, color: string): void {
  const ctx = ctxOf(layer.canvas);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** Every pixel of the picture as it shows. */
function look(doc: PaintDocument): number[] {
  const c = flatten(doc);
  const out: number[] = [];
  for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) out.push(...pixel(c, x, y));
  return out;
}

function expectClose(a: number[], b: number[], tolerance: number): void {
  expect(a.length).toBe(b.length);
  const worst = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  expect(worst).toBeLessThanOrEqual(tolerance);
}

/** A `.sktch` zip as an older Sketch wrote it. */
async function oldFile(meta: object, pngs: Record<string, OffscreenCanvas>): Promise<Uint8Array> {
  const files: Zippable = { 'document.json': strToU8(JSON.stringify(meta)) };
  for (const [name, c] of Object.entries(pngs)) files[name] = await fakePng(c);
  return zipSync(files);
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

describe('one layer holds pixels and objects', () => {
  it('draws a layer’s objects over its own pixels', () => {
    const doc = new PaintDocument(8, 8, null);
    const layer = doc.layers[0];
    layer.objects = [rect(0, 0, 4, 4, '#0000ff')];
    paint(layer, 0, 0, 8, 8, '#ff0000');
    const c = flatten(doc);
    expect(pixel(c, 1, 1)).toEqual(BLUE);
    expect(pixel(c, 6, 6)).toEqual(RED);
  });
});

describe('opening files from older Sketches', () => {
  it('opens a version 1 file (pixel layers only) as layers with no objects', async () => {
    const bg = new OffscreenCanvas(4, 3);
    ctxOf(bg).fillStyle = '#ff0000';
    ctxOf(bg).fillRect(0, 0, 4, 3);
    const bytes = await oldFile(
      { format: 'sketch', version: 1, width: 4, height: 3, fill: '#ffffff', active: 0, layers: [{ name: 'Background', visible: true, opacity: 1, file: 'layers/0.png' }] },
      { 'layers/0.png': bg },
    );
    const doc = await readDocument(bytes);
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].objects).toEqual([]);
    expect(pixel(doc.layers[0].canvas, 3, 2)).toEqual(RED);
  });

  it('still opens Quick Paint files', async () => {
    const bg = new OffscreenCanvas(2, 2);
    const bytes = await oldFile(
      { format: 'quickpaint', version: 1, width: 2, height: 2, fill: null, active: 0, layers: [{ name: 'Background', visible: true, opacity: 1, file: 'layers/0.png' }] },
      { 'layers/0.png': bg },
    );
    expect((await readDocument(bytes)).layers).toHaveLength(1);
  });

  it('opens a version 2 to 5 file with an object layer as the same layers, the objects on a see-through canvas', async () => {
    const bg = new OffscreenCanvas(8, 8);
    ctxOf(bg).fillStyle = '#ff0000';
    ctxOf(bg).fillRect(0, 0, 8, 8);
    const shape = rect(2, 2, 3, 3, '#0000ff');
    const bytes = await oldFile(
      {
        format: 'sketch',
        version: 3,
        width: 8,
        height: 8,
        fill: '#ffffff',
        active: 1,
        layers: [
          { name: 'Background', visible: true, opacity: 1, file: 'layers/0.png' },
          { name: 'Shapes', kind: 'objects', visible: true, locked: true, opacity: 0.5, objects: [shape] },
        ],
      },
      { 'layers/0.png': bg },
    );
    const doc = await readDocument(bytes);
    expect(doc.layers.map((l) => l.name)).toEqual(['Background', 'Shapes']);
    expect(doc.active).toBe(1);
    expect(doc.layers[0].objects).toEqual([]);
    const shapes = doc.layers[1];
    expect(shapes.objects).toEqual([shape]);
    expect(shapes.locked).toBe(true);
    expect(shapes.opacity).toBe(0.5);
    expect(shapes.canvas.width).toBe(8);
    expect(pixel(shapes.canvas, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  it('refuses a file from a newer Sketch rather than open part of it', async () => {
    const bytes = await oldFile({ format: 'sketch', version: 7, width: 2, height: 2, fill: null, active: 0, layers: [] }, {});
    await expect(readDocument(bytes)).rejects.toThrow('saved by a newer Sketch');
  });
});

describe('saving .sktch version 6', () => {
  it('keeps a layer’s pixels and objects together through a save and an open', async () => {
    const doc = new PaintDocument(8, 8, '#ffffff');
    const layer = doc.layers[0];
    paint(layer, 0, 0, 4, 8, '#ff0000');
    const shape = rect(1, 1, 5, 5, '#0000ff');
    layer.objects = [shape];
    const { files } = await sketchFiles(doc, fakePng);
    const meta = JSON.parse(new TextDecoder().decode(files['document.json'] as Uint8Array));
    expect(meta.version).toBe(6);
    expect(meta.layers).toHaveLength(1);
    expect(meta.layers[0].file).toBe('layers/0.png');
    const back = await readDocument(zipSync(files));
    expect(back.layers).toHaveLength(1);
    expect(back.layers[0].objects).toEqual([shape]);
    expect(look(back)).toEqual(look(doc));
    expect(pixel(back.layers[0].canvas, 6, 6)).toEqual([255, 255, 255, 255]);
  });

  it('saves a picture with no objects as version 1, so older Sketches still open it', async () => {
    const doc = new PaintDocument(4, 4, '#ffffff');
    const { files } = await sketchFiles(doc, fakePng);
    const meta = JSON.parse(new TextDecoder().decode(files['document.json'] as Uint8Array));
    expect(meta.version).toBe(1);
    expect(meta.layers[0].objects).toBeUndefined();
  });
});

describe('merge down', () => {
  function twoLayers(): PaintDocument {
    const doc = new PaintDocument(8, 8, '#ffffff');
    const lower = doc.layers[0];
    paint(lower, 0, 0, 4, 8, '#ff0000');
    lower.objects = [rect(1, 1, 4, 4, '#0000ff')];
    const upper = createLayer('Layer 2', 8, 8);
    doc.layers.push(upper);
    doc.active = 1;
    return doc;
  }

  it('looks the same when the upper layer has pixels, keeping its objects editable', () => {
    const doc = twoLayers();
    const upper = doc.layers[1];
    paint(upper, 2, 2, 4, 4, '#00ff00');
    upper.objects = [rect(5, 5, 2, 2, '#ffff00')];
    const before = look(doc);
    const cmd = mergeDown(doc, 1);
    expect(doc.layers).toHaveLength(1);
    expect(look(doc)).toEqual(before);
    // The lower layer's shape had to go under the upper layer's paint, so it became pixels.
    expect(doc.layers[0].objects.map((o) => (o as ShapeObject).stroke)).toEqual(['#ffff00']);
    cmd.revert();
    expect(doc.layers).toHaveLength(2);
    expect(look(doc)).toEqual(before);
  });

  it('keeps both layers’ objects when the upper layer has no painted pixels', () => {
    const doc = twoLayers();
    doc.layers[1].objects = [rect(5, 5, 2, 2, '#ffff00')];
    const before = look(doc);
    mergeDown(doc, 1);
    expect(look(doc)).toEqual(before);
    expect(doc.layers[0].objects).toHaveLength(2);
  });

  it('turns the objects into pixels when the opacities differ, since the upper ones must stay on top', () => {
    const doc = twoLayers();
    const upper = doc.layers[1];
    upper.opacity = 0.5;
    upper.objects = [rect(5, 5, 2, 2, '#ffff00')];
    const before = look(doc);
    mergeDown(doc, 1);
    expectClose(look(doc), before, 2);
    expect(doc.layers[0].objects).toHaveLength(0);
    expect(doc.layers[0].opacity).toBe(1);
  });
});

describe('rasterizing', () => {
  it('Rasterize Layer draws the objects into the layer’s own pixels, as one undo step', () => {
    const doc = new PaintDocument(8, 8, '#ffffff');
    const layer = doc.layers[0];
    paint(layer, 0, 0, 8, 2, '#ff0000');
    const objects = [rect(1, 1, 3, 3, '#0000ff'), rect(4, 4, 3, 3, '#00ff00')];
    layer.objects = objects;
    const before = look(doc);
    const cmd = rasterizeLayer(doc, 0)!;
    expect(doc.layers).toHaveLength(1);
    expect(layer.objects).toEqual([]);
    expect(look(doc)).toEqual(before);
    expect(pixel(layer.canvas, 2, 2)).toEqual(BLUE);
    cmd.revert();
    expect(layer.objects).toEqual(objects);
    expect(pixel(layer.canvas, 2, 2)).toEqual([255, 255, 255, 255]);
    cmd.apply();
    expect(layer.objects).toEqual([]);
    expect(look(doc)).toEqual(before);
  });

  it('Rasterize Shapes draws only the picked objects into their own layer', () => {
    const doc = new PaintDocument(8, 8, null);
    const top = createLayer('Layer 2', 8, 8);
    const keep = rect(4, 4, 3, 3, '#00ff00');
    const flat = rect(0, 0, 3, 3, '#0000ff');
    top.objects = [flat, keep];
    addLayer(doc, top, 'New layer');
    const cmd = rasterizeObjects(doc, top, [flat.id], 'Rasterize shape')!;
    expect(top.objects).toEqual([keep]);
    expect(pixel(top.canvas, 1, 1)).toEqual(BLUE);
    expect(pixel(doc.layers[0].canvas, 1, 1)).toEqual([0, 0, 0, 0]);
    cmd.revert();
    expect(top.objects).toEqual([flat, keep]);
    expect(pixel(top.canvas, 1, 1)).toEqual([0, 0, 0, 0]);
  });
});

describe('nothing makes a layer on its own', () => {
  it('puts new shapes and text on the current layer, and refuses a locked one', async () => {
    // The page's timers, for the settings the tools save.
    vi.stubGlobal('window', globalThis);
    const { app } = await import('../src/app/store');
    const shapes = await import('../src/tools/shapes');
    const text = await import('../src/tools/text');
    const ev = { button: 0, shiftKey: false, altKey: false, ctrlKey: false } as PointerEvent;
    const doc = app.doc;
    expect(doc.layers).toHaveLength(1);

    const drag = shapes.shapeDrag('rectangle', { x: 100, y: 100 }, ev, () => {});
    drag.move({ x: 300, y: 250 }, ev, () => ({ x: 0, y: 0 }));
    drag.up({ x: 300, y: 250 }, ev);
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].objects.map((o) => o.type)).toEqual(['shape']);

    text.textDrag({ x: 400, y: 400 }, 0).up({ x: 400, y: 400 }, ev);
    text.updateText({ text: 'Hello' });
    text.commitText();
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].objects.map((o) => o.type)).toEqual(['shape', 'text']);

    // A second layer the person added gets the next one.
    app.history.record(addLayer(doc, createLayer('Layer 2', doc.width, doc.height), 'New layer'));
    shapes.addObjects([rect(10, 10, 20, 20, '#000000')], 'Add rectangle');
    expect(doc.layers).toHaveLength(2);
    expect(doc.layers[1].objects).toHaveLength(1);

    // A locked current layer refuses new things, saying why, instead of making a layer.
    doc.layers[1].locked = true;
    shapes.addObjects([rect(10, 10, 20, 20, '#000000')], 'Add rectangle');
    expect(text.newTextBlocked()).not.toBeNull();
    expect(doc.layers).toHaveLength(2);
    expect(doc.layers[1].objects).toHaveLength(1);
    expect(app.toast?.text).toContain('is locked');
  });
});
