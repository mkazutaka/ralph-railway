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

// API-level (integration) security checks for the test-node endpoint.
//
// Scope (review C-2 / S-1 / S-2):
// - Path traversal through workflowId / nodeId (`parseWorkflowParam` /
//   `parseNodeIdParam` 400 boundary).
// - Cross-origin POST (`hooks.server.ts` same-origin guard / 403 boundary).
// - Internal path / fixture id 漏洩確認.
//
// These cases cannot be reproduced from the UI because the UI only exposes
// brand-validated ids loaded from the server. Kept out of
// `apps/web/e2e/test-node.spec.ts` (UI-driven E2E only) and live under
// `e2e/integration/` to make the boundary explicit.

const tracker = createFixtureTracker();

test.beforeEach(async () => {
  await warmUpServer();
});

test.afterEach(async () => {
  await tracker.cleanupAll();
});

test.describe('test-node API: パストラバーサル / brand 検証の境界', () => {
  test('path-traversal な workflowId への POST は 400 で拒否され、内部パス情報が漏れない', async () => {
    const fixture = await tracker.create(
      'test-node-traversal-wf',
      VALID_WORKFLOW_YAML,
    );
    const evilWorkflowId = '..%2F..%2Fetc%2Fpasswd';

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${evilWorkflowId}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: {},
        },
      );
      expect(res.status()).toBe(400);
      const body = await res.text();
      // 攻撃者文字列 / fixture path / RALPH_WORKFLOWS_DIR が漏れていない
      expect(body).not.toContain(fixture.id);
      expect(body).not.toContain('etc/passwd');
      expect(body).not.toContain('.e2e-workflows');
    });
  });

  test('path-traversal な nodeId への POST は 400 で拒否され、内部パス情報が漏れない', async () => {
    const fixture = await tracker.create(
      'test-node-traversal-node',
      VALID_WORKFLOW_YAML,
    );
    const evilNodeId = '..%2F..%2Fetc%2Fshadow';

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${evilNodeId}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: {},
        },
      );
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body).not.toContain('etc/shadow');
      expect(body).not.toContain('.e2e-workflows');
    });
  });

  test('存在しない workflow への 404 ボディに fixture の絶対パスが漏れない', async () => {
    // 観点: review S-2「機密情報のレスポンス漏洩確認」。404 メッセージは
    //       短い文言 (`workflow not found`) のはずだが、内部実装の変更で
    //       fixture path が混入していないかを担保する。
    await withApiContext(async (ctx) => {
      const ghostId = 'definitely-not-existing-wf-1234567890.yaml';
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(ghostId)}/nodes/${encodeURIComponent('any_node')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: {},
        },
      );
      expect(res.status()).toBe(404);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('workflow not found');
      // 絶対パスや RALPH_WORKFLOWS_DIR の中身が漏れていない
      expect(body).not.toMatch(/\/Users\//);
      expect(body).not.toContain('.e2e-workflows');
      expect(body).not.toContain('RALPH_WORKFLOWS_DIR');
    });
  });
});

test.describe('test-node API: same-origin guard (CSRF 境界)', () => {
  test('Origin が異なる POST は same-origin guard により 403 で拒否される', async () => {
    // 観点: hooks.server.ts の `isSameOrigin` ガードが test-node 経路にも
    //       適用されていることを担保する (review S-1)。
    const fixture = await tracker.create(
      'test-node-csrf',
      VALID_WORKFLOW_YAML,
    );

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: {
            'content-type': 'application/json',
            origin: 'http://attacker.example.com',
          },
          data: {},
        },
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
