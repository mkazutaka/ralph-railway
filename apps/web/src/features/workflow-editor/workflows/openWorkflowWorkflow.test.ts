import { describe, expect, it } from 'vitest';
import { asWorkflowId, asYamlSource } from '../entities/types';
import type { ReadWorkflowFile } from '../repositories/workflowFileRepository';
import { parseWorkflowYaml } from '../lib/yaml';
import { parseToGraph } from '../lib/parseToGraph';
import { openWorkflowWorkflow } from './openWorkflowWorkflow';

function makeReader(map: Record<string, string>): ReadWorkflowFile {
  return async (id) => {
    const yaml = map[id as string];
    if (yaml === undefined) return { kind: 'notFound' };
    return { kind: 'found', yaml: asYamlSource(yaml) };
  };
}

describe('openWorkflowWorkflow', () => {
  it('returns notFound when the file does not exist (scenario: LocateWorkflow → NotFound)', async () => {
    const out = await openWorkflowWorkflow(
      { workflowId: asWorkflowId('missing.yaml') },
      {
        readWorkflowFile: makeReader({}),
        parseToGraph,
        parseWorkflowYaml,
      },
    );
    expect(out.kind).toBe('notFound');
  });

  it('returns workflowOpened with the parsed graph on the happy path', async () => {
    const yaml = 'document:\n  name: My Pipeline\ndo:\n  - build: { run: "make" }\n  - test: { run: "make test" }\n';
    const out = await openWorkflowWorkflow(
      { workflowId: asWorkflowId('demo.yaml') },
      {
        readWorkflowFile: makeReader({ 'demo.yaml': yaml }),
        parseToGraph,
        parseWorkflowYaml,
      },
    );
    expect(out.kind).toBe('workflowOpened');
    if (out.kind !== 'workflowOpened') return;
    expect(out.opened.id as string).toBe('demo.yaml');
    expect(out.opened.name).toBe('My Pipeline');
    expect(out.opened.graph.parseError).toBeNull();
    expect(out.opened.graph.nodes.map((n) => n.id as string)).toEqual(['build', 'test']);
    expect(out.opened.graph.edges.map((e) => `${e.source as string}->${e.target as string}`)).toEqual([
      'build->test',
    ]);
  });

  it('falls back to the file basename when document.name is missing', async () => {
    const yaml = 'do: []\n';
    const out = await openWorkflowWorkflow(
      { workflowId: asWorkflowId('release.v2.yaml') },
      {
        readWorkflowFile: makeReader({ 'release.v2.yaml': yaml }),
        parseToGraph,
        parseWorkflowYaml,
      },
    );
    expect(out.kind).toBe('workflowOpened');
    if (out.kind !== 'workflowOpened') return;
    expect(out.opened.name).toBe('release.v2');
  });

  it('still opens the workflow with empty graph + parseError when YAML is broken (invariant 1, 2)', async () => {
    const out = await openWorkflowWorkflow(
      { workflowId: asWorkflowId('broken.yaml') },
      {
        readWorkflowFile: makeReader({ 'broken.yaml': 'do: [unclosed\n' }),
        parseToGraph,
        parseWorkflowYaml,
      },
    );
    expect(out.kind).toBe('workflowOpened');
    if (out.kind !== 'workflowOpened') return;
    expect(out.opened.graph.nodes).toEqual([]);
    expect(out.opened.graph.edges).toEqual([]);
    expect(out.opened.graph.parseError).not.toBeNull();
    // Display name falls back to basename when YAML cannot be parsed.
    expect(out.opened.name).toBe('broken');
  });

  it('does not invoke parseToGraph on the notFound path (invariant 3: no side effects)', async () => {
    let parseCalls = 0;
    const out = await openWorkflowWorkflow(
      { workflowId: asWorkflowId('absent.yaml') },
      {
        readWorkflowFile: makeReader({}),
        parseToGraph: (yaml) => {
          parseCalls += 1;
          return parseToGraph(yaml);
        },
        parseWorkflowYaml,
      },
    );
    expect(out.kind).toBe('notFound');
    expect(parseCalls).toBe(0);
  });
});
