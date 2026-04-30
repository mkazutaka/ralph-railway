// Adapter: `FlowGraphDto` (DMMF-shaped, server-rendered) -> xyflow `Node[]`/`Edge[]`.
//
// Background (review note F-5): the open-workflow scenario's DMMF entity
// `FlowGraph` (and its DTO mirror `FlowGraphDto`) carries node ids, labels,
// and kinds in a flat shape — `{ id, label, kind }`. The Svelte Flow library
// (`@xyflow/svelte`) however expects nested `{ id, data: { label, kind },
// position }` for nodes. To consume the server-rendered graph directly in
// `Graph.svelte`, we adapt the DTO into xyflow's shape here.
//
// Layout policy is intentionally identical to the legacy client-side
// `yamlToFlow` (`./to-flow.ts`): a horizontal chain at `y = 0`, with a 240px
// gap between nodes. Keeping the same layout means switching between the
// server-rendered graph and the client-parsed graph (during live YAML edits)
// does not visibly shift the canvas — the user sees a smooth handoff with no
// node-position flicker on first keystroke. The horizontal layout matches the
// design's `Right`/`Left` source/target handle positions (review note P0-1).
//
// `parseError` is preserved separately as `error` so the page-level banner can
// surface the same message that drove the empty graph (scenario invariant 2).

import type { FlowGraphDto } from '$features/workflow-editor/entities/dto';
import type { FlowGraph } from './to-flow';

const NODE_GAP_X = 240;

/**
 * Convert a server-rendered `FlowGraphDto` into the xyflow-shaped `FlowGraph`
 * the canvas already knows how to render. The conversion is pure: same input
 * always yields a fresh, structurally-equal output. Reference identity is the
 * caller's responsibility (see `+page.svelte` for the current memoisation
 * strategy that drives SvelteFlow's layout/fitView re-runs).
 */
export function flowGraphFromDto(dto: FlowGraphDto): FlowGraph {
  const nodes = dto.nodes.map((n, i) => ({
    id: n.id,
    data: { label: n.label, kind: n.kind },
    position: { x: i * NODE_GAP_X, y: 0 },
  }));
  const edges = dto.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
  return {
    nodes,
    edges,
    // Map `null` (DTO contract) to `undefined` (xyflow-shaped FlowGraph) so
    // the existing `{#if parsed.error}` template branch keeps working without
    // an extra null-vs-undefined dance.
    error: dto.parseError ?? undefined,
  };
}
