// Client-side API helpers for the workflow editor.
//
// Encapsulates `fetch` against the SvelteKit REST endpoints so page
// components stay free of parsing / status-code branching. Each helper
// returns a discriminated `Result` rather than throwing for expected failures
// — exceptions are reserved for true network/runtime errors.
//
// NOTE: pattern insertion is intentionally NOT exposed here. The picker
// component drives `?/insertPattern` directly via `<form use:enhance>` so we
// keep SvelteKit's CSRF protection in the canonical form-encoded path and
// gain progressive enhancement for free (review note M-1). Adding a `fetch`
// wrapper for the same action would silently bypass the CSRF check (it lives
// on `application/x-www-form-urlencoded` / `multipart/form-data` request
// bodies, but a fetch-based action call cannot guarantee that without
// re-implementing form serialisation).

export type SaveWorkflowResult =
  | { ok: true }
  | { ok: false; kind: 'cancelled' }
  | { ok: false; kind: 'failed'; status: number; message: string };

export type CreateWorkflowResult =
  | { ok: true; id: string }
  | { ok: false; kind: 'cancelled' }
  | { ok: false; kind: 'failed'; status: number; message: string };

/**
 * Maximum YAML buffer size accepted by the server (`PUT /api/workflows/:id`
 * enforces 256 KiB). Mirrored client-side so we can short-circuit oversize
 * saves without a network round-trip.
 */
export const MAX_YAML_BYTES = 256 * 1024;

/**
 * Persist the current YAML buffer for `workflowId`. The server enforces the
 * canonical state — callers should re-fetch via `invalidateAll()` on success.
 */
export async function saveWorkflow(
  workflowId: string,
  yaml: string,
  options: { signal?: AbortSignal } = {},
): Promise<SaveWorkflowResult> {
  let res: Response;
  try {
    res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/yaml' },
      body: yaml,
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, kind: 'cancelled' };
    }
    return {
      ok: false,
      kind: 'failed',
      status: 0,
      message: e instanceof Error ? e.message : 'network error',
    };
  }
  if (res.ok) return { ok: true };
  return {
    ok: false,
    kind: 'failed',
    status: res.status,
    message: mapSaveHttpStatus(res.status),
  };
}

/**
 * Create a new workflow via `POST /api/workflows`. Returns a discriminated
 * `Result` with the same shape as `saveWorkflow` so call
 * sites get a single error-handling path instead of bespoke `fetch` parsing.
 */
export async function createWorkflow(
  id: string,
  yaml: string,
  options: { signal?: AbortSignal } = {},
): Promise<CreateWorkflowResult> {
  let res: Response;
  try {
    res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, yaml }),
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, kind: 'cancelled' };
    }
    return {
      ok: false,
      kind: 'failed',
      status: 0,
      message: e instanceof Error ? e.message : 'network error',
    };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: body.id ?? id };
  }
  // The server uses `throw error(status, message)` which serialises to
  // `{ message }`. Fall back to a generic per-status mapping so the user gets
  // something more helpful than `HTTP 500` even when the body is missing.
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return {
    ok: false,
    kind: 'failed',
    status: res.status,
    message: body.message ?? mapCreateHttpStatus(res.status),
  };
}

/**
 * Map a non-success HTTP status from `POST /api/workflows` to a user-facing
 * message.
 */
export function mapCreateHttpStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid workflow id or YAML';
    case 404:
      return 'workflow create endpoint is disabled';
    // 409 is returned when the create-only path detects an existing
    // workflow with the same id (review note M-3). Surface a user-facing
    // hint so a typo in the new-workflow form is recoverable without
    // having to read the network panel.
    case 409:
      return 'workflow with this id already exists';
    case 413:
      return 'workflow YAML is too large';
    case 415:
      return 'unsupported content type';
    case 422:
      return 'workflow YAML is invalid';
    case 500:
    case 502:
    case 503:
      return 'server error while creating';
    default:
      return `create failed (HTTP ${status})`;
  }
}

/**
 * Map a non-success HTTP status from the save endpoint to a user-facing
 * message. Mirrors the spirit of `mapInsertPatternFailure` so the editor
 * surfaces something more helpful than `HTTP 500`.
 *
 * NOTE: the save endpoint deliberately does *not* return 422 for unparseable
 * YAML — the save-workflow scenario explicitly preserves invalid buffers so
 * the user does not lose mid-edit work (invariant 2). A 422 from this
 * endpoint therefore signals a future extension and falls through to the
 * default branch.
 */
export function mapSaveHttpStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid workflow id';
    case 404:
      return 'workflow not found';
    case 413:
      return 'workflow YAML is too large';
    case 415:
      return 'unsupported content type';
    case 500:
    case 502:
    case 503:
      return 'server error while saving';
    default:
      return `save failed (HTTP ${status})`;
  }
}
