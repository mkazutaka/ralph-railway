import { useSyncExternalStore } from 'react';

/**
 * Shared animation clock. Mirrors claude-code's `useBlink`, which derives
 * blink state from a single time source so every subscriber pulses in sync.
 * A single module-level interval fans out to all subscribers via
 * `useSyncExternalStore`, so blinks stay perfectly aligned across rows.
 */
// Matches claude-code's BLINK_INTERVAL_MS (600ms on, 600ms off).
const TICK_MS = 600;

let tick = 0;
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (intervalId == null) {
    intervalId = setInterval(() => {
      tick += 1;
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function getSnapshot(): number {
  return tick;
}

/**
 * Toggle a boolean on/off every ~600ms while `enabled` is true. All callers
 * share the same clock so blinks stay synchronized and the effect is easier
 * to notice than a single row flipping on its own schedule.
 */
export function useBlink(enabled: boolean): boolean {
  const t = useSyncExternalStore(enabled ? subscribe : noopSubscribe, getSnapshot);
  if (!enabled) return true;
  return t % 2 === 0;
}

function noopSubscribe(): () => void {
  return () => {};
}
