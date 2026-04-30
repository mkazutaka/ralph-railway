// Implements `apps/web/docs/scenarios/workflow-management/open-workflow.md`.
//
//   workflow "Open Workflow" =
//     input: WorkflowId
//     output:
//       WorkflowOpened
//       OR NotFound
//     dependencies: readWorkflowFile, parseToGraph
//
//     // step 1
//     do LocateWorkflow
//     If not found then:
//       return NotFound
//       stop
//
//     // step 2
//     do RenderGraph
//     return WorkflowOpened
//
// Scenario invariants:
//   1. YAML が壊れていてもワークフロー自体は開ける（編集して修正できる）
//      — enforced by `parseToGraph` never throwing: a parse failure surfaces
//      via `graph.parseError` and the workflow still returns
//      `workflowOpened`. Only `readWorkflowFile`'s `notFound` branch can
//      short-circuit out.
//   2. 構文エラーがある場合は ParseError にメッセージが入り、Graph は最後に
//      解析成功した状態ではなく空になる
//      — enforced by `parseToGraph` returning
//      `{ nodes: [], edges: [], parseError }` on every failure path.
//   3. 読み込みは副作用を持たない（ファイルを書き換えない）
//      — enforced by the dependency contract: `readWorkflowFile` is the only
//      I/O performed here, and it is read-only by construction.

import type { WorkflowId } from '../entities/types';
import type { OpenedWorkflow } from '../entities/openedWorkflow';
import { newOpenedWorkflow } from '../entities/openedWorkflow';
import type { ReadWorkflowFile } from '../repositories/workflowFileRepository';
import type { parseWorkflowYaml } from '../lib/yaml';
import type { parseToGraph } from '../lib/parseToGraph';

export interface OpenWorkflowInput {
  readonly workflowId: WorkflowId;
}

/**
 * Discriminated union of every outcome the workflow can produce. CLAUDE.md
 * forbids using exceptions for expected failure modes — the workflow always
 * returns one of these variants, and the route layer maps it to a status
 * code.
 *
 * Variants mirror the scenario's named cases 1:1:
 *   - `workflowOpened` carries the freshly assembled `OpenedWorkflow`.
 *   - `notFound` is reached when the repository reports the file no longer
 *     exists on disk (e.g. it was deleted between listing and opening).
 */
export type OpenWorkflowOutput =
  | { kind: 'workflowOpened'; opened: OpenedWorkflow }
  | { kind: 'notFound' };

export interface OpenWorkflowDeps {
  /** Repository operation realising the scenario's `readWorkflowFile`. */
  readWorkflowFile: ReadWorkflowFile;
  /**
   * Pure helper realising the scenario's `parseToGraph`. Injected (rather
   * than imported by the workflow) so tests can swap it without the file
   * system seam, and so the wiring is centralised in `$lib/server/repos.ts`.
   */
  parseToGraph: typeof parseToGraph;
  /**
   * Pure helper used to read `document.name` from the YAML so the opened
   * workflow can carry a display name in the same shape as the listing view
   * (see invariant 2 of the list-workflows scenario: name fallback to
   * filename when the YAML lacks a `document.name`). Injected so the
   * workflow stays free of `import`s on the implementation module and tests
   * can swap it out.
   *
   * `parseToGraph` itself does not return the parsed document — it only
   * returns the graph — so we need a second, structural pass to recover the
   * name. Routing this through `parseWorkflowYaml` keeps the YAML schema
   * defence-in-depth (JSON_SCHEMA, prototype-key rejection) in one place.
   */
  parseWorkflowYaml: typeof parseWorkflowYaml;
}

/**
 * Locate the YAML on disk and assemble the visualisation graph + display
 * envelope expected by the editor. Mirrors the scenario step-by-step.
 *
 * Order of substeps matches the scenario:
 *   1. LocateWorkflow — `readWorkflowFile`. A `notFound` result short-circuits
 *      with `kind: 'notFound'`; no further work is performed (invariant 3:
 *      no side effects on the not-found path either).
 *   2. RenderGraph — `parseToGraph`. Always succeeds (the graph carries any
 *      parse error inline), so the workflow always returns `workflowOpened`
 *      after step 1.
 */
export async function openWorkflowWorkflow(
  input: OpenWorkflowInput,
  deps: OpenWorkflowDeps,
): Promise<OpenWorkflowOutput> {
  // step 1 (LocateWorkflow): read from disk.
  const read = await deps.readWorkflowFile(input.workflowId);
  if (read.kind === 'notFound') {
    return { kind: 'notFound' };
  }

  // step 2 (RenderGraph): build the visualisation. Never throws — invariant 1
  // requires the workflow to open even when the YAML is broken so the user
  // can edit and fix it.
  const graph = deps.parseToGraph(read.yaml);

  // Pull the optional `document.name` from the parsed YAML. We tolerate every
  // failure mode silently (parse error, missing key, non-string value) and
  // fall back to the file basename inside `newOpenedWorkflow` — invariant 1
  // again forbids surfacing this as a workflow-level error.
  const documentName = readDocumentName(deps.parseWorkflowYaml, read.yaml);

  return {
    kind: 'workflowOpened',
    opened: newOpenedWorkflow(input.workflowId, read.yaml, graph, documentName),
  };
}

/**
 * Best-effort extraction of `document.name` from the YAML's top-level
 * mapping. Returns `null` whenever the field is absent, blank, or not a
 * string — the entity layer (`newOpenedWorkflow`) folds that into the
 * filename fallback.
 *
 * Mirrors the private helper inside `lib/extractWorkflowSummary.ts`. We
 * deliberately keep a copy here instead of exporting the original because
 * the listing scenario's helper carries scenario-specific context in its
 * docstring (filename fallback policy, parse-error fallback) and reusing it
 * by name would muddle the dependency graph between two unrelated scenarios.
 */
function readDocumentName(
  parseYaml: typeof parseWorkflowYaml,
  yaml: Parameters<typeof parseWorkflowYaml>[0],
): string | null {
  const parsed = parseYaml(yaml);
  if (parsed.kind !== 'parsed') return null;
  const documentMeta = parsed.document.meta.document;
  if (
    documentMeta == null ||
    typeof documentMeta !== 'object' ||
    Array.isArray(documentMeta)
  ) {
    return null;
  }
  const name = (documentMeta as Record<string, unknown>).name;
  if (typeof name !== 'string') return null;
  if (name.length === 0) return null;
  return name;
}
