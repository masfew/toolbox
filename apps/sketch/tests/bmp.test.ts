import { describe, expect, it } from 'vitest';
import { encodeBmp } from '../src/io/bmp';

describe('encodeBmp', () => {
  it('writes a valid header and bottom-up BGR rows padded to 4 bytes', () => {
    // 2 × 2: top row red, green; bottom row blue, white.
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const bmp = encodeBmp(2, 2, rgba);
    const dv = new DataView(bmp.buffer);
    expect(String.fromCharCode(bmp[0], bmp[1])).toBe('BM');
    expect(dv.getUint32(2, true)).toBe(bmp.length);
    expect(dv.getInt32(18, true)).toBe(2);
    expect(dv.getUint16(28, true)).toBe(24);
    // Row size is 6 bytes padded to 8, so 54 + 16 bytes in all.
    expect(bmp.length).toBe(70);
    // First stored row is the bottom one: blue, then white.
    expect([...bmp.slice(54, 60)]).toEqual([255, 0, 0, 255, 255, 255]);
    // Second stored row is the top one: red, then green, in BGR order.
    expect([...bmp.slice(62, 68)]).toEqual([0, 0, 255, 0, 255, 0]);
  });
});
