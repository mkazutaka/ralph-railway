import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
} from '@playwright/test';
import {
  VALID_WORKFLOW_YAML,
  createFixtureTracker,
} from '../helpers/workflowFixtures';

/**
 * Build a fresh APIRequestContext for each call. `Connection: close`
 * mitigates the keep-alive issue documented in `list-recent-runs.spec.ts`.
 */
async function withApiContext<T>(
  fn: (request: APIRequestContext) => Promise<T>,
): Promise<T> {
  const ctx = await apiRequest.newContext({
    baseURL: 'http://localhost:5100',
    extraHTTPHeaders: { connection: 'close' },
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

/**
 * Retry a request once to absorb a one-off keep-alive stall after the
 * insert-pattern security spec (300 KiB 413 body). Mirrors the helper
 * pattern from `list-recent-runs.spec.ts`.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

let warmedUp = false;
async function warmUpServer() {
  if (warmedUp) return;
  warmedUp = true;
  await withRetry(async () => {
    await withApiContext(async (ctx) => {
      const res = await ctx.get('/api/patterns', { timeout: 5_000 });
      expect(res.ok(), 'patterns endpoint should be reachable').toBe(true);
    });
  });
}

// API-level (integration) security checks for the stop-run endpoint.
//
// Scope:
// - Path traversal through the workflow id / run id (`parseWorkflowParam` /
//   `parseRunIdParam` 400 boundary).
// - Cross-origin POST (`hooks.server.ts` same-origin guard / 403 boundary).
//
// These cases cannot be reproduced from the UI because the UI only exposes
// brand-validated ids loaded from the server, and never issues cross-origin
// requests to its own backend. They are kept out of `apps/web/e2e/stop-run.spec.ts`
// (which is reserved for UI-driven E2E) and live under `e2e/integration/`
// to make the boundary explicit. (review m-4)

const tracker = createFixtureTracker();

test.beforeEach(async () => {
  await warmUpServer();
});

test.afterEach(async () => {
  await tracker.cleanupAll();
});

test.describe('stop-run API: 入力検証 / パストラバーサル の境界', () => {
  test('path-traversal な workflowId への POST は 400 で拒否され、内部パス情報が漏れない', async () => {
    const fixture = await tracker.create(
      'stop-run-traversal-victim-wf',
      VALID_WORKFLOW_YAML,
    );
    const evilWorkflowId = '..%2F..%2Fetc%2Fpasswd';
    const validRunId = 'run-some-id';

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${evilWorkflowId}/runs/${encodeURIComponent(validRunId)}/stop`,
      );
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body).not.toContain(fixture.id);
      expect(body).not.toContain('etc/passwd');
    });
  });

  test('path-traversal な runId への POST は 400 で拒否され、内部パス情報が漏れない', async () => {
    const fixture = await tracker.create(
      'stop-run-traversal-victim-run',
      VALID_WORKFLOW_YAML,
    );
    const evilRunId = '..%2F..%2Fetc%2Fshadow';
    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${evilRunId}/stop`,
      );
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body).not.toContain('etc/shadow');
    });
  });
});

test.describe('stop-run API: same-origin guard (CSRF 境界)', () => {
  test('Origin が異なる POST は same-origin guard により 403 で拒否される', async () => {
    // 観点: hooks.server.ts の `isSameOrigin` ガードが mutating endpoint へ
    // 効いていることを stop 経路でも担保する (run-workflow / insert-pattern
    // と同じガードが run/stop の両方に適用されることを確認)。
    const fixture = await tracker.create(
      'stop-run-csrf-api',
      VALID_WORKFLOW_YAML,
    );
    const validRunId = 'run-some-id';

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(validRunId)}/stop`,
        { headers: { origin: 'http://attacker.example.com' } },
      );
      expect(
        res.status(),
        `expected 403 for cross-origin POST, got ${res.status()}`,
      ).toBe(403);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('cross-origin');
    });
  });
});
