// Implements `apps/web/docs/scenarios/workflow-editor/stop-run.md`.
//
//   workflow "Stop Run" =
//     input: RunId AND WorkflowId
//     output:
//       StopRequested
//       OR RunNotFound
//       OR RunAlreadyTerminal
//       OR RuntimeUnavailable
//     dependencies: findRun, requestRunStop

import type { RunId, WorkflowId } from '../entities/types';
import type { RunStatus } from '../entities/runSummary';
import { isTerminalRunStatus } from '../entities/runSummary';
import type { StopAccepted } from '../entities/stopAccepted';
import type { FindRunDetail } from '../repositories/runRepository';
import type { RequestRunStop } from '../repositories/runtimeRepository';

export interface StopRunInput {
  readonly runId: RunId;
  /**
   * The workflow the caller asserts the run belongs to. Used by step 1
   * (LocateRun) to enforce cross-workflow isolation: if the run exists but
   * its `workflowId` does not match this value, the workflow returns
   * `runNotFound` (scenario invariant 4). This keeps the isolation check as
   * part of the workflow's own responsibility — the route layer no longer
   * needs to peek at the run before calling the workflow.
   */
  readonly workflowId: WorkflowId;
}

/**
 * Discriminated union of every outcome the workflow can produce. CLAUDE.md
 * forbids using exceptions for expected failure modes — the workflow always
 * returns one of these variants, and the route layer maps it to a status
 * code.
 *
 * `stopRequested` carries the `StopAccepted` (run id + `requestedAt`). The
 * remaining variants mirror the scenario's named error cases 1:1 so the
 * route layer can do an exhaustive `switch` and TypeScript flags any future
 * addition that the route forgets to handle.
 *
 * - `runAlreadyTerminal.status` echoes the observed terminal status so the
 *   route layer can return a more informative diagnostic (e.g. "run already
 *   succeeded" vs. "run already failed"). The scenario only requires the
 *   error variant itself, but surfacing the status is strictly more
 *   information for the same payload size and is consistent with the
 *   `unsupportedNode.nodeType` precedent in `startRunWorkflow`.
 */
export type StopRunOutput =
  | { kind: 'stopRequested'; stop: StopAccepted }
  | { kind: 'runNotFound' }
  | { kind: 'runAlreadyTerminal'; status: RunStatus }
  | { kind: 'runtimeUnavailable' };

export interface StopRunDeps {
  /**
   * The scenario names this dependency `findRun` and types it as
   * `RunId -> RunSnapshot OR NotFound`. The repository's `findRunDetail`
   * already exposes the same shape (full run detail, or `null` for
   * NotFound) — the workflow only inspects `status` here, so we reuse the
   * existing seam rather than introducing a parallel "snapshot" type that
   * would have to track the same status field anyway.
   */
  findRun: FindRunDetail;
  requestRunStop: RequestRunStop;
}

/**
 * Request that a previously enqueued workflow run be stopped. Mirrors the
 * scenario step-by-step.
 *
 * Order of checks matches the scenario's substep ordering:
 *   1. LocateRun     — run must exist; must not be in a terminal state.
 *   2. RequestStop   — runtime must be reachable.
 *
 * Each step has a single failure mode and the next step is only attempted
 * when the previous returned its success variant. The discriminated union
 * means callers cannot accidentally treat a failure as a success.
 *
 * Scenario invariants:
 *   1. 既に終了状態の Run には停止要求を発行しない — enforced by the early
 *      return from step 1 when `isTerminalRunStatus(status)` is true. The
 *      runtime adapter is never invoked in that case.
 *   2. 停止は非同期要求であり、本ワークフローの完了は「要求の受理」までを
 *      保証する — `requestRunStop` returns once the request is queued; we
 *      do not block on the runtime actually transitioning the run to
 *      `Cancelled`.
 *   3. 実際に Cancelled 状態へ遷移したかは別ワークフロー (実行状態購読) で
 *      観測する — the success variant carries `StopAccepted`, NOT a
 *      post-stop `RunStatus`. Callers MUST consult the read-run-detail
 *      endpoint to learn the eventual state.
 *   4. 入力 `WorkflowId` に紐付かない Run は `runNotFound` として扱う —
 *      enforced inside step 1: when `detail.workflowId !== input.workflowId`
 *      we return `runNotFound` *without* invoking the runtime. This keeps
 *      cross-workflow isolation as part of the workflow's responsibility
 *      (review note M1 / L3) so the route layer is not tempted to leak
 *      "the run exists but you cannot address it" to callers.
 *   5. ランタイムアダプタは冪等 — we still rely on `findRun` having returned
 *      a non-terminal status, but the adapter must accept duplicate /
 *      late-arriving requests without error. See `RuntimeStore.requestStop`
 *      for the contract.
 */
export async function stopRunWorkflow(
  input: StopRunInput,
  deps: StopRunDeps,
): Promise<StopRunOutput> {
  // step 1: LocateRun
  // The repository contract returns `null` for "no such run" and a fully
  // validated detail otherwise. Validation (status / timestamp / brand
  // checks) happens at the entity boundary inside `buildRunDetailFromRow`,
  // so by the time we reach this point the value is trusted.
  const detail = await deps.findRun(input.runId);
  if (detail === null) {
    return { kind: 'runNotFound' };
  }
  // Cross-workflow isolation (scenario invariant 4): a run that exists but
  // belongs to a different workflow is treated as "not found" so callers
  // cannot probe for run ids across workflows. Branded-string equality is
  // safe because both sides are de-branded `string` at runtime.
  if ((detail.workflowId as string) !== (input.workflowId as string)) {
    return { kind: 'runNotFound' };
  }
  if (isTerminalRunStatus(detail.status)) {
    return { kind: 'runAlreadyTerminal', status: detail.status };
  }

  // step 2: RequestStop
  // The repository's `RequestRunStopResult` is already the brand-validated
  // entity flavour, so we forward the result directly without re-conversion.
  const result = await deps.requestRunStop(input.runId);
  if (result.kind === 'runtimeUnavailable') {
    return { kind: 'runtimeUnavailable' };
  }
  return { kind: 'stopRequested', stop: result.stop };
}
