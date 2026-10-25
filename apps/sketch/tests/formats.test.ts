import { describe, expect, it } from 'vitest';
import { formatFromName, isPictureName, withExtension } from '../src/io/formats';

describe('layered file names', () => {
  it('saves layered pictures as .sktch', () => {
    expect(withExtension('Untitled', 'sktch')).toBe('Untitled.sktch');
    expect(withExtension('photo.png', 'sktch')).toBe('photo.sktch');
  });

  it('still opens .qpaint files saved while the app was called Quick Paint', () => {
    expect(formatFromName('old.qpaint')).toBe('sktch');
    expect(formatFromName('OLD.QPAINT')).toBe('sktch');
    expect(isPictureName('old.qpaint')).toBe(true);
    expect(formatFromName('new.sktch')).toBe('sktch');
    expect(isPictureName('new.sktch')).toBe(true);
  });
});
