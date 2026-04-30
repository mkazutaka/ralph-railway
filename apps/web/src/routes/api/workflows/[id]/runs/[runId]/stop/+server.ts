import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  makeRunRepository,
  makeRuntimeRepository,
} from '$lib/server/repos';
import { stopRunWorkflow } from '$features/workflow-editor/workflows/stopRunWorkflow';
import { toStopAcceptedDto } from '$features/workflow-editor/entities/dto';
import {
  parseRunIdParam,
  parseWorkflowParam,
} from '$features/workflow-editor/lib/routeHelpers';

/**
 * POST /api/workflows/:id/runs/:runId/stop
 *
 * Request that the runtime stop the identified Run. Implements the scenario in
 * `apps/web/docs/scenarios/workflow-editor/stop-run.md`.
 *
 *   202  → `StopAcceptedDto`. The runtime accepted the stop request but the
 *          eventual transition to `Cancelled` is observed via
 *          `GET /api/workflows/:id/runs/:runId` (scenario invariants 2 & 3:
 *          the call only guarantees receipt; final state is owned by the
 *          read-run-detail path).
 *   400  → invalid workflow id or run id (path-traversal / brand validation).
 *   404  → run with the given id does not exist (`runNotFound` from
 *          workflow), OR the run exists but does not belong to the workflow
 *          on the URL (cross-workflow isolation, scenario invariant 4 —
 *          enforced inside the workflow).
 *   409  → run is already in a terminal state (`succeeded` / `failed` /
 *          `cancelled`). 409 (Conflict) rather than 422 because the request
 *          itself was well-formed; the resource state simply prohibits the
 *          requested transition (scenario invariant 1: 既に終了状態の Run
 *          には停止要求を発行しない).
 *
 *          API CONTRACT: the response body's `message` is exactly
 *          `"run is already <status>"` where `<status>` is one of
 *          `succeeded` | `failed` | `cancelled` (the RunStatus enum's
 *          terminal members). Clients SHOULD treat the message as an
 *          opaque user-facing string; the structured information is the
 *          409 status code itself. The string is included verbatim from
 *          a server-side enum so it is safe to display, but is not part
 *          of the long-term machine-readable contract.
 *   503  → runtime is unreachable. Distinct from 409 because retrying once
 *          the runtime is back up will succeed — this is a transient
 *          infrastructure condition, not a state conflict.
 *
 * The route is mutating; the localhost guard / same-origin check / body
 * limit in `hooks.server.ts` apply. The endpoint takes no request body — the
 * `runId` and `workflowId` come from the URL path and are both forwarded to
 * the workflow as `StopRunInput`.
 *
 * AUTHN/AUTHZ: this route relies entirely on the localhost guard and
 * `RALPH_WEB_INGRESS_SECRET`-stamped reverse-proxy traffic for authn (see
 * `apps/web/src/hooks.server.ts` and the scenario's "前提" note). There is no
 * per-user identity in this domain today, so production deployments MUST
 * front this endpoint with an authenticating reverse proxy that has already
 * validated the requesting user. Cross-workflow isolation (invariant 4) is
 * enforced inside `stopRunWorkflow` and protects against probing run ids
 * across workflows but is NOT a substitute for caller authentication.
 *
 * Status code choice — 202 vs 204:
 *   The scenario's invariants 2 & 3 (実行停止は非同期; 実際の Cancelled は
 *   別ワークフローで観測) make 202 the right code: we have *accepted* the
 *   request for processing but completion is reported via a different
 *   endpoint. 204 (No Content) would be wrong here because we DO carry a
 *   payload (`StopAcceptedDto`) that callers may want to log or correlate
 *   with subsequent state polls.
 */
export const POST: RequestHandler = async ({ params }) => {
  const workflowId = parseWorkflowParam(params.id);
  const runId = parseRunIdParam(params.runId);

  const runRepo = makeRunRepository();
  const runtimeRepo = makeRuntimeRepository();

  // Cross-workflow isolation lives inside the workflow itself
  // (scenario invariant 4 / review notes M1 + L3): we hand the workflow
  // both the runId AND the workflowId asserted by the URL, and the
  // workflow returns `runNotFound` if the loaded detail's workflowId
  // does not match. This collapses the previous "peek then re-read"
  // pattern into a single repository call and keeps the isolation check
  // expressed as a workflow obligation rather than a route-layer bolt-on.
  const result = await stopRunWorkflow(
    { runId, workflowId },
    {
      findRun: runRepo.findRunDetail,
      requestRunStop: runtimeRepo.requestRunStop,
    },
  );

  // Exhaustive switch (mirrors the sibling `runs` POST handler): TypeScript
  // will flag a future addition to `StopRunOutput` that this route forgets
  // to handle.
  switch (result.kind) {
    case 'stopRequested':
      // 202 (Accepted) is the canonical "your request will be processed
      // asynchronously" response. `cache-control: no-store` keeps reverse
      // proxies from echoing a stale receipt to a subsequent stop request.
      return json(toStopAcceptedDto(result.stop), {
        status: 202,
        headers: { 'cache-control': 'no-store' },
      });
    case 'runNotFound':
      throw error(404, 'run not found');
    case 'runAlreadyTerminal':
      // 409 Conflict (not 422): the request shape is fine; the resource is
      // simply in a state that prohibits the requested transition. Echo the
      // observed terminal status so the UI can show "run already <status>"
      // rather than a generic message — `result.status` is one of the
      // RunStatus enum values (never user-supplied), so embedding it is
      // safe. See the JSDoc above for the message-format contract.
      throw error(409, `run is already ${result.status}`);
    case 'runtimeUnavailable':
      // 503 (not 500) so retry-aware clients back off and retry instead
      // of treating this as a bug in their request.
      throw error(503, 'workflow runtime is unavailable');
  }
};
