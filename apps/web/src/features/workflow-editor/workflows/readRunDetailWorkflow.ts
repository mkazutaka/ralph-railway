// Implements `apps/web/docs/scenarios/workflow-editor/read-run-detail.md`.
//
//   workflow "Read Run Detail" =
//     input: RunId
//     output:
//       RunDetailRead
//       OR RunNotFound
//     dependencies: findRunDetail
//
//     do LocateRunDetail
//     If not found then:
//       return RunNotFound
//       stop
//     return RunDetailRead

import type { RunId, WorkflowId } from '../entities/types';
import type { RunDetail } from '../entities/runDetail';
import type { FindRunDetail } from '../repositories/runRepository';

export interface ReadRunDetailInput {
  readonly runId: RunId;
  /**
   * The workflow the caller asserts the run belongs to. Used inside step 1
   * (LocateRunDetail) to enforce cross-workflow isolation: if the run exists
   * but its `workflowId` does not match this value, the workflow returns
   * `runNotFound` so callers cannot probe for run ids across workflows.
   *
   * The scenario type signature only names `RunId`, but the same isolation
   * rule applies to the sibling `stopRunWorkflow` (see its `StopRunInput`):
   * keeping the responsibility inside the workflow — rather than scattering
   * it across each calling route / form action / page load — guarantees the
   * check cannot be forgotten when a new entry-point is added.
   */
  readonly workflowId: WorkflowId;
}

/**
 * Discriminated union of every outcome the workflow can produce. CLAUDE.md
 * forbids using exceptions for expected failure modes — the workflow always
 * returns one of these variants, and the route layer maps it to a status
 * code.
 *
 * `runDetailRead` carries the full `RunDetail` (workflow id, run-level
 * status/timestamps, and per-node detail rows). The scenario's invariant 1
 * ("進行中の Run でも詳細を取得できる") means a successful result can include
 * nodes whose status is `pending` or `running`; routes MUST NOT translate
 * an in-flight run into a 404 or a 202.
 */
export type ReadRunDetailOutput =
  | { kind: 'runDetailRead'; detail: RunDetail }
  | { kind: 'runNotFound' };

export interface ReadRunDetailDeps {
  findRunDetail: FindRunDetail;
}

export async function readRunDetailWorkflow(
  input: ReadRunDetailInput,
  deps: ReadRunDetailDeps,
): Promise<ReadRunDetailOutput> {
  // step 1: LocateRunDetail
  // The repository contract returns `null` for "no such run" and a fully
  // validated `RunDetail` otherwise. Validation (status / timestamp / brand
  // checks) happens at the entity boundary inside `buildRunDetailFromRow`,
  // so by the time we reach this point the value is trusted.
  const detail = await deps.findRunDetail(input.runId);
  if (detail === null) {
    return { kind: 'runNotFound' };
  }
  // Cross-workflow isolation: a run that exists but belongs to a different
  // workflow is treated as "not found" so callers cannot use this endpoint
  // as an oracle that confirms run ids outside the addressed workflow.
  // Branded ids are plain strings at runtime, so the comparison is a string
  // equality after de-branding. Mirrors `stopRunWorkflow`'s LocateRun step.
  if ((detail.workflowId as string) !== (input.workflowId as string)) {
    return { kind: 'runNotFound' };
  }
  return { kind: 'runDetailRead', detail };
}
