// `RunSummary` is the entity that crosses the repository boundary for the
// "list recent runs" sidebar view. Mirrors the DMMF declaration in
// `apps/web/docs/scenarios/workflow-editor/list-recent-runs.md`:
//
//   data RunSummary =
//       Id: RunId
//       WorkflowId: WorkflowId
//       Status: RunStatus
//       StartedAt: number
//       DurationMs: number OR null

import type { RunId, WorkflowId } from './types';
import {
  asRunId,
  asWorkflowId,
  InvalidBrandedValueError,
} from './types';

/**
 * Lifecycle states for a workflow Run. Mirrors the scenario's `RunStatus`
 * sum-type 1:1; the union is exhaustive so `switch` statements over it are
 * checked at compile time.
 */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

const RUN_STATUS_VALUES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

/**
 * Type predicate over `RunStatus`. Lets `asRunStatus` (and any future
 * caller) narrow a `string` to a `RunStatus` without an `as` cast inside
 * `Set.prototype.has` (review note n3): `Set<T>.has` types its argument as
 * `T`, which forces a widening cast at the call site otherwise.
 */
export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUS_VALUES as ReadonlySet<string>).has(value);
}

/**
 * `RunStatus` values that have not reached a terminal state yet. The list
 * view uses this to decide whether `durationMs` should be `null` (per
 * scenario invariant 4: "実行中 (Pending/Running) の Run も一覧に含まれ、
 * DurationMs は null").
 */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function asRunStatus(value: string): RunStatus {
  if (!isRunStatus(value)) {
    // Review note n4: brand argument was previously `'RunId'` which made
    // the error message lie about which brand validation tripped. The
    // brand union now includes `'RunStatus'`, so the message reads
    // `invalid RunStatus: unknown RunStatus "foo"`.
    throw new InvalidBrandedValueError(
      'RunStatus',
      `unknown RunStatus "${value}"`,
    );
  }
  return value;
}

export interface RunSummary {
  readonly id: RunId;
  readonly workflowId: WorkflowId;
  readonly status: RunStatus;
  /** Unix epoch in milliseconds. */
  readonly startedAt: number;
  /**
   * Total run duration in milliseconds, or `null` while the run is still
   * pending/running. Scenario invariant 4 forbids fabricating a value here
   * for in-flight runs.
   */
  readonly durationMs: number | null;
}

/**
 * Plain row shape returned by the underlying run store. Branded validation
 * happens here in `buildRunSummaryFromRow` so the workflow / route layers
 * can rely on every `RunSummary` having already passed the invariant checks.
 */
export interface RunSummaryRow {
  readonly id: string;
  readonly workflowId: string;
  readonly status: string;
  readonly startedAt: number;
  readonly durationMs: number | null;
}

/**
 * Convert a raw repository row into the entity. We re-validate ids and
 * status here even though the store *should* only emit valid values — a
 * future swap of the underlying store (in-memory → SQLite → REST proxy)
 * could regress and we'd rather surface a typed error than let an unsafe
 * value reach the workflow layer.
 *
 * Mirrors `buildWorkflowSummaryFromRow` (CLAUDE.md: "DB rows never leak
 * past the repository — convert via `buildXxxFromRow()` first").
 */
export function buildRunSummaryFromRow(row: RunSummaryRow): RunSummary {
  let id: RunId;
  let workflowId: WorkflowId;
  let status: RunStatus;
  try {
    id = asRunId(row.id);
    workflowId = asWorkflowId(row.workflowId);
    status = asRunStatus(row.status);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      throw new Error(
        `run store yielded an invalid row (id="${row.id}", workflowId="${row.workflowId}", status="${row.status}"): ${e.reason}`,
      );
    }
    throw e;
  }

  // Invariant 4 (scenario): in-flight runs (pending/running) MUST NOT carry
  // a duration. Surface the violation as a typed error rather than silently
  // accepting nonsense data — this is a programming error in the store, not
  // a recoverable user-facing condition.
  if (!isTerminalRunStatus(status) && row.durationMs !== null) {
    throw new Error(
      `run store yielded a non-terminal run with a duration (id="${row.id}", status="${status}", durationMs=${row.durationMs})`,
    );
  }
  if (isTerminalRunStatus(status) && row.durationMs === null) {
    throw new Error(
      `run store yielded a terminal run without a duration (id="${row.id}", status="${status}")`,
    );
  }

  if (!Number.isFinite(row.startedAt) || row.startedAt < 0) {
    throw new Error(
      `run store yielded an invalid startedAt (id="${row.id}", startedAt=${row.startedAt})`,
    );
  }
  if (row.durationMs !== null && (!Number.isFinite(row.durationMs) || row.durationMs < 0)) {
    throw new Error(
      `run store yielded an invalid durationMs (id="${row.id}", durationMs=${row.durationMs})`,
    );
  }

  return {
    id,
    workflowId,
    status,
    startedAt: row.startedAt,
    durationMs: row.durationMs,
  };
}
