import { beforeEach, describe, expect, it } from 'vitest';
import { __resetYamlToFlowCacheForTests, yamlToFlow } from './to-flow';

beforeEach(() => {
  // Clear the module-scoped memo so tests that assert on output values are
  // isolated from each other (the cache is keyed on the YAML string and a
  // previous test's identical input would short-circuit the parse path).
  __resetYamlToFlowCacheForTests();
});

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

  it('positions nodes horizontally with a 240px gap (matches design EbnDF)', () => {
    // Horizontal layout matches the design (`apps/web/design/app.pen` frame
    // `EbnDF`: Manual Run x=30, Shell x=240, both y=300) and the
    // `Right`/`Left` source/target handle positions enforced by
    // `Graph.svelte`. A previous vertical layout produced visually wrong
    // "loop-back" bezier edges (review note P0-1).
    const { nodes } = yamlToFlow(sample);
    expect(nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(nodes[1]!.position).toEqual({ x: 240, y: 0 });
  });

  it('returns empty graph for invalid YAML', () => {
    const { nodes, edges, error } = yamlToFlow(': : :');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
    expect(error).toBeDefined();
  });

  it('treats missing top-level `do` as an empty graph (matches server policy)', () => {
    // Mirrors `parseWorkflowYaml` in `features/workflow-editor/lib/yaml.ts`,
    // which treats `do: null` / a missing `do:` as an empty task list. The
    // editor's read-only flow visualisation must agree so a freshly-created
    // workflow doesn't flash a red banner before the user inserts the first
    // pattern (review note m-1).
    const { nodes, edges, error } = yamlToFlow('document:\n  name: demo\n');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
    expect(error).toBeUndefined();
  });

  it('treats `do: null` (empty value) as an empty graph', () => {
    const { nodes, edges, error } = yamlToFlow('document:\n  name: demo\ndo:\n');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
    expect(error).toBeUndefined();
  });

  it('returns an error when top-level `do` is not a list', () => {
    const { nodes, edges, error } = yamlToFlow('do: not-a-list\n');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
    expect(error).toMatch(/do/);
  });

  it('returns an error when the root is not a mapping', () => {
    const { nodes, edges, error } = yamlToFlow('- one\n- two\n');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
    expect(error).toBeDefined();
  });

  it('returns the same reference when called twice with the same source (memoization, P1-1)', () => {
    // SvelteFlow uses array reference identity to decide when to re-run its
    // internal layout / fitView passes. Identical YAML input must therefore
    // round-trip through the memo and yield the same `{ nodes, edges }`
    // object (and the same nested arrays) on a second call.
    const a = yamlToFlow(sample);
    const b = yamlToFlow(sample);
    expect(b).toBe(a);
    expect(b.nodes).toBe(a.nodes);
    expect(b.edges).toBe(a.edges);
  });

  it('returns a fresh result when the source string changes (memoization, P1-1)', () => {
    const a = yamlToFlow(sample);
    const b = yamlToFlow(sample + '\n# trailing comment is a new source\n');
    expect(b).not.toBe(a);
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

  it('extracts bodyStepCount and until for `for` (loop) tasks', () => {
    // The Loop Container variant in `WorkflowNode.svelte` (Pencil `yr3GN`)
    // surfaces the inner step count via an accent-pill badge (`YR65n`) and
    // the exit condition via the `loop back until …` footer (`OrLXv`).
    // The adapter has to extract both fields here because the WorkflowNode
    // is purely visual and does not re-parse the YAML.
    const yamlSrc = `
do:
  - approval_loop:
      for:
        each: item
        in: \${ .var.items }
        until: \${ .var.approved }
        do:
          - send_request:
              run:
                shell:
                  command: echo request
          - wait_for_review:
              run:
                shell:
                  command: echo waiting
`;
    const { nodes } = yamlToFlow(yamlSrc);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.data.kind).toBe('for');
    expect(nodes[0]!.data.bodyStepCount).toBe(2);
    expect(nodes[0]!.data.until).toBe('${ .var.approved }');
  });

  it('falls back to undefined bodyStepCount/until when the for body is missing', () => {
    // Defensive: a half-typed loop pattern (e.g. just `for: { each, in }`)
    // should still produce a valid node — the WorkflowNode will fall back
    // to the static "loop" / "loop body" captions.
    const yamlSrc = `
do:
  - half:
      for:
        each: item
        in: \${ .var.items }
`;
    const { nodes } = yamlToFlow(yamlSrc);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.data.kind).toBe('for');
    expect(nodes[0]!.data.bodyStepCount).toBeUndefined();
    expect(nodes[0]!.data.until).toBeUndefined();
  });

  it('accepts `while` as an alias for the loop exit condition', () => {
    // The runtime accepts both `until` and `while` for the loop's exit
    // condition; the adapter surfaces whichever the user typed so the UI
    // does not silently drop one of the two equivalent forms.
    const yamlSrc = `
do:
  - poll:
      for:
        each: i
        in: \${ .var.range }
        while: \${ .var.continue }
        do: []
`;
    const { nodes } = yamlToFlow(yamlSrc);
    expect(nodes[0]!.data.until).toBe('${ .var.continue }');
  });
});
