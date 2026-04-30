// `WorkflowFile` is the entity that crosses the repository boundary for the
// list-workflows scenario. Mirrors the DMMF declaration in
// `apps/web/docs/scenarios/workflow-management/list-workflows.md`:
//
//   data WorkflowFile = WorkflowId + YamlSource (raw file contents)
//
// The scenario splits the listing into two steps:
//   1. CollectWorkflowFiles  — `listWorkflowFiles: void -> WorkflowFile[]`
//   2. SummarizeEach         — `extractWorkflowSummary: WorkflowFile -> WorkflowSummary`
//
// Keeping the raw `YamlSource` on the entity (instead of pre-parsing inside the
// repository) lets the parse / extract step live in the workflow layer where
// the fallback policy ("if extraction fails, use the file basename") is
// expressible in code rather than smuggled into the repo adapter.

import type { WorkflowId, YamlSource } from './types';
import { asWorkflowId, asYamlSource, InvalidBrandedValueError } from './types';

export interface WorkflowFile {
  /** Branded so consumers know it has already passed the path-traversal /
   * extension allow-list. */
  readonly id: WorkflowId;
  /** Raw YAML source as read from disk. Branded only to confirm it is a
   * NUL-free string; structural validity is the responsibility of the
   * `extractWorkflowSummary` step in the workflow. */
  readonly yaml: YamlSource;
}

export interface WorkflowFileRow {
  readonly id: string;
  readonly yaml: string;
}

/**
 * Convert a raw repository row (filename + raw yaml source) into the entity.
 * Mirrors the DMMF rule "DB rows never leak past the repository — convert via
 * `buildXxxFromRow()` first" so a future swap of the underlying store does
 * not silently leak unbranded IDs into the workflow layer.
 *
 * Branded validation is re-applied here: even though the lower-level
 * `WorkflowStore` already filters by extension when listing, re-validating at
 * the entity boundary keeps this layer self-defending against a future store
 * implementation that forgets the check.
 */
export function buildWorkflowFileFromRow(row: WorkflowFileRow): WorkflowFile {
  try {
    return { id: asWorkflowId(row.id), yaml: asYamlSource(row.yaml) };
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      throw new Error(
        `workflow store yielded an invalid file row (id="${row.id}"): ${e.reason}`,
      );
    }
    throw e;
  }
}
