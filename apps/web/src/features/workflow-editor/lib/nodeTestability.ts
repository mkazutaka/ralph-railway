// Pure helpers for the "Test Node" scenario in
// `apps/web/docs/scenarios/workflow-editor/test-node.md`.
//
//   func locateNode: WorkflowDocument AND NodeId -> NodeDefinition OR NotFound
//   func validateNodeInputs: NodeDefinition AND DummyInputs -> Valid OR InvalidInputs
//
// These are deliberately structural, side-effect-free, and free of any
// dependency on the runtime / file system. The workflow layer composes them
// alongside the runtime adapter (`executeNodeOnce`) which performs the actual
// isolated execution.

import type { NodeId } from '../entities/types';
import type { TaskEntry, WorkflowDocument } from '../entities/workflowDocument';

/**
 * Per-node body extracted from a `WorkflowDocument` task entry. The shape is
 * `Record<string, unknown>` because the inner record is whatever the YAML
 * author wrote — we only inspect its top-level keys to identify the node
 * type and any reserved metadata fields (mirrors `lib/runtimeSupport.ts`).
 *
 * `nodeType` is the runtime-meaningful key (e.g. `run`, `set`, `if`). For a
 * task body like `{ run: { shell: { command: "..." } } }`, `nodeType` is
 * `"run"` and `body[nodeType]` is the payload the runtime executes.
 */
export interface NodeDefinition {
  readonly nodeId: NodeId;
  readonly nodeType: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Reserved keys that may appear alongside a node-type key inside a task body
 * — workflow-author metadata (guards, descriptions, etc.) rather than node
 * types. Mirrors `RESERVED_TASK_KEYS` in `runtimeSupport.ts`; kept as a
 * separate constant so a future divergence (e.g. test execution treats
 * `when` differently) can land without touching the runtime check.
 */
const RESERVED_TASK_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'when',
  'continue_on_error',
  'with',
]);

/**
 * Node types the test-execution runtime can run in isolation. Scenario
 * invariant 3 ("NodeNotTestable のノード（純粋なロジック構造のみのコンテナ
 * 等）には事前に拒否する") is enforced here:
 *
 *   - `run` and `set` produce a concrete output value and have no inner
 *     control flow — perfect candidates for isolated execution.
 *   - `if`, `switch`, `loop`, `for`, `do` are *containers* whose semantics
 *     come from the surrounding workflow; running them in isolation does
 *     not yield a meaningful single-node result.
 *   - `fork`, `try`, `catch`, `retry` are runtime-unsupported today (see
 *     `runtimeSupport.ts`); we surface those as `NodeNotTestable` rather
 *     than `RuntimeUnavailable` because the rejection is structural, not
 *     transient.
 */
const TESTABLE_NODE_TYPES: ReadonlySet<string> = new Set([
  'run',
  'set',
]);

export type LocateNodeResult =
  | { kind: 'located'; node: NodeDefinition }
  | { kind: 'notFound' }
  | { kind: 'notTestable'; nodeType: string };

/**
 * Walk the document's top-level `do` list and return the matching node's
 * structural definition. Returns `notFound` if no task entry has the given id;
 * returns `notTestable` if the id matches but the node's type is not in the
 * testable set (scenario invariant 3).
 *
 * Note: the scenario lists `locateNode` and "is testable?" as separate
 * substeps, but combining them here is intentional. The two checks share the
 * same traversal and an extra public function would invite callers to do
 * "locate then forget to check" — keeping them together makes "the node was
 * located AND it is testable" the only path that yields a `located` variant.
 */
export function locateNode(
  document: WorkflowDocument,
  nodeId: NodeId,
): LocateNodeResult {
  const target = nodeId as string;
  for (const entry of document.tasks) {
    const keys = Object.keys(entry);
    if (keys.length !== 1) continue;
    const taskId = keys[0]!;
    if (taskId !== target) continue;

    const body = entry[taskId];
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      // The task id matched but the body shape is malformed — treat as
      // not-testable rather than "found", because no runtime can execute
      // this in isolation.
      return { kind: 'notTestable', nodeType: '' };
    }
    const bodyRecord = body as Record<string, unknown>;
    const nodeType = pickNodeType(bodyRecord);
    if (nodeType === null) {
      return { kind: 'notTestable', nodeType: '' };
    }
    if (!TESTABLE_NODE_TYPES.has(nodeType)) {
      return { kind: 'notTestable', nodeType };
    }
    return {
      kind: 'located',
      node: { nodeId, nodeType, body: bodyRecord },
    };
  }
  return { kind: 'notFound' };
}

/**
 * Pick the runtime-meaningful key out of a task body. Reserved keys are
 * skipped; the first remaining key (in insertion order) is treated as the
 * node type. Returns `null` if every key is reserved (an empty/metadata-only
 * body that the runtime cannot execute).
 */
function pickNodeType(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (RESERVED_TASK_KEYS.has(key)) continue;
    return key;
  }
  return null;
}

export type DummyInputs = Readonly<Record<string, unknown>>;

export type ValidateNodeInputsResult =
  | { kind: 'valid' }
  | { kind: 'invalid'; reason: string };

/**
 * Structural validation of dummy inputs against the node's declared `with:`
 * (or, for `set`, the assignment map). The scenario's two failure modes are
 * called out verbatim:
 *
 *   - "type mismatch on <field>"        — a field is present but its concrete
 *                                         JS type does not match the
 *                                         declared shape.
 *   - "missing required <field>"        — a declared field is absent from
 *                                         the dummy inputs.
 *
 * The validator is deliberately conservative: when the node body does not
 * declare a `with:` schema (or declares an empty one), any inputs are
 * accepted. This matches scenario invariant 4 ("ダミー入力の型不一致は実行前
 * に検出する") — we only reject when there is an explicit declaration to
 * check against, otherwise we hand the inputs to the runtime as-is.
 */
export function validateNodeInputs(
  node: NodeDefinition,
  inputs: DummyInputs,
): ValidateNodeInputsResult {
  const declared = readDeclaredInputs(node);
  if (declared === null) {
    // No `with:` declaration — nothing to validate against.
    return { kind: 'valid' };
  }

  // Required-fields check first: a missing required field is a more
  // actionable diagnostic than "type mismatch on undefined".
  for (const [field, expected] of Object.entries(declared)) {
    if (!(field in inputs)) {
      return { kind: 'invalid', reason: `missing required ${field}` };
    }
    const actual = inputs[field];
    if (!matchesDeclaredType(expected, actual)) {
      return { kind: 'invalid', reason: `type mismatch on ${field}` };
    }
  }
  return { kind: 'valid' };
}

/**
 * Extract the declared input schema from the node body. Returns `null` when
 * the node does not declare one (so callers know to skip validation).
 *
 * - For `run` nodes the convention is `with: { field: <type-or-default> }`.
 * - For `set` nodes the assignment map IS the input schema (each key is a
 *   field, each value is its expected default; we use the value's JS type
 *   as the expected type).
 */
function readDeclaredInputs(
  node: NodeDefinition,
): Record<string, unknown> | null {
  const withRaw = (node.body as Record<string, unknown>)['with'];
  if (
    withRaw !== undefined &&
    withRaw !== null &&
    typeof withRaw === 'object' &&
    !Array.isArray(withRaw)
  ) {
    return withRaw as Record<string, unknown>;
  }
  if (node.nodeType === 'set') {
    const setRaw = node.body[node.nodeType];
    if (
      setRaw !== null &&
      typeof setRaw === 'object' &&
      !Array.isArray(setRaw)
    ) {
      return setRaw as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Compare a declared field's expected shape against an actual dummy value.
 * The declared value can be:
 *  - a primitive default (`"hello"`, `42`, `true`) — actual must be the same
 *    JS primitive type.
 *  - a marker string like `"string"` / `"number"` / `"boolean"` — actual is
 *    typechecked against that type.
 *  - an object — actual must also be a non-null, non-array object.
 *  - an array — actual must also be an array.
 *  - `null` / `undefined` — any actual value is accepted (no constraint).
 */
function matchesDeclaredType(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return true;
  if (typeof expected === 'string') {
    if (expected === 'string') return typeof actual === 'string';
    if (expected === 'number') return typeof actual === 'number';
    if (expected === 'boolean') return typeof actual === 'boolean';
    // Default-value case: declared as a string default like "hello" — actual
    // must also be a string.
    return typeof actual === 'string';
  }
  if (typeof expected === 'number') return typeof actual === 'number';
  if (typeof expected === 'boolean') return typeof actual === 'boolean';
  if (Array.isArray(expected)) return Array.isArray(actual);
  if (typeof expected === 'object') {
    return (
      actual !== null && typeof actual === 'object' && !Array.isArray(actual)
    );
  }
  return true;
}
