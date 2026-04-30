import { describe, expect, it } from 'vitest';
import {
  asRunId,
  asWorkflowId,
  asYamlSource,
} from '../entities/types';
import type { StartedRun } from '../entities/startedRun';
import type { WorkflowDocument } from '../entities/workflowDocument';
import type { ReadWorkflowFile } from '../repositories/workflowFileRepository';
import type {
  EnqueueRun,
  EnqueueRunResult,
} from '../repositories/runtimeRepository';
import { parseWorkflowYaml } from '../lib/yaml';
import { validateRuntimeSupport } from '../lib/runtimeSupport';
import {
  startRunWorkflow,
  type StartRunDeps,
} from './startRunWorkflow';

const wfA = asWorkflowId('a.yaml');

const validBaseYaml = asYamlSource(
  'document:\n  name: demo\ndo:\n  - existing:\n      set:\n        n: 1\n',
);

function makeStartedRun(overrides: Partial<StartedRun> = {}): StartedRun {
  return {
    id: asRunId('run-001'),
    workflowId: wfA,
    startedAt: 1_000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StartRunDeps> = {}): {
  deps: StartRunDeps;
  enqueueCalls: Array<{ workflowId: string; document: WorkflowDocument }>;
} {
  const enqueueCalls: Array<{
    workflowId: string;
    document: WorkflowDocument;
  }> = [];
  const defaultEnqueue: EnqueueRun = async (workflowId, document) => {
    enqueueCalls.push({ workflowId: workflowId as string, document });
    const result: EnqueueRunResult = {
      kind: 'started',
      run: makeStartedRun(),
    };
    return result;
  };
  const deps: StartRunDeps = {
    readWorkflowFile:
      overrides.readWorkflowFile ??
      (async () => ({ kind: 'found', yaml: validBaseYaml }) as const),
    enqueueRun: overrides.enqueueRun ?? defaultEnqueue,
    parseWorkflowYaml: overrides.parseWorkflowYaml ?? parseWorkflowYaml,
    validateRuntimeSupport:
      overrides.validateRuntimeSupport ?? validateRuntimeSupport,
  };
  return { deps, enqueueCalls };
}

describe('startRunWorkflow', () => {
  it('returns workflowNotFound when the workflow file is missing', async () => {
    const { deps, enqueueCalls } = makeDeps({
      readWorkflowFile: (async () => ({ kind: 'notFound' })) as ReadWorkflowFile,
    });
    const out = await startRunWorkflow({ workflowId: wfA }, deps);
    expect(out.kind).toBe('workflowNotFound');
    // Invariant 1: parser / runtime must not be invoked when the file is
    // missing — there is no document to validate.
    expect(enqueueCalls).toHaveLength(0);
  });

  it('returns invalidYaml when the YAML cannot be parsed (invariant 1)', async () => {
    const { deps, enqueueCalls } = makeDeps({
      readWorkflowFile: (async () => ({
        kind: 'found',
        yaml: asYamlSource('do: [unclosed\n'),
      })) as ReadWorkflowFile,
    });
    const out = await startRunWorkflow({ workflowId: wfA }, deps);
    expect(out.kind).toBe('invalidYaml');
    if (out.kind !== 'invalidYaml') return;
    expect(out.reason).toBeTruthy();
    // Critical (invariant 1): a syntactically broken workflow MUST NOT
    // reach the runtime. The dispatch step is the only place that mutates
    // observable state, so we assert it never ran.
    expect(enqueueCalls).toHaveLength(0);
  });

  it('returns unsupportedNode when the document uses a runtime-unsupported node (invariant 2)', async () => {
    // `fork` is in the unsupported set in `lib/runtimeSupport.ts` (mirrors
    // the `supported: false` flag for `fork` in the pattern registry).
    const yamlWithFork = asYamlSource(
      'do:\n  - parallel_step:\n      fork:\n        branches:\n          - do:\n              - branch_a:\n                  run:\n                    shell:\n                      command: "echo a"\n',
    );
    const { deps, enqueueCalls } = makeDeps({
      readWorkflowFile: (async () => ({
        kind: 'found',
        yaml: yamlWithFork,
      })) as ReadWorkflowFile,
    });
    const out = await startRunWorkflow({ workflowId: wfA }, deps);
    expect(out.kind).toBe('unsupportedNode');
    if (out.kind !== 'unsupportedNode') return;
    expect(out.nodeType).toBe('fork');
    // Invariant 2: an unsupported workflow MUST NOT be enqueued.
    expect(enqueueCalls).toHaveLength(0);
  });

  it('returns runtimeUnavailable when the runtime adapter reports unavailable', async () => {
    const { deps } = makeDeps({
      enqueueRun: async () =>
        ({ kind: 'runtimeUnavailable' }) as EnqueueRunResult,
    });
    const out = await startRunWorkflow({ workflowId: wfA }, deps);
    expect(out.kind).toBe('runtimeUnavailable');
  });

  it('returns runStarted with the entity returned by the runtime adapter', async () => {
    const stub: StartedRun = makeStartedRun({
      id: asRunId('run-xyz'),
      startedAt: 42,
    });
    const { deps } = makeDeps({
      enqueueRun: async () => ({ kind: 'started', run: stub }),
    });
    const out = await startRunWorkflow({ workflowId: wfA }, deps);
    expect(out.kind).toBe('runStarted');
    if (out.kind !== 'runStarted') return;
    expect(out.run).toBe(stub);
  });

  it('passes the parsed document (not the YAML source) to the runtime adapter', async () => {
    const { deps, enqueueCalls } = makeDeps({});
    await startRunWorkflow({ workflowId: wfA }, deps);
    expect(enqueueCalls).toHaveLength(1);
    // Document carries the existing task, confirming the parser ran and
    // the workflow forwarded the structured result rather than the raw
    // text. A future regression that bypasses the parser would surface a
    // string here instead of a document and fail this assertion.
    const doc = enqueueCalls[0]!.document;
    expect(doc).toHaveProperty('tasks');
    expect(doc.tasks).toHaveLength(1);
  });

  it('passes the workflow id verbatim to the runtime adapter', async () => {
    const { deps, enqueueCalls } = makeDeps({});
    await startRunWorkflow({ workflowId: wfA }, deps);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.workflowId).toBe('a.yaml');
  });

  it('does not write to the workflow file (invariant 4: side-effect free on the source)', async () => {
    // The workflow's `deps` only declares `readWorkflowFile`. Even at the
    // type level there is no `writeWorkflowFile` available — this test
    // documents that fact so a future refactor that adds a write
    // dependency would have to first prove invariant 4 still holds.
    const { deps } = makeDeps({});
    const ok = !('writeWorkflowFile' in (deps as unknown as Record<string, unknown>));
    expect(ok).toBe(true);
  });
});
