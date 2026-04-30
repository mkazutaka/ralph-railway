// `RunDetail` and `NodeRunDetail` are the entities that cross the repository
// boundary for the "read run detail" panel. Mirror the DMMF declaration in
// `apps/web/docs/scenarios/workflow-editor/read-run-detail.md`:
//
//   data NodeRunStatus =
//       | Pending | Running | Succeeded | Failed | Skipped | Cancelled
//
//   data NodeRunDetail =
//       NodeId: NodeId
//       Status: NodeRunStatus
//       StartedAt: number OR null
//       EndedAt: number OR null
//       Output: string OR null
//       ErrorMessage: string OR null
//       LogExcerpt: string
//
//   data RunDetail =
//       Id: RunId
//       WorkflowId: WorkflowId
//       Status: RunStatus
//       StartedAt: number
//       EndedAt: number OR null
//       Nodes: NodeRunDetail[]

import {
  asNodeId,
  asRunId,
  asWorkflowId,
  InvalidBrandedValueError,
  type NodeId,
  type RunId,
  type WorkflowId,
} from './types';
import type { RunStatus } from './runSummary';
import { asRunStatus, isTerminalRunStatus } from './runSummary';

/**
 * Lifecycle states for a single node within a Run. The `Skipped` variant is
 * unique to nodes (a Run as a whole cannot be skipped — see `RunStatus` in
 * `runSummary.ts` which omits it). The union is kept exhaustive so `switch`
 * statements over it are checked at compile time.
 */
export type NodeRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

const NODE_RUN_STATUS_VALUES: ReadonlySet<NodeRunStatus> = new Set<NodeRunStatus>([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);

export function isNodeRunStatus(value: string): value is NodeRunStatus {
  return (NODE_RUN_STATUS_VALUES as ReadonlySet<string>).has(value);
}

export function asNodeRunStatus(value: string): NodeRunStatus {
  if (!isNodeRunStatus(value)) {
    throw new InvalidBrandedValueError(
      'NodeRunStatus',
      `unknown NodeRunStatus "${value}"`,
    );
  }
  return value;
}

/**
 * `NodeRunStatus` values that have not reached a terminal state yet. Used by
 * `buildNodeRunDetailFromRow` to validate scenario invariant: a Pending or
 * Running node MUST NOT carry `endedAt`, and a terminal node SHOULD carry
 * timestamps consistent with its lifecycle.
 *
 * `Skipped` is treated as terminal here: the node never runs but its result
 * is still final for the purposes of this Run.
 */
export function isTerminalNodeRunStatus(status: NodeRunStatus): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'skipped'
  );
}

export interface NodeRunDetail {
  readonly nodeId: NodeId;
  readonly status: NodeRunStatus;
  /** Unix epoch in milliseconds, or `null` if the node has not started yet. */
  readonly startedAt: number | null;
  /** Unix epoch in milliseconds, or `null` if the node has not finished yet. */
  readonly endedAt: number | null;
  /**
   * `.output.<name>` payload as a string, or `null` if the node produced no
   * output (or has not run). `null` is preserved verbatim — empty string and
   * `null` are not interchangeable per the scenario type definition.
   */
  readonly output: string | null;
  /**
   * Set when (and only when) the node ended in `failed`. Scenario invariant 2
   * is enforced by `buildNodeRunDetailFromRow`.
   */
  readonly errorMessage: string | null;
  /**
   * Display-only excerpt of the node's logs (scenario invariant 3: full log
   * retrieval is a separate path). Always a string — the empty string is the
   * "no logs to show yet" sentinel rather than `null` so the UI does not need
   * a `??` fallback at every render site.
   */
  readonly logExcerpt: string;
}

export interface RunDetail {
  readonly id: RunId;
  readonly workflowId: WorkflowId;
  readonly status: RunStatus;
  /** Unix epoch in milliseconds. The Run as a whole has always started. */
  readonly startedAt: number;
  /** `null` while the Run is in-flight; set once it reaches a terminal state. */
  readonly endedAt: number | null;
  readonly nodes: ReadonlyArray<NodeRunDetail>;
}

/**
 * Plain row shapes returned by the underlying run store. Branded validation
 * happens here in `buildXxxFromRow` so the workflow / route layers can rely
 * on every entity having already passed the invariant checks.
 */
export interface NodeRunDetailRow {
  readonly nodeId: string;
  readonly status: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly output: string | null;
  readonly errorMessage: string | null;
  readonly logExcerpt: string;
}

export interface RunDetailRow {
  readonly id: string;
  readonly workflowId: string;
  readonly status: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly nodes: ReadonlyArray<NodeRunDetailRow>;
}

/**
 * Convert a node row into a branded entity, enforcing the scenario invariants
 * at the entity boundary so workflow / route / UI code can treat the result
 * as already validated.
 *
 * Invariants checked:
 *  - Pending/Running nodes MUST NOT carry `endedAt`.
 *  - Failed nodes MUST carry a non-empty `errorMessage` (scenario invariant 2).
 *  - Non-failed nodes MUST NOT carry an `errorMessage` (the field belongs to
 *    the failure branch only — leaking a prior error message into a
 *    succeeded retry would mislead the UI).
 *  - Numeric timestamps must be finite and non-negative.
 */
export function buildNodeRunDetailFromRow(row: NodeRunDetailRow): NodeRunDetail {
  let nodeId: NodeId;
  let status: NodeRunStatus;
  try {
    nodeId = asNodeId(row.nodeId);
    status = asNodeRunStatus(row.status);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      throw new Error(
        `run store yielded an invalid node row (nodeId="${row.nodeId}", status="${row.status}"): ${e.reason}`,
      );
    }
    throw e;
  }

  if (
    row.startedAt !== null &&
    (!Number.isFinite(row.startedAt) || row.startedAt < 0)
  ) {
    throw new Error(
      `run store yielded an invalid node startedAt (nodeId="${nodeId}", startedAt=${row.startedAt})`,
    );
  }
  if (
    row.endedAt !== null &&
    (!Number.isFinite(row.endedAt) || row.endedAt < 0)
  ) {
    throw new Error(
      `run store yielded an invalid node endedAt (nodeId="${nodeId}", endedAt=${row.endedAt})`,
    );
  }

  // Non-terminal (Pending/Running) nodes never have an end timestamp. Surface
  // the violation as a typed error rather than silently accepting nonsense
  // data — this is a programming error in the store, not a recoverable
  // user-facing condition.
  if (!isTerminalNodeRunStatus(status) && row.endedAt !== null) {
    throw new Error(
      `run store yielded a non-terminal node with endedAt (nodeId="${nodeId}", status="${status}", endedAt=${row.endedAt})`,
    );
  }

  // Scenario invariant 2: failed nodes carry an error message; non-failed
  // nodes must not.
  if (status === 'failed') {
    if (row.errorMessage === null || row.errorMessage.length === 0) {
      throw new Error(
        `run store yielded a failed node without errorMessage (nodeId="${nodeId}")`,
      );
    }
  } else if (row.errorMessage !== null) {
    throw new Error(
      `run store yielded a non-failed node with errorMessage (nodeId="${nodeId}", status="${status}")`,
    );
  }

  return {
    nodeId,
    status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    output: row.output,
    errorMessage: row.errorMessage,
    logExcerpt: row.logExcerpt,
  };
}

/**
 * Convert a run-detail row into a branded entity. Re-validates ids, status,
 * and the run-level timestamp invariants:
 *  - In-flight runs (pending/running) MUST NOT carry `endedAt`.
 *  - Terminal runs (succeeded/failed/cancelled) MUST carry `endedAt` and it
 *    must be >= `startedAt`.
 *
 * Mirrors `buildRunSummaryFromRow` (CLAUDE.md: "DB rows never leak past the
 * repository — convert via `buildXxxFromRow()` first").
 */
export function buildRunDetailFromRow(row: RunDetailRow): RunDetail {
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
        `run store yielded an invalid run-detail row (id="${row.id}", workflowId="${row.workflowId}", status="${row.status}"): ${e.reason}`,
      );
    }
    throw e;
  }

  if (!Number.isFinite(row.startedAt) || row.startedAt < 0) {
    throw new Error(
      `run store yielded an invalid startedAt (id="${id}", startedAt=${row.startedAt})`,
    );
  }
  if (
    row.endedAt !== null &&
    (!Number.isFinite(row.endedAt) || row.endedAt < 0)
  ) {
    throw new Error(
      `run store yielded an invalid endedAt (id="${id}", endedAt=${row.endedAt})`,
    );
  }

  if (!isTerminalRunStatus(status) && row.endedAt !== null) {
    throw new Error(
      `run store yielded a non-terminal run with endedAt (id="${id}", status="${status}", endedAt=${row.endedAt})`,
    );
  }
  if (isTerminalRunStatus(status) && row.endedAt === null) {
    throw new Error(
      `run store yielded a terminal run without endedAt (id="${id}", status="${status}")`,
    );
  }
  if (row.endedAt !== null && row.endedAt < row.startedAt) {
    throw new Error(
      `run store yielded endedAt < startedAt (id="${id}", startedAt=${row.startedAt}, endedAt=${row.endedAt})`,
    );
  }

  const nodes = row.nodes.map(buildNodeRunDetailFromRow);

  return {
    id,
    workflowId,
    status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    nodes,
  };
}
