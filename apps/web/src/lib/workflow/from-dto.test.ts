import { describe, expect, it } from 'vitest';
import { flowGraphFromDto } from './from-dto';
import type { FlowGraphDto } from '$features/workflow-editor/entities/dto';

describe('flowGraphFromDto', () => {
  it('converts DMMF nodes/edges into xyflow-shaped equivalents', () => {
    // Two-node chain — mirrors the linear `do` topology produced by the
    // server-side `parseToGraph` helper for a simple workflow.
    const dto: FlowGraphDto = {
      nodes: [
        { id: 'first', label: 'first', kind: 'set' },
        { id: 'second', label: 'second', kind: 'call' },
      ],
      edges: [{ id: 'first->second', source: 'first', target: 'second' }],
      parseError: null,
    };
    const out = flowGraphFromDto(dto);
    expect(out.nodes).toEqual([
      { id: 'first', data: { label: 'first', kind: 'set' }, position: { x: 0, y: 0 } },
      { id: 'second', data: { label: 'second', kind: 'call' }, position: { x: 240, y: 0 } },
    ]);
    expect(out.edges).toEqual([{ id: 'first->second', source: 'first', target: 'second' }]);
    expect(out.error).toBeUndefined();
  });

  it('preserves the parseError as `error` (DTO null → undefined contract)', () => {
    // Empty graph + non-null parseError is the exact shape `parseToGraph`
    // produces when the YAML is broken (scenario invariant 2). The page-level
    // `{#if parsed.error}` banner reads `error`, so we must surface
    // `parseError` under that key.
    const dto: FlowGraphDto = {
      nodes: [],
      edges: [],
      parseError: 'top-level `do` must be a list',
    };
    expect(flowGraphFromDto(dto).error).toBe('top-level `do` must be a list');
  });

  it('places successive nodes 240px apart horizontally (matches yamlToFlow layout)', () => {
    // Layout policy must agree with the legacy client-side `yamlToFlow` so
    // the canvas does not visibly shift when the page hands off from the
    // server-rendered graph to the client re-parse on first keystroke.
    // Horizontal layout matches the design `EbnDF` (review note P0-1).
    const dto: FlowGraphDto = {
      nodes: [
        { id: 'a', label: 'a', kind: 'set' },
        { id: 'b', label: 'b', kind: 'set' },
        { id: 'c', label: 'c', kind: 'set' },
      ],
      edges: [],
      parseError: null,
    };
    const out = flowGraphFromDto(dto);
    expect(out.nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 240, y: 0 },
      { x: 480, y: 0 },
    ]);
  });

  it('returns an empty graph for a DTO with no nodes', () => {
    // Freshly-created workflows have `do: null` and therefore an empty
    // graph; the canvas should render without an error banner.
    const dto: FlowGraphDto = { nodes: [], edges: [], parseError: null };
    const out = flowGraphFromDto(dto);
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.error).toBeUndefined();
  });
});
