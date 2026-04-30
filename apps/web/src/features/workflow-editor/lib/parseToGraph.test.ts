import { describe, expect, it } from 'vitest';
import { asYamlSource } from '../entities/types';
import { parseToGraph } from './parseToGraph';

describe('parseToGraph', () => {
  it('returns an empty graph with parseError for syntactically broken YAML (invariant 2)', () => {
    const g = parseToGraph(asYamlSource('do: [unclosed\n'));
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.parseError).not.toBeNull();
  });

  it('returns an empty graph + parseError when the root is not a mapping', () => {
    const g = parseToGraph(asYamlSource('- not\n- a\n- map\n'));
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.parseError).not.toBeNull();
  });

  it('treats a missing or null `do` key as an empty task list (no parse error)', () => {
    const g = parseToGraph(asYamlSource('document:\n  name: blank\n'));
    expect(g.parseError).toBeNull();
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it('linearises the do list into a sequential chain', () => {
    const yaml = 'do:\n  - a: { run: "echo a" }\n  - b: { call: "noop" }\n  - c: { set: { x: 1 } }\n';
    const g = parseToGraph(asYamlSource(yaml));
    expect(g.parseError).toBeNull();
    expect(g.nodes.map((n) => ({ id: n.id as string, kind: n.kind }))).toEqual([
      { id: 'a', kind: 'run' },
      { id: 'b', kind: 'call' },
      { id: 'c', kind: 'set' },
    ]);
    expect(
      g.edges.map((e) => ({
        id: e.id,
        source: e.source as string,
        target: e.target as string,
      })),
    ).toEqual([
      { id: 'a->b', source: 'a', target: 'b' },
      { id: 'b->c', source: 'b', target: 'c' },
    ]);
  });

  it('produces no edges for a single-node graph', () => {
    const yaml = 'do:\n  - only: { run: "echo" }\n';
    const g = parseToGraph(asYamlSource(yaml));
    expect(g.nodes.map((n) => n.id as string)).toEqual(['only']);
    expect(g.edges).toEqual([]);
  });

  it('falls back to "unknown" kind when no DSL keyword is present', () => {
    const yaml = 'do:\n  - mystery: { foo: 1 }\n';
    const g = parseToGraph(asYamlSource(yaml));
    expect(g.nodes[0]?.kind).toBe('unknown');
  });
});
