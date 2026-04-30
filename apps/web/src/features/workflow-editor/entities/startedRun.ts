// `StartedRun` is the entity returned to the caller after a workflow has been
// successfully enqueued for execution. Mirrors the DMMF declaration in
// `apps/web/docs/scenarios/workflow-editor/run-workflow.md`:
//
//   data StartedRun =
//       Id: RunId
//       WorkflowId: WorkflowId
//       StartedAt: number
//
// The entity is intentionally minimal: progress / completion / per-node detail
// are owned by the read-run-detail scenario and are deliberately *not* part of
// the start-run contract (scenario invariant 5: 実行開始は非同期であり、進捗・
// 完了は本ワークフローの責務外).

import type { RunId, WorkflowId } from './types';
import {
  asRunId,
  asWorkflowId,
  InvalidBrandedValueError,
} from './types';

export interface StartedRun {
  readonly id: RunId;
  readonly workflowId: WorkflowId;
  /** Unix epoch in milliseconds, set when the runtime accepted the run. */
  readonly startedAt: number;
}

/**
 * Plain row shape returned by the underlying runtime adapter. Branded
 * validation happens here in `buildStartedRunFromRow` so the workflow / route
 * layers can rely on every `StartedRun` having already passed the invariant
 * checks.
 */
export interface StartedRunRow {
  readonly id: string;
  readonly workflowId: string;
  readonly startedAt: number;
}

/**
 * Convert a raw runtime-adapter row into the entity. We re-validate ids and
 * the timestamp here even though the adapter *should* only emit valid values
 * — a future swap of the underlying runtime (in-memory → CLI socket → REST
 * proxy) could regress and we'd rather surface a typed error than let an
 * unsafe value reach the workflow layer.
 *
 * Mirrors `buildRunSummaryFromRow` (CLAUDE.md: "DB rows never leak past the
 * repository — convert via `buildXxxFromRow()` first").
 */
export function buildStartedRunFromRow(row: StartedRunRow): StartedRun {
  let id: RunId;
  let workflowId: WorkflowId;
  try {
    id = asRunId(row.id);
    workflowId = asWorkflowId(row.workflowId);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      throw new Error(
        `runtime adapter yielded an invalid StartedRun row (id="${row.id}", workflowId="${row.workflowId}"): ${e.reason}`,
      );
    }
    throw e;
  }

  if (!Number.isFinite(row.startedAt) || row.startedAt < 0) {
    throw new Error(
      `runtime adapter yielded an invalid startedAt (id="${row.id}", startedAt=${row.startedAt})`,
    );
  }

  return { id, workflowId, startedAt: row.startedAt };
}
