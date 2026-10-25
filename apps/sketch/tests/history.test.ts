import { describe, expect, it } from 'vitest';
import { CompositeCommand, History, type Command } from '../src/engine/history';

function counter() {
  const state = { value: 0 };
  const make = (label: string, delta: number, bytes = 10): Command => {
    state.value += delta;
    return { label, bytes, apply: () => (state.value += delta), revert: () => (state.value -= delta) };
  };
  return { state, make };
}

describe('History', () => {
  it('undoes and redoes in order', () => {
    const h = new History();
    const { state, make } = counter();
    h.record(make('a', 1));
    h.record(make('b', 10));
    expect(state.value).toBe(11);
    h.undo();
    expect(state.value).toBe(1);
    h.redo();
    expect(state.value).toBe(11);
    expect(h.undo() && h.undo()).toBe(true);
    expect(h.undo()).toBe(false);
    expect(state.value).toBe(0);
  });

  it('drops redo steps when something new is recorded', () => {
    const h = new History();
    const { state, make } = counter();
    h.record(make('a', 1));
    h.record(make('b', 2));
    h.undo();
    h.record(make('c', 4));
    expect(h.canRedo).toBe(false);
    expect(h.entries().map((e) => e.label)).toEqual(['New picture', 'a', 'c']);
    expect(state.value).toBe(5);
  });

  it('jumps to any point in the list', () => {
    const h = new History();
    const { state, make } = counter();
    for (const d of [1, 2, 4, 8]) h.record(make(String(d), d));
    h.jumpTo(1);
    expect(state.value).toBe(1);
    const entries = h.entries();
    expect(entries.filter((e) => e.undone).map((e) => e.label)).toEqual(['2', '4', '8']);
    h.jumpTo(3);
    expect(state.value).toBe(7);
    h.jumpTo(0);
    expect(state.value).toBe(0);
  });

  it('tracks unsaved changes, including after undoing past the save', () => {
    const h = new History();
    const { make } = counter();
    expect(h.dirty).toBe(false);
    h.record(make('a', 1));
    expect(h.dirty).toBe(true);
    h.markSaved();
    expect(h.dirty).toBe(false);
    h.undo();
    expect(h.dirty).toBe(true);
    h.redo();
    expect(h.dirty).toBe(false);
    h.undo();
    h.record(make('b', 2));
    h.redo();
    expect(h.dirty).toBe(true);
  });

  it('drops the oldest steps when over the memory cap', () => {
    const h = new History(25);
    const { state, make } = counter();
    h.record(make('a', 1));
    h.record(make('b', 2));
    h.record(make('c', 4));
    expect(h.bytesUsed).toBe(20);
    expect(h.position).toBe(3);
    const entries = h.entries();
    expect(entries[0].position).toBeNull();
    expect(entries.map((e) => e.label).slice(1)).toEqual(['b', 'c']);
    h.jumpTo(0);
    // Only the steps still held can be undone.
    expect(state.value).toBe(1);
  });

  it('undoes a composite command as one step, in reverse', () => {
    const order: string[] = [];
    const part = (n: string): Command => ({ label: n, bytes: 1, apply: () => order.push(`+${n}`), revert: () => order.push(`-${n}`) });
    const h = new History();
    h.record(new CompositeCommand('both', [part('a'), part('b')]));
    h.undo();
    h.redo();
    expect(order).toEqual(['-b', '-a', '+a', '+b']);
  });
});
