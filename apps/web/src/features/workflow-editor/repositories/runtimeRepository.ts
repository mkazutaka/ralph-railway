// Repository functions for the run-workflow / stop-run scenarios' runtime
// dependency.
//
// Adapts the lower-level `RuntimeStore` (in-memory today, CLI socket / REST
// proxy later) into branded-entity-aware functions used by the workflow
// layer. The workflow layer never touches the underlying store directly —
// it composes the dependencies declared in the scenarios:
//
//   docs/scenarios/workflow-editor/run-workflow.md
//     func enqueueRun: WorkflowDocument -> RunId OR RuntimeUnavailable
//
//   docs/scenarios/workflow-editor/stop-run.md
//     func requestRunStop: RunId -> StopAccepted OR RuntimeUnavailable

import type { RuntimeStore } from '$lib/server/runtime';
import type { NodeId, RunId, WorkflowId } from '../entities/types';
import type { StartedRun } from '../entities/startedRun';
import { buildStartedRunFromRow } from '../entities/startedRun';
import type { StopAccepted } from '../entities/stopAccepted';
import { buildStopAcceptedFromRow } from '../entities/stopAccepted';
import type { NodeTestResult } from '../entities/nodeTestResult';
import { buildNodeTestResultFromRow } from '../entities/nodeTestResult';
import type { WorkflowDocument } from '../entities/workflowDocument';
import type {
  DummyInputs,
  NodeDefinition,
} from '../lib/nodeTestability';

/**
 * Discriminated result mirroring the scenario's
 * `enqueueRun: ... -> RunId OR RuntimeUnavailable`. The success variant
 * carries a fully validated `StartedRun` so the workflow layer never has
 * to touch raw rows — branding has already been enforced via
 * `buildStartedRunFromRow` at the repository boundary (CLAUDE.md: "DB
 * rows never leak past the repository").
 */
export type EnqueueRunResult =
  | { kind: 'started'; run: StartedRun }
  | { kind: 'runtimeUnavailable' };

export type EnqueueRun = (
  workflowId: WorkflowId,
  document: WorkflowDocument,
) => Promise<EnqueueRunResult>;

/**
 * Discriminated result mirroring the scenario's
 * `requestRunStop: RunId -> StopAccepted OR RuntimeUnavailable`. The success
 * variant carries a fully validated `StopAccepted` so the workflow layer
 * never has to touch raw rows — branding has already been enforced via
 * `buildStopAcceptedFromRow` at the repository boundary.
 */
export type RequestRunStopResult =
  | { kind: 'accepted'; stop: StopAccepted }
  | { kind: 'runtimeUnavailable' };

export type RequestRunStop = (runId: RunId) => Promise<RequestRunStopResult>;

/**
 * Discriminated result mirroring the scenario's
 * `executeNodeOnce: NodeDefinition AND DummyInputs -> NodeTestResult OR RuntimeUnavailable`.
 * The success variant carries a fully validated `NodeTestResult` so the
 * workflow layer never has to touch raw rows — branding has already been
 * enforced via `buildNodeTestResultFromRow` at the repository boundary.
 */
export type ExecuteNodeOnceResult =
  | { kind: 'executed'; result: NodeTestResult }
  | { kind: 'runtimeUnavailable' };

export type ExecuteNodeOnce = (
  node: NodeDefinition,
  inputs: DummyInputs,
) => Promise<ExecuteNodeOnceResult>;

export interface RuntimeRepository {
  enqueueRun: EnqueueRun;
  requestRunStop: RequestRunStop;
  executeNodeOnce: ExecuteNodeOnce;
}

/**
 * Build the runtime repository.
 *
 * The store is accepted as a parameter (CLAUDE.md: workflows must receive
 * their deps via injection, not via `import`); the route layer builds it
 * and hands the function to the workflow.
 */
export function toRuntimeRepository(store: RuntimeStore): RuntimeRepository {
  return {
    async enqueueRun(workflowId, document) {
      const result = await store.enqueue(workflowId as string, document);
      if (result.kind === 'unavailable') {
        return { kind: 'runtimeUnavailable' };
      }
      // Brand validation happens here — the underlying store returns plain
      // strings and a future swap of the implementation must not weaken
      // the entity invariants reaching the workflow layer.
      const run = buildStartedRunFromRow(result.row);
      return { kind: 'started', run };
    },
    async requestRunStop(runId) {
      const result = await store.requestStop(runId as string);
      if (result.kind === 'unavailable') {
        return { kind: 'runtimeUnavailable' };
      }
      // Brand validation at the repository boundary mirrors `enqueueRun` —
      // the underlying store returns plain strings; we re-validate so the
      // workflow layer always sees a typed entity.
      const stop = buildStopAcceptedFromRow(result.row);
      // Defence-in-depth (review note L2): the runtime adapter MUST echo the
      // exact run id we requested. A future remote runtime that mismatches
      // ids would otherwise silently confirm a stop against the wrong run;
      // surface that as a hard error here rather than letting the workflow
      // return a misleading `StopAccepted`. The in-memory adapter already
      // echoes verbatim so this never fires in practice — it is purely a
      // boundary check for swapped implementations.
      if ((stop.id as string) !== (runId as string)) {
        throw new Error(
          `runtime adapter returned a StopAccepted for the wrong run ` +
            `(requested="${runId as string}", returned="${stop.id as string}")`,
        );
      }
      return { kind: 'accepted', stop };
    },
    async executeNodeOnce(node, inputs) {
      const result = await store.executeNodeOnce(
        node.nodeId as string,
        node.nodeType,
        node.body,
        inputs,
      );
      if (result.kind === 'unavailable') {
        return { kind: 'runtimeUnavailable' };
      }
      // Brand validation at the repository boundary mirrors `enqueueRun` /
      // `requestRunStop` — the underlying store returns plain strings; we
      // re-validate so the workflow layer always sees a typed entity.
      const built = buildNodeTestResultFromRow(result.row);
      // Defence-in-depth (mirrors the `requestRunStop` echo check): the
      // runtime adapter MUST return a result whose `nodeId` matches the
      // node we asked to execute. A future remote runtime that mismatches
      // ids would otherwise silently confirm a test against the wrong
      // node; surface that as a hard error here rather than letting the
      // workflow return a misleading `NodeTested`.
      if ((built.nodeId as string) !== (node.nodeId as string)) {
        throw new Error(
          `runtime adapter returned a NodeTestResult for the wrong node ` +
            `(requested="${node.nodeId as string}", returned="${built.nodeId as string}")`,
        );
      }
      return { kind: 'executed', result: built };
    },
  };
}
