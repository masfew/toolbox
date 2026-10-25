import { useEffect, useState } from 'preact/hooks';
import type { Signal } from '../app/store';

/** Re-renders the component whenever the signal fires. */
export function useSignal(signal: Signal): void {
  const [, setTick] = useState(0);
  useEffect(() => signal.on(() => setTick((n) => n + 1)), [signal]);
}
