// Implements `apps/web/docs/scenarios/workflow-editor/run-workflow.md`.
//
//   workflow "Start Run" =
//     input: WorkflowId
//     output:
//       RunStarted
//       OR WorkflowNotFound
//       OR InvalidYaml
//       OR UnsupportedNode
//       OR RuntimeUnavailable
//     dependencies: readWorkflowFile, parseWorkflowYaml,
//                   validateRuntimeSupport, enqueueRun

import type { StartedRun } from '../entities/startedRun';
import type { WorkflowId } from '../entities/types';
import type {
  ReadWorkflowFile,
} from '../repositories/workflowFileRepository';
import type { EnqueueRun } from '../repositories/runtimeRepository';
import type { parseWorkflowYaml } from '../lib/yaml';
import type { validateRuntimeSupport } from '../lib/runtimeSupport';

export interface StartRunInput {
  readonly workflowId: WorkflowId;
}

/**
 * Discriminated union of every outcome the workflow can produce. CLAUDE.md
 * forbids using exceptions for expected failure modes — the workflow always
 * returns one of these variants, and the route layer maps it to a status
 * code.
 *
 * `runStarted` carries the full `StartedRun` (run id + workflow id +
 * `startedAt`). The remaining variants mirror the scenario's named error
 * cases 1:1 so the route layer can do an exhaustive `switch` and TypeScript
 * flags any future addition that the route forgets to handle.
 *
 * - `invalidYaml.reason` echoes the parser's structured reason. Routes are
 *   responsible for deciding whether to forward it (granular client-side
 *   diagnostics are useful in the editor — the YAML originated from the
 *   user's own file) or scrub it (the same payload from a public-facing
 *   deployment may leak internal parser details).
 * - `unsupportedNode.nodeType` is the *first* unsupported node type found
 *   in document order. Surfacing one (rather than a list) keeps the error
 *   message actionable: the user fixes that node and retries.
 */
export type StartRunOutput =
  | { kind: 'runStarted'; run: StartedRun }
  | { kind: 'workflowNotFound' }
  | { kind: 'invalidYaml'; reason: string }
  | { kind: 'unsupportedNode'; nodeType: string }
  | { kind: 'runtimeUnavailable' };

export interface StartRunDeps {
  readWorkflowFile: ReadWorkflowFile;
  enqueueRun: EnqueueRun;
  // Pure helpers are injected so the workflow stays free of `import`s on
  // implementation modules and tests can swap them out. Required (no
  // optional defaults) — wiring is centralised in `$lib/server/repos.ts` so
  // callers cannot accidentally bypass the test seam (mirrors
  // `insertPatternWorkflow.deps`).
  parseWorkflowYaml: typeof parseWorkflowYaml;
  validateRuntimeSupport: typeof validateRuntimeSupport;
}

/**
 * Dispatch a workflow for execution. Mirrors the scenario step-by-step.
 *
 * Order of checks matches the scenario's substep ordering:
 *   1. LocateWorkflow   — workflow file must exist
 *   2. ValidateDocument — YAML must parse and conform to the document schema
 *   3. CheckRuntimeSupport — every node type must be runtime-supported
 *   4. DispatchRun      — runtime must be reachable
 *
 * Each step has a single failure mode and the next step is only attempted
 * when the previous returned its success variant. The discriminated union
 * means callers cannot accidentally treat a failure as a success.
 *
 * Scenario invariants:
 *   1. 構文エラーのある YAML では実行を開始しない — enforced by the early
 *      return from step 2 (no call to `enqueueRun`).
 *   2. ランタイム未対応ノードを含むワークフローは実行を開始しない —
 *      enforced by the early return from step 3.
 *   3. RunStarted の RunId は実行ごとに一意 — delegated to the runtime
 *      adapter which mints a fresh id per call (see `RuntimeStore`).
 *   4. ワークフロー本体 (YAML 原文) は実行開始によって変更されない —
 *      we never write the file; `readWorkflowFile` is the only file-system
 *      interaction.
 *   5. 実行開始は非同期 — `enqueueRun` returns once the run is queued; we
 *      do not block on completion.
 */
export async function startRunWorkflow(
  input: StartRunInput,
  deps: StartRunDeps,
): Promise<StartRunOutput> {
  // step 1: LocateWorkflow
  const read = await deps.readWorkflowFile(input.workflowId);
  if (read.kind === 'notFound') {
    return { kind: 'workflowNotFound' };
  }

  // step 2: ValidateDocument
  // The parser is pure (no I/O) and returns a structured result; we never
  // throw past this point.
  const parsed = deps.parseWorkflowYaml(read.yaml);
  if (parsed.kind === 'parseError') {
    return { kind: 'invalidYaml', reason: parsed.reason };
  }

  // step 3: CheckRuntimeSupport
  // Pure helper; the document is in hand at the call site so the success
  // variant carries no payload.
  const supportCheck = deps.validateRuntimeSupport(parsed.document);
  if (supportCheck.kind === 'unsupportedNode') {
    return { kind: 'unsupportedNode', nodeType: supportCheck.nodeType };
  }

  // step 4: DispatchRun
  // The repository's `EnqueueRunResult` is already the brand-validated
  // entity flavour, so we forward the run directly without re-conversion.
  const dispatch = await deps.enqueueRun(input.workflowId, parsed.document);
  if (dispatch.kind === 'runtimeUnavailable') {
    return { kind: 'runtimeUnavailable' };
  }
  return { kind: 'runStarted', run: dispatch.run };
}
