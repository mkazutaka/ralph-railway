// `NodeTestResult` is the entity returned to the caller after a single-node
// isolated test execution. Mirrors the DMMF declaration in
// `apps/web/docs/scenarios/workflow-editor/test-node.md`:
//
//   data NodeTestResult =
//       NodeId: NodeId
//       Status: NodeRunStatus                    // Succeeded / Failed のいずれか
//       Output: string OR null
//       ErrorMessage: string OR null
//       LogExcerpt: string
//       DurationMs: number
//
// Scenario invariant 1: 単独テストはワークフロー本体の Run 履歴に永続化されない。
// この entity は read-run-detail の `RunDetail` / `NodeRunDetail` と意図的に
// 切り離されており、`RunId` を持たない。テスト実行結果は呼び出し側プロセス
// のメモリに留まり、`RunStore` には書き込まれない。

import {
  asNodeId,
  InvalidBrandedValueError,
  type NodeId,
} from './types';
import { asNodeRunStatus, type NodeRunStatus } from './runDetail';

/**
 * Status values that a *test* run can terminate with. The scenario constrains
 * the result to `Succeeded` or `Failed` — `Pending` / `Running` / `Skipped` /
 * `Cancelled` are not possible end-states for an isolated, synchronous node
 * execution. Modelling the constraint at the type level prevents a future
 * runtime adapter from accidentally returning, say, a `pending` result.
 */
export type NodeTestStatus = Extract<NodeRunStatus, 'succeeded' | 'failed'>;

const NODE_TEST_STATUS_VALUES: ReadonlySet<NodeTestStatus> =
  new Set<NodeTestStatus>(['succeeded', 'failed']);

export function isNodeTestStatus(value: string): value is NodeTestStatus {
  return (NODE_TEST_STATUS_VALUES as ReadonlySet<string>).has(value);
}

export interface NodeTestResult {
  readonly nodeId: NodeId;
  readonly status: NodeTestStatus;
  /**
   * `.output.<name>` payload as a string, or `null` if the node produced no
   * output. `null` is preserved verbatim — empty string and `null` are not
   * interchangeable per the scenario type definition.
   */
  readonly output: string | null;
  /**
   * Set when (and only when) the node ended in `failed`. Mirrors the same
   * invariant `NodeRunDetail` enforces (a non-failed result must not carry an
   * error message; a failed result must carry one).
   */
  readonly errorMessage: string | null;
  /**
   * Display-only excerpt of the node's logs. Always a string — the empty
   * string is the "no logs to show yet" sentinel rather than `null` so the
   * UI does not need a `??` fallback at every render site.
   */
  readonly logExcerpt: string;
  /**
   * Wall-clock duration of the isolated execution in milliseconds. Always
   * present (the test always either finishes or fails locally — there is no
   * in-flight test variant). MUST be finite and non-negative.
   */
  readonly durationMs: number;
}

/**
 * Plain row shape returned by the underlying runtime adapter. Branded
 * validation happens here in `buildNodeTestResultFromRow` so the workflow /
 * route layers can rely on every `NodeTestResult` having already passed the
 * invariant checks.
 */
export interface NodeTestResultRow {
  readonly nodeId: string;
  readonly status: string;
  readonly output: string | null;
  readonly errorMessage: string | null;
  readonly logExcerpt: string;
  readonly durationMs: number;
}

/**
 * Convert a raw runtime-adapter row into the entity. We re-validate ids,
 * status, and the duration here even though the adapter *should* only emit
 * valid values — a future swap of the underlying runtime (in-memory → CLI
 * socket → REST proxy) could regress and we'd rather surface a typed error
 * than let an unsafe value reach the workflow layer.
 *
 * Invariants checked:
 *  - `nodeId` is a valid `NodeId`.
 *  - `status` is one of `succeeded` / `failed` (the test-result subset of
 *    `NodeRunStatus`). A pending/running/skipped/cancelled value coming back
 *    from the adapter is a programming error, not a user-recoverable
 *    condition.
 *  - Failed results MUST carry a non-empty `errorMessage`; non-failed
 *    results MUST NOT (mirrors `buildNodeRunDetailFromRow`).
 *  - `durationMs` is finite and non-negative.
 */
export function buildNodeTestResultFromRow(row: NodeTestResultRow): NodeTestResult {
  let nodeId: NodeId;
  let runStatus: NodeRunStatus;
  try {
    nodeId = asNodeId(row.nodeId);
    runStatus = asNodeRunStatus(row.status);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      throw new Error(
        `runtime adapter yielded an invalid NodeTestResult row (nodeId="${row.nodeId}", status="${row.status}"): ${e.reason}`,
      );
    }
    throw e;
  }

  if (!isNodeTestStatus(runStatus)) {
    throw new Error(
      `runtime adapter yielded a non-terminal NodeTestResult status (nodeId="${nodeId}", status="${runStatus}")`,
    );
  }
  const status: NodeTestStatus = runStatus;

  if (status === 'failed') {
    if (row.errorMessage === null || row.errorMessage.length === 0) {
      throw new Error(
        `runtime adapter yielded a failed NodeTestResult without errorMessage (nodeId="${nodeId}")`,
      );
    }
  } else if (row.errorMessage !== null) {
    throw new Error(
      `runtime adapter yielded a non-failed NodeTestResult with errorMessage (nodeId="${nodeId}", status="${status}")`,
    );
  }

  if (!Number.isFinite(row.durationMs) || row.durationMs < 0) {
    throw new Error(
      `runtime adapter yielded an invalid durationMs (nodeId="${nodeId}", durationMs=${row.durationMs})`,
    );
  }

  return {
    nodeId,
    status,
    output: row.output,
    errorMessage: row.errorMessage,
    logExcerpt: row.logExcerpt,
    durationMs: row.durationMs,
  };
}
