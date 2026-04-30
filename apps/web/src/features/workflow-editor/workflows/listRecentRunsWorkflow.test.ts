import { describe, expect, it } from 'vitest';
import { asRunId, asWorkflowId } from '../entities/types';
import type { RunSummary } from '../entities/runSummary';
import {
  listRecentRunsWorkflow,
  type ListRecentRunsDeps,
} from './listRecentRunsWorkflow';

const wfA = asWorkflowId('a.yaml');

function makeRun(
  id: string,
  startedAt: number,
  status: RunSummary['status'] = 'succeeded',
  durationMs: number | null = 100,
): RunSummary {
  return {
    id: asRunId(id),
    workflowId: wfA,
    status,
    startedAt,
    durationMs,
  };
}

function makeDeps(overrides: Partial<ListRecentRunsDeps> = {}): ListRecentRunsDeps {
  return {
    workflowExists: overrides.workflowExists ?? (async () => true),
    findRecentRunsByWorkflow:
      overrides.findRecentRunsByWorkflow ?? (async () => []),
  };
}

describe('listRecentRunsWorkflow', () => {
  it('returns workflowNotFound when the workflow is unknown', async () => {
    const out = await listRecentRunsWorkflow(
      { workflowId: wfA, limit: 20 },
      makeDeps({ workflowExists: async () => false }),
    );
    expect(out.kind).toBe('workflowNotFound');
  });

  it('returns runList with an empty array when the workflow has no runs (invariant 3)', async () => {
    const out = await listRecentRunsWorkflow(
      { workflowId: wfA, limit: 20 },
      makeDeps({ findRecentRunsByWorkflow: async () => [] }),
    );
    expect(out).toEqual({ kind: 'runList', runs: [] });
  });

  it('passes the workflow id and limit to the repository', async () => {
    const calls: Array<{ workflowId: string; limit: number }> = [];
    await listRecentRunsWorkflow(
      { workflowId: wfA, limit: 5 },
      makeDeps({
        findRecentRunsByWorkflow: async (workflowId, limit) => {
          calls.push({ workflowId: workflowId as string, limit });
          return [];
        },
      }),
    );
    expect(calls).toEqual([{ workflowId: 'a.yaml', limit: 5 }]);
  });

  it('sorts runs by startedAt descending (invariant 2)', async () => {
    const r1 = makeRun('r1', 1000);
    const r2 = makeRun('r2', 3000);
    const r3 = makeRun('r3', 2000);
    const out = await listRecentRunsWorkflow(
      { workflowId: wfA, limit: 20 },
      makeDeps({ findRecentRunsByWorkflow: async () => [r1, r2, r3] }),
    );
    expect(out.kind).toBe('runList');
    if (out.kind !== 'runList') return;
    expect(out.runs.map((r) => r.id as string)).toEqual(['r2', 'r3', 'r1']);
  });

  it('preserves null durationMs for in-flight runs (invariant 4)', async () => {
    const inflight = makeRun('r1', 1000, 'running', null);
    const done = makeRun('r2', 500, 'succeeded', 250);
    const out = await listRecentRunsWorkflow(
      { workflowId: wfA, limit: 20 },
      makeDeps({ findRecentRunsByWorkflow: async () => [inflight, done] }),
    );
    expect(out.kind).toBe('runList');
    if (out.kind !== 'runList') return;
    expect(out.runs[0]!.status).toBe('running');
    expect(out.runs[0]!.durationMs).toBeNull();
    expect(out.runs[1]!.status).toBe('succeeded');
    expect(out.runs[1]!.durationMs).toBe(250);
  });
});
