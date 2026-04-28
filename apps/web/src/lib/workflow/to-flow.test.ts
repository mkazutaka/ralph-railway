import { describe, expect, it } from 'vitest';
import { yamlToFlow } from './to-flow';

const sample = `
document:
  dsl: '1.0.0'
  namespace: test
  name: demo
  version: '1.0.0'
do:
  - first:
      set:
        x: 1
  - second:
      set:
        y: 2
`;

describe('yamlToFlow', () => {
  it('produces a node per top-level task and edges in order', () => {
    const { nodes, edges } = yamlToFlow(sample);
    expect(nodes.map((n) => n.id)).toEqual(['first', 'second']);
    expect(edges).toEqual([{ id: 'first->second', source: 'first', target: 'second' }]);
  });

  it('detects task kinds for each node', () => {
    const yamlWithMix = `
do:
  - a:
      set: { x: 1 }
  - b:
      call:
        function: foo
`;
    const { nodes } = yamlToFlow(yamlWithMix);
    expect(nodes.map((n) => n.data.kind)).toEqual(['set', 'call']);
  });

  it('positions nodes vertically with a 96px gap', () => {
    const { nodes } = yamlToFlow(sample);
    expect(nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(nodes[1]!.position).toEqual({ x: 0, y: 96 });
  });

  it('returns empty graph for invalid YAML', () => {
    const { nodes, edges, error } = yamlToFlow(': : :');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
    expect(error).toBeDefined();
  });

  it('returns an error when top-level `do` is missing', () => {
    const { nodes, edges, error } = yamlToFlow('document:\n  name: demo\n');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
    expect(error).toMatch(/do/);
  });

  it('skips entries that are not single-key task maps', () => {
    const ill = `
do:
  - {}
  - good:
      set: { x: 1 }
`;
    const { nodes } = yamlToFlow(ill);
    expect(nodes.map((n) => n.id)).toEqual(['good']);
  });
});
