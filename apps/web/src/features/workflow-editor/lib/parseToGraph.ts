// Pure helper that realises the `parseToGraph` dependency from
// `apps/web/docs/scenarios/workflow-management/open-workflow.md`:
//
//   func parseToGraph: YamlSource -> FlowGraph
//
// Invariant 2 from the scenario:
//   "構文エラーがある場合は ParseError にメッセージが入り、Graph は最後に
//    解析成功した状態ではなく空になる"
//
// The helper therefore:
//   - Always returns a `FlowGraph` (never throws).
//   - On parse failure, returns `{ nodes: [], edges: [], parseError: <reason> }`
//     — never a partially populated graph.
//   - On success, returns the linearised node/edge chain with `parseError: null`.
//
// Implementation note: we reuse `parseWorkflowYaml` rather than a second
// js-yaml call so the security defence-in-depth (JSON_SCHEMA, prototype-key
// rejection) lives in one place. Tasks that fail the "exactly one key" check
// are already rejected by the parser, so we can rely on `Object.keys(entry)[0]`
// being defined for every entry returned in a `parsed` result.

import type { YamlSource } from '../entities/types';
import type { FlowEdge, FlowGraph, FlowNode } from '../entities/openedWorkflow';
import { asFlowNodeId } from '../entities/openedWorkflow';
import type { TaskEntry } from '../entities/workflowDocument';
import { InvalidBrandedValueError } from '../entities/types';
import { parseWorkflowYaml } from './yaml';

/**
 * DSL action keywords the editor recognises today. Mirrors the list used by
 * the (legacy) client-side `yamlToFlow` helper so the icon-by-kind mapping in
 * `Graph.svelte` keeps working unchanged. A task whose body has none of these
 * keys collapses to `'unknown'` — the canvas falls back to a neutral node
 * style.
 */
const TASK_KINDS = ['set', 'call', 'run', 'for', 'switch', 'fork', 'try', 'do'] as const;

function detectKind(body: Record<string, unknown>): string {
  for (const k of TASK_KINDS) if (k in body) return k;
  return 'unknown';
}

/**
 * Build an empty graph carrying a parse-error message. Centralised so every
 * failure branch produces the exact same shape (review-worthy because
 * invariant 2 hinges on `nodes`/`edges` being empty in this case).
 */
function emptyGraphWithError(reason: string): FlowGraph {
  return { nodes: [], edges: [], parseError: reason };
}

/**
 * Parse a YAML source string into a `FlowGraph`. Never throws.
 *
 * The graph is a linear chain of the top-level `do` list: each entry becomes
 * one node; consecutive entries are joined by an edge. This matches the
 * current editor canvas semantics and the scenario's high-level `RenderGraph`
 * step. Branch / fork / loop topology is intentionally out of scope here and
 * will land via separate scenarios.
 */
export function parseToGraph(source: YamlSource): FlowGraph {
  const parsed = parseWorkflowYaml(source);
  if (parsed.kind === 'parseError') {
    return emptyGraphWithError(parsed.reason);
  }

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let prevId: string | null = null;

  for (const entry of parsed.document.tasks as ReadonlyArray<TaskEntry>) {
    const keys = Object.keys(entry);
    // `parseWorkflowYaml` guarantees exactly one key per entry, but we still
    // guard here so a future parser change (e.g. relaxing the check) cannot
    // silently break this layer.
    const rawId = keys[0];
    if (keys.length !== 1 || !rawId) {
      return emptyGraphWithError('each `do` entry must have exactly one key');
    }
    const body = entry[rawId];
    const kindSource =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    let nodeId;
    try {
      nodeId = asFlowNodeId(rawId);
    } catch (e) {
      // The node id rejected by the brand boundary is structurally invalid
      // (e.g. starts with a punctuation character, exceeds 128 bytes, …).
      // Surface it as a parse error so the editor still opens — invariant 1
      // ("YAML が壊れていてもワークフロー自体は開ける") only holds when we
      // never throw from this helper.
      const reason =
        e instanceof InvalidBrandedValueError
          ? `invalid task id "${rawId}": ${e.reason}`
          : `invalid task id "${rawId}"`;
      return emptyGraphWithError(reason);
    }

    nodes.push({ id: nodeId, label: rawId, kind: detectKind(kindSource) });
    if (prevId !== null) {
      edges.push({
        id: `${prevId}->${rawId}`,
        source: asFlowNodeId(prevId),
        target: nodeId,
      });
    }
    prevId = rawId;
  }

  return { nodes, edges, parseError: null };
}
