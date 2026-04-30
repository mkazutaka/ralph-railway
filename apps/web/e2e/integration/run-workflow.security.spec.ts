import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
} from '@playwright/test';

/**
 * API-level (integration) security checks for the run-workflow endpoint
 * (`POST /api/workflows/:id/runs`).
 *
 * Scope (split off from `apps/web/e2e/run-workflow.spec.ts` per review-e2e.md
 * minor指摘):
 *
 *   - body limit (DoS 境界):
 *       `hooks.server.ts` の body-limit guard が Content-Length を 256 KiB の
 *       既定上限と比較し、超過したら 413 を返すことを確認する。
 *
 *   - same-origin (CSRF 境界):
 *       `hooks.server.ts` の `isSameOrigin` ガードが Origin/Referer ホスト
 *       不一致を 403 で拒否することを確認する。
 *
 * 観点: これらのケースはユーザの通常 UI 操作からは到達できない (ブラウザは
 * 自分の Origin を別ホストに偽装できないし、UI が 256 KiB のリクエストを
 * 投げる経路もない)。攻撃者ブラウザが直接 fetch する想定の経路として API
 * レイヤで境界を担保する。
 *
 * 共通の helper パターン (`withApiContext` / `connection: close`) は
 * `e2e/integration/stop-run.security.spec.ts` と整合させており、
 * keep-alive 由来の hang を回避する。
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
 * Retry a request once to absorb a one-off keep-alive stall that can follow
 * the insert-pattern / save-workflow security specs' large-body POSTs.
 * Mirrors the helper used in `stop-run.security.spec.ts`.
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

test.beforeEach(async () => {
  await warmUpServer();
});

test.describe('run-workflow API: body-limit guard (DoS 境界)', () => {
  test('リクエストボディが body limit (256 KiB 既定) を超える POST は 413 で拒否される', async () => {
    // 観点: hooks.server.ts の body-limit guard は Content-Length をパース
    // して全 mutation リクエストへ適用される。攻撃面として軽くカバーする。
    //
    // 実 fixture は不要 (413 はルートハンドラに到達する前にトリップする)。
    // workflow id は brand 検査を通すために有効な basename を使う。
    const validId = `body-limit-probe-${Date.now()}.yaml`;
    // 256 KiB + 1 byte。デフォルト BODY_LIMIT_DEFAULT_BYTES を確実に超える。
    const oversize = 'x'.repeat(256 * 1024 + 1);

    await withRetry(async () => {
      await withApiContext(async (ctx) => {
        const res = await ctx.post(
          `/api/workflows/${encodeURIComponent(validId)}/runs`,
          {
            data: oversize,
            headers: { 'content-type': 'text/plain' },
            timeout: 10_000,
          },
        );
        expect(
          res.status(),
          `expected 413 for oversized body, got ${res.status()}`,
        ).toBe(413);
        const body = await res.text();
        expect(body.toLowerCase()).toContain('too large');
      });
    });
  });
});

test.describe('run-workflow API: same-origin guard (CSRF 境界)', () => {
  test('クロスオリジンの POST は same-origin guard により 403 で拒否される', async () => {
    // 観点: hooks.server.ts の `isSameOrigin` ガードが、Origin / Referer の
    // ホストが異なる場合に 403 を返すことを担保する。CLI 風 (Origin/Referer
    // なし) の経路は通る一方で、Origin が外部サイトの場合は弾かれる。
    const validId = `same-origin-probe-${Date.now()}.yaml`;

    await withRetry(async () => {
      await withApiContext(async (ctx) => {
        const res = await ctx.post(
          `/api/workflows/${encodeURIComponent(validId)}/runs`,
          {
            // 攻撃者サイトを名乗る Origin。same-origin チェックは host が
            // `localhost:5100` と一致しない限り 403 を返す。
            headers: { origin: 'http://attacker.example.com' },
            timeout: 10_000,
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
});
