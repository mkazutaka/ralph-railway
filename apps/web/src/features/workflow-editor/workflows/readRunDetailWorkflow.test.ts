import { describe, expect, it } from 'vitest';
import { asNodeId, asRunId, asWorkflowId } from '../entities/types';
import type { RunDetail, NodeRunDetail } from '../entities/runDetail';
import {
  readRunDetailWorkflow,
  type ReadRunDetailDeps,
} from './readRunDetailWorkflow';

const wfA = asWorkflowId('a.yaml');
const wfB = asWorkflowId('b.yaml');
const runIdA = asRunId('run-001');
const runIdMissing = asRunId('run-does-not-exist');

function makeNode(
  nodeId: string,
  overrides: Partial<NodeRunDetail> = {},
): NodeRunDetail {
  return {
    nodeId: asNodeId(nodeId),
    status: 'succeeded',
    startedAt: 1_000,
    endedAt: 2_000,
    output: null,
    errorMessage: null,
    logExcerpt: '',
    ...overrides,
  };
}

function makeDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: runIdA,
    workflowId: wfA,
    status: 'succeeded',
    startedAt: 1_000,
    endedAt: 5_000,
    nodes: [makeNode('build')],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReadRunDetailDeps> = {}): ReadRunDetailDeps {
  return {
    findRunDetail: overrides.findRunDetail ?? (async () => null),
  };
}

describe('readRunDetailWorkflow', () => {
  it('returns runNotFound when the repository yields null', async () => {
    const out = await readRunDetailWorkflow(
      { runId: runIdMissing, workflowId: wfA },
      makeDeps({ findRunDetail: async () => null }),
    );
    expect(out.kind).toBe('runNotFound');
  });

  it('returns runDetailRead with the full detail when the run exists', async () => {
    const detail = makeDetail();
    const out = await readRunDetailWorkflow(
      { runId: runIdA, workflowId: wfA },
      makeDeps({ findRunDetail: async () => detail }),
    );
    expect(out.kind).toBe('runDetailRead');
    if (out.kind !== 'runDetailRead') return;
    expect(out.detail).toBe(detail);
  });

  it('passes the run id to the repository verbatim', async () => {
    const calls: string[] = [];
    await readRunDetailWorkflow(
      { runId: runIdA, workflowId: wfA },
      makeDeps({
        findRunDetail: async (runId) => {
          calls.push(runId as string);
          return null;
        },
      }),
    );
    expect(calls).toEqual(['run-001']);
  });

  it('returns runDetailRead even when nodes are still in-flight (invariant 1)', async () => {
    // Scenario invariant 1: 進行中の Run でも詳細を取得できる. The workflow
    // MUST NOT translate "still running" into a not-found result; that is
    // the route layer's contract too.
    const detail = makeDetail({
      status: 'running',
      endedAt: null,
      nodes: [
        makeNode('build', { status: 'succeeded' }),
        makeNode('deploy', {
          status: 'running',
          startedAt: 3_000,
          endedAt: null,
        }),
        makeNode('verify', {
          status: 'pending',
          startedAt: null,
          endedAt: null,
        }),
      ],
    });
    const out = await readRunDetailWorkflow(
      { runId: runIdA, workflowId: wfA },
      makeDeps({ findRunDetail: async () => detail }),
    );
    expect(out.kind).toBe('runDetailRead');
    if (out.kind !== 'runDetailRead') return;
    expect(out.detail.status).toBe('running');
    expect(out.detail.endedAt).toBeNull();
    expect(out.detail.nodes.map((n) => n.status)).toEqual([
      'succeeded',
      'running',
      'pending',
    ]);
  });

  it('preserves errorMessage on failed nodes (invariant 2)', async () => {
    // Scenario invariant 2: 失敗ノードがある場合、その NodeRunDetail に
    // 必ず ErrorMessage が入る. The workflow does not synthesise this — the
    // entity boundary already guarantees it — but we assert here that the
    // workflow round-trips the value untouched so a future refactor that
    // accidentally drops the field is caught.
    const detail = makeDetail({
      status: 'failed',
      endedAt: 4_000,
      nodes: [
        makeNode('build', {
          status: 'failed',
          endedAt: 4_000,
          errorMessage: 'compile error: missing semicolon',
        }),
      ],
    });
    const out = await readRunDetailWorkflow(
      { runId: runIdA, workflowId: wfA },
      makeDeps({ findRunDetail: async () => detail }),
    );
    expect(out.kind).toBe('runDetailRead');
    if (out.kind !== 'runDetailRead') return;
    expect(out.detail.nodes[0]!.errorMessage).toBe(
      'compile error: missing semicolon',
    );
  });

  it('does not call the repository more than once per invocation (invariant 4: side-effect-free)', async () => {
    let calls = 0;
    await readRunDetailWorkflow(
      { runId: runIdA, workflowId: wfA },
      makeDeps({
        findRunDetail: async () => {
          calls += 1;
          return null;
        },
      }),
    );
    expect(calls).toBe(1);
  });

  it('returns runNotFound when the run exists under a different workflow (cross-workflow isolation)', async () => {
    // Symmetric with `stopRunWorkflow`: a run that exists but does not
    // belong to the workflow named in the input must be invisible to the
    // caller, so the response cannot be used to probe for run ids across
    // workflows. The detail's payload (output / error / nodeIds) MUST NOT
    // leak via this path.
    const detail = makeDetail({ workflowId: wfB });
    const out = await readRunDetailWorkflow(
      { runId: runIdA, workflowId: wfA },
      makeDeps({ findRunDetail: async () => detail }),
    );
    expect(out.kind).toBe('runNotFound');
  });
});
