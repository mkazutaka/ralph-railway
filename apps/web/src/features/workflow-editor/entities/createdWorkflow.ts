// `CreatedWorkflow` is the entity returned by the create-workflow scenario
// once a new YAML file has been persisted. Mirrors the DMMF declaration in
// `apps/web/docs/scenarios/workflow-management/create-workflow.md`:
//
//   data CreatedWorkflow =
//       Id: WorkflowId
//       Name: string
//
// The entity is intentionally minimal — the scenario only needs the freshly
// created id (to redirect to the editor) and a display name (matching the
// `WorkflowSummary` shape used by the index page so future callers can treat
// the result as a list-row without a second fetch).

import type { WorkflowId } from './types';
import { asWorkflowId, InvalidBrandedValueError } from './types';

export interface CreatedWorkflow {
  readonly id: WorkflowId;
  readonly name: string;
}

/**
 * Plain row shape returned by the underlying repository. Branded validation
 * happens here in `buildCreatedWorkflowFromRow` so the workflow / route
 * layers can rely on every `CreatedWorkflow` having already passed the
 * invariant checks (CLAUDE.md: "DB rows never leak past the repository —
 * convert via `buildXxxFromRow()` first").
 */
export interface CreatedWorkflowRow {
  readonly id: string;
  readonly name: string;
}

export function buildCreatedWorkflowFromRow(row: CreatedWorkflowRow): CreatedWorkflow {
  try {
    return { id: asWorkflowId(row.id), name: row.name };
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      throw new Error(
        `workflow store yielded an invalid created-workflow row (id="${row.id}"): ${e.reason}`,
      );
    }
    throw e;
  }
}

/**
 * Build a `CreatedWorkflow` from an already-branded `WorkflowId`. The display
 * name is derived from the filename by stripping the `.yaml` / `.yml`
 * extension so the result is consistent with `WorkflowSummary` produced by the
 * directory listing.
 */
export function newCreatedWorkflow(id: WorkflowId): CreatedWorkflow {
  const raw = id as string;
  const name = raw.replace(/\.(ya?ml)$/, '');
  return { id, name };
}
