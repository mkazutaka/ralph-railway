import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
} from '@playwright/test';
import { mkdir, access, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VALID_WORKFLOW_YAML,
  createFixtureTracker,
} from '../helpers/workflowFixtures';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const E2E_WORKFLOWS_DIR = resolve(__dirname, '../../.e2e-workflows');

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

/** Retry helper consistent with the other integration specs. */
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

// API-level (integration) security checks for the `POST /api/workflows`
// create endpoint.
//
// Scope (review-e2e.md major items 1 & 2):
// - Cross-origin POST (`hooks.server.ts` `isSameOrigin` guard / 403 boundary).
// - Oversized JSON body / chunked transfer bypass (route-level
//   `BODY_LIMIT_BYTES` defence-in-depth / 413 boundary).
// - Malformed JSON body (route-level 400 boundary).
// - Wrong-shape JSON (id/yaml not strings / 400 boundary).
//
// These cases cannot be reproduced via the UI because the UI only sends
// well-formed same-origin JSON with string id/yaml. They are kept out of
// `apps/web/e2e/create-workflow.spec.ts` (UI-driven E2E only) and live
// here under `e2e/integration/` to make the boundary explicit, mirroring
// `stop-run.security.spec.ts` and `test-node.security.spec.ts`.

const tracker = createFixtureTracker();

test.beforeEach(async () => {
  await warmUpServer();
  await mkdir(E2E_WORKFLOWS_DIR, { recursive: true });
});

test.afterEach(async () => {
  await tracker.cleanupAll();
});

test.describe('create-workflow API: same-origin guard (CSRF 境界)', () => {
  test('Origin が異なる POST は same-origin guard により 403 で拒否され、ファイルは作成されない', async () => {
    // 観点: hooks.server.ts の `isSameOrigin` ガードが create endpoint にも
    // 適用されていることを担保する。POST /api/workflows は最も破壊的な
    // mutation なので、stop-run / test-node 同様に CSRF 境界を確認する。
    const id = `csrf-attack-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.yaml`;

    await withApiContext(async (ctx) => {
      const res = await ctx.post('/api/workflows', {
        headers: {
          'content-type': 'application/json',
          origin: 'http://attacker.example.com',
        },
        data: { id, yaml: VALID_WORKFLOW_YAML },
      });
      expect(
        res.status(),
        `expected 403 for cross-origin POST, got ${res.status()}`,
      ).toBe(403);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('cross-origin');
    });

    // 不変条件: 拒否されたリクエストはディスクに副作用を残さない。
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, id)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('Origin が壊れた (URL 不正) POST も 403 で拒否される', async () => {
    // 観点: `new URL(origin)` が例外を投げるケース (malformed Origin) は
    // fail-closed されるべき。
    const id = `csrf-malformed-origin-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.yaml`;

    await withApiContext(async (ctx) => {
      const res = await ctx.post('/api/workflows', {
        headers: {
          'content-type': 'application/json',
          origin: 'not a url at all',
        },
        data: { id, yaml: VALID_WORKFLOW_YAML },
      });
      expect(res.status()).toBe(403);
    });

    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, id)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });
});

test.describe('create-workflow API: ボディサイズ / フォーマット境界', () => {
  test('巨大な JSON ボディは 413 で拒否され、ファイルは作成されない', async () => {
    // 観点: 4 MiB を超える YAML を含むペイロードを POST すると、
    // hooks-level の Content-Length 上限 (BODY_LIMIT_BYTES, 既定 256 KiB)
    // でブロックされる。route-level の defence-in-depth も同じ閾値を使う
    // ので Transfer-Encoding: chunked でも検出されるが、ここでは標準的な
    // Content-Length 経路を確認する。
    const id = `oversize-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.yaml`;
    // 5 MiB の YAML 風ペイロード。BODY_LIMIT_MAX_BYTES (4 MiB) を確実に
    // 超える + 既定 256 KiB は遥かに超える。
    const huge = 'a'.repeat(5 * 1024 * 1024);
    const oversizeYaml = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: oversize\n  version: '0.1.0'\n  description: '${huge}'\ndo:\n  - first_step:\n      run:\n        shell:\n          command: 'echo hi'\n`;

    await withApiContext(async (ctx) => {
      const res = await ctx.post('/api/workflows', {
        headers: { 'content-type': 'application/json' },
        data: { id, yaml: oversizeYaml },
      });
      expect(res.status()).toBe(413);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('too large');
    });

    // 不変条件: oversize 拒否されたリクエストはディスクに何も書き込まない。
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, id)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('壊れた JSON ボディは 400「invalid JSON body」で拒否される', async () => {
    // 観点: route-level の `JSON.parse` 失敗時に 400 を返し、内部スタック
    // トレースを漏らさないこと。Playwright の `data: <string>` は文字列を
    // JSON.stringify してしまうので、`Buffer.from(...)` で raw bytes を
    // 直接送って parser を確実に失敗させる。
    const broken = '{ "id": "incomplete-json.yaml", "yaml": "no closing';

    await withApiContext(async (ctx) => {
      const res = await ctx.post('/api/workflows', {
        headers: { 'content-type': 'application/json' },
        data: Buffer.from(broken, 'utf8'),
      });
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('invalid json body');
      // スタックトレース (`at Object.<anonymous>` 等) や絶対パスが漏れて
      // いないこと。
      expect(body).not.toMatch(/\/Users\//);
      expect(body).not.toMatch(/\bat \w+\.\w+/);
    });
  });

  test('id / yaml が文字列でない JSON は 400「id and yaml required as strings」で拒否される', async () => {
    // 観点: brand 検証より手前の型ガード (typeof !== 'string') で 400 を
    // 返し、後続の brand コンストラクタへ非文字列を渡さないこと。
    await withApiContext(async (ctx) => {
      const res = await ctx.post('/api/workflows', {
        headers: { 'content-type': 'application/json' },
        data: { id: 123, yaml: { not: 'a string' } },
      });
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('id and yaml required as strings');
    });
  });

  test('id フィールドが欠落した JSON は 400 で拒否される', async () => {
    // 観点: `body.id` が undefined の場合も上記の型ガードで弾かれる。
    await withApiContext(async (ctx) => {
      const res = await ctx.post('/api/workflows', {
        headers: { 'content-type': 'application/json' },
        data: { yaml: VALID_WORKFLOW_YAML },
      });
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('id and yaml required as strings');
    });
  });
});

test.describe('create-workflow API: 内部情報の漏洩防止', () => {
  test('既存の id への重複 POST のレスポンスに絶対パス / RALPH_WORKFLOWS_DIR が漏れない', async () => {
    // 観点: 409 の error body に fixture の絶対パスや内部ディレクトリ名が
    // 露出していないこと (review S-2 と同じ観点)。
    const fixture = await tracker.create('create-dup-leak', VALID_WORKFLOW_YAML);

    await withApiContext(async (ctx) => {
      const res = await ctx.post('/api/workflows', {
        headers: { 'content-type': 'application/json' },
        data: { id: fixture.id, yaml: VALID_WORKFLOW_YAML },
      });
      expect(res.status()).toBe(409);
      const body = await res.text();
      // メッセージは "workflow already exists" のような短い文言である想定。
      expect(body.toLowerCase()).toContain('already exists');
      expect(body).not.toMatch(/\/Users\//);
      expect(body).not.toContain('.e2e-workflows');
      expect(body).not.toContain('RALPH_WORKFLOWS_DIR');
    });
  });

  test('壊れた YAML への POST のレスポンスに raw YAML 本文 / パースエラーの内部詳細が漏れない', async () => {
    // 観点: 422 の error body は固定文言 (`workflow YAML is invalid`) のみで、
    // ユーザ提供の YAML そのものは echo されないこと (review-backend で
    // 触れられている通り、`reason` は console.warn に留まりレスポンスには
    // 載らない設計)。
    const id = `yaml-leak-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.yaml`;
    // 攻撃者がエラーメッセージで自分の入力をそのまま返してほしいと期待する
    // ような特異な文字列を入れる。
    const sentinel = 'SENTINEL_XXXX_DO_NOT_ECHO_BACK_9876543210';
    const brokenYaml = `document:\n  dsl: '1.0.0'\n  namespace: '${sentinel}'\n  name: broken\ndo: [unclosed\n`;

    // 念のため cleanup 登録 (作成されないはず)。
    const cleanupPath = resolve(E2E_WORKFLOWS_DIR, id);

    try {
      await withApiContext(async (ctx) => {
        const res = await ctx.post('/api/workflows', {
          headers: { 'content-type': 'application/json' },
          data: { id, yaml: brokenYaml },
        });
        expect(res.status()).toBe(422);
        const body = await res.text();
        expect(body.toLowerCase()).toContain('workflow yaml is invalid');
        // sentinel が echo されていない。
        expect(body).not.toContain(sentinel);
        expect(body).not.toContain('unclosed');
      });
    } finally {
      try {
        await unlink(cleanupPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  });

  test('URL エンコード済みのパストラバーサル `..%2Ffoo.yaml` を POST しても 400 で拒否され、ディスクには ..%2F や ../ ディレクトリが作成されない (review §2-5 攻撃ベクタ)', async () => {
    // 観点 (review-e2e §2-5): URL エンコード形式 (`..%2Ffoo.yaml`) のような
    // 攻撃用 id は server 側で decode せずそのまま brand validate される。
    // %2F は `/` ではなく文字列として残るので、basename チェックには
    // ヒットしないが `(?!.*\.\.)` (連続ドット禁止) で弾かれる。あるいは
    // brand 正規表現の許容文字 `[A-Za-z0-9._-]` に %20/2F の `%` が含まれない
    // ので、いずれにせよ 400 でフィルタリングされる。攻撃者がエンコードを
    // 噛ませてフィルタを回避できないことを担保する。
    const evilEncoded = '..%2Ffoo.yaml';

    await withApiContext(async (ctx) => {
      const res = await ctx.post('/api/workflows', {
        headers: { 'content-type': 'application/json' },
        data: { id: evilEncoded, yaml: VALID_WORKFLOW_YAML },
      });
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('invalid workflowid');
    });

    // どの形でもファイルが書かれていないこと:
    //   - 生の `..%2Ffoo.yaml` (basename) として
    //   - URL decode 後の `../foo.yaml` (basename, 連続ドット込み) として
    //   - decode 後にパストラバーサル 1 段上 (`foo.yaml` 直前ディレクトリ) として
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, evilEncoded)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, '../foo.yaml')).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('id に script タグを含む文字列を POST しても error メッセージに raw HTML が echo されない (XSS 緩和)', async () => {
    // 観点: brand validation で弾かれた id がそのまま error 本文に echo
    // されないこと。`asWorkflowId` は raw input を含めない汎用メッセージを
    // 出すので、`<script>` のような文字列が含まれても response body に
    // 生で出現してはならない。alert UI 側でも textContent として描画される
    // ことを担保するため、UI 側のテストは create-workflow.spec.ts に追加。
    const evilId = '<script>window.__pwn=1</script>.yaml';

    await withApiContext(async (ctx) => {
      const res = await ctx.post('/api/workflows', {
        headers: { 'content-type': 'application/json' },
        data: { id: evilId, yaml: VALID_WORKFLOW_YAML },
      });
      // brand regex に引っかかるので 400。
      expect(res.status()).toBe(400);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('invalid workflowid');
      // raw HTML が response body に含まれていない (= server が dangerous な
      // 入力を反射していない)。
      expect(body).not.toContain('<script>');
      expect(body).not.toContain('window.__pwn');
    });

    // 念のためディスクにも作成されていないこと。
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, evilId)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });
});
