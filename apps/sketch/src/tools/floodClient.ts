import type { FloodRequest, FloodResponse } from './flood.worker';

type Req = FloodRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, (r: FloodResponse) => void>();
/** Jobs run one at a time, each reading the picture after the last one has changed it. */
let queue: Promise<unknown> = Promise.resolve();

function flood(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./flood.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FloodResponse>) => {
      const done = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      done?.(e.data);
    };
  }
  return worker;
}

function send(req: Req, transfer: Transferable[]): Promise<FloodResponse> {
  return new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    flood().postMessage({ ...req, id }, transfer);
  });
}

/** Runs `job` after the fills before it have finished. */
export function queued<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

/** Fills the area around (x, y) in `target`. Resolves with the changed rectangle, or null when nothing was filled. */
export async function floodFill(
  target: ImageData,
  sample: ImageData | null,
  x: number,
  y: number,
  tolerance: number,
  global: boolean,
  color: [number, number, number, number],
): Promise<{ data: Uint8ClampedArray; rect: { x: number; y: number; w: number; h: number } } | null> {
  const transfer: Transferable[] = [target.data.buffer as ArrayBuffer];
  if (sample) transfer.push(sample.data.buffer as ArrayBuffer);
  const r = await send(
    {
      kind: 'fill',
      width: target.width,
      height: target.height,
      target: target.data.buffer as ArrayBuffer,
      sample: sample ? (sample.data.buffer as ArrayBuffer) : null,
      x,
      y,
      tolerance,
      global,
      color,
    },
    transfer,
  );
  if (r.kind === 'error') throw new Error(r.error);
  return r.kind === 'fill' ? { data: new Uint8ClampedArray(r.target), rect: r.rect } : null;
}

/**
 * The magic wand's area around (x, y), the size of its bounds: as pixels, see-through outside it
 * and black inside, and its outline as [x0, y0, x1, y1] runs along pixel edges.
 */
export function floodArea(
  sample: ImageData,
  x: number,
  y: number,
  tolerance: number,
): Promise<{ pixels: Uint8ClampedArray; outline: Int32Array; rect: { x: number; y: number; w: number; h: number } } | null> {
  return queued(async () => {
    const r = await send(
      { kind: 'area', width: sample.width, height: sample.height, sample: sample.data.buffer as ArrayBuffer, x, y, tolerance },
      [sample.data.buffer as ArrayBuffer],
    );
    if (r.kind === 'error') throw new Error(r.error);
    return r.kind === 'area' ? { pixels: new Uint8ClampedArray(r.pixels), outline: new Int32Array(r.outline), rect: r.rect } : null;
  });
}
