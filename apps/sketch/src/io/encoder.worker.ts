import { zipSync, type Zippable } from 'fflate';
import { encodeBmp } from './bmp';

export type EncodeRequest =
  | {
      id: number;
      bitmap: ImageBitmap;
      type: 'png' | 'jpeg' | 'webp' | 'bmp';
      quality: number;
    }
  /** Zips a .sktch file's parts. Done here because the zip's checksums of a big picture's PNG kept the page busy for over 100 ms. */
  | { id: number; zip: Zippable };

export type EncodeResponse = { id: number; bytes: Uint8Array } | { id: number; error: string };

// Encoding runs here so saving a big picture never freezes the window.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(msg: EncodeResponse, transfer?: Transferable[]): void;
};

scope.onmessage = async (e) => {
  if ('zip' in e.data) {
    const { id, zip } = e.data;
    try {
      const bytes = zipSync(zip);
      scope.postMessage({ id, bytes }, [bytes.buffer]);
    } catch (err) {
      scope.postMessage({ id, error: String(err) });
    }
    return;
  }
  const { id, bitmap, type, quality } = e.data;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    let bytes: Uint8Array;
    if (type === 'bmp') {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      bytes = encodeBmp(data.width, data.height, data.data);
    } else {
      const blob = await canvas.convertToBlob({ type: `image/${type}`, quality });
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    scope.postMessage({ id, bytes }, [bytes.buffer]);
  } catch (err) {
    scope.postMessage({ id, error: String(err) });
  }
};
