// Repository functions for the run-related workflows.
//
// Adapts the lower-level `RunStore` (in-memory today, persistent later) into
// branded-entity-aware functions used by the workflow layer. The workflow
// layer never touches the underlying store directly — it composes the
// dependencies declared in the relevant scenarios:
//
//   docs/scenarios/workflow-editor/list-recent-runs.md
//     func workflowExists: WorkflowId -> bool
//     func findRecentRunsByWorkflow: WorkflowId AND Limit -> RunSummary[]
//
//   docs/scenarios/workflow-editor/read-run-detail.md
//     func findRunDetail: RunId -> RunDetail OR NotFound

import type { RunStore } from '$lib/server/runs';
import type { WorkflowFileRepository } from './workflowFileRepository';
import type { RunId, WorkflowId } from '../entities/types';
import type { RunSummary } from '../entities/runSummary';
import { buildRunSummaryFromRow } from '../entities/runSummary';
import type { RunDetail } from '../entities/runDetail';
import { buildRunDetailFromRow } from '../entities/runDetail';

export type WorkflowExists = (workflowId: WorkflowId) => Promise<boolean>;
export type FindRecentRunsByWorkflow = (
  workflowId: WorkflowId,
  limit: number,
) => Promise<ReadonlyArray<RunSummary>>;

/**
 * Find a single run's detail by id. Resolves to `null` when no run with that
 * id exists — the scenario's `RunNotFound` outcome is signalled with the
 * absence of a row rather than an exception so the workflow can switch on a
 * sum-type result.
 */
export type FindRunDetail = (runId: RunId) => Promise<RunDetail | null>;

export interface RunRepository {
  workflowExists: WorkflowExists;
  findRecentRunsByWorkflow: FindRecentRunsByWorkflow;
  findRunDetail: FindRunDetail;
}

/**
 * Build the run repository.
 *
 * Note that `workflowExists` is wired against the *workflow file repository*,
 * not the `RunStore`. The list-recent-runs scenario's invariant 1 ("自分が
 * 指定したワークフローの履歴のみが返される") combined with invariant 3 ("0件
 * の場合は空配列で返る") means we must distinguish "workflow does not exist
 * at all" from "workflow exists but has no runs yet". The file repository is
 * the source of truth for "does this workflow exist" — the run store knows
 * only about runs.
 *
 * Both dependencies are accepted as parameters (CLAUDE.md: workflows must
 * receive their deps via injection, not via `import`); the route layer
 * builds them and hands them to the workflow.
 */
export function toRunRepository(
  runStore: RunStore,
  workflowFileRepo: WorkflowFileRepository,
): RunRepository {
  return {
    async workflowExists(workflowId) {
      const result = await workflowFileRepo.readWorkflowFile(workflowId);
      return result.kind === 'found';
    },
    async findRecentRunsByWorkflow(workflowId, limit) {
      const rows = await runStore.findRecentByWorkflow(workflowId as string, limit);
      // CLAUDE.md rule: never leak DB rows past the repository — convert via
      // `buildXxxFromRow()` first so the entity layer stays self-contained
      // and ID branding is enforced at the boundary.
      return rows.map(buildRunSummaryFromRow);
    },
    async findRunDetail(runId) {
      const row = await runStore.findDetailById(runId as string);
      if (row === null) return null;
      return buildRunDetailFromRow(row);
    },
  };
}
