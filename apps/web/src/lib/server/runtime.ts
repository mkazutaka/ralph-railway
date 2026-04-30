// In-memory runtime adapter. The web UI does not yet ship its own workflow
// runtime — runs are normally produced by the CLI runtime which hands the
// `RunStore` (in `runs.ts`) the resulting summary / detail rows. Until the
// web app speaks to a real runtime daemon, this module hosts the seam
// `enqueueRun` plugs into so the "Start Run" scenario has somewhere
// observable to land.
//
// Mirrors `runs.ts`: the store is an interface with a small default
// implementation, and `repos.ts` wires the production instance. Tests inject
// their own implementation directly into the repository factory.

import type { StartedRunRow } from '$features/workflow-editor/entities/startedRun';
import type { StopAcceptedRow } from '$features/workflow-editor/entities/stopAccepted';
import type { NodeTestResultRow } from '$features/workflow-editor/entities/nodeTestResult';
import type { WorkflowDocument } from '$features/workflow-editor/entities/workflowDocument';

/**
 * Outcome of a runtime dispatch attempt.
 *
 * - `enqueued` carries the freshly minted `StartedRunRow`. Plain row shape
 *   (no branded ids) so the entity layer keeps ownership of brand validation
 *   via `buildStartedRunFromRow`.
 * - `unavailable` is the structured failure mode mapped to scenario's
 *   `RuntimeUnavailable` outcome — surfaced as a sum-type result rather
 *   than an exception so the workflow can switch on it.
 */
export type EnqueueRunResult =
  | { kind: 'enqueued'; row: StartedRunRow }
  | { kind: 'unavailable' };

/**
 * Outcome of a runtime stop-request attempt. Mirrors `EnqueueRunResult`.
 *
 * - `accepted` carries the freshly recorded `StopAcceptedRow`. Plain row
 *   shape (no branded ids) so the entity layer keeps ownership of brand
 *   validation via `buildStopAcceptedFromRow`.
 * - `unavailable` is the structured failure mode mapped to the scenario's
 *   `RuntimeUnavailable` outcome (see
 *   `apps/web/docs/scenarios/workflow-editor/stop-run.md`).
 *
 * The store contract intentionally does NOT distinguish "run does not exist"
 * here — that check happens earlier in the workflow via `findRunDetail`
 * (scenario step 1: LocateRun). The runtime adapter is only consulted once
 * the workflow has confirmed the run is non-terminal.
 */
export type RequestStopResult =
  | { kind: 'accepted'; row: StopAcceptedRow }
  | { kind: 'unavailable' };

/**
 * Outcome of an isolated single-node test execution. Mirrors the scenario in
 * `apps/web/docs/scenarios/workflow-editor/test-node.md`:
 *
 *   func executeNodeOnce: NodeDefinition AND DummyInputs
 *                       -> NodeTestResult OR RuntimeUnavailable
 *
 * - `executed` carries the freshly produced `NodeTestResultRow`. Plain row
 *   shape (no branded ids) so the entity layer keeps ownership of brand /
 *   invariant validation via `buildNodeTestResultFromRow`.
 * - `unavailable` is the structured failure mode mapped to the scenario's
 *   `RuntimeUnavailable` outcome — surfaced as a sum-type result rather than
 *   an exception so the workflow can switch on it.
 *
 * Scenario invariants 1 & 2: this method MUST NOT mutate the persistent
 * `RunStore` (the test result is not folded into the run history) and MUST
 * NOT mutate the workflow YAML file. The in-memory adapter satisfies both
 * trivially because it only constructs the result row from its inputs.
 */
export type ExecuteNodeOnceResult =
  | { kind: 'executed'; row: NodeTestResultRow }
  | { kind: 'unavailable' };

/**
 * Underlying runtime store. The contract is:
 *
 *   - `enqueue(workflowId, document)` accepts a *parsed* document (not raw
 *     YAML) so the syntax / schema check has already happened by the time
 *     the adapter is called. The runtime is free to re-validate against its
 *     own schema, but the workflow layer does not require it to.
 *   - `enqueue` MUST allocate a unique id per call (scenario invariant 3)
 *     and SHOULD return the row in `startedAt` order (caller's clock is the
 *     source of truth for that timestamp; the runtime echoes it back).
 *
 * The store does not own any state related to *progress* — that is the
 * `RunStore`'s responsibility. Keeping the two seams separate means a real
 * backend can swap each independently (e.g. a CLI socket for runtime, a
 * SQLite table for the read-model).
 */
export interface RuntimeStore {
  /**
   * Whether the runtime is reachable right now. Used by the workflow layer
   * to short-circuit when the runtime cannot accept new work — `enqueue`
   * itself surfaces the same condition as `unavailable`, but the explicit
   * health check lets diagnostics pages render without poking the queue.
   */
  available(): Promise<boolean>;
  /**
   * Dispatch a parsed workflow document for execution. Returns the freshly
   * allocated run id with the start timestamp. Resolves to
   * `{ kind: 'unavailable' }` when the runtime is offline so the workflow
   * does not need to translate exceptions into the scenario's
   * `RuntimeUnavailable` variant.
   */
  enqueue(
    workflowId: string,
    document: WorkflowDocument,
  ): Promise<EnqueueRunResult>;
  /**
   * Forward a stop request for a previously enqueued run id. Resolves to
   * `{ kind: 'unavailable' }` when the runtime is offline so the workflow
   * does not need to translate exceptions into the scenario's
   * `RuntimeUnavailable` variant.
   *
   * Scenario invariant 2: this method only guarantees the request was
   * *received* by the runtime — actual transition to `Cancelled` is observed
   * via the read-run-detail path. The adapter therefore returns a
   * `requestedAt` timestamp rather than the post-stop run state.
   *
   * Idempotency contract (scenario invariant 5 / review notes L1 + L4):
   * implementations MUST treat `requestStop(runId)` as idempotent. Repeated
   * calls with the same `runId` (whether due to UI double-clicks, retry
   * after a transient `unavailable`, or the workflow racing the runtime to
   * a terminal transition) MUST resolve to either `accepted` or
   * `unavailable`, NEVER throw, and MUST NOT corrupt earlier state. A run
   * that has already reached a terminal state is allowed to surface as
   * `accepted` (the runtime no-ops); the `stopRunWorkflow` already
   * short-circuits on terminal status before calling this method, so this
   * branch is just a hardening clause for adapters that may receive late
   * requests through other paths.
   *
   * The returned `StopAcceptedRow.id` MUST equal the input `runId`. The
   * repository layer (`runtimeRepository.requestRunStop`) re-checks this
   * invariant as defence-in-depth.
   */
  requestStop(runId: string): Promise<RequestStopResult>;
  /**
   * Execute a single node in isolation against the supplied dummy inputs.
   * Resolves to `{ kind: 'unavailable' }` when the runtime is offline so the
   * workflow does not need to translate exceptions into the scenario's
   * `RuntimeUnavailable` variant.
   *
   * Scenario invariants 1 & 2: implementations MUST NOT touch the run history
   * (no `RunStore` writes) and MUST NOT touch the workflow YAML file (no
   * `WorkflowFileRepository.writeWorkflowFile` calls). The result is
   * ephemeral — its lifetime is the HTTP response that returned it.
   *
   * The returned `NodeTestResultRow.nodeId` MUST equal the input `nodeId`. The
   * repository layer (`runtimeRepository.executeNodeOnce`) re-checks this
   * invariant as defence-in-depth (mirrors the `requestStop` contract).
   */
  executeNodeOnce(
    nodeId: string,
    nodeType: string,
    nodeBody: Readonly<Record<string, unknown>>,
    inputs: Readonly<Record<string, unknown>>,
  ): Promise<ExecuteNodeOnceResult>;
}

/**
 * Module-level state. Mirrors `runs.ts`: shared across `+server.ts` request
 * handlers within the same Node process so multiple requests see a
 * consistent view; lost on restart, which matches the current "no
 * persistence" assumption.
 */
const QUEUE: StartedRunRow[] = [];
const STOP_REQUESTS: StopAcceptedRow[] = [];
let AVAILABLE = true;
let SEQ = 0;

/**
 * Test seam: when set, `executeNodeOnce` returns a `failed` row with this
 * error message instead of the default `succeeded` synthesis. Lets the E2E
 * `Failed` UI rendering path be exercised end-to-end (review note C-4).
 *
 * Production builds never reach this branch because the toggle endpoint
 * (`/api/_test/runtime`) is itself gated on `RALPH_WEB_TEST_SEED=1` AND
 * `NODE_ENV !== 'production'` — see the endpoint handler.
 */
let TEST_NODE_FORCED_FAILURE_MESSAGE: string | null = null;

/**
 * Build a synthetic run id. Production deployments will swap this for a
 * UUID/ULID/snowflake — all of which match the loose `RUN_ID_RE` brand
 * constraint, so the only contract this helper has is "monotonic + unique
 * within a process".
 */
function nextRunId(): string {
  SEQ += 1;
  // `web-` prefix tags ids minted by this in-memory adapter so a future
  // operator looking at logs can tell them apart from CLI-issued ids
  // (which use the runtime's own id scheme).
  return `web-${Date.now()}-${SEQ}`;
}

/**
 * Module-scoped singleton instance. Built lazily on first access so module
 * load is cheap and unit tests that import the file purely for its types
 * (e.g. `RuntimeStore`) do not pay the construction cost. The factory
 * function is intentionally pure — it dereferences the module-level mutable
 * state on every call — so a future refactor that closes over per-instance
 * state will not silently change observable semantics for test seams that
 * still mutate the module-level vars.
 *
 * Review note M3: previously `createInMemoryRuntimeStore()` minted a fresh
 * adapter object on every call but every adapter shared the same module-
 * level state. That made the factory's per-call signature lie about the
 * lifecycle. Routing all callers through one accessor makes the
 * "process-singleton" semantics explicit; if we ever want true
 * per-instance state, the change becomes a single-file refactor instead of
 * a silent contract drift.
 */
let SINGLETON: RuntimeStore | null = null;

function buildRuntimeStore(): RuntimeStore {
  return {
    async available() {
      return AVAILABLE;
    },
    async enqueue(workflowId, _document) {
      if (!AVAILABLE) return { kind: 'unavailable' };
      const row: StartedRunRow = {
        id: nextRunId(),
        workflowId,
        startedAt: Date.now(),
      };
      QUEUE.push(row);
      return { kind: 'enqueued', row };
    },
    async executeNodeOnce(nodeId, nodeType, nodeBody, inputs) {
      // Scenario invariant 1 (test results never persist): this stub
      // synthesises a deterministic `NodeTestResultRow` from the inputs and
      // does NOT push it onto `QUEUE` / `STOP_REQUESTS` / any other module
      // state. A future production runtime will replace this with a real
      // single-node executor — that implementation must preserve the same
      // "no persistent state mutation" contract.
      //
      // Scenario invariant 2 (no YAML mutation): this method receives the
      // node body by value and never calls the workflow file repository, so
      // there is no way for it to write back to disk.
      if (!AVAILABLE) return { kind: 'unavailable' };

      // Synthesise an `output` payload from the inputs so the caller has
      // *something* to display in the right-pane test-result view. This is
      // intentionally simple — the real runtime will run shell commands /
      // template evaluation / etc. — but it gives the UI a concrete success
      // payload to render. The output mirrors `set:` semantics: a JSON
      // pretty-print of the merged input/body keys.
      const merged: Record<string, unknown> = {};
      if (nodeType === 'set') {
        const setRaw = nodeBody[nodeType];
        if (
          setRaw !== null &&
          typeof setRaw === 'object' &&
          !Array.isArray(setRaw)
        ) {
          for (const [k, v] of Object.entries(setRaw as Record<string, unknown>)) {
            merged[k] = v;
          }
        }
      }
      for (const [k, v] of Object.entries(inputs)) {
        merged[k] = v;
      }

      const output = JSON.stringify(merged);
      // Hard-coded zero duration is acceptable for the in-memory stub: every
      // call resolves synchronously. A future async runtime would wrap the
      // execution in `performance.now()` deltas instead.
      //
      // Test seam (review C-4): when the operator has flipped
      // `TEST_NODE_FORCED_FAILURE_MESSAGE`, surface the result as `failed`
      // with the supplied error message so the UI's `failed` rendering
      // branch can be exercised end-to-end. Production code paths are
      // unaffected because the seam is only mutable through the
      // `/api/_test/runtime` endpoint which is gated on
      // `RALPH_WEB_TEST_SEED=1` AND `NODE_ENV !== 'production'`.
      if (TEST_NODE_FORCED_FAILURE_MESSAGE !== null) {
        const row: NodeTestResultRow = {
          nodeId,
          status: 'failed',
          // A failed test still echoes the synthesized output so users see
          // the partial state on which the failure occurred.
          output: output === '{}' ? null : output,
          errorMessage: TEST_NODE_FORCED_FAILURE_MESSAGE,
          logExcerpt: `executed node "${nodeId}" of type "${nodeType}" (forced failure)`,
          durationMs: 0,
        };
        return { kind: 'executed', row };
      }
      const row: NodeTestResultRow = {
        nodeId,
        status: 'succeeded',
        output: output === '{}' ? null : output,
        errorMessage: null,
        logExcerpt: `executed node "${nodeId}" of type "${nodeType}"`,
        durationMs: 0,
      };
      return { kind: 'executed', row };
    },
    async requestStop(runId) {
      // Scenario invariant 2: the in-memory adapter records the request and
      // echoes back the receipt timestamp. Actual `Cancelled` transition is
      // observed via the read-run-detail path; this stub does not mutate any
      // run row so the existing detail seeding stays the source of truth for
      // observed state in tests.
      //
      // Idempotency (scenario invariant 5): the adapter does NOT deduplicate
      // — repeated calls append distinct receipt rows with new
      // `requestedAt` timestamps. Callers (and the workflow layer) are free
      // to issue duplicate requests; the contract is "no error and a new
      // receipt" not "merge into the existing receipt".
      if (!AVAILABLE) return { kind: 'unavailable' };
      const row: StopAcceptedRow = {
        id: runId,
        requestedAt: Date.now(),
      };
      STOP_REQUESTS.push(row);
      return { kind: 'accepted', row };
    },
  };
}

/**
 * Return the process-wide in-memory runtime store. Always the same
 * instance across calls within a single Node process — this matches the
 * actual lifecycle of the underlying state arrays (`QUEUE`,
 * `STOP_REQUESTS`, `AVAILABLE`, `SEQ`) which are module-level and shared
 * across all callers.
 *
 * The accessor is named `createInMemoryRuntimeStore` rather than
 * `getInMemoryRuntimeStore` for backwards compatibility with existing
 * callers in `repos.ts`; the "create" verb is a misnomer (it just
 * returns the singleton) but renaming touches every wiring site without
 * any runtime benefit.
 */
export function createInMemoryRuntimeStore(): RuntimeStore {
  if (SINGLETON === null) {
    SINGLETON = buildRuntimeStore();
  }
  return SINGLETON;
}

/**
 * Test seam: drain the in-memory queue and return its contents. Mirrors the
 * `_appendRunRowForTesting` / `_clearRunStoreForTesting` helpers in
 * `runs.ts` so vitest unit tests can assert dispatch happened without
 * importing the queue array directly.
 */
export function _drainRuntimeQueueForTesting(): StartedRunRow[] {
  const snapshot = [...QUEUE];
  QUEUE.length = 0;
  return snapshot;
}

/**
 * Test seam: drain the in-memory stop-request queue and return its contents.
 * Mirrors `_drainRuntimeQueueForTesting` so vitest unit / E2E tests can
 * assert that stop requests were forwarded to the adapter without importing
 * the array directly.
 */
export function _drainStopRequestsForTesting(): StopAcceptedRow[] {
  const snapshot = [...STOP_REQUESTS];
  STOP_REQUESTS.length = 0;
  return snapshot;
}

/**
 * Test seam: toggle runtime availability so the `RuntimeUnavailable` path
 * can be exercised end-to-end without spinning up a fake daemon.
 */
export function _setRuntimeAvailableForTesting(available: boolean): void {
  AVAILABLE = available;
}

/**
 * Test seam: force the next `executeNodeOnce` calls to surface as `failed`
 * with the supplied error message. Pass `null` to revert to default
 * `succeeded` synthesis. Used by the E2E test that exercises the UI's
 * `failed` rendering branch (review note C-4).
 */
export function _setTestNodeForcedFailureForTesting(
  message: string | null,
): void {
  TEST_NODE_FORCED_FAILURE_MESSAGE = message;
}

/**
 * Test seam: reset all module-level state. Used by unit tests that share
 * the module instance across cases.
 *
 * The cached singleton is intentionally NOT discarded here: the adapter
 * object only references module-level state, so reusing the same instance
 * across tests is safe and keeps any captured references inside tests
 * pointing at a working store.
 */
export function _resetRuntimeStoreForTesting(): void {
  QUEUE.length = 0;
  STOP_REQUESTS.length = 0;
  AVAILABLE = true;
  SEQ = 0;
  TEST_NODE_FORCED_FAILURE_MESSAGE = null;
}
