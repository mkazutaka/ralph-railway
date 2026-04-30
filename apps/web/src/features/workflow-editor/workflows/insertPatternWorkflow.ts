import type { InsertedPattern } from '../entities/insertedPattern';
import type { PatternId, WorkflowId } from '../entities/types';
import type { ReadWorkflowFile, WriteWorkflowFile } from '../repositories/workflowFileRepository';
import type { LoadPatternTemplate } from '../repositories/patternTemplateRepository';
import type {
  mergePatternIntoDocument,
  parseWorkflowYaml,
  serializeYaml,
  MergePatternResult,
  ParseYamlResult,
} from '../lib/yaml';

export interface InsertPatternInput {
  workflowId: WorkflowId;
  patternId: PatternId;
}

export type InsertPatternOutput =
  | { kind: 'patternInserted'; result: InsertedPattern }
  | { kind: 'workflowNotFound' }
  | { kind: 'unknownPattern' }
  | { kind: 'unsupportedPattern' }
  | { kind: 'invalidBaseYaml'; reason: string }
  | { kind: 'idConflict' }
  // Pattern template registry has a malformed entry. Distinct from
  // `idConflict` because it represents a server-side bug, not a recoverable
  // user-facing collision (see review note: 'IdConflict が握りつぶしている').
  | { kind: 'templateMalformed'; reason: string }
  // Persistence layer rejected the write (e.g. invalid id at the store).
  // Re-using `workflowNotFound` here would lie; surface the reason but the
  // route layer is responsible for not echoing details to the client.
  | { kind: 'persistFailed'; reason: string };

export interface InsertPatternDeps {
  readWorkflowFile: ReadWorkflowFile;
  loadPatternTemplate: LoadPatternTemplate;
  writeWorkflowFile: WriteWorkflowFile;
  // Pure helpers are injected so the workflow stays free of `import`s on
  // implementation modules and tests can swap them out. Required (no
  // optional defaults) — wiring is centralised in `$lib/server/repos.ts` so
  // callers cannot accidentally bypass the test seam (review note Minor 5).
  parseWorkflowYaml: typeof parseWorkflowYaml;
  mergePatternIntoDocument: typeof mergePatternIntoDocument;
  serializeYaml: typeof serializeYaml;
}

/**
 * Insert a pattern from the showcase into an existing workflow YAML file.
 *
 * Mirrors `apps/web/docs/scenarios/workflow-editor/insert-pattern.md` step by
 * step. The output is a discriminated union — callers must handle every
 * variant; errors are never thrown for expected failure modes.
 */
export async function insertPatternWorkflow(
  input: InsertPatternInput,
  deps: InsertPatternDeps,
): Promise<InsertPatternOutput> {
  const parse = deps.parseWorkflowYaml;
  const merge = deps.mergePatternIntoDocument;
  const serialize = deps.serializeYaml;

  // step 1: LoadBaseWorkflow
  const baseRead = await deps.readWorkflowFile(input.workflowId);
  if (baseRead.kind === 'notFound') {
    return { kind: 'workflowNotFound' };
  }

  // step 2: LoadPattern
  const patternLoad = await deps.loadPatternTemplate(input.patternId);
  if (patternLoad.kind === 'unknown') {
    return { kind: 'unknownPattern' };
  }
  if (patternLoad.kind === 'unsupported') {
    return { kind: 'unsupportedPattern' };
  }

  // step 3: ParseBase
  const parsed: ParseYamlResult = parse(baseRead.yaml);
  if (parsed.kind === 'parseError') {
    return { kind: 'invalidBaseYaml', reason: parsed.reason };
  }

  // step 4: MergePattern
  const merged: MergePatternResult = merge(parsed.document, patternLoad.template);
  if (merged.kind === 'idConflict') {
    return { kind: 'idConflict' };
  }
  if (merged.kind === 'templateMalformed') {
    return { kind: 'templateMalformed', reason: merged.reason };
  }

  // step 5: PersistMergedYaml
  const updatedYaml = serialize(merged.document);

  // Invariant 1: the post-merge YAML must remain parseable and schema-conform.
  // The merge logic is *supposed* to guarantee this, but a future refactor of
  // the pattern registry or the serializer could silently violate it. We
  // re-parse before committing to disk and treat any failure here as a
  // server-side bug (`templateMalformed`, mapped to HTTP 500), never as a
  // user-recoverable condition — the caller's input is fine; our output isn't.
  const safetyParse = parse(updatedYaml);
  if (safetyParse.kind === 'parseError') {
    return {
      kind: 'templateMalformed',
      reason: `merged yaml failed re-parse: ${safetyParse.reason}`,
    };
  }

  const writeResult = await deps.writeWorkflowFile(input.workflowId, updatedYaml);
  if (writeResult.kind === 'invalidId' || writeResult.kind === 'storageFailure') {
    // Both structural ID rejection and underlying I/O failure are persistence
    // failures from the insert-pattern scenario's perspective — the caller's
    // input was fine, the write itself didn't take. Re-using the same
    // variant keeps the route mapping simple (both → 500 with a generic
    // message); the structured `reason` is for server-side logging only and
    // must not be echoed to the client.
    return { kind: 'persistFailed', reason: writeResult.reason };
  }

  return {
    kind: 'patternInserted',
    result: {
      workflowId: input.workflowId,
      patternId: input.patternId,
      updatedYaml,
    },
  };
}
