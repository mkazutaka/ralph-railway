// Client-side API helper for the "Start Run" scenario
// (`apps/web/docs/scenarios/workflow-editor/run-workflow.md`).
//
// Encapsulates `fetch` against `POST /api/workflows/:id/runs` so the
// `RunWorkflowButton` component stays free of parsing / status-code branching.
// Mirrors the contract established in `lib/api.ts` (`saveWorkflow` /
// `createWorkflow`): each helper returns a discriminated `Result` rather than
// throwing for expected failure modes, and a status-code → user-facing message
// helper is exported alongside so tests can assert exact copy.
//
// The route is mutating; `hooks.server.ts` allows same-origin POSTs without a
// dedicated CSRF token, so a fetch-based call from the editor page is the
// canonical path. Form-action wiring would also work but adds no value here:
// the page does not currently host a `<form>` for this action and the editor's
// remaining mutations (save / pattern insert) already split between fetch
// (save) and form-action (pattern insert) on grounds documented in
// `lib/api.ts`'s top-level note.
//
// SECURITY: the body is empty — the workflow id rides in the path and the YAML
// is read server-side from disk (scenario invariant 4: 「ワークフロー本体は実行
// 開始によって変更されない」). We never accept request-supplied YAML on this
// endpoint, so there is no payload validation to perform here.

import type { StartedRunDto, StopAcceptedDto } from '../entities/dto';

export type StartRunResult =
  | { ok: true; run: StartedRunDto }
  | { ok: false; kind: 'cancelled' }
  | { ok: false; kind: 'failed'; status: number; message: string };

export type StopRunResult =
  | { ok: true; stop: StopAcceptedDto }
  | { ok: false; kind: 'cancelled' }
  | { ok: false; kind: 'failed'; status: number; message: string };

/**
 * Dispatch the workflow identified by `workflowId` for asynchronous execution.
 *
 * On success the runtime has accepted the run (HTTP 202) and returned the run
 * id + `startedAt` timestamp; progress is read via the read-run-detail
 * scenario's separate endpoint.
 *
 * `options.signal` is forwarded to `fetch` so the caller can abort an
 * in-flight request when the component unmounts (the editor page reuses the
 * same component when switching between workflows).
 */
export async function startRun(
  workflowId: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<StartRunResult> {
  const fetcher = options.fetcher ?? fetch;
  let res: Response;
  try {
    res = await fetcher(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
      method: 'POST',
      // `application/json` (with empty body) keeps the request inside the
      // simple-CORS-safe set and aligns with `createWorkflow` so the same
      // hook-level body-limit and content-type guard rails apply.
      headers: { 'content-type': 'application/json' },
      body: '',
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
    // The endpoint returns the `StartedRunDto` shape (id, workflowId,
    // startedAt). We trust the server contract — the brand validation has
    // already happened in `buildStartedRunFromRow` before serialisation.
    const body = (await res.json().catch(() => null)) as StartedRunDto | null;
    if (body === null || typeof body.id !== 'string') {
      return {
        ok: false,
        kind: 'failed',
        status: res.status,
        message: 'unexpected server response',
      };
    }
    return { ok: true, run: body };
  }
  // Non-OK responses from the SvelteKit `error(...)` helper serialise to
  // `{ message }`. Forward the server's message when present (it carries
  // useful structured detail like "workflow YAML is invalid: <reason>") and
  // fall back to a generic per-status message so the user gets something
  // more helpful than `HTTP 500` even when the body is missing.
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return {
    ok: false,
    kind: 'failed',
    status: res.status,
    message: body.message ?? mapStartRunHttpStatus(res.status),
  };
}

/**
 * Map a non-success HTTP status from the start-run endpoint to a user-facing
 * fallback message. The endpoint's own `error(...)` envelope usually supplies
 * a more specific string (`'workflow YAML is invalid: ...'`,
 * `'workflow uses a runtime-unsupported node type: ...'`), so this helper is
 * only consulted when the response body is empty / unparseable.
 *
 * Status code semantics mirror the route handler in
 * `routes/api/workflows/[id]/runs/+server.ts`:
 *   400 → invalid workflow id (path-traversal / brand validation)
 *   404 → workflow file does not exist
 *   422 → YAML invalid OR uses runtime-unsupported node
 *   503 → workflow runtime unavailable (transient infra)
 */
export function mapStartRunHttpStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid workflow id';
    case 404:
      return 'workflow not found';
    case 413:
      return 'workflow YAML is too large';
    case 422:
      return 'workflow YAML is invalid or uses an unsupported node';
    case 500:
    case 502:
      return 'server error while starting run';
    case 503:
      return 'workflow runtime is unavailable';
    default:
      return `start run failed (HTTP ${status})`;
  }
}

/**
 * Request that the runtime stop the identified Run. Implements the client side
 * of the "Stop Run" scenario
 * (`apps/web/docs/scenarios/workflow-editor/stop-run.md`).
 *
 * The endpoint is asynchronous: HTTP 202 indicates the runtime accepted the
 * stop request, but the eventual transition to `Cancelled` is observed via
 * the read-run-detail endpoint (scenario invariants 2 & 3). Callers should
 * therefore refresh the run detail panel after success rather than treat the
 * `StopAcceptedDto` payload as the final state.
 *
 * `options.signal` is forwarded to `fetch` so a component unmount or a rapid
 * follow-up click can abort the previous request before kicking off a new
 * one (mirrors `startRun`).
 */
export async function stopRun(
  workflowId: string,
  runId: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<StopRunResult> {
  const fetcher = options.fetcher ?? fetch;
  let res: Response;
  try {
    res = await fetcher(
      `/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/stop`,
      {
        method: 'POST',
        // Empty body, `application/json` to keep the request inside the
        // simple-CORS-safe set and align with the other mutating endpoints
        // (`startRun`, `createWorkflow`).
        headers: { 'content-type': 'application/json' },
        body: '',
        signal: options.signal,
      },
    );
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
    const body = (await res.json().catch(() => null)) as StopAcceptedDto | null;
    if (body === null || typeof body.id !== 'string') {
      return {
        ok: false,
        kind: 'failed',
        status: res.status,
        message: 'unexpected server response',
      };
    }
    return { ok: true, stop: body };
  }
  // SvelteKit `error(...)` envelopes serialise to `{ message }`; forward the
  // server's message when present (it carries useful detail like
  // "run is already succeeded" for the 409 branch). Fall back to a per-status
  // message so the user always sees something more helpful than `HTTP 500`.
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return {
    ok: false,
    kind: 'failed',
    status: res.status,
    message: body.message ?? mapStopRunHttpStatus(res.status),
  };
}

/**
 * Map a non-success HTTP status from the stop-run endpoint to a user-facing
 * fallback message. The endpoint's own `error(...)` envelope usually supplies
 * a more specific string (`'run is already succeeded'`, etc.), so this helper
 * is only consulted when the response body is empty / unparseable.
 *
 * Status code semantics mirror the route handler in
 * `routes/api/workflows/[id]/runs/[runId]/stop/+server.ts`:
 *   400 → invalid workflow id or run id (path-traversal / brand validation)
 *   404 → run does not exist OR does not belong to the workflow on the URL
 *   409 → run is already in a terminal state (`runAlreadyTerminal`)
 *   503 → runtime is unreachable (transient infra)
 */
export function mapStopRunHttpStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid run or workflow id';
    case 404:
      return 'run not found';
    case 409:
      return 'run has already finished';
    case 500:
    case 502:
      return 'server error while stopping run';
    case 503:
      return 'workflow runtime is unavailable';
    default:
      return `stop run failed (HTTP ${status})`;
  }
}
