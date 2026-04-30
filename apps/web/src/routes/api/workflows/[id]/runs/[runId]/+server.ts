import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { makeRunRepository } from '$lib/server/repos';
import { readRunDetailWorkflow } from '$features/workflow-editor/workflows/readRunDetailWorkflow';
import { toRunDetailDto } from '$features/workflow-editor/entities/dto';
import {
  parseRunIdParam,
  parseWorkflowParam,
} from '$features/workflow-editor/lib/routeHelpers';

/**
 * GET /api/workflows/:id/runs/:runId
 *
 * Read the full per-node detail for a single Run. Implements the scenario in
 * `apps/web/docs/scenarios/workflow-editor/read-run-detail.md`.
 *
 *   200  → `RunDetailDto` (may include in-flight nodes per invariant 1)
 *   400  → invalid workflow id or run id (path-traversal / brand validation)
 *   404  → run with the given id does not exist (`runNotFound` from workflow),
 *          OR the run exists but does not belong to the workflow on the URL
 *          (cross-workflow isolation; enforced inside the workflow itself —
 *           see `ReadRunDetailInput.workflowId`)
 *
 * The `:id` segment is parsed and forwarded to the workflow as
 * `workflowId`. The cross-workflow isolation check (a run id whose workflow
 * does not match the URL must be invisible to the caller) lives inside
 * `readRunDetailWorkflow` so that any future entry-point (form action, page
 * load, internal caller) automatically inherits the same guard. Mirrors the
 * sibling `stopRunWorkflow` which already takes `workflowId` as input for
 * the same reason.
 *
 * AUTHN/AUTHZ: identical to the sibling stop endpoint (see
 * `apps/web/src/routes/api/workflows/[id]/runs/[runId]/stop/+server.ts`).
 * GET is a `SAFE_METHOD` so `hooks.server.ts`'s ingress-secret /
 * localhost-only guards do NOT run on this path. The deployment expectation
 * is that read traffic is fronted by an authenticating reverse proxy; the
 * route itself reveals only `runNotFound` for any unaddressable run, so it
 * cannot be used as an existence oracle even in the absence of authn.
 *
 * The route is read-only (scenario invariant 4: 副作用を持たない); cache is
 * disabled because in-flight runs change state every few seconds and a
 * cached `Pending` view would mislead the user long after the run has
 * completed.
 */
export const GET: RequestHandler = async ({ params }) => {
  const workflowId = parseWorkflowParam(params.id);
  const runId = parseRunIdParam(params.runId);

  const runRepo = makeRunRepository();
  const result = await readRunDetailWorkflow(
    { runId, workflowId },
    { findRunDetail: runRepo.findRunDetail },
  );

  // Exhaustive switch (mirrors the sibling `runs` endpoint): TypeScript will
  // flag a future addition to `ReadRunDetailOutput` that this route forgets
  // to handle.
  switch (result.kind) {
    case 'runDetailRead':
      return json(toRunDetailDto(result.detail), {
        headers: { 'cache-control': 'no-store' },
      });
    case 'runNotFound':
      throw error(404, 'run not found');
  }
};
