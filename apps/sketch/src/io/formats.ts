import { strFromU8, strToU8, unzipSync, type Zippable } from 'fflate';
import { BOARD_BACKGROUND, exportArea, flattenArea, pictureArea } from '../engine/board';
import { checkSize, createLayer, ctxOf, flatten, PaintDocument, type Layer } from '../engine/document';
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

/**
 * One layer in `document.json`. Up to version 5 a layer held either pixels (`file`, no `kind`) or objects
 * (`kind: 'objects'`, no `file`). From version 6 (Sketch 1.6.0) every layer holds both: its PNG and,
 * when it has any, its objects. A file is read the same way whatever its version: pixels from `file`
 * when there is one (else a see-through canvas), objects from `objects` when there are any.
 */
interface LayerJson {
  name: string;
  visible: boolean;
  /** Missing in files from before step 5.1, which read as unlocked; older builds ignore it. */
  locked?: boolean;
  opacity: number;
  /** The layer's PNG in the zip. Missing on the object layers of versions 2 to 5. */
  file?: string;
  /** Written by versions 2 to 5 on object layers only; version 6 doesn't write it. */
  kind?: 'pixel' | 'objects';
  objects?: SketchObject[];
}

/**
 * Version 1 files hold only pixel layers. Version 2 adds object layers (text); version 3 shapes and lines
 * in them; version 4 mark-up and callouts; version 5 whiteboards (`board`). Version 6 lets one layer
 * hold pixels and objects together. A Sketch from before a version refuses its files, saying a newer
 * Sketch saved them, rather than opening them without what it can't read.
 */
const NEWEST = 6;

interface SketchJson {
  format: 'sketch' | 'quickpaint';
  version: 1 | 2 | 3 | 4 | 5 | 6;
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
  if (meta.version > NEWEST) throw new Error('This picture was saved by a newer Sketch. Update the app to open it.');
  const tooBig = checkSize(meta.width, meta.height);
  if (tooBig) throw new Error(tooBig);
  const layers = await Promise.all(
    meta.layers.map(async (l): Promise<Layer> => {
      // An object layer from before version 6 becomes a layer with a see-through canvas, so the
      // picture looks the same and keeps its layers.
      const objects = (Array.isArray(l.objects) ? l.objects : []).map(readObject).filter((o): o is SketchObject => o !== null);
      reserveObjectIds(objects);
      const layer = createLayer(l.name, meta.width, meta.height, null, objects);
      layer.visible = l.visible;
      layer.locked = l.locked === true;
      layer.opacity = l.opacity;
      const png = typeof l.file === 'string' ? files[l.file] : undefined;
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
  const { files, pngs } = await sketchFiles(doc, (c) => encodeCanvas(c, 'png', 1));
  return send({ id: nextId++, zip: files }, pngs.map((png) => png.buffer as ArrayBuffer));
}

/**
 * What a `.sktch` zip holds (`document.json` and one PNG per layer), with `png` encoding each layer's
 * canvas. Kept apart from the zipping, which runs in the encoder worker, so tests can read it back.
 */
export async function sketchFiles(doc: PaintDocument, png: (canvas: OffscreenCanvas) => Promise<Uint8Array>): Promise<{ files: Zippable; pngs: Uint8Array[] }> {
  const pngs = await Promise.all(doc.layers.map((l) => png(l.canvas)));
  const withObjects = doc.layers.some((l) => l.objects.length);
  const meta: SketchJson = {
    format: 'sketch',
    // A picture with no objects still opens in every Sketch that can show it (version 1, or 5 for a
    // whiteboard). Objects need version 6, so an older Sketch refuses the file rather than open it
    // without them.
    version: withObjects ? NEWEST : doc.board ? 5 : 1,
    ...(doc.board ? { board: true } : {}),
    ...(doc.edges ? { edges: [doc.edges.left, doc.edges.top, doc.edges.right, doc.edges.bottom] } : {}),
    width: doc.width,
    height: doc.height,
    fill: doc.fill,
    active: doc.active,
    layers: doc.layers.map(
      (l, i): LayerJson => ({
        name: l.name,
        visible: l.visible,
        locked: l.locked,
        opacity: l.opacity,
        file: `layers/${i}.png`,
        ...(l.objects.length ? { objects: [...l.objects] } : {}),
      }),
    ),
  };
  const files: Zippable = { 'document.json': strToU8(JSON.stringify(meta, null, 2)) };
  // PNGs are already compressed, so store them as they are.
  pngs.forEach((png, i) => {
    files[`layers/${i}.png`] = [png, { level: 0 }];
  });
  return { files, pngs };
}
