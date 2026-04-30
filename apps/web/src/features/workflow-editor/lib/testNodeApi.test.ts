// Direct unit tests for the client-side adapter to
// `POST /api/workflows/:id/nodes/:nodeId/test`. The E2E suite covers the
// full network path, but the unit-level branches (server-supplied message
// passthrough, abort detection, malformed JSON, shape-validation failure,
// status-code → fallback message mapping) are easier to pin down here.
//
// The `fetcher` injection point on `testNode` lets us substitute a fake
// fetch function without monkey-patching `globalThis.fetch`.

import { describe, expect, it } from 'vitest';
import type { NodeTestResultDto } from '../entities/dto';
import { mapTestNodeHttpStatus, testNode } from './testNodeApi';

/**
 * Build a `Response`-like object that satisfies the surface area `testNode`
 * touches (`ok`, `status`, `json`). Using the global `Response` constructor
 * directly would be more faithful but it forces tests to JSON-encode
 * payloads that `testNode` then re-parses; a hand-rolled stub keeps the
 * intent ("server returned this body") visible at the call site.
 */
function makeFakeResponse(init: {
  status: number;
  body?: unknown;
  /** Set to true to make `.json()` throw, mimicking unparseable payloads. */
  jsonThrows?: boolean;
}): Response {
  const ok = init.status >= 200 && init.status < 300;
  return {
    ok,
    status: init.status,
    json: () =>
      init.jsonThrows
        ? Promise.reject(new SyntaxError('Unexpected token'))
        : Promise.resolve(init.body),
  } as unknown as Response;
}

function makeSuccessDto(
  overrides: Partial<NodeTestResultDto> = {},
): NodeTestResultDto {
  return {
    nodeId: 'greet',
    status: 'succeeded',
    output: 'hello',
    errorMessage: null,
    logExcerpt: 'executed node "greet"',
    durationMs: 12,
    ...overrides,
  };
}

describe('testNode (success path)', () => {
  it('returns ok=true with the parsed result on a 200 response', async () => {
    const dto = makeSuccessDto();
    const fetcher: typeof fetch = async () =>
      makeFakeResponse({ status: 200, body: dto });

    const r = await testNode('a.yaml', 'greet', { name: 'world' }, { fetcher });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toEqual(dto);
  });

  it('encodes the workflow id and node id in the URL path', async () => {
    let observedUrl: string | undefined;
    const fetcher: typeof fetch = async (url) => {
      observedUrl = String(url);
      return makeFakeResponse({ status: 200, body: makeSuccessDto() });
    };
    await testNode('weird name.yaml', 'a/b', {}, { fetcher });
    // `encodeURIComponent` escapes both spaces (%20) and slashes (%2F).
    expect(observedUrl).toBe(
      '/api/workflows/weird%20name.yaml/nodes/a%2Fb/test',
    );
  });

  it('sends the inputs payload as a JSON-serialised body', async () => {
    let observedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      observedInit = init;
      return makeFakeResponse({ status: 200, body: makeSuccessDto() });
    };
    await testNode('a.yaml', 'greet', { name: 'world', count: 7 }, { fetcher });
    expect(observedInit?.method).toBe('POST');
    expect(
      new Headers(observedInit?.headers as HeadersInit).get('content-type'),
    ).toBe('application/json');
    expect(observedInit?.body).toBe(
      JSON.stringify({ inputs: { name: 'world', count: 7 } }),
    );
  });

  it('forwards the AbortSignal to the underlying fetch call', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return makeFakeResponse({ status: 200, body: makeSuccessDto() });
    };
    const ac = new AbortController();
    await testNode('a.yaml', 'greet', {}, { fetcher, signal: ac.signal });
    expect(observedSignal).toBe(ac.signal);
  });
});

describe('testNode (server-error branches)', () => {
  it('forwards the server-supplied message verbatim on a 422 (invalid inputs)', async () => {
    // The server wraps SvelteKit `error(...)` into `{ message }`. The
    // adapter MUST surface that string verbatim — the user-actionable
    // detail (e.g. "missing required working_directory") only lives there.
    const fetcher: typeof fetch = async () =>
      makeFakeResponse({
        status: 422,
        body: { message: 'missing required working_directory' },
      });
    const r = await testNode('a.yaml', 'greet', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('failed');
    if (r.kind !== 'failed') return;
    expect(r.status).toBe(422);
    expect(r.message).toBe('missing required working_directory');
  });

  it('forwards the server-supplied message on a 409 (not testable)', async () => {
    const fetcher: typeof fetch = async () =>
      makeFakeResponse({
        status: 409,
        body: { message: 'node type "if" is not testable' },
      });
    const r = await testNode('a.yaml', 'guarded', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'failed') return;
    expect(r.message).toBe('node type "if" is not testable');
  });

  it('falls back to the status-code fallback when the server message is missing', async () => {
    // An empty body (e.g. the server returned just a status) means the
    // adapter must consult `mapTestNodeHttpStatus` so the user always sees
    // something more helpful than a bare HTTP code.
    const fetcher: typeof fetch = async () =>
      makeFakeResponse({ status: 503, body: {} });
    const r = await testNode('a.yaml', 'greet', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'failed') return;
    expect(r.status).toBe(503);
    expect(r.message).toBe('workflow runtime is unavailable');
  });

  it('falls back to the status-code message when the body is unparseable JSON', async () => {
    // If `.json()` throws (e.g. the server returned text/html or the
    // payload was truncated mid-stream), the adapter catches it and uses
    // the fallback. We verify both the status passthrough and the message
    // come from `mapTestNodeHttpStatus`.
    const fetcher: typeof fetch = async () =>
      makeFakeResponse({ status: 500, jsonThrows: true });
    const r = await testNode('a.yaml', 'greet', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'failed') return;
    expect(r.status).toBe(500);
    expect(r.message).toBe('server error while running test');
  });
});

describe('testNode (success-shape validation)', () => {
  it('returns failed with "unexpected server response" when the JSON body is null', async () => {
    // `.json()` returning `null` (e.g. the server wrote a literal `null`
    // body for a 200 response) is a contract violation we should not let
    // through — the result block in the UI assumes both `nodeId` and
    // `status` are non-null strings.
    const fetcher: typeof fetch = async () =>
      makeFakeResponse({ status: 200, body: null });
    const r = await testNode('a.yaml', 'greet', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'failed') return;
    expect(r.message).toBe('unexpected server response');
  });

  it('returns failed when the body is missing required fields', async () => {
    // A 200 with only `{ status: "succeeded" }` (no `nodeId`) is a server
    // bug — the adapter rejects it rather than passing a malformed dto on
    // to the panel.
    const fetcher: typeof fetch = async () =>
      makeFakeResponse({ status: 200, body: { status: 'succeeded' } });
    const r = await testNode('a.yaml', 'greet', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'failed') return;
    expect(r.message).toBe('unexpected server response');
  });

  it('returns failed when the body has the wrong field types', async () => {
    // Defensive against a regressed server that emitted `nodeId: 42`. The
    // adapter only checks the discriminating fields; richer shape
    // validation belongs to the entity layer (`NodeTestResult`).
    const fetcher: typeof fetch = async () =>
      makeFakeResponse({
        status: 200,
        body: { nodeId: 42, status: 'succeeded' },
      });
    const r = await testNode('a.yaml', 'greet', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'failed') return;
    expect(r.message).toBe('unexpected server response');
  });

  it('returns failed when the body has an unparseable success payload', async () => {
    // 200 + `.json()` throwing means the server reported success but the
    // body was malformed. Surface that as a contract violation rather than
    // a network error.
    const fetcher: typeof fetch = async () =>
      makeFakeResponse({ status: 200, jsonThrows: true });
    const r = await testNode('a.yaml', 'greet', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'failed') return;
    expect(r.message).toBe('unexpected server response');
  });
});

describe('testNode (transport failure branches)', () => {
  it('returns kind="cancelled" when the underlying fetch throws AbortError', async () => {
    const fetcher: typeof fetch = async () => {
      throw new DOMException('aborted', 'AbortError');
    };
    const r = await testNode('a.yaml', 'greet', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('cancelled');
  });

  it('returns kind="failed" with the network-error message for non-abort errors', async () => {
    const fetcher: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const r = await testNode('a.yaml', 'greet', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'failed') return;
    expect(r.status).toBe(0);
    expect(r.message).toBe('Failed to fetch');
  });

  it('uses the generic fallback message when the thrown value is not an Error', async () => {
    const fetcher: typeof fetch = async () => {
      // Simulate a runtime that throws a non-Error value (e.g. a string).
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'connection reset';
    };
    const r = await testNode('a.yaml', 'greet', {}, { fetcher });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'failed') return;
    expect(r.status).toBe(0);
    expect(r.message).toBe('network error');
  });
});

describe('mapTestNodeHttpStatus', () => {
  it.each([
    [400, 'invalid request'],
    [404, 'workflow or node not found'],
    [409, 'this node cannot be tested in isolation'],
    [415, 'unsupported request content-type'],
    [422, 'dummy inputs are invalid'],
    [500, 'server error while running test'],
    [502, 'server error while running test'],
    [503, 'workflow runtime is unavailable'],
  ])('maps HTTP %i to its documented fallback', (status, expected) => {
    expect(mapTestNodeHttpStatus(status)).toBe(expected);
  });

  it('falls back to a generic "test failed (HTTP <code>)" for unknown statuses', () => {
    // The route handler today only emits the codes above, but the function
    // must remain total — a future code (e.g. 418) should produce a
    // human-readable string rather than `undefined`.
    expect(mapTestNodeHttpStatus(418)).toBe('test failed (HTTP 418)');
    expect(mapTestNodeHttpStatus(599)).toBe('test failed (HTTP 599)');
  });
});
