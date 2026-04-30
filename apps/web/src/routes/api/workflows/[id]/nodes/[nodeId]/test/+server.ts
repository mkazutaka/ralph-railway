import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  makeRuntimeRepository,
  makeTestNodeHelpers,
  makeWorkflowFileRepository,
} from '$lib/server/repos';
import { testNodeWorkflow } from '$features/workflow-editor/workflows/testNodeWorkflow';
import { toNodeTestResultDto } from '$features/workflow-editor/entities/dto';
import {
  parseNodeIdParam,
  parseWorkflowParam,
} from '$features/workflow-editor/lib/routeHelpers';

/**
 * POST /api/workflows/:id/nodes/:nodeId/test  { inputs?: object }
 *
 * Test-execute a single node in isolation against caller-supplied dummy
 * inputs. Implements the scenario in
 * `apps/web/docs/scenarios/workflow-editor/test-node.md`.
 *
 *   200  → `NodeTestResultDto` (status: succeeded | failed). The endpoint
 *          returns 200 even when the node ended in `failed` because that
 *          IS the test result the user asked for — a runtime failure is
 *          information, not an HTTP error.
 *   400  → invalid workflow id or node id (path-traversal / brand validation),
 *          OR invalid request body shape (missing / non-object `inputs`).
 *   404  → workflow file does not exist (`workflowNotFound`), OR node id
 *          does not exist in the workflow (`nodeNotFound`).
 *   415  → request Content-Type is not `application/json`. Mirrors the
 *          `insertPattern` route: a non-simple media type forces browsers
 *          to preflight, which lets the same-origin check in
 *          `hooks.server.ts` fire before the body lands here.
 *   422  → dummy input failed validation (`invalidInputs`). 422
 *          (Unprocessable Entity) rather than 400 because the request was
 *          syntactically well-formed; the semantic mismatch is between
 *          the inputs and the node's declared shape (scenario invariant 4:
 *          ダミー入力の型不一致は実行前に検出する).
 *   409  → node is structurally not testable (`nodeNotTestable`). 409
 *          (Conflict) because the resource state — the node's type —
 *          prohibits the requested operation; retrying with the same
 *          payload will keep failing until the workflow YAML is edited.
 *   503  → runtime is unreachable. Distinct from 422 because retrying once
 *          the runtime is back up will succeed — this is a transient
 *          infrastructure condition, not a client mistake.
 *
 * The route is mutating-shaped (POST) but does NOT mutate persistent
 * state (scenario invariants 1 & 2: no run history, no YAML write). POST is
 * still the correct verb because the request carries a body and the
 * operation is not safely retriable as a cache key — every call may produce
 * a fresh result given the same inputs (e.g. `run` nodes that touch external
 * state).
 *
 * AUTHN/AUTHZ: this route relies entirely on the localhost guard and
 * `RALPH_WEB_INGRESS_SECRET`-stamped reverse-proxy traffic for authn (see
 * `apps/web/src/hooks.server.ts`). There is no per-user identity in this
 * domain today, so production deployments MUST front this endpoint with an
 * authenticating reverse proxy that has already validated the requesting
 * user.
 */
const ALLOWED_POST_CONTENT_TYPES = new Set(['application/json']);

export const POST: RequestHandler = async ({ params, request }) => {
  // SECURITY: pin Content-Type to application/json. Mirrors the
  // `insertPattern` route — a `text/plain` body would otherwise be a
  // "simple request" per the Fetch spec and bypass the CORS preflight.
  const contentType = (request.headers.get('content-type') ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
  if (!ALLOWED_POST_CONTENT_TYPES.has(contentType)) {
    throw error(415, 'content-type must be application/json');
  }

  let body: { inputs?: unknown };
  try {
    body = (await request.json()) as { inputs?: unknown };
  } catch {
    throw error(400, 'invalid JSON body');
  }
  // The `inputs` field is optional — a node with no declared `with:` schema
  // is testable without any dummy inputs. When present, it MUST be a plain
  // object: arrays / primitives / null are not accepted because the workflow
  // contract types `DummyInputs` as `Record<string, unknown>`.
  let inputs: Record<string, unknown>;
  if (body.inputs === undefined || body.inputs === null) {
    inputs = {};
  } else if (
    typeof body.inputs === 'object' &&
    !Array.isArray(body.inputs)
  ) {
    inputs = body.inputs as Record<string, unknown>;
  } else {
    throw error(400, 'inputs must be an object');
  }

  const workflowId = parseWorkflowParam(params.id);
  const nodeId = parseNodeIdParam(params.nodeId);

  const fileRepo = makeWorkflowFileRepository();
  const runtimeRepo = makeRuntimeRepository();
  const helpers = makeTestNodeHelpers();

  const result = await testNodeWorkflow(
    { workflowId, nodeId, inputs },
    {
      readWorkflowFile: fileRepo.readWorkflowFile,
      executeNodeOnce: runtimeRepo.executeNodeOnce,
      ...helpers,
    },
  );

  // Exhaustive switch (mirrors the sibling `runs/[runId]/stop` handler):
  // TypeScript will flag a future addition to `TestNodeOutput` that this
  // route forgets to handle.
  switch (result.kind) {
    case 'nodeTested':
      // 200 (not 202): the test executed *synchronously* end-to-end; there
      // is no asynchronous follow-up endpoint. `cache-control: no-store`
      // because the result depends on `inputs` and may differ between
      // identical-looking calls if the underlying node touches external
      // state (e.g. a `run:` node).
      return json(toNodeTestResultDto(result.result), {
        status: 200,
        headers: { 'cache-control': 'no-store' },
      });
    case 'workflowNotFound':
      throw error(404, 'workflow not found');
    case 'nodeNotFound':
      throw error(404, 'node not found');
    case 'nodeNotTestable':
      // 409 Conflict: the request shape is fine; the resource state (this
      // node's type) prohibits the requested operation. Echo the offending
      // node-type when we have one so the UI can show "node type X cannot
      // be tested in isolation" rather than a generic message.
      throw error(
        409,
        result.nodeType.length > 0
          ? `node type "${result.nodeType}" is not testable`
          : 'node is not testable',
      );
    case 'invalidInputs':
      // 422 Unprocessable Entity (not 400): the request was well-formed JSON
      // and matched the schema; the semantic mismatch is between the inputs
      // and the node's declared `with:` shape. The `reason` is forwarded
      // verbatim because the inputs originated from the same UI session.
      throw error(422, result.reason);
    case 'runtimeUnavailable':
      // 503 (not 500) so retry-aware clients back off and retry instead
      // of treating this as a bug in their request.
      throw error(503, 'workflow runtime is unavailable');
  }
};
