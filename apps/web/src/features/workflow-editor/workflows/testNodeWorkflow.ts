// Implements `apps/web/docs/scenarios/workflow-editor/test-node.md`.
//
//   workflow "Test Node" =
//     input: WorkflowId AND NodeId AND DummyInputs
//     output:
//       NodeTested
//       OR WorkflowNotFound
//       OR NodeNotFound
//       OR NodeNotTestable
//       OR InvalidInputs
//       OR RuntimeUnavailable
//     dependencies: readWorkflowFile, parseWorkflowYaml, locateNode,
//                   validateNodeInputs, executeNodeOnce

import type { NodeId, WorkflowId } from '../entities/types';
import type { NodeTestResult } from '../entities/nodeTestResult';
import type { ReadWorkflowFile } from '../repositories/workflowFileRepository';
import type { ExecuteNodeOnce } from '../repositories/runtimeRepository';
import type { parseWorkflowYaml } from '../lib/yaml';
import type {
  DummyInputs,
  locateNode,
  validateNodeInputs,
} from '../lib/nodeTestability';

export interface TestNodeInput {
  readonly workflowId: WorkflowId;
  readonly nodeId: NodeId;
  /**
   * Caller-supplied dummy inputs. We accept `Readonly<Record<string, unknown>>`
   * because dummy inputs by definition come from untrusted UI / API payloads
   * — narrowing happens inside `validateNodeInputs` (step 3) before the
   * runtime is invoked. The workflow never destructures the map; it is only
   * forwarded to `validateNodeInputs` and `executeNodeOnce`.
   */
  readonly inputs: DummyInputs;
}

/**
 * Discriminated union of every outcome the workflow can produce. CLAUDE.md
 * forbids using exceptions for expected failure modes — the workflow always
 * returns one of these variants, and the route layer maps it to a status
 * code.
 *
 * `nodeTested` carries the full `NodeTestResult` (status / output / log
 * excerpt / duration). The remaining variants mirror the scenario's named
 * error cases 1:1 so the route layer can do an exhaustive `switch` and
 * TypeScript flags any future addition that the route forgets to handle.
 *
 * - `nodeNotTestable.nodeType` echoes the offending node-type key when one
 *   could be identified (the structural check landed but the node type is
 *   not in the testable set). For malformed bodies where no node type can
 *   be picked, the field is the empty string — callers MUST treat it as
 *   diagnostic only and not a stable identifier.
 * - `invalidInputs.reason` is the structured reason returned by
 *   `validateNodeInputs`. Forwarded verbatim because the dummy inputs
 *   originated from the same UI session — there is no leakage risk.
 */
export type TestNodeOutput =
  | { kind: 'nodeTested'; result: NodeTestResult }
  | { kind: 'workflowNotFound' }
  | { kind: 'nodeNotFound' }
  | { kind: 'nodeNotTestable'; nodeType: string }
  | { kind: 'invalidInputs'; reason: string }
  | { kind: 'runtimeUnavailable' };

export interface TestNodeDeps {
  readWorkflowFile: ReadWorkflowFile;
  executeNodeOnce: ExecuteNodeOnce;
  // Pure helpers are injected so the workflow stays free of `import`s on
  // implementation modules and tests can swap them out. Required (no
  // optional defaults) — wiring is centralised in `$lib/server/repos.ts` so
  // callers cannot accidentally bypass the test seam (mirrors
  // `startRunWorkflow.deps`).
  parseWorkflowYaml: typeof parseWorkflowYaml;
  locateNode: typeof locateNode;
  validateNodeInputs: typeof validateNodeInputs;
}

/**
 * Test-execute a single node in isolation. Mirrors the scenario step-by-step.
 *
 * Order of checks matches the scenario's substep ordering:
 *   1. LoadWorkflow      — workflow file must exist AND parse.
 *   2. LocateTargetNode  — node id must exist AND be testable.
 *   3. ValidateDummyInputs — inputs must conform to the node's declared shape.
 *   4. ExecuteIsolated   — runtime must be reachable.
 *
 * Each step has a single (or, for step 1/2, a small set of) failure modes
 * and the next step is only attempted when the previous returned its
 * success variant. The discriminated union means callers cannot accidentally
 * treat a failure as a success.
 *
 * Scenario invariants:
 *   1. 単独テストはワークフロー本体の Run 履歴に永続化されない — enforced by
 *      the runtime adapter (`executeNodeOnce`) which receives no `RunStore`
 *      handle. The workflow itself owns no state, so there is no way for it
 *      to write to the run history even by mistake.
 *   2. テスト実行はファイル（YAML）を変更しない — the only file-system
 *      interaction in this workflow is `readWorkflowFile` (read-only by
 *      contract). `executeNodeOnce` receives the node body by value and
 *      cannot reach back into the file repository.
 *   3. NodeNotTestable のノードには事前に拒否する — enforced inside
 *      `locateNode`: when the located node's type is not in the testable
 *      set, the workflow short-circuits to `nodeNotTestable` BEFORE invoking
 *      the runtime.
 *   4. ダミー入力の型不一致は実行前に検出する — enforced by step 3
 *      (`validateNodeInputs`) which runs before `executeNodeOnce`.
 *
 * Step 1 special case (per the scenario substep): a YAML parse error is
 * mapped to `workflowNotFound`. The scenario calls this out explicitly
 * ("構文エラーは ... 本ワークフローでは事前条件として WorkflowNotFound と
 * 区別せず WorkflowNotFound を返す") — surfacing a separate
 * `invalidYaml` variant here would force the route layer to either
 * fabricate a status code from the editor's perspective or echo the parser
 * error to a context where it makes no sense.
 */
export async function testNodeWorkflow(
  input: TestNodeInput,
  deps: TestNodeDeps,
): Promise<TestNodeOutput> {
  // step 1: LoadWorkflow
  const read = await deps.readWorkflowFile(input.workflowId);
  if (read.kind === 'notFound') {
    return { kind: 'workflowNotFound' };
  }
  const parsed = deps.parseWorkflowYaml(read.yaml);
  if (parsed.kind === 'parseError') {
    // Scenario substep "LoadWorkflow": parse errors collapse into
    // `WorkflowNotFound` for this workflow's caller-facing contract.
    return { kind: 'workflowNotFound' };
  }

  // step 2: LocateTargetNode
  const located = deps.locateNode(parsed.document, input.nodeId);
  if (located.kind === 'notFound') {
    return { kind: 'nodeNotFound' };
  }
  if (located.kind === 'notTestable') {
    return { kind: 'nodeNotTestable', nodeType: located.nodeType };
  }

  // step 3: ValidateDummyInputs
  const validation = deps.validateNodeInputs(located.node, input.inputs);
  if (validation.kind === 'invalid') {
    return { kind: 'invalidInputs', reason: validation.reason };
  }

  // step 4: ExecuteIsolated
  // The repository's `ExecuteNodeOnceResult` is already the brand-validated
  // entity flavour, so we forward the result directly without re-conversion.
  const dispatch = await deps.executeNodeOnce(located.node, input.inputs);
  if (dispatch.kind === 'runtimeUnavailable') {
    return { kind: 'runtimeUnavailable' };
  }
  return { kind: 'nodeTested', result: dispatch.result };
}
