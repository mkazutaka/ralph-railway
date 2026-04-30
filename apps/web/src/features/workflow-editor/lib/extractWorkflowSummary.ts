// Pure helper that realises the `extractWorkflowSummary` dependency from
// `apps/web/docs/scenarios/workflow-management/list-workflows.md`:
//
//   func extractWorkflowSummary: WorkflowFile -> WorkflowSummary
//
// The scenario states:
//   - Name は YAML から抽出（document name）or ファイル名
//   - 抽出に失敗したら fallback Name = file basename
//
// Fallback behaviour is therefore part of this helper: it never throws and
// never returns `null` — invariant 2 ("各 WorkflowSummary には必ず Name が
// 設定される") is enforced here so the workflow layer can rely on the result
// being well-formed even when the underlying YAML is broken.

import type { WorkflowFile } from '../entities/workflowFile';
import type { WorkflowSummary } from '../entities/workflowSummary';
import type { WorkflowId } from '../entities/types';
import { parseWorkflowYaml } from './yaml';

/**
 * Strip the `.yaml` / `.yml` extension from a workflow id to produce the
 * fallback display name. Mirrors `newCreatedWorkflow` in `createdWorkflow.ts`
 * so the listing and post-create displays use the same convention.
 */
function basenameOf(id: WorkflowId): string {
  return (id as string).replace(/\.(ya?ml)$/, '');
}

/**
 * Read `document.name` from a parsed workflow YAML's `meta` map. Returns
 * `null` when the field is absent, blank, or not a string — the caller falls
 * back to the file basename in those cases.
 *
 * The helper does not trim whitespace beyond a non-empty check so the actual
 * authored value reaches the listing UI verbatim. A future product decision
 * to normalise (collapse runs, strip leading/trailing whitespace) belongs at
 * the DTO layer, not here.
 */
function readDocumentName(meta: Readonly<Record<string, unknown>>): string | null {
  const document = meta.document;
  if (document == null || typeof document !== 'object' || Array.isArray(document)) {
    return null;
  }
  const name = (document as Record<string, unknown>).name;
  if (typeof name !== 'string') return null;
  if (name.length === 0) return null;
  return name;
}

/**
 * Realise a `WorkflowSummary` from a `WorkflowFile`. Never throws.
 *
 * Behavioural contract (matches the scenario step "SummarizeEach"):
 *   - Returns `{ id, name = document.name }` when the YAML parses and has a
 *     non-empty `document.name` string.
 *   - Returns `{ id, name = file basename }` in every other case (parse
 *     failure, missing `document` key, non-string name, empty string).
 */
export function extractWorkflowSummary(file: WorkflowFile): WorkflowSummary {
  const fallback = basenameOf(file.id);

  const parsed = parseWorkflowYaml(file.yaml);
  if (parsed.kind !== 'parsed') {
    return { id: file.id, name: fallback };
  }
  const documentName = readDocumentName(parsed.document.meta);
  return { id: file.id, name: documentName ?? fallback };
}
