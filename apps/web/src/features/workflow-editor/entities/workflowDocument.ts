// A `WorkflowDocument` is the parsed in-memory representation of a workflow YAML file.
//
// The Ralph Railway DSL keeps the top-level `do` array as an ordered list where
// each entry is a single-key map whose key is the task ID. To preserve the
// invariant that "existing task IDs are not changed by an insertion" (see
// scenarios/workflow-editor/insert-pattern.md), we keep these tasks as plain
// records and only manipulate IDs through `mergePatternIntoDocument`.

export type TaskEntry = Record<string, unknown>;

export interface WorkflowDocument {
  /**
   * All other top-level keys (document metadata, etc.) preserved verbatim.
   * `Readonly` reflects the contract that mergers and serializers MUST treat
   * `meta` as immutable — invariant 2 only holds when no consumer mutates
   * the existing document in place.
   */
  readonly meta: Readonly<Record<string, unknown>>;
  /**
   * Top-level `do` task list. Each entry has exactly one key (the task ID).
   * `ReadonlyArray<TaskEntry>` enforces append-only semantics at the type
   * level so a future merger can't accidentally splice out an existing task
   * and silently violate invariant 2 ("existing task IDs are never changed").
   */
  readonly tasks: ReadonlyArray<TaskEntry>;
}

export function listTaskIds(doc: WorkflowDocument): string[] {
  const ids: string[] = [];
  for (const entry of doc.tasks) {
    const keys = Object.keys(entry);
    if (keys.length === 1 && keys[0]) ids.push(keys[0]);
  }
  return ids;
}
