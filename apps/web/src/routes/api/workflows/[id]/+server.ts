import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  makeSaveWorkflowHelpers,
  makeWorkflowFileRepository,
} from '$lib/server/repos';
import {
  asYamlSource,
  InvalidBrandedValueError,
} from '$features/workflow-editor/entities/types';
import { toSavedWorkflowDto } from '$features/workflow-editor/entities/dto';
import { saveWorkflowWorkflow } from '$features/workflow-editor/workflows/saveWorkflowWorkflow';
import { parseWorkflowParam } from '$features/workflow-editor/lib/routeHelpers';

// 256 KiB cap for inline YAML uploads. Mirrors the global hooks.server.ts
// limit; routes also enforce it to defend against missing/forged
// content-length headers.
const MAX_YAML_BYTES = 256 * 1024;

// Permitted Content-Type values for the PUT endpoint. We accept the two
// common YAML media types and `text/plain` (used by some tooling that has
// no notion of YAML); JSON or form-encoded bodies are rejected so a YAML
// file that happens to look like valid JSON cannot be silently shoved in.
const ALLOWED_PUT_CONTENT_TYPES = new Set([
  'text/yaml',
  'application/x-yaml',
  'application/yaml',
  'text/plain',
]);

export const GET: RequestHandler = async ({ params }) => {
  const id = parseWorkflowParam(params.id);
  const repo = makeWorkflowFileRepository();
  const result = await repo.readWorkflowFile(id);
  if (result.kind === 'notFound') throw error(404, 'workflow not found');
  // `no-store`: clients invalidate the editor view via `invalidateAll()` /
  // explicit refetch after mutations, but a caching reverse proxy would
  // serve a stale YAML to the next reader. The file is small (256 KiB cap)
  // so the lost cache hit is irrelevant compared to the consistency win.
  return new Response(result.yaml, {
    headers: { 'content-type': 'text/yaml', 'cache-control': 'no-store' },
  });
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const id = parseWorkflowParam(params.id);

  // Validate Content-Type before reading the body so a misdirected JSON or
  // multipart payload cannot slip through and be written verbatim. Strip
  // parameters (`; charset=utf-8`) before comparing. An empty / missing
  // header is rejected too (review note Minor 9): some HTTP libraries omit
  // Content-Type and we don't want to default to "text/yaml" by accident.
  const contentType = (request.headers.get('content-type') ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
  if (!contentType || !ALLOWED_PUT_CONTENT_TYPES.has(contentType)) {
    throw error(415, 'content-type must be text/yaml');
  }

  // Reject oversized bodies before allocating memory for them when the
  // client advertises the size honestly. `hooks.server.ts` already enforces
  // the same cap globally for non-safe methods, but keeping it here means
  // the route remains correct even if the hook is bypassed in tests.
  const advertisedLength = request.headers.get('content-length');
  if (advertisedLength) {
    const n = Number.parseInt(advertisedLength, 10);
    if (Number.isFinite(n) && n > MAX_YAML_BYTES) {
      throw error(413, 'workflow body exceeds maximum size');
    }
  }

  const body = await request.text();
  if (body.length > MAX_YAML_BYTES) {
    // Fallback for clients that omit / forge `content-length`. We still
    // pay the cost of receiving the body, but we refuse to write it.
    throw error(413, 'workflow body exceeds maximum size');
  }

  let yaml;
  try {
    yaml = asYamlSource(body);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) throw error(400, 'invalid yaml body');
    throw e;
  }

  // SAVE-WORKFLOW SCENARIO INVARIANT 2: 構文不正な YAML も保存可能.
  // We deliberately do NOT call `parseWorkflowYaml` here so the user's
  // editing buffer can be persisted verbatim — a half-typed workflow is a
  // recoverable state, and forcing the user to fix every syntax error before
  // saving would lose work on browser refresh. The previous behaviour (422
  // on parse error) was incompatible with this scenario; if a downstream
  // consumer (insert-pattern, run-workflow) needs a parseable document it
  // performs the validation itself.
  //
  // Delegate to the workflow so the scenario's flow (EnsureExists →
  // WriteContent) lives in one place and is unit-testable without spinning
  // up an HTTP server.
  const repo = makeWorkflowFileRepository();
  const helpers = makeSaveWorkflowHelpers();
  const result = await saveWorkflowWorkflow(
    { workflowId: id, yaml },
    {
      workflowFileExists: repo.workflowFileExists,
      writeWorkflowFile: repo.writeWorkflowFile,
      ...helpers,
    },
  );

  switch (result.kind) {
    case 'workflowSaved':
      // Use the entity → DTO converter so the de-branding boundary stays
      // explicit and the response shape is owned by `entities/dto.ts`.
      return json(toSavedWorkflowDto(result.saved));
    case 'notFound':
      // Save is overwrite-only (scenario invariant 1); creating a new file
      // is the create-workflow scenario's job.
      throw error(404, 'workflow not found');
    case 'invalidId':
      // Brand regex accepted the id but the lower-level store rejected it
      // (e.g. a future store implementation tightens the rules). Defence
      // in depth — log the structured reason but don't echo it to the
      // client (it can include the raw id).
      console.warn('[PUT /api/workflows/:id] store rejected id', {
        workflowId: id,
        reason: result.reason,
      });
      throw error(400, 'workflow id was rejected by the store');
    case 'storageFailure':
      // Genuine I/O failure (permission denied, disk full, ...). Log the
      // detail server-side and surface a generic 500 so we never leak the
      // underlying `errno` / filesystem path to the client.
      console.error('[PUT /api/workflows/:id] storage failure', {
        workflowId: id,
        reason: result.reason,
      });
      throw error(500, 'failed to save workflow');
  }
};

export const DELETE: RequestHandler = async ({ params }) => {
  const id = parseWorkflowParam(params.id);
  const repo = makeWorkflowFileRepository();
  const result = await repo.removeWorkflowFile(id);
  // Exhaustive switch (review note m-7): the previous `if (notFound)` form
  // implicitly assumed only the two known variants, so a future addition to
  // `RemoveWorkflowFileResult` would silently fall through to a 204. The
  // explicit `switch` lets TypeScript flag that case.
  switch (result.kind) {
    case 'removed':
      return new Response(null, { status: 204 });
    case 'notFound':
      throw error(404, 'workflow not found');
  }
};
