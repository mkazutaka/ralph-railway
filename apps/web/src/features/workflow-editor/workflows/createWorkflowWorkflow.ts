// Implements `apps/web/docs/scenarios/workflow-management/create-workflow.md`.
//
//   workflow "Create Workflow" =
//     input: WorkflowId AND YamlSource
//     output:
//       WorkflowCreated
//       OR InvalidId
//       OR DuplicateId
//       OR InvalidYaml
//     dependencies: validateWorkflowId, parseWorkflowYaml, workflowExists,
//                   persistWorkflow
//
// `validateWorkflowId` is realised by the `asWorkflowId` brand constructor,
// which the route layer applies to the raw input *before* invoking the
// workflow. We therefore start the workflow from a branded `WorkflowId`; the
// `InvalidId` case is surfaced by the route when branding fails. A second
// validation pass here would either duplicate the regex or weaken the contract
// — both worse than letting the brand constructor be the single source of
// truth.
//
// `workflowExists` and `persistWorkflow` are folded together into the
// repository's atomic `createWorkflowFile` (TOCTOU-free `fs.open(..., 'wx')`).
// Splitting them at the workflow boundary would re-introduce the race window
// the repository's create-only contract was designed to close (review note M-3
// on the workflow-file repository).

import type { WorkflowId, YamlSource } from '../entities/types';
import type { CreatedWorkflow } from '../entities/createdWorkflow';
import { newCreatedWorkflow } from '../entities/createdWorkflow';
import type { CreateWorkflowFile } from '../repositories/workflowFileRepository';
import type { parseWorkflowYaml } from '../lib/yaml';

export interface CreateWorkflowInput {
  readonly workflowId: WorkflowId;
  readonly yaml: YamlSource;
}

/**
 * Discriminated union of every outcome the workflow can produce. CLAUDE.md
 * forbids using exceptions for expected failure modes — the workflow always
 * returns one of these variants, and the route layer maps it to a status
 * code.
 *
 * Variants mirror the scenario's named cases 1:1:
 *   - `workflowCreated` carries the freshly persisted `CreatedWorkflow`.
 *   - `invalidYaml` reports a parse / DSL-schema failure with a generic
 *     reason. The route layer is responsible for not echoing the reason
 *     verbatim (it can contain a fragment of the user-supplied YAML).
 *   - `duplicateId` is reached when the create-only repository operation
 *     observes an existing file with the same id.
 *   - `persistFailed` covers the structural-rejection path from the store
 *     (e.g. the path normaliser disagrees with the brand regex). It is
 *     distinct from `duplicateId` so the route layer can return 400 vs. 409.
 */
export type CreateWorkflowOutput =
  | { kind: 'workflowCreated'; created: CreatedWorkflow }
  | { kind: 'invalidYaml'; reason: string }
  | { kind: 'duplicateId' }
  | { kind: 'persistFailed'; reason: string };

export interface CreateWorkflowDeps {
  /**
   * Atomic create-only persistence. Combines the scenario's `workflowExists`
   * and `persistWorkflow` dependencies into a single repository call so the
   * existence check and the write cannot race (TOCTOU-free
   * `fs.open(..., 'wx')`).
   */
  createWorkflowFile: CreateWorkflowFile;
  /**
   * Pure helper injected so the workflow stays free of `import`s on the
   * implementation module and tests can swap it out. Required (no optional
   * defaults) — wiring is centralised in `$lib/server/repos.ts` so callers
   * cannot accidentally bypass the test seam.
   */
  parseWorkflowYaml: typeof parseWorkflowYaml;
}

/**
 * Create a brand new workflow YAML file. Mirrors the scenario step-by-step.
 *
 * Order of checks matches the scenario's substep ordering:
 *   1. ValidateIdentifier — handled at the route boundary by `asWorkflowId`
 *      (`InvalidId` surfaces there).
 *   2. ValidateDocument   — parse the YAML before persisting (invariant 2:
 *      "不正な YAML はディスクに書き込まれない").
 *   3. EnsureUnique + PersistWorkflow — fused into the atomic create call
 *      (invariant 1: "既存のワークフローを上書きしない").
 *
 * Scenario invariants:
 *   1. 既存のワークフローを上書きしない — enforced by `createWorkflowFile`'s
 *      `'alreadyExists'` branch returning `duplicateId` here.
 *   2. 不正な YAML はディスクに書き込まれない — enforced by parsing *before*
 *      the create call. A parse failure short-circuits with `invalidYaml`
 *      and the store is never touched.
 *   3. WorkflowId にディレクトリ区切り文字を含められない — enforced at the
 *      brand boundary (`asWorkflowId` in `entities/types.ts`) before this
 *      function is called.
 *   4. 作成後は同じ Id で読み出せる — `CreatedWorkflow.id` is the same
 *      branded value we received as input, so the caller can immediately
 *      redirect to `/workflows/[id]` with the same identifier.
 */
export async function createWorkflowWorkflow(
  input: CreateWorkflowInput,
  deps: CreateWorkflowDeps,
): Promise<CreateWorkflowOutput> {
  // step 2 (ValidateDocument): refuse to write an unparseable YAML. The
  // scenario splits "parse error" and "DSL schema violation" into two reasons,
  // but `parseWorkflowYaml` already collapses both into the same
  // `parseError` variant — anything that fails the DMMF schema check is
  // re-emitted as a parse error with a structured reason. We forward that
  // reason verbatim to the workflow output so route logging has context, but
  // the route layer is responsible for not surfacing it to the client (it can
  // contain a fragment of the user-supplied YAML).
  const parsed = deps.parseWorkflowYaml(input.yaml);
  if (parsed.kind === 'parseError') {
    return { kind: 'invalidYaml', reason: parsed.reason };
  }

  // steps 3+4 (EnsureUnique + PersistWorkflow): one atomic call. The store
  // returns `'alreadyExists'` when the create-only `wx` open observes a
  // pre-existing file (invariant 1) and `'invalidId'` when the lower-level
  // path normaliser disagrees with the brand regex (defence in depth).
  const result = await deps.createWorkflowFile(input.workflowId, input.yaml);
  if (result.kind === 'alreadyExists') {
    return { kind: 'duplicateId' };
  }
  if (result.kind === 'invalidId') {
    return { kind: 'persistFailed', reason: result.reason };
  }

  return {
    kind: 'workflowCreated',
    created: newCreatedWorkflow(input.workflowId),
  };
}
