// Implements `apps/web/docs/scenarios/workflow-management/save-workflow.md`.
//
//   workflow "Save Workflow" =
//     input: WorkflowId AND YamlSource
//     output:
//       WorkflowSaved
//       OR InvalidId
//       OR NotFound
//       OR StorageFailure
//     dependencies: validateWorkflowId, workflowExists, writeWorkflowFile
//
// `validateWorkflowId` is realised by the `asWorkflowId` brand constructor at
// the route boundary; the workflow therefore starts from an already-branded
// `WorkflowId` and the `InvalidId` outcome is surfaced by the route when
// branding fails. We still expose `invalidId` as an output variant here
// because the lower-level store performs an additional path-shape check
// (`assertValidId`) that can disagree with the brand regex — defence in
// depth.
//
// Invariant 2 from the scenario: 構文不正な YAML も保存可能. The workflow
// therefore **does NOT** parse / validate the YAML — it is the user's
// editing buffer and we want to preserve it verbatim so they can recover
// later. This is a deliberate departure from `createWorkflowWorkflow` (which
// rejects unparseable YAML to keep the file system clean of dead workflows
// from the moment of creation).

import type { WorkflowId, YamlSource } from '../entities/types';
import type { SavedWorkflow } from '../entities/savedWorkflow';
import { newSavedWorkflow } from '../entities/savedWorkflow';
import type {
  WorkflowFileExists,
  WriteWorkflowFile,
} from '../repositories/workflowFileRepository';

export interface SaveWorkflowInput {
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
 *   - `workflowSaved` carries the freshly persisted `SavedWorkflow`.
 *   - `invalidId` reports an id rejected by the lower-level store even
 *     though the brand regex accepted it. Mapped to 400 by the route. The
 *     `reason` is for logs only — it can echo the raw id (defence in
 *     depth: the route should not surface it to clients).
 *   - `notFound` is reached when the existence probe finds no file at the
 *     branded id. Mapped to 404 by the route — the save-workflow scenario
 *     is strictly an *overwrite*; new-file creation is the
 *     create-workflow scenario's job.
 *   - `storageFailure` covers genuine I/O failures (permission denied,
 *     disk full, ...). Mapped to 500 by the route with a generic message.
 */
export type SaveWorkflowOutput =
  | { kind: 'workflowSaved'; saved: SavedWorkflow }
  | { kind: 'invalidId'; reason: string }
  | { kind: 'notFound' }
  | { kind: 'storageFailure'; reason: string };

export interface SaveWorkflowDeps {
  /**
   * Existence probe — realises the scenario's `workflowExists` dependency.
   * Cheap O(1) `fs.access` under the hood so the save hot path doesn't
   * read the existing file just to discriminate found / notFound.
   */
  workflowFileExists: WorkflowFileExists;
  /**
   * Atomic overwrite — realises the scenario's `writeWorkflowFile`
   * dependency. Both the structural-id rejection (`invalidId`) and the
   * I/O-failure (`storageFailure`) outcomes are surfaced as discriminated
   * variants by the repository so the workflow stays free of try/catch.
   */
  writeWorkflowFile: WriteWorkflowFile;
  /**
   * Clock injected so tests can pin the `savedAt` timestamp deterministically
   * without freezing global `Date.now`. Defaulting at the wiring site
   * (`$lib/server/repos.ts`) keeps the workflow free of side effects on
   * import.
   */
  now: () => number;
}

/**
 * Save (overwrite) an existing workflow YAML file. Mirrors the scenario
 * step-by-step.
 *
 * Order of checks matches the scenario's substep ordering:
 *   1. ValidateIdentifier — handled at the route boundary by `asWorkflowId`
 *      (`InvalidId` surfaces there). The workflow still surfaces
 *      `invalidId` as an output for the lower-level store rejection path.
 *   2. EnsureExists       — probe for the file before attempting the write
 *      (invariant: save is overwrite-only, never create).
 *   3. WriteContent       — atomic overwrite. Storage failures surface as
 *      `storageFailure` (invariant 3: 保存失敗時は元のファイル内容が
 *      変わらない — fs.writeFile is not atomic across crashes, but the
 *      repository's contract is that a partial write is reported as a
 *      failure rather than silently swallowed).
 *
 * Scenario invariants:
 *   1. 保存は上書きであり、新規作成とは別ワークフロー — enforced by step 2
 *      returning `notFound` when the file does not exist. The route maps
 *      this to 404; the create-workflow scenario owns new-file creation.
 *   2. 構文不正な YAML も保存可能 — enforced by *not* parsing the YAML
 *      anywhere in this workflow. The route also skips validation (this
 *      diverges from the create-workflow scenario, which does parse).
 *   3. 保存に失敗した場合は元のファイル内容が変わらない — best-effort
 *      via `fs.writeFile`. A genuine atomic-write contract would require a
 *      tempfile + rename, which is out of scope for the current store; the
 *      `storageFailure` outcome captures the case where the write is
 *      reported as failed by the underlying syscall.
 *   4. WorkflowId にディレクトリ区切り文字を含められない — enforced at the
 *      brand boundary (`asWorkflowId` in `entities/types.ts`) before this
 *      function is called.
 */
export async function saveWorkflowWorkflow(
  input: SaveWorkflowInput,
  deps: SaveWorkflowDeps,
): Promise<SaveWorkflowOutput> {
  // step 2 (EnsureExists): refuse to create a new file under the save path.
  // The brand has already enforced shape, so any throw from the existence
  // probe is a genuine I/O failure (e.g. directory unreadable) and the
  // route surfaces it as 500.
  const exists = await deps.workflowFileExists(input.workflowId);
  if (!exists) {
    return { kind: 'notFound' };
  }

  // step 3 (WriteContent): atomic overwrite. The repository converts the
  // two known failure modes (id rejection, I/O error) into discriminated
  // variants so we never throw for an expected outcome.
  const writeResult = await deps.writeWorkflowFile(input.workflowId, input.yaml);
  if (writeResult.kind === 'invalidId') {
    return { kind: 'invalidId', reason: writeResult.reason };
  }
  if (writeResult.kind === 'storageFailure') {
    return { kind: 'storageFailure', reason: writeResult.reason };
  }

  return {
    kind: 'workflowSaved',
    saved: newSavedWorkflow(input.workflowId, deps.now()),
  };
}
