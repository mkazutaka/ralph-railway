// Pure formatting helpers for the recent-runs sidebar. Kept separate from
// the Svelte component so they are unit-testable without the DOM.
//
// Mirrors the design tokens in `apps/web/design/app.pen` (Left Sidebar
// `RECENT RUNS` rows): each row pairs a status dot tint with a short
// "<relative time> · <duration>" caption.

import type { RunStatus } from '../entities/runSummary';

/**
 * CSS variable name (with the leading `--`) used to tint the status dot
 * for a given `RunStatus`. The recent-runs design uses two shades only:
 * `$success` for terminal-success runs, `$error` for failures.
 *
 * For the in-progress states (pending/running) the dot uses the FlowCraft
 * accent so the row is visually distinguishable from a finished run, and
 * cancelled runs share the danger tint with `failed` since they both
 * represent a non-success terminal state from the user's perspective.
 *
 * Review note m2: the `succeeded` mapping previously borrowed
 * `--color-node-trigger` because `--color-success` was undefined. The
 * dedicated `--color-success` token now lives in `app.css`, so a future
 * tweak to the node-category palette will not silently shift run-status
 * colours.
 */
export function statusDotVar(status: RunStatus): string {
  switch (status) {
    case 'succeeded':
      return '--color-success';
    case 'failed':
    case 'cancelled':
      return '--color-danger';
    case 'pending':
    case 'running':
      return '--color-accent';
  }
}

/**
 * Render a relative time stamp like "2m", "3h", "5d" for the design's
 * "<time> · <duration>" caption. Uses ASCII suffixes so the rendered width
 * stays predictable in the narrow 260px sidebar (design's Left Sidebar
 * `iHBGe` width).
 *
 * Always rounds down — a 119s duration is "1m" not "2m" — so the value never
 * jumps ahead of the wall clock on a slow render.
 */
export function formatRelativeTime(startedAt: number, now: number): string {
  const deltaMs = Math.max(0, now - startedAt);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  const day = Math.floor(hour / 24);
  return `${day}d`;
}

/**
 * Render a duration in milliseconds for the right-hand side of the run row.
 * Returns `null` for in-flight runs so the caller can substitute the
 * "running" label (per scenario invariant 4).
 */
export function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  const sec = durationMs / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec - min * 60);
  if (min < 60) return remSec === 0 ? `${min}m` : `${min}m${remSec}s`;
  const hour = Math.floor(min / 60);
  const remMin = min - hour * 60;
  return remMin === 0 ? `${hour}h` : `${hour}h${remMin}m`;
}
