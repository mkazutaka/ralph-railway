// Pure formatting helpers for the test-node panel. Kept separate from the
// Svelte component so they are unit-testable without the DOM.
//
// Mirrors the design tokens in `apps/web/design/app.pen` (Right Panel
// `SV10l`, `statusRow` a1DWw): the result row reuses the same
// "<status dot> · <Status Word>" idiom that the design uses for the
// per-step test result. Aligned with `runDetailFormat.ts` so a future tweak
// to one palette does not silently shift the other.

import type { NodeTestStatus } from '../entities/nodeTestResult';

/**
 * CSS variable name (with the leading `--`) used to tint the status dot
 * for a `NodeTestStatus`. The test-result subset is `succeeded | failed`
 * — we deliberately do NOT lift this through `nodeStatusDotVar` (in
 * `runDetailFormat.ts`) because:
 *   - the test-node domain only sees terminal states; routing via the
 *     broader helper would force callers to handle `pending`/`running`
 *     branches that are unreachable here.
 *   - duplicating the two-arm switch keeps the test-node palette
 *     evolvable independently from the run-detail palette (review note
 *     in `runDetailFormat.ts` about avoiding cross-component re-exports).
 */
export function testNodeStatusDotVar(status: NodeTestStatus): string {
  switch (status) {
    case 'succeeded':
      return '--color-success';
    case 'failed':
      return '--color-danger';
  }
}

/**
 * Status word rendered next to the dot in the result row. Capitalised
 * form mirrors the design's `statusResult` text in `SV10l/Hv0EB/a1DWw`.
 */
export function testNodeStatusLabel(status: NodeTestStatus): string {
  switch (status) {
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
  }
}

/**
 * Tint applied to the status text and badge fill: success / danger. Used
 * to colour the result pill consistently with the dot. Returned token is
 * the *foreground* (text) variable; the muted background companion (e.g.
 * `--color-success-muted`) is picked at the call site.
 */
export function testNodeStatusToneVar(status: NodeTestStatus): string {
  switch (status) {
    case 'succeeded':
      return '--color-success';
    case 'failed':
      return '--color-danger';
  }
}

/**
 * Format a millisecond duration for the result row. Mirrors
 * `formatDuration` in `recentRunsFormat.ts` so the test-node and recent-
 * runs surfaces share the same caption shape, but specialised to the
 * test-node domain (always non-null — a finished test always has a
 * concrete duration per `NodeTestResult.durationMs`).
 *
 * Negative / non-finite values are clamped to `0ms` so a future runtime
 * regression cannot make the panel render `-3s`.
 */
export function formatTestDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0ms';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const sec = durationMs / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec - min * 60);
  if (min < 60) return remSec === 0 ? `${min}m` : `${min}m${remSec}s`;
  const hour = Math.floor(min / 60);
  const remMin = min - hour * 60;
  return remMin === 0 ? `${hour}h` : `${hour}h${remMin}m`;
}
