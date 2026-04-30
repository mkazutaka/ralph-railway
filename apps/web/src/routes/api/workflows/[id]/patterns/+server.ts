import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  makeInsertPatternHelpers,
  makePatternTemplateRepository,
  makeWorkflowFileRepository,
} from '$lib/server/repos';
import { insertPatternWorkflow } from '$features/workflow-editor/workflows/insertPatternWorkflow';
import {
  toInsertPatternFailureContext,
  toInsertedPatternDto,
} from '$features/workflow-editor/entities/dto';
import { handleInsertPatternFailure } from '$features/workflow-editor/lib/insertPatternRoute';
import {
  parsePatternId,
  parseWorkflowParam,
} from '$features/workflow-editor/lib/routeHelpers';

/**
 * POST /api/workflows/:id/patterns  { patternId: string }
 *
 * Insert a showcase pattern into the workflow YAML file. Maps the workflow's
 * sum-type output to HTTP status codes via `handleInsertPatternFailure`;
 * never leaks internal stack traces.
 *
 * This REST surface is retained even though the in-app picker uses the
 * `?/insertPattern` form action instead — the Playwright integration tests
 * in `e2e/insert-pattern.api.spec.ts` exercise registry / receive-set
 * consistency through this endpoint, and external integrators (CLI tools,
 * scripts) that don't run a browser need a non-form transport. Removing the
 * route would silently break those callers.
 */
// Allowed Content-Type values for the JSON body (review note M-1). Browsers
// can issue "simple" CORS requests with `text/plain` or
// `application/x-www-form-urlencoded` *without* triggering a preflight, which
// means a cross-origin page in the developer's browser could otherwise sneak
// a JSON-shaped body past us as `text/plain`. Restricting to
// `application/json` (which always triggers a preflight) means a malicious
// origin must clear the browser's CORS check before we even see the request.
const ALLOWED_POST_CONTENT_TYPES = new Set(['application/json']);

export const POST: RequestHandler = async ({ params, request }) => {
  // SECURITY (review note M-1): pin Content-Type to application/json. This is
  // a non-simple media type per the Fetch spec, so cross-origin browser
  // requests *must* preflight and our `hooks.server.ts` Origin check fires
  // before the actual POST body lands here. Without this allowlist, a
  // malicious page could issue a `simple request` with `text/plain` and
  // bypass the preflight entirely.
  const contentType = (request.headers.get('content-type') ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
  if (!ALLOWED_POST_CONTENT_TYPES.has(contentType)) {
    throw error(415, 'content-type must be application/json');
  }

  let body: { patternId?: unknown };
  try {
    body = (await request.json()) as { patternId?: unknown };
  } catch {
    throw error(400, 'invalid JSON body');
  }
  if (typeof body.patternId !== 'string') {
    throw error(400, 'patternId is required');
  }

  const workflowId = parseWorkflowParam(params.id);
  const patternId = parsePatternId(body.patternId);

  const fileRepo = makeWorkflowFileRepository();
  const patternRepo = makePatternTemplateRepository();
  const helpers = makeInsertPatternHelpers();

  const result = await insertPatternWorkflow(
    { workflowId, patternId },
    {
      readWorkflowFile: fileRepo.readWorkflowFile,
      writeWorkflowFile: fileRepo.writeWorkflowFile,
      loadPatternTemplate: patternRepo.loadPatternTemplate,
      ...helpers,
    },
  );

  if (result.kind === 'patternInserted') {
    // 200 (not 201): this endpoint mutates the existing workflow file rather
    // than creating a new resource at a new URL. The "Location" of the
    // updated YAML is the same `/api/workflows/:id` the caller already
    // knows; clients invalidate via that URL after the call. See review
    // note Minor 3 — keep 200 explicitly to avoid breaking integrators.
    return json(toInsertedPatternDto(result.result), { status: 200 });
  }

  // Non-success branches go through the shared mapping so REST and form
  // action stay in lockstep. The failure context is built via the DTO
  // helper (review note Minor 2) so de-branding stays in `entities/dto.ts`.
  const failure = handleInsertPatternFailure(
    result,
    toInsertPatternFailureContext(workflowId, patternId),
  );
  throw error(failure.status, failure.message);
};
