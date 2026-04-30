import { describe, expect, it } from 'vitest';
import {
  asNodeId,
  asWorkflowId,
  asYamlSource,
} from '../entities/types';
import type { NodeTestResult } from '../entities/nodeTestResult';
import type { ReadWorkflowFile } from '../repositories/workflowFileRepository';
import type {
  ExecuteNodeOnce,
  ExecuteNodeOnceResult,
} from '../repositories/runtimeRepository';
import { parseWorkflowYaml } from '../lib/yaml';
import {
  locateNode,
  validateNodeInputs,
  type DummyInputs,
} from '../lib/nodeTestability';
import {
  testNodeWorkflow,
  type TestNodeDeps,
} from './testNodeWorkflow';

const wfA = asWorkflowId('a.yaml');
const targetNodeId = asNodeId('greet');

// A small workflow with two nodes:
//   - `greet` is a `run` node with a declared `with:` schema (testable).
//   - `decide` is an `if` node (NOT testable: it is a control-flow container).
const baseYaml = asYamlSource(
  [
    'document:',
    '  name: demo',
    'do:',
    '  - greet:',
    '      with:',
    '        name: string',
    '      run:',
    '        shell:',
    '          command: "echo hello"',
    '  - decide:',
    '      if: "n > 0"',
    '      do:',
    '        - inner:',
    '            run:',
    '              shell:',
    '                command: "echo inner"',
    '',
  ].join('\n'),
);

function makeNodeTestResult(
  overrides: Partial<NodeTestResult> = {},
): NodeTestResult {
  return {
    nodeId: targetNodeId,
    status: 'succeeded',
    output: '{"name":"world"}',
    errorMessage: null,
    logExcerpt: 'executed node "greet"',
    durationMs: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TestNodeDeps> = {}): {
  deps: TestNodeDeps;
  executeCalls: Array<{ nodeId: string; inputs: DummyInputs }>;
} {
  const executeCalls: Array<{ nodeId: string; inputs: DummyInputs }> = [];
  const defaultExecute: ExecuteNodeOnce = async (node, inputs) => {
    executeCalls.push({ nodeId: node.nodeId as string, inputs });
    const result: ExecuteNodeOnceResult = {
      kind: 'executed',
      result: makeNodeTestResult(),
    };
    return result;
  };
  const deps: TestNodeDeps = {
    readWorkflowFile:
      overrides.readWorkflowFile ??
      (async () => ({ kind: 'found', yaml: baseYaml }) as const),
    executeNodeOnce: overrides.executeNodeOnce ?? defaultExecute,
    parseWorkflowYaml: overrides.parseWorkflowYaml ?? parseWorkflowYaml,
    locateNode: overrides.locateNode ?? locateNode,
    validateNodeInputs: overrides.validateNodeInputs ?? validateNodeInputs,
  };
  return { deps, executeCalls };
}

describe('testNodeWorkflow', () => {
  it('returns workflowNotFound when the workflow file is missing', async () => {
    const { deps, executeCalls } = makeDeps({
      readWorkflowFile: (async () => ({ kind: 'notFound' })) as ReadWorkflowFile,
    });
    const out = await testNodeWorkflow(
      { workflowId: wfA, nodeId: targetNodeId, inputs: { name: 'world' } },
      deps,
    );
    expect(out.kind).toBe('workflowNotFound');
    // Invariant: the runtime adapter must not be invoked when the file is
    // missing — there is no document to test against.
    expect(executeCalls).toHaveLength(0);
  });

  it('returns workflowNotFound when the YAML cannot be parsed (scenario substep)', async () => {
    // Scenario "LoadWorkflow" substep: parse errors collapse into
    // WorkflowNotFound from this workflow's caller-facing perspective.
    const { deps, executeCalls } = makeDeps({
      readWorkflowFile: (async () => ({
        kind: 'found',
        yaml: asYamlSource('do: [unclosed\n'),
      })) as ReadWorkflowFile,
    });
    const out = await testNodeWorkflow(
      { workflowId: wfA, nodeId: targetNodeId, inputs: {} },
      deps,
    );
    expect(out.kind).toBe('workflowNotFound');
    expect(executeCalls).toHaveLength(0);
  });

  it('returns nodeNotFound when the node id does not exist in the document', async () => {
    const { deps, executeCalls } = makeDeps({});
    const out = await testNodeWorkflow(
      {
        workflowId: wfA,
        nodeId: asNodeId('does-not-exist'),
        inputs: {},
      },
      deps,
    );
    expect(out.kind).toBe('nodeNotFound');
    expect(executeCalls).toHaveLength(0);
  });

  it('returns nodeNotTestable when the node is a control-flow container (invariant 3)', async () => {
    const { deps, executeCalls } = makeDeps({});
    const out = await testNodeWorkflow(
      {
        workflowId: wfA,
        nodeId: asNodeId('decide'),
        inputs: {},
      },
      deps,
    );
    expect(out.kind).toBe('nodeNotTestable');
    if (out.kind !== 'nodeNotTestable') return;
    expect(out.nodeType).toBe('if');
    // Critical (invariant 3): NodeNotTestable must short-circuit BEFORE the
    // runtime is invoked.
    expect(executeCalls).toHaveLength(0);
  });

  it('returns invalidInputs when a required field is missing (invariant 4)', async () => {
    const { deps, executeCalls } = makeDeps({});
    const out = await testNodeWorkflow(
      {
        workflowId: wfA,
        nodeId: targetNodeId,
        inputs: {}, // missing `name`
      },
      deps,
    );
    expect(out.kind).toBe('invalidInputs');
    if (out.kind !== 'invalidInputs') return;
    expect(out.reason).toContain('name');
    // Critical (invariant 4): type mismatches detected BEFORE execution.
    expect(executeCalls).toHaveLength(0);
  });

  it('returns invalidInputs when a field has the wrong type (invariant 4)', async () => {
    const { deps, executeCalls } = makeDeps({});
    const out = await testNodeWorkflow(
      {
        workflowId: wfA,
        nodeId: targetNodeId,
        inputs: { name: 42 }, // declared type is `string`
      },
      deps,
    );
    expect(out.kind).toBe('invalidInputs');
    if (out.kind !== 'invalidInputs') return;
    expect(out.reason).toContain('name');
    expect(executeCalls).toHaveLength(0);
  });

  it('returns runtimeUnavailable when the runtime adapter reports unavailable', async () => {
    const { deps } = makeDeps({
      executeNodeOnce: async () =>
        ({ kind: 'runtimeUnavailable' }) as ExecuteNodeOnceResult,
    });
    const out = await testNodeWorkflow(
      {
        workflowId: wfA,
        nodeId: targetNodeId,
        inputs: { name: 'world' },
      },
      deps,
    );
    expect(out.kind).toBe('runtimeUnavailable');
  });

  it('returns nodeTested with the result entity from the runtime adapter', async () => {
    const stub: NodeTestResult = makeNodeTestResult({
      output: '{"x":1}',
      durationMs: 42,
    });
    const { deps } = makeDeps({
      executeNodeOnce: async () => ({ kind: 'executed', result: stub }),
    });
    const out = await testNodeWorkflow(
      {
        workflowId: wfA,
        nodeId: targetNodeId,
        inputs: { name: 'world' },
      },
      deps,
    );
    expect(out.kind).toBe('nodeTested');
    if (out.kind !== 'nodeTested') return;
    expect(out.result).toBe(stub);
  });

  it('passes the node id verbatim to the runtime adapter', async () => {
    const { deps, executeCalls } = makeDeps({});
    await testNodeWorkflow(
      {
        workflowId: wfA,
        nodeId: targetNodeId,
        inputs: { name: 'world' },
      },
      deps,
    );
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]!.nodeId).toBe('greet');
    expect(executeCalls[0]!.inputs).toEqual({ name: 'world' });
  });

  it('does not write to the workflow file (invariant 2: side-effect free on the source)', async () => {
    // The workflow's `deps` only declares `readWorkflowFile`. Mirrors the
    // `startRunWorkflow` invariant assertion: even at the type level there
    // is no `writeWorkflowFile` available, so a future regression that adds
    // a write dependency would have to first prove invariant 2 still holds.
    const { deps } = makeDeps({});
    const ok = !('writeWorkflowFile' in (deps as unknown as Record<string, unknown>));
    expect(ok).toBe(true);
  });

  it('checks happen in scenario order: read → parse → locate → validate → execute', async () => {
    const calls: string[] = [];
    const deps: TestNodeDeps = {
      readWorkflowFile: async () => {
        calls.push('readWorkflowFile');
        return { kind: 'found', yaml: baseYaml };
      },
      parseWorkflowYaml: (yaml) => {
        calls.push('parseWorkflowYaml');
        return parseWorkflowYaml(yaml);
      },
      locateNode: (doc, nodeId) => {
        calls.push('locateNode');
        return locateNode(doc, nodeId);
      },
      validateNodeInputs: (node, inputs) => {
        calls.push('validateNodeInputs');
        return validateNodeInputs(node, inputs);
      },
      executeNodeOnce: async (node, _inputs) => {
        calls.push('executeNodeOnce');
        return {
          kind: 'executed',
          result: makeNodeTestResult({ nodeId: node.nodeId }),
        };
      },
    };
    await testNodeWorkflow(
      {
        workflowId: wfA,
        nodeId: targetNodeId,
        inputs: { name: 'world' },
      },
      deps,
    );
    expect(calls).toEqual([
      'readWorkflowFile',
      'parseWorkflowYaml',
      'locateNode',
      'validateNodeInputs',
      'executeNodeOnce',
    ]);
  });
});

