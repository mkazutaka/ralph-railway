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

// API-level (integration) tests for the test-node endpoint.
//
// Scope (review C-1): UI からは到達できない API レイヤの境界を担保する。
//   - 415: Content-Type が application/json 以外
//   - 400: 不正な JSON body
//   - 400: `inputs` が非オブジェクト (配列 / プリミティブ)
//   - 200: `inputs` が undefined / null は `{}` 扱い (許容)
//
// UI から発火する POST は常に application/json + 整形済み JSON なので、
// これらの境界は UI 経路では到達できない。E2E から外して integration
// spec として隔離する (mirrors `stop-run.api.spec.ts`).

const tracker = createFixtureTracker();

test.beforeEach(async () => {
  await warmUpServer();
});

test.afterEach(async () => {
  await tracker.cleanupAll();
});

test.describe('test-node API: 入力バリデーションの境界', () => {
  test('Content-Type が application/json 以外の POST は 415 で拒否される', async () => {
    // 観点: `+server.ts` の Content-Type pin (application/json 強制)。
    //       text/plain は CORS の "simple request" になるため、ここで
    //       弾かないと same-origin guard を迂回されうる。
    const fixture = await tracker.create(
      'test-node-api-415',
      VALID_WORKFLOW_YAML,
    );

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'text/plain' },
          data: 'hello',
        },
      );
      expect(res.status()).toBe(415);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('application/json');
    });
  });

  test('不正な JSON body の POST は 400 (invalid JSON body) で拒否される', async () => {
    // 観点: `+server.ts` の `request.json()` の try/catch 経路。
    const fixture = await tracker.create(
      'test-node-api-400-json',
      VALID_WORKFLOW_YAML,
    );

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          // Buffer で渡して Playwright の data シリアライズ判断に依存しない
          // (data: string 経路では Playwright が `Content-Type: application/json`
          // を見て自動 JSON-stringify してしまうことがあり、`'{not json'` が
          // `'"{not json"'` に変換されて valid JSON として通ってしまう)。
          data: Buffer.from('{not json', 'utf8'),
        },
      );
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('invalid json');
    });
  });

  test('`inputs` が配列の POST は 400 (inputs must be an object) で拒否される', async () => {
    // 観点: `+server.ts` の inputs 型チェック (Array.isArray 経路)。
    const fixture = await tracker.create(
      'test-node-api-400-array',
      VALID_WORKFLOW_YAML,
    );

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: { inputs: [1, 2, 3] },
        },
      );
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('inputs must be an object');
    });
  });

  test('`inputs` がプリミティブの POST は 400 (inputs must be an object) で拒否される', async () => {
    const fixture = await tracker.create(
      'test-node-api-400-primitive',
      VALID_WORKFLOW_YAML,
    );

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: { inputs: 'a string' },
        },
      );
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('inputs must be an object');
    });
  });

  test('`inputs` が null の POST は 200 (空 inputs として扱われる)', async () => {
    // 観点: `+server.ts` で `body.inputs === null` は `{}` 扱いと記述
    //       されている。UI からは送られないが API 仕様としては許容する
    //       ことを担保する。
    const fixture = await tracker.create(
      'test-node-api-200-null-inputs',
      VALID_WORKFLOW_YAML,
    );

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: { inputs: null },
        },
      );
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { status: string; nodeId: string };
      expect(body.status).toBe('succeeded');
      expect(body.nodeId).toBe('first_step');
    });
  });

  test('成功レスポンスは cache-control: no-store を返す（review L-5: invariant 1 補強）', async () => {
    // 観点: review L-5。`+server.ts:125` で `cache-control: no-store` を
    //       返している。CDN/ブラウザキャッシュに乗らないことが invariant 1
    //       (永続化なし) を補強しているので、API レイヤで担保する。
    const fixture = await tracker.create(
      'test-node-api-cache-control',
      VALID_WORKFLOW_YAML,
    );

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: {},
        },
      );
      expect(res.status()).toBe(200);
      const cacheControl = res.headers()['cache-control'] ?? '';
      expect(cacheControl.toLowerCase()).toContain('no-store');
    });
  });

  test('body 無し POST (Content-Type は JSON) は 400 で拒否される', async () => {
    // 観点: 空 body (`""`) は `request.json()` で SyntaxError → 400。
    const fixture = await tracker.create(
      'test-node-api-400-empty',
      VALID_WORKFLOW_YAML,
    );

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          // 空 body を確実に送るため Buffer (length 0) を使う
          data: Buffer.alloc(0),
        },
      );
      expect(res.status()).toBe(400);
    });
  });

  test('Content-Type に charset パラメータが付いていても 200 を返す（review-e2e P3 boundary regression）', async () => {
    // 観点: review-e2e P3。`+server.ts:67-70` の `split(';', 1)[0].trim()` で
    //       charset パラメータが正しく剥がれていることを担保する。回帰で
    //       `application/json; charset=utf-8` が 415 になると CORS preflight が
    //       不要なブラウザ向けに壊れる。
    const fixture = await tracker.create(
      'test-node-api-charset',
      VALID_WORKFLOW_YAML,
    );

    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json; charset=utf-8' },
          data: {},
        },
      );
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('succeeded');
    });
  });
});

test.describe('test-node API: DoS 境界 / prototype pollution', () => {
  test('巨大 inputs (body limit 超過) の POST は 413 で拒否される（review-e2e P1 DoS 境界）', async () => {
    // 観点: review-e2e P1。`hooks.server.ts:186-192` の body-size guard が
    //       test-node エンドポイントにも適用されることを担保する。256 KiB の
    //       既定上限を確実に超える 512 KiB の文字列を 1 件渡す。
    const fixture = await tracker.create(
      'test-node-api-413',
      VALID_WORKFLOW_YAML,
    );

    // 512 KiB の payload (default body limit 256 KiB の倍)
    const huge = 'x'.repeat(512 * 1024);
    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: { inputs: { huge } },
        },
      );
      // hooks.server.ts は content-length ヘッダで判定して 413 を返す
      expect(
        res.status(),
        `expected 413 (body too large), got ${res.status()}`,
      ).toBe(413);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('too large');
    });
  });

  test('inputs に `__proto__` キーを含めても Object.prototype が汚染されない（review-e2e P2 prototype pollution）', async () => {
    // 観点: review-e2e P2。`+server.ts:88-92` は `typeof === 'object' &&
    //       !Array.isArray` だけを検査して inputs を transparent に通すので、
    //       `{ __proto__: { polluted: true } }` のような payload を送って
    //       後続の処理で Object.prototype が汚染されると、サーバ全体に副作用
    //       が出る。汚染が発生しないことを 2 度 POST して確認する。
    const fixture = await tracker.create(
      'test-node-api-proto',
      VALID_WORKFLOW_YAML,
    );

    await withApiContext(async (ctx) => {
      // 1 投目: 攻撃 payload。json data は Playwright が JSON.stringify するので
      // raw bytes で送って意図的に `__proto__` キーを含める。
      const evil = '{"inputs":{"__proto__":{"e2e_polluted":"yes"}}}';
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: Buffer.from(evil, 'utf8'),
        },
      );
      // パース成功 → サーバ側は inputs を Record として扱う。エンドポイントは
      // 200 を返すかもしれないし、validateNodeInputs が unexpected key として
      // 422 を返すかもしれない。重要なのは「pollution が発生しない」こと。
      expect([200, 422]).toContain(res.status());
    });

    // 2 投目: 同じワークフローで普通の test-node を呼んで、サーバ側の動作が
    // 正常 (e2e_polluted キーが Object.prototype から漏れていない) であることを
    // 担保する。response body に "e2e_polluted" が含まれない = サーバ内部の
    // オブジェクトが汚染されていない (汚染されると `for..in` 経路や spread で
    // 漏出する可能性がある)。
    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: { inputs: { ordinary: 'value' } },
        },
      );
      expect(res.status()).toBe(200);
      const body = await res.text();
      expect(body).not.toContain('e2e_polluted');
    });
  });

  test('inputs に大量のキー (1 万件) を送っても server がクラッシュせず適切なステータスを返す（review-e2e P1 DoS 境界）', async () => {
    // 観点: review-e2e P1。inputs キー数のオーダー boundary。1 万件の small
    //       key/value を送ってサーバがエラーで応答するか、200 で成功するか
    //       のどちらかになり、決して接続が切れたり 500 にならないことを担保する。
    const fixture = await tracker.create(
      'test-node-api-many-keys',
      VALID_WORKFLOW_YAML,
    );

    const inputs: Record<string, string> = {};
    for (let i = 0; i < 10_000; i++) {
      inputs[`k${i}`] = `v${i}`;
    }
    // body サイズが body-limit を超えるかどうかは payload 次第。256 KiB の
    // 上限に近づくので 413 になる可能性が高い。重要なのは「サーバが応答を返す」。
    await withApiContext(async (ctx) => {
      const res = await ctx.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('first_step')}/test`,
        {
          headers: { 'content-type': 'application/json' },
          data: { inputs },
        },
      );
      // 413 (body too large) か 200 (受理) のどちらか。500 や接続切断は不可。
      expect([200, 413]).toContain(res.status());
    });
  });
});
