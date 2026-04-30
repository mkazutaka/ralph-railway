import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  makeRunRepository,
  makeRuntimeRepository,
  makeStartRunHelpers,
  makeWorkflowFileRepository,
} from '$lib/server/repos';
import { listRecentRunsWorkflow } from '$features/workflow-editor/workflows/listRecentRunsWorkflow';
import { startRunWorkflow } from '$features/workflow-editor/workflows/startRunWorkflow';
import {
  toRunSummaryDto,
  toStartedRunDto,
} from '$features/workflow-editor/entities/dto';
import {
  parseWorkflowParam,
  safeParseRecentRunsLimit,
} from '$features/workflow-editor/lib/routeHelpers';

/**
 * GET /api/workflows/:id/runs?limit=N
 *
 * List recent runs for a workflow, newest first. Implements the scenario in
 * `apps/web/docs/scenarios/workflow-editor/list-recent-runs.md`.
 *
 *   200  → array of `RunSummaryDto`, possibly empty (invariant 3)
 *   400  → invalid workflow id or invalid `limit`
 *   404  → workflow does not exist (`workflowNotFound` from the workflow)
 *
 * The route is read-only; `hooks.server.ts` exempts safe methods from the
 * localhost guard and the same-origin check, but the workflow-id validator
 * still rejects path-traversal inputs.
 */
export const GET: RequestHandler = async ({ params, url }) => {
  const workflowId = parseWorkflowParam(params.id);

  // `?limit=` is optional; missing → default. Invalid → 400 so a buggy
  // pagination control surfaces immediately instead of silently truncating.
  const parsedLimit = safeParseRecentRunsLimit(url.searchParams.get('limit'));
  if (!parsedLimit.ok) {
    throw error(400, parsedLimit.reason);
  }
  const limit = parsedLimit.value;

  const runRepo = makeRunRepository();
  const result = await listRecentRunsWorkflow(
    { workflowId, limit },
    {
      workflowExists: runRepo.workflowExists,
      findRecentRunsByWorkflow: runRepo.findRecentRunsByWorkflow,
    },
  );

  // Exhaustive switch (mirrors the DELETE handler in
  // `routes/api/workflows/[id]/+server.ts`): TypeScript will flag a future
  // addition to `ListRecentRunsOutput` that this route forgets to handle.
  switch (result.kind) {
    case 'runList':
      // `cache-control: no-store`: in-flight runs change state every few
      // seconds (pending → running → succeeded), so a caching reverse proxy
      // would happily serve a stale "Pending" view long after the run has
      // completed. The payload is small (20 rows × ~150B); the bandwidth
      // saving from caching does not justify the staleness risk.
      return json(result.runs.map(toRunSummaryDto), {
        headers: { 'cache-control': 'no-store' },
      });
    case 'workflowNotFound':
      throw error(404, 'workflow not found');
  }
};

/**
 * POST /api/workflows/:id/runs
 *
 * Dispatch the workflow identified by `:id` for asynchronous execution.
 * Implements the scenario in
 * `apps/web/docs/scenarios/workflow-editor/run-workflow.md`.
 *
 *   202  → `StartedRunDto` (the runtime accepted the run; progress is read
 *          via `GET /api/workflows/:id/runs/:runId`).
 *   400  → invalid workflow id (path-traversal / brand validation).
 *   404  → workflow file does not exist (`workflowNotFound` from workflow).
 *   422  → workflow YAML is syntactically broken or contains a runtime-
 *          unsupported node type. Both are user-recoverable validation
 *          failures: the file is fine on disk but the runtime cannot run
 *          it as written.
 *   503  → runtime is unreachable. Distinct from 422 because retrying the
 *          identical request once the runtime is back up will succeed —
 *          this is a transient infrastructure condition, not a content bug.
 *
 * The route is mutating; the localhost guard / same-origin check / body
 * limit in `hooks.server.ts` apply. We additionally expect the workflow
 * file to exist (`makeWorkflowFileRepository().readWorkflowFile`) — the
 * route never accepts request-supplied YAML, so there is no body to
 * validate beyond what the hook already enforces.
 *
 * Status code choice — 202 vs 201:
 *   The scenario's invariant 5 (実行開始は非同期) makes 202 the right code:
 *   we have *accepted* the request for processing but completion is
 *   reported via a different endpoint. 201 would imply the run resource
 *   has reached its final state, which it has not.
 */
export const POST: RequestHandler = async ({ params }) => {
  const workflowId = parseWorkflowParam(params.id);

  const fileRepo = makeWorkflowFileRepository();
  const runtimeRepo = makeRuntimeRepository();
  const helpers = makeStartRunHelpers();

  const result = await startRunWorkflow(
    { workflowId },
    {
      readWorkflowFile: fileRepo.readWorkflowFile,
      enqueueRun: runtimeRepo.enqueueRun,
      ...helpers,
    },
  );

  // Exhaustive switch (mirrors the GET handler above): TypeScript will
  // flag a future addition to `StartRunOutput` that this route forgets to
  // handle.
  switch (result.kind) {
    case 'runStarted':
      // 202 (Accepted) is the canonical "your request will be processed
      // asynchronously" response. `cache-control: no-store` keeps reverse
      // proxies from echoing a stale "started" payload to a subsequent
      // identical POST.
      return json(toStartedRunDto(result.run), {
        status: 202,
        headers: { 'cache-control': 'no-store' },
      });
    case 'workflowNotFound':
      throw error(404, 'workflow not found');
    case 'invalidYaml':
      // Forward the parser's structured reason: the YAML originated from
      // the user's own workflow file (we never accept request-body YAML
      // here), so echoing the parse error helps them locate the syntax
      // problem in the editor. SECURITY: `parseWorkflowYaml` does not
      // include user-supplied template strings in its reason, only the
      // structural error (`top-level \`do\` must be a list`, etc.), so
      // there is no path-disclosure risk.
      throw error(422, `workflow YAML is invalid: ${result.reason}`);
    case 'unsupportedNode':
      // Surface the offending node type so the user can edit it. The
      // node-type names are author-chosen YAML keys but they are also
      // the *runtime* DSL vocabulary (e.g. `fork`, `try`) — never
      // arbitrary user data — so embedding them in the response is safe.
      throw error(
        422,
        `workflow uses a runtime-unsupported node type: ${result.nodeType}`,
      );
    case 'runtimeUnavailable':
      // 503 (not 500) so retry-aware clients back off and retry instead
      // of treating this as a bug in the workflow file.
      throw error(503, 'workflow runtime is unavailable');
  }
};
