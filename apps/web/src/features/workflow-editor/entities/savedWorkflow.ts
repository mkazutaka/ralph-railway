// `SavedWorkflow` is the entity returned by the save-workflow scenario once a
// YAML buffer has been overwritten on disk. Mirrors the DMMF declaration in
// `apps/web/docs/scenarios/workflow-management/save-workflow.md`:
//
//   data SavedWorkflow =
//       Id: WorkflowId
//       SavedAt: number
//
// The entity is intentionally minimal — the scenario only needs the saved id
// (so the client can reconcile its local buffer with the canonical file) and
// the persistence timestamp (so the editor can surface a "Saved at HH:MM"
// indicator without a follow-up read).

import type { WorkflowId } from './types';

export interface SavedWorkflow {
  readonly id: WorkflowId;
  readonly savedAt: number;
}

/**
 * Build a `SavedWorkflow` from an already-branded `WorkflowId` and the
 * persistence timestamp captured at the moment the write completed.
 *
 * Centralised here (rather than inlined in the workflow) so a future change
 * to the entity shape — e.g. adding a server-issued revision id — only
 * touches this constructor and its callers, not every workflow that emits
 * the entity.
 */
export function newSavedWorkflow(id: WorkflowId, savedAt: number): SavedWorkflow {
  return { id, savedAt };
}
