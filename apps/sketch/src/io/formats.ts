import { strFromU8, strToU8, unzipSync, type Zippable } from 'fflate';
import { BOARD_BACKGROUND, exportArea, flattenArea, pictureArea } from '../engine/board';
import { checkSize, createLayer, createObjectLayer, ctxOf, flatten, PaintDocument, type Layer } from '../engine/document';
import { readObject, reserveObjectIds, type SketchObject } from '../engine/objects';
import type { FileFormat } from '../app/store';
import type { EncodeRequest, EncodeResponse } from './encoder.worker';

export const FORMATS: Record<FileFormat, { label: string; ext: string; lossy: boolean; writable: boolean }> = {
  png: { label: 'PNG', ext: 'png', lossy: false, writable: true },
  jpeg: { label: 'JPEG', ext: 'jpg', lossy: true, writable: true },
  webp: { label: 'WebP', ext: 'webp', lossy: true, writable: true },
  bmp: { label: 'BMP', ext: 'bmp', lossy: false, writable: true },
  gif: { label: 'GIF', ext: 'gif', lossy: false, writable: false },
  sktch: { label: 'Sketch (keeps layers)', ext: 'sktch', lossy: false, writable: true },
};

export const OPEN_FILTERS = [
  { name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'sktch', 'qpaint'] },
  { name: 'All files', extensions: ['*'] },
];

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|sktch|qpaint)$/i;

export function isPictureName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function formatFromName(name: string): FileFormat | null {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'png';
    case 'jpg':
    case 'jpeg':
      return 'jpeg';
    case 'webp':
      return 'webp';
    case 'bmp':
      return 'bmp';
    case 'gif':
      return 'gif';
    case 'sktch':
    case 'qpaint': // files saved while the app was called Quick Paint
      return 'sktch';
    default:
      return null;
  }
}

export function withExtension(name: string, format: FileFormat): string {
  const base = name.replace(/\.[^.\\/]+$/, '');
  return `${base}.${FORMATS[format].ext}`;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export async function decodeImage(bytes: Uint8Array): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    throw new Error("This file isn't a picture Sketch can open.");
  }
}

/** Opens any supported file as a document. */
export async function readDocument(bytes: Uint8Array): Promise<PaintDocument> {
  if (isZip(bytes)) return readSketch(bytes);
  const bitmap = await decodeImage(bytes);
  const tooBig = checkSize(bitmap.width, bitmap.height);
  if (tooBig) throw new Error(tooBig);
  const doc = PaintDocument.fromImage(bitmap);
  bitmap.close();
  return doc;
}

interface LayerJsonBase {
  name: string;
  visible: boolean;
  /** Missing in files from before step 5.1, which read as unlocked; older builds ignore it. */
  locked?: boolean;
  opacity: number;
}

/**
 * Version 1 files hold only pixel layers (no `kind`). Version 2 adds object layers (text); version 3 shapes
 * and lines in them; version 4 mark-up and callouts; version 5 whiteboards (`board`).
 */
type LayerJson = (LayerJsonBase & { kind?: 'pixel'; file: string }) | (LayerJsonBase & { kind: 'objects'; objects: SketchObject[] });

interface SketchJson {
  format: 'sketch' | 'quickpaint';
  version: 1 | 2 | 3 | 4 | 5;
  /** A whiteboard, whose shapes and text can sit off its canvas. */
  board?: boolean;
  /**
   * A screen capture's open edges (`PaintDocument.edges`): how far the canvas reaches past the capture,
   * left, top, right and bottom. An older Sketch ignores it and opens the whole canvas as the picture.
   */
  edges?: [number, number, number, number];
  width: number;
  height: number;
  fill: string | null;
  active: number;
  layers: LayerJson[];
}

async function readSketch(bytes: Uint8Array): Promise<PaintDocument> {
  const files = unzipSync(bytes);
  const meta = files['document.json'] && (JSON.parse(strFromU8(files['document.json'])) as SketchJson);
  // 'quickpaint' is the tag written while the app was called Quick Paint.
  if (!meta || (meta.format !== 'sketch' && meta.format !== 'quickpaint')) throw new Error("This file isn't a Sketch picture.");
  if (meta.version > 5) throw new Error('This picture was saved by a newer Sketch. Update the app to open it.');
  const tooBig = checkSize(meta.width, meta.height);
  if (tooBig) throw new Error(tooBig);
  const layers = await Promise.all(
    meta.layers.map(async (l): Promise<Layer> => {
      if (l.kind === 'objects') {
        const objects = (Array.isArray(l.objects) ? l.objects : []).map(readObject).filter((o): o is SketchObject => o !== null);
        reserveObjectIds(objects);
        const layer = createObjectLayer(l.name, objects);
        layer.visible = l.visible;
        layer.locked = l.locked === true;
        layer.opacity = l.opacity;
        return layer;
      }
      const layer = createLayer(l.name, meta.width, meta.height);
      layer.visible = l.visible;
      layer.locked = l.locked === true;
      layer.opacity = l.opacity;
      const png = files[l.file];
      if (png) {
        const bmp = await decodeImage(png);
        ctxOf(layer.canvas).drawImage(bmp, 0, 0);
        bmp.close();
      }
      return layer;
    }),
  );
  const doc = new PaintDocument(meta.width, meta.height, meta.fill, layers);
  doc.active = Math.min(Math.max(0, meta.active), layers.length - 1);
  doc.board = meta.board === true;
  const e = meta.edges;
  if (!doc.board && Array.isArray(e) && e.length === 4 && e.every((n) => Number.isInteger(n) && n >= 0)) {
    doc.edges = { left: e[0], top: e[1], right: e[2], bottom: e[3] };
  }
  return doc;
}

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();

function encoder(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./encoder.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<EncodeResponse>) => {
      const job = waiting.get(e.data.id);
      if (!job) return;
      waiting.delete(e.data.id);
      if ('error' in e.data) job.reject(new Error(e.data.error));
      else job.resolve(e.data.bytes);
    };
  }
  return worker;
}

async function encodeCanvas(canvas: OffscreenCanvas, type: 'png' | 'jpeg' | 'webp' | 'bmp', quality: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(canvas);
  return send({ id: nextId++, bitmap, type, quality }, [bitmap]);
}

function send(msg: EncodeRequest, transfer: Transferable[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    waiting.set(msg.id, { resolve, reject });
    encoder().postMessage(msg, transfer);
  });
}

/** A canvas as a PNG, encoded in the worker. */
export function encodePng(canvas: OffscreenCanvas): Promise<Uint8Array> {
  return encodeCanvas(canvas, 'png', 1);
}

/** Encodes the document in a file format. `quality` (0 to 1) applies to JPEG and WebP. */
export async function encodeDocument(doc: PaintDocument, format: FileFormat, quality = 0.9): Promise<Uint8Array> {
  if (doc.board && format !== 'sktch' && format !== 'gif') {
    // A whiteboard saves as a picture of what's on it, on its white, with a small margin.
    const area = exportArea(doc);
    if (!area) throw new Error("The whiteboard is empty, so there's nothing to save yet.");
    return encodeCanvas(flattenArea(doc, area, BOARD_BACKGROUND), format, quality);
  }
  if (doc.edges && format !== 'sktch' && format !== 'gif') {
    // A capture saves as itself and everything drawn round it, see-through past its edges where the
    // format allows.
    const background = format === 'jpeg' || format === 'bmp' ? '#ffffff' : null;
    return encodeCanvas(flattenArea(doc, pictureArea(doc), background), format, quality);
  }
  switch (format) {
    case 'sktch':
      return encodeSketch(doc);
    case 'png':
    case 'webp':
      return encodeCanvas(flatten(doc), format, quality);
    case 'jpeg':
    case 'bmp':
      // No transparency in these formats: flatten onto white.
      return encodeCanvas(flatten(doc, '#ffffff'), format, quality);
    case 'gif':
      throw new Error("Sketch can't save GIFs. Choose another format.");
  }
}

async function encodeSketch(doc: PaintDocument): Promise<Uint8Array> {
  const pngs = await Promise.all(doc.layers.map((l) => (l.kind === 'pixel' ? encodeCanvas(l.canvas, 'png', 1) : null)));
  const objectLayers = doc.layers.filter((l) => l.kind === 'objects');
  const hasShapes = objectLayers.some((l) => l.objects.some((o) => o.type !== 'text'));
  const hasMarkup = objectLayers.some((l) => l.objects.some((o) => o.type === 'mark' || (o.type === 'text' && o.tail)));
  const meta: SketchJson = {
    format: 'sketch',
    // The oldest version that holds everything in the picture, so it opens in as many Sketches as it can.
    // A Sketch too old for shapes or mark-up says so, rather than opening the picture without them.
    version: doc.board ? 5 : hasMarkup ? 4 : hasShapes ? 3 : objectLayers.length ? 2 : 1,
    ...(doc.board ? { board: true } : {}),
    ...(doc.edges ? { edges: [doc.edges.left, doc.edges.top, doc.edges.right, doc.edges.bottom] } : {}),
    width: doc.width,
    height: doc.height,
    fill: doc.fill,
    active: doc.active,
    layers: doc.layers.map((l, i): LayerJson => {
      const base = { name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity };
      return l.kind === 'pixel' ? { ...base, file: `layers/${i}.png` } : { ...base, kind: 'objects', objects: [...l.objects] };
    }),
  };
  const files: Zippable = { 'document.json': strToU8(JSON.stringify(meta, null, 2)) };
  // PNGs are already compressed, so store them as they are.
  pngs.forEach((png, i) => {
    if (png) files[`layers/${i}.png`] = [png, { level: 0 }];
  });
  return send({ id: nextId++, zip: files }, pngs.flatMap((png) => (png ? [png.buffer as ArrayBuffer] : [])));
}
