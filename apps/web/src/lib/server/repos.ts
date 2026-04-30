// Server-side dependency injection helpers.
//
// Routes call `makeWorkflowFileRepository()` and `makePatternTemplateRepository()`
// rather than wiring `createWorkflowStore(getWorkflowsDir())` themselves.
// This keeps the wiring in one place (so a future swap to a DB-backed store
// only touches this file) and makes route-level tests easy: a test harness
// can replace the factory functions before the route is invoked.

import { createWorkflowStore, getWorkflowsDir } from './workflows';
import { createInMemoryRunStore } from './runs';
import { createInMemoryRuntimeStore } from './runtime';
import {
  toWorkflowFileRepository,
  type WorkflowFileRepository,
} from '$features/workflow-editor/repositories/workflowFileRepository';
import {
  toPatternTemplateRepository,
  type PatternTemplateRepository,
} from '$features/workflow-editor/repositories/patternTemplateRepository';
import {
  toRunRepository,
  type RunRepository,
} from '$features/workflow-editor/repositories/runRepository';
import {
  toRuntimeRepository,
  type RuntimeRepository,
} from '$features/workflow-editor/repositories/runtimeRepository';
import {
  mergePatternIntoDocument,
  parseWorkflowYaml,
  serializeYaml,
} from '$features/workflow-editor/lib/yaml';
import { validateRuntimeSupport } from '$features/workflow-editor/lib/runtimeSupport';
import {
  locateNode,
  validateNodeInputs,
} from '$features/workflow-editor/lib/nodeTestability';
import { extractWorkflowSummary } from '$features/workflow-editor/lib/extractWorkflowSummary';
import { parseToGraph } from '$features/workflow-editor/lib/parseToGraph';

/**
 * Pure helpers required by `insertPatternWorkflow`. Captured as an explicit
 * interface so adding a new helper (or accidentally dropping one) is caught
 * at this single wiring site instead of by downstream tests.
 *
 * Review note (architecture / Minor 1): explicitly typed return values pin
 * the repository / helper contracts here so a missing method on a future
 * implementation fails to type-check at the factory rather than where the
 * route consumes it.
 */
export interface InsertPatternHelpers {
  readonly parseWorkflowYaml: typeof parseWorkflowYaml;
  readonly mergePatternIntoDocument: typeof mergePatternIntoDocument;
  readonly serializeYaml: typeof serializeYaml;
}

/**
 * Build the workflow-file repository wired against the on-disk workflow
 * directory. Each call constructs a fresh `WorkflowStore`, but that is just
 * an object literal capturing the resolved root path — there is no I/O on
 * construction so per-request creation is cheap.
 */
export function makeWorkflowFileRepository(): WorkflowFileRepository {
  return toWorkflowFileRepository(createWorkflowStore(getWorkflowsDir()));
}

/**
 * Build the pattern-template repository. The registry is a static
 * in-memory map today, so every call returns an equivalent adapter.
 */
export function makePatternTemplateRepository(): PatternTemplateRepository {
  return toPatternTemplateRepository();
}

/**
 * Build the run repository wired against the in-memory `RunStore` and the
 * production workflow file repository. Both are constructed per-call: the
 * in-memory store is module-level singleton state inside `runs.ts`, and the
 * file repository is a cheap object literal (`makeWorkflowFileRepository()`
 * does no I/O on construction). Wiring them together here keeps the
 * dependency graph in one file so a future swap to a SQL-backed run store
 * only touches this module.
 */
export function makeRunRepository(): RunRepository {
  return toRunRepository(createInMemoryRunStore(), makeWorkflowFileRepository());
}

/**
 * Wire the pure helpers required by `insertPatternWorkflow`. Centralised here
 * (review note Minor 5) so route code never imports the implementation
 * modules directly — the workflow's `deps` argument is the only place these
 * helpers can be swapped, which keeps the test seam consistent across both
 * the REST endpoint and the page-level form action.
 */
export function makeInsertPatternHelpers(): InsertPatternHelpers {
  return {
    parseWorkflowYaml,
    mergePatternIntoDocument,
    serializeYaml,
  };
}

/**
 * Pure helpers required by `startRunWorkflow`. Mirrors `InsertPatternHelpers`:
 * an explicit interface so adding a new dependency is caught at this single
 * wiring site instead of by downstream tests.
 */
export interface StartRunHelpers {
  readonly parseWorkflowYaml: typeof parseWorkflowYaml;
  readonly validateRuntimeSupport: typeof validateRuntimeSupport;
}

/**
 * Build the runtime repository wired against the in-memory `RuntimeStore`.
 * Per-call construction is cheap (the store factory just captures module-
 * level state) and matches the pattern used by `makeRunRepository` so a
 * future swap to a CLI socket / REST proxy only touches this file.
 */
export function makeRuntimeRepository(): RuntimeRepository {
  return toRuntimeRepository(createInMemoryRuntimeStore());
}

/**
 * Wire the pure helpers required by `startRunWorkflow`. Centralised here so
 * route code never imports the implementation modules directly — the
 * workflow's `deps` argument is the only place these helpers can be swapped,
 * which keeps the test seam consistent across the REST endpoint and any
 * future form action.
 */
export function makeStartRunHelpers(): StartRunHelpers {
  return {
    parseWorkflowYaml,
    validateRuntimeSupport,
  };
}

/**
 * Pure helpers required by `createWorkflowWorkflow`. Mirrors `StartRunHelpers`:
 * an explicit interface so adding a new dependency is caught at this single
 * wiring site instead of by downstream tests.
 */
export interface CreateWorkflowHelpers {
  readonly parseWorkflowYaml: typeof parseWorkflowYaml;
}

/**
 * Pure helpers required by `saveWorkflowWorkflow`. Mirrors
 * `CreateWorkflowHelpers`: an explicit interface so adding a new dependency
 * (e.g. a future audit-log writer) is caught at this single wiring site
 * instead of by downstream tests.
 *
 * The workflow itself is parser-free by design (save-workflow scenario
 * invariant 2: 構文不正な YAML も保存可能), so the only injected helper is
 * the clock used to stamp `SavedWorkflow.savedAt`.
 */
export interface SaveWorkflowHelpers {
  readonly now: () => number;
}

/**
 * Wire the pure helpers required by `saveWorkflowWorkflow`. Centralised here
 * so route code never imports the implementation modules directly — the
 * workflow's `deps` argument is the only place these helpers can be swapped,
 * which keeps the test seam consistent.
 */
export function makeSaveWorkflowHelpers(): SaveWorkflowHelpers {
  return { now: () => Date.now() };
}

/**
 * Wire the pure helpers required by `createWorkflowWorkflow`. Centralised
 * here so route code never imports the implementation modules directly — the
 * workflow's `deps` argument is the only place these helpers can be swapped,
 * which keeps the test seam consistent across the REST endpoint and any
 * future form action.
 */
export function makeCreateWorkflowHelpers(): CreateWorkflowHelpers {
  return { parseWorkflowYaml };
}

/**
 * Pure helpers required by `listWorkflowsWorkflow`. Mirrors `CreateWorkflowHelpers`:
 * an explicit interface so adding a new dependency is caught at this single
 * wiring site instead of by downstream tests.
 */
export interface ListWorkflowsHelpers {
  readonly extractWorkflowSummary: typeof extractWorkflowSummary;
}

/**
 * Wire the pure helpers required by `listWorkflowsWorkflow`. Centralised here
 * so route code never imports the implementation modules directly — the
 * workflow's `deps` argument is the only place these helpers can be swapped,
 * which keeps the test seam consistent across the REST endpoint and the
 * page-level `+page.server.ts` load function.
 */
export function makeListWorkflowsHelpers(): ListWorkflowsHelpers {
  return { extractWorkflowSummary };
}

/**
 * Pure helpers required by `openWorkflowWorkflow`. Mirrors `CreateWorkflowHelpers`:
 * an explicit interface so adding a new dependency is caught at this single
 * wiring site instead of by downstream tests.
 */
export interface OpenWorkflowHelpers {
  readonly parseToGraph: typeof parseToGraph;
  readonly parseWorkflowYaml: typeof parseWorkflowYaml;
}

/**
 * Wire the pure helpers required by `openWorkflowWorkflow`. Centralised here
 * so route code never imports the implementation modules directly — the
 * workflow's `deps` argument is the only place these helpers can be swapped,
 * which keeps the test seam consistent across the page-level load function
 * and any future REST endpoint.
 */
export function makeOpenWorkflowHelpers(): OpenWorkflowHelpers {
  return { parseToGraph, parseWorkflowYaml };
}

/**
 * Pure helpers required by `testNodeWorkflow`. Mirrors `StartRunHelpers`: an
 * explicit interface so adding a new dependency is caught at this single
 * wiring site instead of by downstream tests.
 */
export interface TestNodeHelpers {
  readonly parseWorkflowYaml: typeof parseWorkflowYaml;
  readonly locateNode: typeof locateNode;
  readonly validateNodeInputs: typeof validateNodeInputs;
}

/**
 * Wire the pure helpers required by `testNodeWorkflow`. Centralised here so
 * route code never imports the implementation modules directly — the
 * workflow's `deps` argument is the only place these helpers can be swapped,
 * which keeps the test seam consistent across the REST endpoint and any
 * future form action.
 */
export function makeTestNodeHelpers(): TestNodeHelpers {
  return {
    parseWorkflowYaml,
    locateNode,
    validateNodeInputs,
  };
}
