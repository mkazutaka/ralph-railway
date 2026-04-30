import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { BODY_LIMIT_BYTES } from '$lib/server/bodyLimit';
import {
  makeCreateWorkflowHelpers,
  makeListWorkflowsHelpers,
  makeWorkflowFileRepository,
} from '$lib/server/repos';
import {
  asWorkflowId,
  asYamlSource,
  InvalidBrandedValueError,
} from '$features/workflow-editor/entities/types';
import {
  toCreatedWorkflowDtoFromEntity,
  toWorkflowSummaryDto,
} from '$features/workflow-editor/entities/dto';
import { createWorkflowWorkflow } from '$features/workflow-editor/workflows/createWorkflowWorkflow';
import { listWorkflowsWorkflow } from '$features/workflow-editor/workflows/listWorkflowsWorkflow';

// Defence-in-depth (review note Major 4): the localhost guard in
// `hooks.server.ts` is the primary protection for this mutating endpoint, but
// CLAUDE.md requires *every* server route to enforce its own authorisation
// check rather than rely on a global hook. Operators that don't need to
// create new workflow files via this endpoint can disable it entirely with
// `RALPH_WEB_DISABLE_WORKFLOW_CREATE=true` so the route surface area shrinks.
const WORKFLOW_CREATE_DISABLED =
  process.env.RALPH_WEB_DISABLE_WORKFLOW_CREATE === 'true';

export const GET: RequestHandler = async () => {
  // Delegate to `listWorkflowsWorkflow` so the scenario's flow
  // (CollectWorkflowFiles → SummarizeEach with filename fallback) lives in
  // one place and is unit-testable without spinning up an HTTP server. The
  // route only owns the wiring and the entity → DTO de-branding.
  const fileRepo = makeWorkflowFileRepository();
  const helpers = makeListWorkflowsHelpers();
  const result = await listWorkflowsWorkflow({
    listWorkflowFiles: fileRepo.listWorkflowFiles,
    ...helpers,
  });
  return json(result.workflows.map(toWorkflowSummaryDto));
};

export const POST: RequestHandler = async ({ request }) => {
  if (WORKFLOW_CREATE_DISABLED) {
    // 404 (not 403) so disabled deployments don't leak the existence of the
    // route to a probe.
    throw error(404, 'not found');
  }
  // Error response format unified with the rest of the API surface
  // (review note M-1): every other 4xx in `routes/api/workflows/...` uses
  // SvelteKit's `throw error(status, message)`, which serialises to
  // `{ message: "..." }`. Returning `{ error: "..." }` here forced clients to
  // implement two parsers; we now match the standard envelope.
  // Defence-in-depth (review note M1): the hooks-level `Content-Length` cap
  // is bypassed by `Transfer-Encoding: chunked` requests that omit the
  // header. Read the body as text first so we can measure its actual byte
  // length and reject oversize payloads here, *before* `JSON.parse` materialises
  // them into memory. Uses the shared `BODY_LIMIT_BYTES` constant so the
  // route and hook stay in lockstep.
  let body: { id?: unknown; yaml?: unknown };
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > BODY_LIMIT_BYTES) {
      throw error(413, 'request body too large');
    }
    body = JSON.parse(raw) as { id?: unknown; yaml?: unknown };
  } catch (e) {
    // Re-throw SvelteKit `error()` results unchanged; only JSON.parse failures
    // collapse into the generic 400.
    if (e && typeof e === 'object' && 'status' in e) throw e;
    throw error(400, 'invalid JSON body');
  }
  if (typeof body.id !== 'string' || typeof body.yaml !== 'string') {
    throw error(400, 'id and yaml required as strings');
  }

  // step 1 (ValidateIdentifier in the scenario): the brand constructor is the
  // single source of truth for what counts as a valid workflow id. Failure
  // here surfaces as the scenario's `InvalidId` outcome (mapped to 400).
  let workflowId, yaml;
  try {
    workflowId = asWorkflowId(body.id);
    yaml = asYamlSource(body.yaml);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      // Branded validation message is intentionally generic ("invalid
      // WorkflowId: ...") and contains no caller-supplied data beyond the
      // input we just received, so it is safe to forward as the error message.
      throw error(400, e.message);
    }
    throw e;
  }

  // Delegate to the workflow so the scenario's flow (ValidateDocument →
  // EnsureUnique+PersistWorkflow) lives in one place and is unit-testable
  // without spinning up an HTTP server.
  const fileRepo = makeWorkflowFileRepository();
  const helpers = makeCreateWorkflowHelpers();
  const result = await createWorkflowWorkflow(
    { workflowId, yaml },
    {
      createWorkflowFile: fileRepo.createWorkflowFile,
      ...helpers,
    },
  );

  switch (result.kind) {
    case 'workflowCreated':
      // Use the entity → DTO converter so the de-branding boundary stays
      // explicit and the response shape is owned by `entities/dto.ts`.
      return json(toCreatedWorkflowDtoFromEntity(result.created), { status: 201 });
    case 'invalidYaml':
      // Surfacing a 422 with a generic message keeps user-supplied content out
      // of the error envelope (the parser's `reason` echoes part of the body).
      console.warn('[POST /api/workflows] invalid YAML rejected', {
        workflowId,
        reason: result.reason,
      });
      throw error(422, 'workflow YAML is invalid');
    case 'duplicateId':
      // 409 (not 400) so clients can distinguish "your input was malformed"
      // from "your input was well-formed but the resource already exists" —
      // the latter is what the create-only contract is meant to surface.
      throw error(409, 'workflow already exists');
    case 'persistFailed':
      // Lower-level store rejected the id even though our brand regex accepted
      // it. Treat as a 400 because the input is structurally bad; do not echo
      // the reason (it can include filesystem detail).
      // NOTE (review note N1): `result.reason` is sourced from
      // `InvalidWorkflowIdError` which echoes the raw input id (`invalid id:
      // ${id}`). Local server logs are fine, but if these are forwarded to a
      // shared log aggregator consider masking the id field first.
      console.warn('[POST /api/workflows] store rejected id', {
        workflowId,
        reason: result.reason,
      });
      throw error(400, 'workflow id was rejected by the store');
  }
};
