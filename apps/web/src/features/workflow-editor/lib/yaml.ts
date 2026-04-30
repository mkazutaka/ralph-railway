import yaml from 'js-yaml';
import type { YamlSource } from '../entities/types';
import { asYamlSource } from '../entities/types';
import type { PatternTemplate } from '../entities/pattern';
import type { TaskEntry, WorkflowDocument } from '../entities/workflowDocument';
import { listTaskIds } from '../entities/workflowDocument';

// NOTE (review note N2): the scenario distinguishes "YAML parse error" from
// "DSL schema violation" but both currently collapse into `parseError` because
// the schema check is hand-rolled below. If a structured DSL schema validator
// (zod / valibot) is introduced later, widen this union to
// `parseError | schemaViolation` so the workflow / route can branch on it.
export type ParseYamlResult =
  | { kind: 'parsed'; document: WorkflowDocument }
  | { kind: 'parseError'; reason: string };

/**
 * Parse a YAML source string into a WorkflowDocument. Returns a sum-type
 * result; never throws.
 *
 * Invariant 4 from the scenario: callers must refuse to insert into a base
 * YAML that fails to parse. We surface a structured error so the workflow can
 * propagate it as `InvalidBaseYaml`.
 *
 * Edge case (documented in `insert-pattern.md` 設計メモ): a missing top-level
 * `do` key, or `do:` with no value (which YAML lexes as `null`), is treated
 * as an empty task list `[]` rather than a parse error. This permits the
 * very first pattern to be inserted into a freshly created workflow file
 * without manual editing, and does not violate invariant 4 because nothing
 * about the YAML is *syntactically* broken — there are simply no tasks yet.
 */
// SECURITY: js-yaml's default load uses DEFAULT_SCHEMA which can resolve some
// non-trivial tags. We pin both the parser and the serializer to JSON_SCHEMA
// so YAML inputs cannot smuggle custom tag types (`!!js/function`, regexp,
// etc.) into the runtime, and we never serialize values that depend on
// non-JSON tags. JSON_SCHEMA covers all values representable by JSON which is
// a strict superset of the workflow DSL we need.
const YAML_SCHEMA = yaml.JSON_SCHEMA;

// SECURITY (review note M-4): reject mapping keys that JavaScript treats as
// prototype-shaped. Even though `parseWorkflowYaml` produces plain records
// (so the parsed object is fine), we also write the document back to disk
// verbatim via `serializeYaml`. A `__proto__: { ... }` mapping is valid JSON
// and survives the round-trip; downstream consumers that use `Object.assign`
// or property-based deep-merge would then materialise the polluted prototype
// at runtime. Banning these keys at the boundary keeps the workflow-editor
// from being the vector even if a future Ralph CLI changes its merge
// strategy.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Walk a parsed YAML value and reject any nested mapping that uses a key
 * which would alias `Object.prototype`. Returns `null` on success or a human
 * description of the first offending path on failure.
 */
function findForbiddenKey(value: unknown, path: string): string | null {
  if (value == null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k)) return `${path}.${k}`;
    const nestedPath = path === '' ? k : `${path}.${k}`;
    const found = findForbiddenKey(v, nestedPath);
    if (found) return found;
  }
  return null;
}

export function parseWorkflowYaml(source: YamlSource): ParseYamlResult {
  let raw: unknown;
  try {
    raw = yaml.load(source, { schema: YAML_SCHEMA });
  } catch (e) {
    return { kind: 'parseError', reason: (e as Error).message };
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'parseError', reason: 'workflow root must be a mapping' };
  }

  // SECURITY (review note M-4): refuse prototype-shaped keys before any
  // structural validation. Doing this once at the parse boundary means the
  // rest of the pipeline (merge, serialize, write) cannot accidentally
  // re-introduce them.
  const polluted = findForbiddenKey(raw, '');
  if (polluted) {
    return {
      kind: 'parseError',
      reason: `forbidden key in workflow: ${polluted}`,
    };
  }

  const root = raw as Record<string, unknown>;
  const doRaw = root.do;
  // YAML allows `do:` (no value) which parses as `null`. Treat that — and an
  // entirely missing `do` key — as an empty task list rather than a parse
  // error, so the very first pattern can be inserted into a freshly created
  // workflow file. This matches the scenario's invariant that we only refuse
  // *syntactically broken* base YAML.
  let doList: unknown[];
  if (doRaw === undefined || doRaw === null) {
    doList = [];
  } else if (Array.isArray(doRaw)) {
    doList = doRaw;
  } else {
    return { kind: 'parseError', reason: 'top-level `do` must be a list' };
  }

  const tasks: TaskEntry[] = [];
  for (const entry of doList) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { kind: 'parseError', reason: 'each `do` entry must be a mapping' };
    }
    const keys = Object.keys(entry);
    if (keys.length !== 1) {
      return {
        kind: 'parseError',
        reason: `each \`do\` entry must have exactly one key (got ${keys.length})`,
      };
    }
    tasks.push(entry as TaskEntry);
  }

  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(root)) {
    if (k !== 'do') meta[k] = v;
  }

  return { kind: 'parsed', document: { meta, tasks } };
}

export function serializeYaml(document: WorkflowDocument): YamlSource {
  // Reassemble the root mapping while preserving the original `meta` order
  // and placing `do` at the end (matches existing example fixtures).
  const root: Record<string, unknown> = { ...document.meta, do: document.tasks };
  return asYamlSource(
    yaml.dump(root, { lineWidth: 120, noRefs: true, schema: YAML_SCHEMA }),
  );
}

export type MergePatternResult =
  | { kind: 'merged'; document: WorkflowDocument }
  | { kind: 'idConflict' }
  // Template registry shape violation. Distinct from `idConflict` because
  // it indicates a server-side bug, not a user-facing conflict — callers
  // should map this to 500 (internal), not 409.
  | { kind: 'templateMalformed'; reason: string };

const MAX_RENAME_ATTEMPTS = 1000;

/**
 * Merge a PatternTemplate into a WorkflowDocument by appending its tasks to
 * the *end* of the `do` list (design choice: keeps invariant 2 trivially
 * satisfied and matches the current single-action picker UX. Future revisions
 * may expose an explicit insertion point — see scenario "future work").
 *
 * If a base ID already exists in the document, a numeric suffix is allocated
 * to keep IDs unique without renaming any pre-existing task (invariant 2).
 *
 * - `idConflict`: cannot allocate a unique ID after `MAX_RENAME_ATTEMPTS`
 *   (extreme corner case; safety net).
 * - `templateMalformed`: pattern template entry has zero or multiple keys —
 *   signals a registry bug, not user-recoverable.
 */
export function mergePatternIntoDocument(
  document: WorkflowDocument,
  template: PatternTemplate,
): MergePatternResult {
  const used = new Set<string>(listTaskIds(document));
  const appended: TaskEntry[] = [];

  for (const entry of template.tasks) {
    const keys = Object.keys(entry);
    if (keys.length !== 1 || !keys[0]) {
      return {
        kind: 'templateMalformed',
        reason: `pattern entry must have exactly one key (got ${keys.length})`,
      };
    }
    const baseId = keys[0];
    const value = entry[baseId];

    let candidate = baseId;
    let attempt = 1;
    while (used.has(candidate)) {
      if (attempt >= MAX_RENAME_ATTEMPTS) return { kind: 'idConflict' };
      attempt += 1;
      candidate = `${baseId}_${attempt}`;
    }
    used.add(candidate);
    appended.push({ [candidate]: value });
  }

  return {
    kind: 'merged',
    document: {
      meta: document.meta,
      tasks: [...document.tasks, ...appended],
    },
  };
}
