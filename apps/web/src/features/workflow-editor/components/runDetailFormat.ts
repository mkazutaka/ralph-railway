// Pure formatting helpers for the run-detail panel. Kept separate from the
// Svelte component so they are unit-testable without the DOM.
//
// Mirrors the design tokens in `apps/web/design/app.pen` (Right Panel
// `SV10l`, `statusRow` a1DWw): the run / node header reuses the same
// "<status dot> <relative-time> · <Status Word>" idiom that the design
// uses on the per-step status row.

import type { RunStatus } from '../entities/runSummary';
import type { NodeRunStatus } from '../entities/runDetail';

/**
 * CSS variable name (with the leading `--`) used to tint the status dot
 * for a given `RunStatus`. Mirrors `statusDotVar` in
 * `recentRunsFormat.ts` so the run-detail header and the recent-runs
 * sidebar share one mapping. We deliberately do NOT re-export from
 * `recentRunsFormat` because:
 *   - Node-level status (`NodeRunStatus`) extends `RunStatus` with
 *     `skipped`, which is not valid at the Run level. Routing both
 *     through one helper would force the caller to handle a value the
 *     domain forbids.
 *   - Future tweaks to the run-vs-node palette (e.g. tinting `skipped`
 *     differently from `pending`) should not silently shift the
 *     recent-runs sidebar dots.
 *
 * The sidebar mapping is duplicated here intentionally per the project's
 * "no shared remote/utility surface across components" rule.
 */
export function runStatusDotVar(status: RunStatus): string {
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
 * Same idea as `runStatusDotVar` but for per-node status. `skipped` uses
 * the tertiary text token because the design conveys "this step did not
 * execute" with a muted dot (visible but de-emphasised) rather than the
 * danger tint reserved for failures the user may need to act on.
 */
export function nodeStatusDotVar(status: NodeRunStatus): string {
  switch (status) {
    case 'succeeded':
      return '--color-success';
    case 'failed':
      return '--color-danger';
    case 'cancelled':
      return '--color-danger';
    case 'skipped':
      return '--color-text-tertiary';
    case 'pending':
    case 'running':
      return '--color-accent';
  }
}

/**
 * Status word rendered next to the dot in the panel header. Capitalised
 * form mirrors the design's `statusResult` text in `SV10l/Hv0EB/a1DWw`.
 */
export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'succeeded':
      return 'Success';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'pending':
      return 'Pending';
    case 'running':
      return 'Running';
  }
}

export function nodeStatusLabel(status: NodeRunStatus): string {
  switch (status) {
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'skipped':
      return 'Skipped';
    case 'pending':
      return 'Pending';
    case 'running':
      return 'Running';
  }
}

/**
 * Tint applied to the status text + badge fill: success / danger /
 * accent. Used to colour the header pill consistently with the dot.
 *
 * Returned token is the *foreground* (text) variable; the badge muted
 * background is a sibling token (e.g. `--color-success-muted`) and is
 * picked at the call site so the caller can choose whether to render
 * a flat-text or filled-pill variant.
 */
export function runStatusToneVar(status: RunStatus): string {
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
 * Compute the visible duration for a run. Terminal runs derive duration
 * from (endedAt - startedAt) — we accept both and let the UI decide. A
 * non-terminal (pending/running) run returns `null` so the caller can
 * render the "running" placeholder.
 *
 * The function does NOT consult the run status: `endedAt === null`
 * already encodes "the run has not ended yet" per the entity invariants
 * in `runDetail.ts`. Status-based branching belongs at the rendering
 * site, where copy decisions live.
 */
export function computeRunDurationMs(
  startedAt: number,
  endedAt: number | null,
): number | null {
  if (endedAt === null) return null;
  // Defensive clamp: `buildRunDetailFromRow` enforces endedAt >= startedAt
  // for terminal runs, but a future swap of the underlying store could
  // regress. Returning a non-negative value keeps the formatter from
  // emitting "-3s" in the UI.
  return Math.max(0, endedAt - startedAt);
}

/**
 * Same idea for a single node. Pending/Running nodes (no endedAt) →
 * null; nodes that never started (no startedAt) → null. Skipped /
 * cancelled nodes that have both timestamps return their delta even
 * though the time is functionally meaningless ("we marked this as
 * skipped at T+0.001s") — the caller decides whether to suppress the
 * value based on status.
 */
export function computeNodeDurationMs(
  startedAt: number | null,
  endedAt: number | null,
): number | null {
  if (startedAt === null || endedAt === null) return null;
  return Math.max(0, endedAt - startedAt);
}

/**
 * Format a unix-epoch milliseconds timestamp as a wall-clock string in
 * the user's locale. Used for the absolute "Started 2024-09-30 14:32:11"
 * caption in the panel header. Falls back to a stable ISO substring if
 * `Intl.DateTimeFormat` is unavailable (it is in every browser
 * Playwright supports today, but we keep the fallback so the formatter
 * never throws and the panel never blanks).
 */
export function formatStartedAt(epochMs: number): string {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return fmt.format(new Date(epochMs));
  } catch {
    // ISO fallback (e.g. "2024-09-30T14:32:11.000Z" → trim to seconds).
    return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
  }
}
