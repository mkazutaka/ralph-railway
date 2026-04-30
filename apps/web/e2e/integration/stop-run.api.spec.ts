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
 * mitigates the keep-alive issue documented in `list-recent-runs.spec.ts`:
 * Vite's dev server can leave keep-alive connections in an inconsistent
 * state after a request body that exceeds certain thresholds, which
 * causes subsequent requests on the reused connection to hang. Forcing
 * `Connection: close` sidesteps the issue without modifying the server.
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
 * Retry a request once with a short timeout to absorb a one-off hang.
 * The first request of a new file after the integration security spec
 * (which sends a 300 KiB body that the body-limit guard rejects with
 * 413 *before* draining the body) can stall Vite's dev server briefly:
 * the second request always succeeds. Mirrors the helper used in
 * `list-recent-runs.spec.ts`.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

/**
 * Warm up the dev server's HTTP loop with a cheap GET so the very first
 * "real" request in this file is not the one that absorbs the post-413
 * stall from a preceding integration spec. Runs once per file.
 */
let warmedUp = false;
async function warmUpServer() {
  if (warmedUp) return;
  warmedUp = true;
  await withRetry(async () => {
    await withApiContext(async (ctx) => {
      // Any reachable GET works; `/api/patterns` is cheap and has no side
      // effect. We absorb up to one stall here so subsequent test bodies
      // can use a single-shot context without retry boilerplate.
      const res = await ctx.get('/api/patterns', { timeout: 5_000 });
      expect(res.ok(), 'patterns endpoint should be reachable').toBe(true);
    });
  });
}

// API-level (integration) tests for the stop-run endpoint.
//
// Scope:
// - runNotFound (404): existing run id that does not match the URL workflow.
// - 存在しない run id への直接 POST.
//
// These cases cannot be reproduced through the UI because the UI never lets
// the user reference a run that does not belong to the currently-loaded
// workflow. They are kept out of `apps/web/e2e/stop-run.spec.ts` (which is
// reserved for UI-driven E2E) and live under `e2e/integration/` to make the
// boundary explicit. (review m-4)
//
// Note on parallel test data: the test-only seed endpoint
// (`POST /api/_test/runs`) writes to a module-scoped in-memory store, but
// each test uses a unique `workflowId` (file path under .e2e-workflows) and a
// unique `runId`, so cross-test interference is avoided without resetting
// the store.

interface SeedRow {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  durationMs: number | null;
}

interface SeedNode {
  nodeId: string;
  status:
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'skipped';
  startedAt: number | null;
  endedAt: number | null;
  output: string | null;
  errorMessage: string | null;
  logExcerpt: string;
}

interface SeedDetail {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt: number | null;
  nodes: ReadonlyArray<SeedNode>;
}

const tracker = createFixtureTracker();

test.beforeEach(async () => {
  // Absorb at most one keep-alive stall left over from an earlier file.
  await warmUpServer();
});

test.afterEach(async () => {
  await tracker.cleanupAll();
});

test.describe('stop-run API: runNotFound / cross-workflow isolation', () => {
  test('存在しない runId に対する直接 POST は 404 (run not found) を返す', async () => {
    // 観点: UI 上は terminal でない run しか Stop ボタンを描画しないため、
    // runNotFound 経路 (run が存在しない) に到達するには API 直叩きが必要。
    // workflow の step 1 `LocateRun` の `findRun -> NotFound` 分岐を担保する。
    const fixture = await tracker.create(
      'stop-run-api-404',
      VALID_WORKFLOW_YAML,
    );
    const ghostRunId = 'run-ghost-does-not-exist';

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(ghostRunId)}/stop`,
      );
      expect(res.status()).toBe(404);
      const body = await res.text();
      // SvelteKit error envelope は { message } を含む
      expect(body.toLowerCase()).toContain('run not found');
    });
  });

  test('別ワークフローに属する run id への POST は 404 で拒否され、機微情報がボディに漏れない（cross-workflow isolation）', async () => {
    // 観点: stop endpoint の cross-workflow ガード (route handler 冒頭の
    // workflowId mismatch チェック) を担保する。
    const fixtureA = await tracker.create(
      'stop-run-api-isolation-a',
      VALID_WORKFLOW_YAML,
    );
    const fixtureB = await tracker.create(
      'stop-run-api-isolation-b',
      VALID_WORKFLOW_YAML,
    );

    const baseNow = Date.now();
    const runIdB = 'run-b-isolated-api';
    const summaryB: SeedRow = {
      id: runIdB,
      workflowId: fixtureB.id,
      status: 'running',
      startedAt: baseNow - 5_000,
      durationMs: null,
    };
    const detailB: SeedDetail = {
      id: runIdB,
      workflowId: fixtureB.id,
      status: 'running',
      startedAt: baseNow - 5_000,
      endedAt: null,
      nodes: [
        {
          nodeId: 'only_step',
          status: 'running',
          startedAt: baseNow - 5_000,
          endedAt: null,
          output: null,
          errorMessage: null,
          logExcerpt: '',
        },
      ],
    };

    await withApiContext(async (ctx) => {
      // seed B 側の run のみ
      const seedRes = await ctx.post('/api/_test/runs', {
        data: { reset: false, rows: [summaryB], details: [detailB] },
      });
      expect(seedRes.ok()).toBe(true);

      // A の workflowId に B の runId を組み合わせてリクエスト → 404
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixtureA.id)}/runs/${encodeURIComponent(runIdB)}/stop`,
      );
      expect(res.status()).toBe(404);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('run not found');
      // B の機微情報がエラーボディに漏れていないこと
      expect(body).not.toContain(fixtureB.id);
      expect(body).not.toContain('only_step');
    });
  });
});
