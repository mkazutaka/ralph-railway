// Implements `apps/web/docs/scenarios/workflow-editor/list-recent-runs.md`.
//
//   workflow "List Recent Runs" =
//     input: WorkflowId AND Limit: number
//     output:
//       RunList
//       OR WorkflowNotFound
//     dependencies: workflowExists, findRecentRunsByWorkflow

import type { WorkflowId } from '../entities/types';
import type { RunSummary } from '../entities/runSummary';
import type {
  FindRecentRunsByWorkflow,
  WorkflowExists,
} from '../repositories/runRepository';

export interface ListRecentRunsInput {
  readonly workflowId: WorkflowId;
  readonly limit: number;
}

/**
 * Discriminated union of every outcome the workflow can produce. CLAUDE.md
 * forbids using exceptions for expected failure modes — the workflow always
 * returns one of these variants, and the route layer maps it to a status
 * code.
 *
 * `runList` carries `runs: ReadonlyArray<RunSummary>`. The empty array is a
 * legitimate success per scenario invariant 3 ("0件の場合は空配列で返る") —
 * routes MUST NOT translate an empty list into a 404.
 */
export type ListRecentRunsOutput =
  | { kind: 'runList'; runs: ReadonlyArray<RunSummary> }
  | { kind: 'workflowNotFound' };

export interface ListRecentRunsDeps {
  workflowExists: WorkflowExists;
  findRecentRunsByWorkflow: FindRecentRunsByWorkflow;
}

/**
 * Sort the result by `startedAt` descending. The repository contract already
 * states this ordering (and the in-memory store honours it), but we re-sort
 * here so a future store implementation that omits ORDER BY does not
 * silently violate scenario invariant 2 ("結果は新しい順 (StartedAt 降順)").
 *
 * `Array.prototype.sort` is in-place, so we materialise a fresh array from
 * the readonly input first.
 */
function sortByStartedAtDescending(
  runs: ReadonlyArray<RunSummary>,
): ReadonlyArray<RunSummary> {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt);
}

export async function listRecentRunsWorkflow(
  input: ListRecentRunsInput,
  deps: ListRecentRunsDeps,
): Promise<ListRecentRunsOutput> {
  // step 1: EnsureWorkflowExists
  const exists = await deps.workflowExists(input.workflowId);
  if (!exists) {
    return { kind: 'workflowNotFound' };
  }

  // step 2: CollectRecentRuns
  const rows = await deps.findRecentRunsByWorkflow(input.workflowId, input.limit);
  // Defence-in-depth: enforce the descending order the scenario requires
  // (invariant 2) regardless of the repository implementation.
  const runs = sortByStartedAtDescending(rows);

  return { kind: 'runList', runs };
}
