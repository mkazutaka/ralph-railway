// Pure helper that decides whether a parsed `WorkflowDocument` only uses
// node types the runtime currently supports. Mirrors the scenario's
// `validateRuntimeSupport` dependency in
// `apps/web/docs/scenarios/workflow-editor/run-workflow.md`:
//
//   func validateRuntimeSupport: WorkflowDocument -> Supported OR UnsupportedNode
//
// The capability matrix mirrors the `supported: boolean` flag in
// `repositories/patternTemplateRepository.ts` (single source of truth for
// "what does the Ralph runtime understand today"). When new node types
// are implemented in the runtime, both lists are updated together.

import type { TaskEntry, WorkflowDocument } from '../entities/workflowDocument';

/**
 * Discriminated union returned by `validateRuntimeSupport`. The success
 * variant carries no payload (the document was already in hand at the
 * call site); the failure variant names the offending node type so the
 * workflow can surface a precise `UnsupportedNode(nodeType: string)` to
 * the caller.
 */
export type ValidateRuntimeSupportResult =
  | { kind: 'supported' }
  | { kind: 'unsupportedNode'; nodeType: string };

/**
 * Node types the Ralph runtime can execute today. Kept in sync with the
 * `supported: true` entries in `patternTemplateRepository.ts` so a
 * pattern offered to the editor is also a pattern the runtime can run.
 *
 * `do` and `run` are the implicit container forms: `do` is the task list
 * and `run` is the leaf execution wrapper. `for` is the loop iterator
 * key (sibling of `do` inside a loop step) — not itself a node type but
 * appearing in the same key namespace, so we list it here rather than
 * special-case it elsewhere.
 */
const SUPPORTED_NODE_TYPES: ReadonlySet<string> = new Set([
  'do',
  'run',
  'if',
  'switch',
  'loop',
  'for',
  'set',
]);

/**
 * Node types the runtime cannot yet execute. Documentation only — the
 * actual rejection rule below is "key not in `SUPPORTED_NODE_TYPES`" so
 * unknown future keys (added to the YAML schema before the runtime
 * adapter ships) are conservatively rejected without a code change here.
 */
const KNOWN_UNSUPPORTED_NODE_TYPES: ReadonlySet<string> = new Set([
  'fork',
  'try',
  'catch',
  'retry',
]);

/**
 * Reserved keys that may appear alongside a node-type key inside a task
 * body. These are workflow-author metadata (guards, descriptions, etc.)
 * — not node types — and must not be checked against the runtime support
 * matrix. Without this allow-list a task like
 * `{ step: { if: "...", run: ... } }` would treat `if` as the node type
 * even though it is acting as a guard expression.
 */
const RESERVED_TASK_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'when',
  'continue_on_error',
  'with',
]);

/**
 * Container keys whose *value* contains further task entries we must
 * descend into. Anything outside this list is treated as opaque data
 * belonging to the surrounding node — descending into it would cause
 * false positives like `set: { n: 1 }` flagging `n` as an unknown node
 * type.
 */
const CONTAINER_KEYS: ReadonlySet<string> = new Set([
  'do',
  'branches',
  'cases',
]);

/**
 * Extract the runtime-meaningful node-type keys from a single task
 * entry. A task entry is a record like `{ stepId: { run: {...} } }`
 * (per the `WorkflowDocument` shape — exactly one top-level key, the
 * task id). The inner record may itself contain multiple keys; the
 * *node type* is any inner key that is not a reserved metadata key.
 */
function extractNodeTypes(entry: TaskEntry): string[] {
  const taskIds = Object.keys(entry);
  if (taskIds.length !== 1) return [];
  const taskId = taskIds[0]!;
  const body = entry[taskId];
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return [];
  }
  const out: string[] = [];
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (RESERVED_TASK_KEYS.has(key)) continue;
    out.push(key);
  }
  return out;
}

/**
 * Walk the *value* of a container key (`do` / `branches` / `cases`) and
 * accumulate any node-type keys found in nested task entries. The
 * walker only follows further container keys — opaque payloads (the
 * body of `set:`, `run:`, `if:` expression strings, ...) are never
 * descended into, so their property names cannot leak into the sink.
 */
function collectFromContainerValue(value: unknown, sink: Set<string>): void {
  if (value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const keys = Object.keys(item as Record<string, unknown>);
      if (keys.length === 1) {
        // TaskEntry shape — single key is the task id.
        for (const t of extractNodeTypes(item as TaskEntry)) sink.add(t);
        const body = (item as Record<string, unknown>)[keys[0]!];
        descendIntoContainers(body, sink);
      } else {
        // Multi-key list element (e.g. `branches: [{ do: [...] }]` or
        // `cases: [{ when: ..., do: ... }]`). Only descend through the
        // container keys present in this mapping.
        descendIntoContainers(item, sink);
      }
    }
    return;
  }
  // Mapping value — descend through its container keys.
  descendIntoContainers(value, sink);
}

/**
 * Visit only the container-shaped keys of a mapping. Splitting this
 * out from `collectFromContainerValue` keeps the recursion focused:
 * every descent is gated by `CONTAINER_KEYS` so opaque payloads never
 * contribute keys to the sink.
 */
function descendIntoContainers(value: unknown, sink: Set<string>): void {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!CONTAINER_KEYS.has(key)) continue;
    collectFromContainerValue(child, sink);
  }
}

export function validateRuntimeSupport(
  document: WorkflowDocument,
): ValidateRuntimeSupportResult {
  // Walk every task entry and collect node-type keys reachable through
  // container keys. Surface the *first* unsupported type in document
  // order — the workflow contract returns a single
  // `UnsupportedNode(nodeType: string)` and a deterministic error
  // message gives the user something concrete to fix.
  for (const entry of document.tasks) {
    const seen = new Set<string>();
    for (const t of extractNodeTypes(entry)) seen.add(t);
    const taskIds = Object.keys(entry);
    if (taskIds.length === 1) {
      const body = entry[taskIds[0]!];
      descendIntoContainers(body, seen);
    }
    for (const nodeType of seen) {
      if (!SUPPORTED_NODE_TYPES.has(nodeType)) {
        return { kind: 'unsupportedNode', nodeType };
      }
    }
  }
  return { kind: 'supported' };
}

/**
 * Test seam: expose the supported / known-unsupported sets so the unit
 * tests can assert the matrix without re-declaring it.
 */
export const _SUPPORTED_NODE_TYPES_FOR_TESTING = SUPPORTED_NODE_TYPES;
export const _KNOWN_UNSUPPORTED_NODE_TYPES_FOR_TESTING =
  KNOWN_UNSUPPORTED_NODE_TYPES;
