// `WorkflowSummary` is the entity that crosses the repository boundary for
// the workflow listing view. We mirror it here (instead of re-exporting the
// shape from `$lib/server/workflows`) so the entities layer has no inbound
// dependency on infrastructure — `dto.ts` and the workflow layer can both
// rely on it without pulling server-only code into the bundle.

import type { WorkflowId } from './types';
import { asWorkflowId, InvalidBrandedValueError } from './types';

export interface WorkflowSummary {
  /**
   * Branded so consumers know it has already passed the path-traversal /
   * extension allow-list. The DTO layer (`toWorkflowSummaryDto`) re-brands
   * back to a plain `string` at the API boundary.
   */
  readonly id: WorkflowId;
  /** Display name for the picker — currently the filename without extension. */
  readonly name: string;
}

export interface WorkflowSummaryRow {
  readonly id: string;
  readonly name: string;
}

/**
 * Convert a raw repository row (filename + display name) into the entity.
 * Mirrors the DMMF rule "DB rows never leak past the repository — convert via
 * `buildXxxFromRow()` first" so a future swap of the underlying store does
 * not silently leak unbranded IDs into the workflow layer.
 */
export function buildWorkflowSummaryFromRow(row: WorkflowSummaryRow): WorkflowSummary {
  // The store already validated the id when it listed the directory, so this
  // cast is in principle redundant. Re-validating here makes the entity layer
  // self-defending — if a future store implementation forgets the check, we
  // surface it as a typed error rather than letting an unsafe value flow.
  try {
    return { id: asWorkflowId(row.id), name: row.name };
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      throw new Error(
        `workflow store yielded an invalid id "${row.id}": ${e.reason}`,
      );
    }
    throw e;
  }
}
