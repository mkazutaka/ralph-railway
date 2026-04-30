import yaml from 'js-yaml';

// Lock the parser to JSON_SCHEMA so editor-buffer reads stay aligned with the
// server-side `parseWorkflowYaml` (see `features/workflow-editor/lib/yaml.ts`).
// The default schema enables YAML tags such as `!!js/function` which we never
// want evaluated client-side either, even though this code path only feeds the
// read-only flow visualisation.
const FLOW_PARSE_OPTIONS: yaml.LoadOptions = { schema: yaml.JSON_SCHEMA };

export interface FlowNode {
  id: string;
  data: {
    label: string;
    kind: string;
    /**
     * Number of body steps for the `for` (loop) variant. Drives the
     * accent-pill `${n} step(s)` badge in the design's Loop Container
     * (Pencil `yr3GN/YR65n`). Only populated for `kind === 'for'` and only
     * when the YAML carries a non-empty `do:` list inside the loop body —
     * `WorkflowNode.svelte` falls back to a generic `loop` label when the
     * value is missing (e.g. server-side `flowGraphFromDto` path which does
     * not carry loop body shape).
     */
    bodyStepCount?: number;
    /**
     * Loop exit condition surfaced in the Loop Container footer
     * ("loop back until …", Pencil `rgIgJ/OrLXv`). Extracted from the
     * `for:` task's `until` / `while` expression. `WorkflowNode.svelte`
     * falls back to a static `loop body` caption when missing so the loop
     * variant still renders correctly on the server-rendered initial view.
     */
    until?: string;
  };
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  error?: string;
}

const TASK_KINDS = ['set', 'call', 'run', 'for', 'switch', 'fork', 'try', 'do'] as const;
// Horizontal layout: nodes flow left-to-right with `Right`/`Left` source/target
// handles (see `Graph.svelte`). The 240px step matches the design's 30→240→450
// node x positions in `apps/web/design/app.pen` frame `EbnDF` (180px node +
// ~60px edge gutter), and a 0 y matches the design's flat baseline (review
// note P0-1: vertical layout + horizontal handles produced visually wrong
// "loop-back" bezier edges).
const NODE_GAP_X = 240;

function detectKind(task: Record<string, unknown>): string {
  for (const k of TASK_KINDS) if (k in task) return k;
  return 'unknown';
}

/*
 * Module-scoped memo for the most recent `(source -> FlowGraph)` result.
 *
 * SvelteFlow ((`@xyflow/svelte`) uses array reference identity to decide
 * when to re-run its internal layout / fitView passes. Without this cache,
 * every keystroke in the YAML buffer produces a brand-new `{ nodes, edges }`
 * pair (reference-different even when the parsed graph is byte-equal),
 * which makes large workflows visibly judder while typing. The cache is a
 * single-slot LRU keyed on the raw YAML string — strings are interned in
 * V8 and the editor only renders one workflow at a time, so a single slot
 * is sufficient and avoids a Map's overhead on hot keystroke paths
 * (review note P1-1).
 *
 * The cache is intentionally module-scoped (not per-call) so it survives
 * across `$derived` recomputations triggered by sibling reactive deps that
 * don't change `editor.yaml`.
 */
let lastSource: string | undefined;
let lastResult: FlowGraph | undefined;

export function yamlToFlow(source: string): FlowGraph {
  if (lastSource === source && lastResult) return lastResult;

  let parsed: unknown;
  try {
    parsed = yaml.load(source, FLOW_PARSE_OPTIONS);
  } catch (e) {
    const err: FlowGraph = { nodes: [], edges: [], error: (e as Error).message };
    lastSource = source;
    lastResult = err;
    return err;
  }

  // Match the server-side `parseWorkflowYaml` policy (see
  // `features/workflow-editor/lib/yaml.ts`): an empty / missing / `do: null`
  // top-level key is treated as an empty task list, not a parse error. This
  // keeps the freshly-created workflow case from flashing a red banner before
  // the user inserts the first pattern.
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err: FlowGraph = { nodes: [], edges: [], error: 'workflow root must be a mapping' };
    lastSource = source;
    lastResult = err;
    return err;
  }
  const doRaw = (parsed as { do?: unknown }).do;
  let list: Array<Record<string, unknown>>;
  if (doRaw === undefined || doRaw === null) {
    list = [];
  } else if (Array.isArray(doRaw)) {
    list = doRaw as Array<Record<string, unknown>>;
  } else {
    const err: FlowGraph = { nodes: [], edges: [], error: 'top-level `do` must be a list' };
    lastSource = source;
    lastResult = err;
    return err;
  }

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let prev: string | null = null;
  let x = 0;

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const keys = Object.keys(entry);
    if (keys.length !== 1) continue;
    const name = keys[0]!;
    const body = (entry as Record<string, unknown>)[name];
    if (!body || typeof body !== 'object') continue;
    const bodyRecord = body as Record<string, unknown>;
    const kind = detectKind(bodyRecord);
    // For `for` (loop) tasks we surface two extra fields the WorkflowNode's
    // Loop Container variant displays (Pencil `yr3GN`):
    //   - `bodyStepCount`: number of nested tasks under `for: { do: [...] }`.
    //     Drives the accent-pill `${n} steps` badge (Pencil `YR65n`).
    //   - `until`: the loop exit condition expression. Drives the
    //     `loop back until …` footer (Pencil `OrLXv`). We accept both
    //     `until` and `while` keys at the `for` level so the UI doesn't
    //     silently drop one of the two equivalent forms the runtime accepts.
    // Non-loop tasks leave both fields undefined; the WorkflowNode then
    // falls back to its static `loop` / `loop body` strings (which only
    // matter for the Loop variant, so step variants are unaffected).
    const data: FlowNode['data'] = { label: name, kind };
    if (kind === 'for') {
      const forBody = bodyRecord.for;
      if (forBody && typeof forBody === 'object' && !Array.isArray(forBody)) {
        const innerDo = (forBody as { do?: unknown }).do;
        if (Array.isArray(innerDo)) {
          data.bodyStepCount = innerDo.length;
        }
        const untilExpr = (forBody as { until?: unknown; while?: unknown }).until ??
          (forBody as { while?: unknown }).while;
        if (typeof untilExpr === 'string' && untilExpr.length > 0) {
          data.until = untilExpr;
        }
      }
    }
    nodes.push({ id: name, data, position: { x, y: 0 } });
    if (prev) edges.push({ id: `${prev}->${name}`, source: prev, target: name });
    prev = name;
    x += NODE_GAP_X;
  }

  const result: FlowGraph = { nodes, edges };
  lastSource = source;
  lastResult = result;
  return result;
}

/**
 * Test-only escape hatch: clear the memoization slot. Production code paths
 * never need this — the memo is keyed on the YAML string identity which the
 * editor naturally produces fresh values for. Unit tests, however, sometimes
 * want a clean slate between cases (e.g. when asserting that the same input
 * always produces the same output reference).
 */
export function __resetYamlToFlowCacheForTests(): void {
  lastSource = undefined;
  lastResult = undefined;
}
