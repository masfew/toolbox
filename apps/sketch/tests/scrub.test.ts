import { describe, expect, it } from 'vitest';
import { DRAG_START_PX, scrubMove, scrubStart, type Scrub } from '../src/ui/scrub';

/** Moves the pointer by each delta in turn. */
function drag(from: number, deltas: number[], shift: boolean | boolean[] = false, min = 0, max = 100): Scrub {
  let s = scrubStart(from);
  deltas.forEach((d, i) => (s = scrubMove(s, d, Array.isArray(shift) ? shift[i] : shift, min, max)));
  return s;
}

describe('drag label maths', () => {
  it('moves 1 per 2 px, both ways', () => {
    expect(drag(50, [2]).value).toBe(51);
    expect(drag(50, [20]).value).toBe(60);
    expect(drag(50, [-2]).value).toBe(49);
    expect(drag(50, [-20]).value).toBe(40);
  });

  it('moves evenly whatever the movement is cut into', () => {
    const steps = (n: number, d: number) => Array.from({ length: n }, () => d);
    expect(drag(50, steps(100, 1)).value).toBe(100);
    expect(drag(10, steps(40, 1)).value).toBe(30);
    expect(drag(10, steps(40, -1)).value).toBe(0);
    expect(drag(50, steps(7, 3)).value).toBe(50 + 10); // 21 px
    expect(drag(50, steps(7, -3)).value).toBe(50 - 10);
    expect(drag(50, [21]).value).toBe(60);
  });

  it('moves ten times as fast with Shift', () => {
    expect(drag(50, [2], true).value).toBe(60);
    expect(drag(50, [-2], true).value).toBe(40);
    expect(drag(500, [4], true, 0, 1000).value).toBe(520);
  });

  it('keeps the leftover so a slow drag still moves', () => {
    let s = scrubStart(20);
    for (let i = 0; i < 9; i++) s = scrubMove(s, 1, false, 0, 100);
    expect(s.value).toBe(24);
    expect(s.rest).toBe(0.5);
    s = scrubMove(s, 1, false, 0, 100);
    expect(s.value).toBe(25);
    // Dragging back is as even.
    for (let i = 0; i < 10; i++) s = scrubMove(s, -1, false, 0, 100);
    expect(s.value).toBe(20);
  });

  it('does not jump when Shift changes mid-drag', () => {
    // 3 px normal (1 step and half a step over), then 1 px with Shift (5 steps), then 1 px normal.
    let s = scrubStart(50);
    s = scrubMove(s, 3, false, 0, 100);
    expect(s.value).toBe(51);
    const before = s.value;
    // Pressing Shift with no movement changes nothing: only movement moves the value.
    s = scrubMove(s, 0, true, 0, 100);
    expect(s.value).toBe(before);
    s = scrubMove(s, 1, true, 0, 100); // half a step over + 5 = 5.5 more
    expect(s.value).toBe(56);
    s = scrubMove(s, 1, false, 0, 100);
    expect(s.value).toBe(57);
    expect(drag(50, [4, 4, 4], [false, true, false]).value).toBe(50 + 2 + 20 + 2);
  });

  it('clamps to the ends and comes back at once', () => {
    expect(drag(98, [20]).value).toBe(100);
    expect(drag(3, [-20]).value).toBe(0);
    expect(drag(98, [20, -2]).value).toBe(99);
    expect(drag(2, [-100, 4], true).value).toBe(20);
    expect(drag(5, [-1000], true, 1, 5).value).toBe(1);
    expect(drag(0, [1000], true, 0, 12).value).toBe(12);
  });

  it('only gives whole numbers', () => {
    for (const d of [1, 3, 5, 7, -1, -3, 0.5, 1.5, 2.5]) {
      for (const shift of [false, true]) expect(Number.isInteger(drag(40, [d, d, d], shift).value)).toBe(true);
    }
  });

  it('starts a drag after a few pixels', () => {
    expect(DRAG_START_PX).toBe(3);
  });
});
