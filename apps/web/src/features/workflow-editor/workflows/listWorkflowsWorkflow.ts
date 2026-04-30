// Implements `apps/web/docs/scenarios/workflow-management/list-workflows.md`.
//
//   workflow "List Workflows" =
//     input: void
//     output: WorkflowList
//     dependencies: listWorkflowFiles, extractWorkflowSummary
//
//     // step 1
//     do CollectWorkflowFiles
//
//     // step 2
//     do SummarizeEach
//     return WorkflowList
//
// The scenario has only one terminal output (`WorkflowList`) — there are no
// failure variants because invariant 1 requires the empty case to be returned
// as `WorkflowList { workflows: [] }` rather than an error. We still keep the
// output a discriminated union (`kind: 'workflowList'`) so the shape is
// consistent with the other workflows in this directory and so a future
// addition (e.g. `kind: 'storeUnavailable'`) is non-breaking.

import type { WorkflowSummary } from '../entities/workflowSummary';
import type { ListWorkflowFiles } from '../repositories/workflowFileRepository';
import type { extractWorkflowSummary } from '../lib/extractWorkflowSummary';

export type ListWorkflowsOutput = {
  kind: 'workflowList';
  workflows: ReadonlyArray<WorkflowSummary>;
};

export interface ListWorkflowsDeps {
  /** Repository operation realising the scenario's `listWorkflowFiles`. */
  listWorkflowFiles: ListWorkflowFiles;
  /**
   * Pure helper realising the scenario's `extractWorkflowSummary`. Injected
   * (rather than imported by the workflow) so tests can swap it without the
   * file-system seam, and so the wiring is centralised in `$lib/server/repos.ts`.
   */
  extractWorkflowSummary: typeof extractWorkflowSummary;
}

/**
 * Produce the workflow listing for the picker / index page.
 *
 * Invariants enforced here (in addition to the ones enforced by the
 * dependencies):
 *   1. 0件の場合も WorkflowList は空配列で返る（エラーにしない）
 *      — naturally satisfied: an empty `files` array yields an empty
 *      `workflows` array, never a `notFound` variant.
 *   2. 各 WorkflowSummary には必ず Name が設定される（YAMLが壊れていても
 *      ファイル名で代替）
 *      — enforced by `extractWorkflowSummary`'s filename fallback.
 *   3. WorkflowId は一意であり、同一一覧内に重複しない
 *      — enforced by the underlying filesystem: two files cannot share the
 *      same path component, and the repository round-trips ids verbatim.
 */
export async function listWorkflowsWorkflow(
  deps: ListWorkflowsDeps,
): Promise<ListWorkflowsOutput> {
  // step 1: CollectWorkflowFiles
  const files = await deps.listWorkflowFiles();

  // step 2: SummarizeEach
  const workflows = files.map((file) => deps.extractWorkflowSummary(file));

  return { kind: 'workflowList', workflows };
}
