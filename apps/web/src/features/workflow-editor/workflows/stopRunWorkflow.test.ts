import { describe, expect, it } from 'vitest';
import {
  asNodeId,
  asRunId,
  asWorkflowId,
} from '../entities/types';
import type { RunDetail } from '../entities/runDetail';
import type { RunStatus } from '../entities/runSummary';
import type { StopAccepted } from '../entities/stopAccepted';
import type { FindRunDetail } from '../repositories/runRepository';
import type {
  RequestRunStop,
  RequestRunStopResult,
} from '../repositories/runtimeRepository';
import {
  stopRunWorkflow,
  type StopRunDeps,
} from './stopRunWorkflow';

const wfA = asWorkflowId('a.yaml');
const wfB = asWorkflowId('b.yaml');
const runId = asRunId('run-001');

function makeRunDetail(
  status: RunStatus,
  overrides: Partial<RunDetail> = {},
): RunDetail {
  // The detail row's `endedAt` invariant (terminal => set, non-terminal =>
  // null) is enforced by `buildRunDetailFromRow`; we mirror it here so the
  // synthetic detail always satisfies the entity's contract.
  const isTerminal =
    status === 'succeeded' || status === 'failed' || status === 'cancelled';
  return {
    id: runId,
    workflowId: wfA,
    status,
    startedAt: 1_000,
    endedAt: isTerminal ? 2_000 : null,
    nodes: [
      {
        nodeId: asNodeId('build'),
        status: 'pending',
        startedAt: null,
        endedAt: null,
        output: null,
        errorMessage: null,
        logExcerpt: '',
      },
    ],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StopRunDeps> = {}): {
  deps: StopRunDeps;
  stopCalls: Array<{ runId: string }>;
} {
  const stopCalls: Array<{ runId: string }> = [];
  const defaultStop: RequestRunStop = async (id) => {
    stopCalls.push({ runId: id as string });
    const result: RequestRunStopResult = {
      kind: 'accepted',
      stop: { id, requestedAt: 5_000 } satisfies StopAccepted,
    };
    return result;
  };
  const deps: StopRunDeps = {
    findRun:
      overrides.findRun ??
      (async () => makeRunDetail('running')),
    requestRunStop: overrides.requestRunStop ?? defaultStop,
  };
  return { deps, stopCalls };
}

describe('stopRunWorkflow', () => {
  it('returns runNotFound when the run does not exist', async () => {
    const { deps, stopCalls } = makeDeps({
      findRun: (async () => null) as FindRunDetail,
    });
    const out = await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(out.kind).toBe('runNotFound');
    // Invariant: the runtime adapter must not be invoked when the run is
    // unknown — there is nothing to stop.
    expect(stopCalls).toHaveLength(0);
  });

  it('returns runAlreadyTerminal when the run has already succeeded (invariant 1)', async () => {
    const { deps, stopCalls } = makeDeps({
      findRun: async () => makeRunDetail('succeeded'),
    });
    const out = await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(out.kind).toBe('runAlreadyTerminal');
    if (out.kind !== 'runAlreadyTerminal') return;
    expect(out.status).toBe('succeeded');
    // Critical (invariant 1): a stop request MUST NOT be forwarded for an
    // already-terminal run.
    expect(stopCalls).toHaveLength(0);
  });

  it('returns runAlreadyTerminal when the run has already failed (invariant 1)', async () => {
    const { deps, stopCalls } = makeDeps({
      findRun: async () => makeRunDetail('failed'),
    });
    const out = await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(out.kind).toBe('runAlreadyTerminal');
    if (out.kind !== 'runAlreadyTerminal') return;
    expect(out.status).toBe('failed');
    expect(stopCalls).toHaveLength(0);
  });

  it('returns runAlreadyTerminal when the run has already been cancelled (invariant 1)', async () => {
    const { deps, stopCalls } = makeDeps({
      findRun: async () => makeRunDetail('cancelled'),
    });
    const out = await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(out.kind).toBe('runAlreadyTerminal');
    if (out.kind !== 'runAlreadyTerminal') return;
    expect(out.status).toBe('cancelled');
    expect(stopCalls).toHaveLength(0);
  });

  it('forwards the stop request when the run is pending (non-terminal)', async () => {
    const { deps, stopCalls } = makeDeps({
      findRun: async () => makeRunDetail('pending', { endedAt: null }),
    });
    const out = await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(out.kind).toBe('stopRequested');
    expect(stopCalls).toEqual([{ runId: runId as string }]);
  });

  it('forwards the stop request when the run is running (non-terminal)', async () => {
    const { deps, stopCalls } = makeDeps({
      findRun: async () => makeRunDetail('running', { endedAt: null }),
    });
    const out = await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(out.kind).toBe('stopRequested');
    expect(stopCalls).toEqual([{ runId: runId as string }]);
  });

  it('returns runtimeUnavailable when the runtime cannot accept the request', async () => {
    const { deps } = makeDeps({
      requestRunStop: async () =>
        ({ kind: 'runtimeUnavailable' }) as RequestRunStopResult,
    });
    const out = await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(out.kind).toBe('runtimeUnavailable');
  });

  it('returns stopRequested with the StopAccepted entity from the runtime adapter', async () => {
    const stub: StopAccepted = { id: runId, requestedAt: 42 };
    const { deps } = makeDeps({
      requestRunStop: async () => ({ kind: 'accepted', stop: stub }),
    });
    const out = await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(out.kind).toBe('stopRequested');
    if (out.kind !== 'stopRequested') return;
    expect(out.stop).toBe(stub);
  });

  it('passes the run id verbatim to the runtime adapter', async () => {
    const { deps, stopCalls } = makeDeps({});
    await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]!.runId).toBe('run-001');
  });

  it('does not call requestRunStop before findRun (ordering of step 1 → step 2)', async () => {
    const calls: string[] = [];
    const findRun: FindRunDetail = async () => {
      calls.push('findRun');
      return makeRunDetail('running');
    };
    const requestRunStop: RequestRunStop = async (id) => {
      calls.push('requestRunStop');
      return {
        kind: 'accepted',
        stop: { id, requestedAt: 1 },
      };
    };
    await stopRunWorkflow({ runId, workflowId: wfA }, { findRun, requestRunStop });
    expect(calls).toEqual(['findRun', 'requestRunStop']);
  });

  it('returns runNotFound when the run belongs to a different workflow (invariant 4)', async () => {
    // The findRun seam returns a real run, but its workflowId does NOT
    // match the workflowId provided in input. The workflow MUST treat this
    // as runNotFound (cross-workflow isolation, scenario invariant 4) and
    // MUST NOT forward the stop request to the runtime.
    const { deps, stopCalls } = makeDeps({
      findRun: async () => makeRunDetail('running', { workflowId: wfB }),
    });
    const out = await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(out.kind).toBe('runNotFound');
    expect(stopCalls).toHaveLength(0);
  });

  it('still returns stopRequested when workflowId matches (control case for invariant 4)', async () => {
    const { deps, stopCalls } = makeDeps({
      findRun: async () => makeRunDetail('running', { workflowId: wfA }),
    });
    const out = await stopRunWorkflow({ runId, workflowId: wfA }, deps);
    expect(out.kind).toBe('stopRequested');
    expect(stopCalls).toHaveLength(1);
  });
});
