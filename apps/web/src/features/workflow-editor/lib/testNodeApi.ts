// Client-side API helper for the "Test Node" scenario
// (`apps/web/docs/scenarios/workflow-editor/test-node.md`).
//
// Encapsulates `fetch` against `POST /api/workflows/:id/nodes/:nodeId/test`
// so the `TestNodePanel` component stays free of parsing / status-code
// branching. Mirrors the contract established by `runApi.ts` (`startRun` /
// `stopRun`): each helper returns a discriminated `Result` rather than
// throwing for expected failure modes, and a status-code → user-facing
// message helper is exported alongside so tests can assert exact copy.
//
// SECURITY: the body is `{ inputs }` — a plain JSON object whose values are
// caller-supplied. The server validates the shape against the node's
// declared `with:` (scenario invariant 4) before invoking the runtime, so
// we forward the value verbatim from the UI here.

import type { NodeTestResultDto } from '../entities/dto';

export type TestNodeResult =
  | { ok: true; result: NodeTestResultDto }
  | { ok: false; kind: 'cancelled' }
  | { ok: false; kind: 'failed'; status: number; message: string };

/**
 * Test-execute a single node in isolation. Returns 200 even when the node
 * itself ended in `failed` because that IS the test result the user asked
 * for — a runtime-level failure is information, not an HTTP error. The
 * caller branches on the resulting `result.status` to render the success vs
 * failure presentation.
 *
 * `options.signal` is forwarded to `fetch` so the caller can abort an
 * in-flight request when the component unmounts or the user re-clicks the
 * trigger before the previous request lands (mirrors `startRun` / `stopRun`).
 */
export async function testNode(
  workflowId: string,
  nodeId: string,
  inputs: Record<string, unknown>,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<TestNodeResult> {
  const fetcher = options.fetcher ?? fetch;
  let res: Response;
  try {
    res = await fetcher(
      `/api/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/test`,
      {
        method: 'POST',
        // Pin Content-Type so the request matches the server's allow-list
        // and aligns with the other mutating endpoints (`startRun`, `stopRun`,
        // `createWorkflow`).
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs }),
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
    const body = (await res.json().catch(() => null)) as NodeTestResultDto | null;
    if (
      body === null ||
      typeof body.nodeId !== 'string' ||
      typeof body.status !== 'string'
    ) {
      return {
        ok: false,
        kind: 'failed',
        status: res.status,
        message: 'unexpected server response',
      };
    }
    return { ok: true, result: body };
  }
  // SvelteKit `error(...)` envelopes serialise to `{ message }`; forward the
  // server's message when present (it carries useful detail like
  // "missing required <field>" for the 422 branch). Fall back to a
  // per-status message so the user always sees something more helpful than
  // `HTTP 500`.
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return {
    ok: false,
    kind: 'failed',
    status: res.status,
    message: body.message ?? mapTestNodeHttpStatus(res.status),
  };
}

/**
 * Map a non-success HTTP status from the test-node endpoint to a user-facing
 * fallback message. The endpoint's own `error(...)` envelope usually supplies
 * a more specific string (e.g. `'node type "if" is not testable'` for the
 * 409 branch), so this helper is only consulted when the response body is
 * empty / unparseable.
 *
 * Status code semantics mirror the route handler in
 * `routes/api/workflows/[id]/nodes/[nodeId]/test/+server.ts`:
 *   400 → invalid workflow id, node id, or request body
 *   404 → workflow file does not exist OR node id not in workflow
 *   409 → node type cannot be tested in isolation (`nodeNotTestable`)
 *   415 → request Content-Type is not application/json
 *   422 → dummy inputs failed type/required validation (`invalidInputs`)
 *   503 → runtime is unreachable
 */
export function mapTestNodeHttpStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid request';
    case 404:
      return 'workflow or node not found';
    case 409:
      return 'this node cannot be tested in isolation';
    case 415:
      return 'unsupported request content-type';
    case 422:
      return 'dummy inputs are invalid';
    case 500:
    case 502:
      return 'server error while running test';
    case 503:
      return 'workflow runtime is unavailable';
    default:
      return `test failed (HTTP ${status})`;
  }
}
