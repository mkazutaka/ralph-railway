import { test, expect, type Page } from '@playwright/test';
import { access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALID_WORKFLOW_YAML, createFixtureTracker } from '../helpers/workflowFixtures';

// API-level (integration) security checks for the save endpoint
// (`PUT /api/workflows/:id`).
//
// Scope (review-e2e.md S-1 / N-3 / N-4 / S-3 / S-5):
// - Path traversal / arbitrary file write through the workflow id.
// - Cross-origin mutation rejection (hooks.server.ts isSameOrigin guard).
// - Localhost guard verification (= test environment precondition).
//
// These cases cannot be reproduced from the UI because the UI only exposes
// load-served workflow ids and the same-origin save flow. They are kept out
// of `apps/web/e2e/save-workflow.spec.ts` (UI-driven E2E) and live here under
// `e2e/integration/` to make the boundary explicit.
//
// 実装上の選択 (NOTE): 当初 Playwright の `request` (Node.js 側 apiRequestContext)
// で送っていたが、`%2F` を含む URL や NUL バイトを含む body などの edge case で
// vite dev server / keep-alive と相性が悪く、累積実行で hang することがあった。
// 全リクエストをブラウザコンテキスト (`page.evaluate(fetch)`) で送るように統一
// し、攻撃者ブラウザが JS から fetch する現実シナリオに合わせる。

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const tracker = createFixtureTracker();

test.afterEach(async () => {
  await tracker.cleanupAll();
});

// Body large enough to be persisted but small enough not to hit 413 path.
const SAVE_BODY = VALID_WORKFLOW_YAML + '\n# integration-security\n';

// Resolve the e2e workflow directory so we can probe for stray files.
const E2E_WORKFLOWS_DIR = resolve(__dirname, '../../.e2e-workflows');

/**
 * Send a PUT to the save endpoint via the browser's fetch.
 * Returns the HTTP status. The page must already be navigated to a same-
 * origin location (see `await page.goto('/')` in test bodies).
 */
async function browserPut(
  page: Page,
  url: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<number> {
  return page.evaluate(
    async ([u, b, headers]) => {
      const res = await fetch(u, {
        method: 'PUT',
        headers: { 'content-type': 'text/yaml', ...(headers as Record<string, string>) },
        body: b as string,
      });
      return res.status;
    },
    [url, body, extraHeaders] as const,
  );
}

test.describe('save-workflow API: 入力検証 / パストラバーサル の境界 (不変条件 4)', () => {
  // 攻撃ベクタを 1 ヶ所に集約。新しい候補が見つかったらここに足せば
  // 全体の防御を担保できる (review-e2e.md S-1)。各 id は asWorkflowId の
  // brand 検証 / SvelteKit のルーティングのいずれかで弾かれる必要がある。
  const TRAVERSAL_VECTORS: Array<{ name: string; encodedId: string }> = [
    {
      name: 'POSIX 区切り (../etc/passwd.yaml)',
      encodedId: encodeURIComponent('../etc/passwd.yaml'),
    },
    {
      name: 'POSIX 二重区切り (../../etc/passwd.yaml)',
      encodedId: '..%2F..%2Fetc%2Fpasswd.yaml',
    },
    {
      name: 'Windows 区切り (..\\etc\\passwd.yaml)',
      encodedId: encodeURIComponent('..\\etc\\passwd.yaml'),
    },
    {
      name: '絶対パス (/etc/passwd.yaml)',
      encodedId: encodeURIComponent('/etc/passwd.yaml'),
    },
    {
      name: 'NUL バイト挿入 (foo\\0.yaml)',
      encodedId: encodeURIComponent(`foo${String.fromCharCode(0)}.yaml`),
    },
    {
      name: '二重エンコードされたパストラバーサル',
      encodedId: '%252E%252E%252F%252E%252E%252Fetc%252Fpasswd.yaml',
    },
    {
      name: 'ドット始まり hidden file (.hidden.yaml)',
      encodedId: encodeURIComponent('.hidden.yaml'),
    },
    {
      name: '許可外拡張子 (evil.txt)',
      encodedId: 'evil.txt',
    },
  ];

  for (const v of TRAVERSAL_VECTORS) {
    test(`不正な workflow id [${v.name}] への PUT は 400/404 で拒否され、書込が起きない`, async ({
      page,
    }) => {
      await page.goto('/');
      const status = await browserPut(page, `/api/workflows/${v.encodedId}`, SAVE_BODY);
      // SvelteKit のルーティングが decode 結果を basename に正規化するため
      // 経路に応じて 400 (brand 検証) / 404 (ルート未マッチ) のどちらかに
      // なる。「保存できない」ことが本質。
      expect([400, 404]).toContain(status);
    });
  }

  test('e2e 作業ディレクトリ外に passwd.yaml / evil.yaml が漏れていない（パストラバーサルの最終的な fs 確認）', async ({
    page,
  }) => {
    // 全 vector を順に駆動した上で、e2e ディレクトリ外 / 親ディレクトリに
    // 攻撃者が指定したファイルが作成されていないことを確認する。
    await page.goto('/');
    for (const v of TRAVERSAL_VECTORS) {
      await browserPut(page, `/api/workflows/${v.encodedId}`, SAVE_BODY);
    }
    const probes = [
      resolve(E2E_WORKFLOWS_DIR, '../etc/passwd.yaml'),
      resolve(E2E_WORKFLOWS_DIR, '../evil.yaml'),
      resolve(E2E_WORKFLOWS_DIR, '../../etc/passwd.yaml'),
    ];
    for (const probe of probes) {
      await expect(
        access(probe).then(
          () => `unexpected file created: ${probe}`,
          () => 'missing',
        ),
      ).resolves.toBe('missing');
    }
  });

  test('brand 検証が通る形だが lower-level store が拒否する経路は 400 を返す（InvalidId / store reject 経路）', async ({
    page,
  }) => {
    // 観点 (review-e2e.md N-2): asWorkflowId の正規表現は通るが、SvelteKit
    // のルーティングは厳密な basename しか受け付けない。実装上 "abc..yaml" は
    // brand regex `(?!.*\.\.)` で拒否されるので 400 になる。最低限、brand 検証
    // または store 検証のどちらかで弾かれることを示す。
    await page.goto('/');
    const fixtureLikeId = encodeURIComponent('abc..yaml');
    const status = await browserPut(page, `/api/workflows/${fixtureLikeId}`, SAVE_BODY);
    expect([400, 404]).toContain(status);
  });
});

/**
 * Cross-origin / Referer / 同オリジン guard を試すための低レベル PUT
 * ヘルパ。Playwright の apiRequestContext は同 spec ファイル内で `page.evaluate`
 * fetch と混在させると dev server 側 cold path で hang することが観測されたため
 * (root cause は vite dev server の hooks 経路レスポンス生成のロード時間と
 *  apiRequestContext の HTTP/1.1 keep-alive 再利用), Node の標準 `fetch`
 * (undici) を直接使うことで Playwright 経由の fixture を完全に外す。
 *
 * Node fetch は Origin/Referer/Host を「forbidden header」と扱わないため
 * (Workers 側のブラウザではない)、自由にヘッダを偽装できる。CSRF は
 * 「攻撃者ブラウザが localhost に投げる」現実シナリオを模す目的なので、
 * リクエストオリジンがどこから来るか (= テスト ランナー Node) は本質ではない。
 */
async function nodePut(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'text/yaml', ...headers },
    body,
    // Node fetch supports AbortController-based timeouts; default has none, so
    // we wrap with a timeout via AbortSignal.timeout (Node 17.3+).
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status };
}

const BASE_URL = 'http://localhost:5100';

test.describe('save-workflow API: CSRF / Origin guard (hooks.server.ts isSameOrigin)', () => {
  test('クロスオリジン (Origin: https://evil.example) からの PUT は 403 で拒否される', async () => {
    // 観点 (review-e2e.md N-3 / S-3): hooks.server.ts は非安全メソッドで
    // Origin / Referer を url.host と一致させる必要がある。
    const fixture = await tracker.create('cross-origin-save', VALID_WORKFLOW_YAML);
    const { status } = await nodePut(
      `${BASE_URL}/api/workflows/${encodeURIComponent(fixture.id)}`,
      SAVE_BODY,
      { origin: 'https://evil.example' },
    );
    expect(status).toBe(403);
    // ファイルは変更されていない (= guard が body 受信前に短絡している)
    expect(await fixture.read()).toBe(VALID_WORKFLOW_YAML);
  });

  test('Origin が壊れた値の PUT は 403 で拒否される', async () => {
    // hooks.server.ts は new URL(origin) が throw すれば fail closed する。
    const fixture = await tracker.create('cross-origin-malformed', VALID_WORKFLOW_YAML);
    const { status } = await nodePut(
      `${BASE_URL}/api/workflows/${encodeURIComponent(fixture.id)}`,
      SAVE_BODY,
      { origin: 'not a url' },
    );
    expect(status).toBe(403);
    expect(await fixture.read()).toBe(VALID_WORKFLOW_YAML);
  });

  test('Referer が cross-origin の PUT (Origin 不在) は 403 で拒否される', async () => {
    // Origin を欠落させ、Referer のみで判定される経路をついて、
    // それでも cross-origin が拒否されることを担保する。
    const fixture = await tracker.create('cross-origin-referer', VALID_WORKFLOW_YAML);
    const { status } = await nodePut(
      `${BASE_URL}/api/workflows/${encodeURIComponent(fixture.id)}`,
      SAVE_BODY,
      { referer: 'https://evil.example/page' },
    );
    expect(status).toBe(403);
    expect(await fixture.read()).toBe(VALID_WORKFLOW_YAML);
  });

  test('Origin / Referer が同オリジンなら PUT は通過する（guard が誤って通過させていないことの positive 担保）', async () => {
    // 観点 (review-e2e.md N-4): guard 自体が機能している前提を positive 側
    // でも担保する。これがないと「全部 403 になる broken 環境」でテストが
    // 通ってしまう。
    const fixture = await tracker.create('same-origin-save', VALID_WORKFLOW_YAML);
    const { status } = await nodePut(
      `${BASE_URL}/api/workflows/${encodeURIComponent(fixture.id)}`,
      SAVE_BODY,
      { origin: BASE_URL },
    );
    expect(status).toBe(200);
    expect(await fixture.read()).toBe(SAVE_BODY);
  });

  test('Origin / Referer ヘッダなしの PUT は (CLI ケース扱いで) 通過する（負担増を起こさない）', async () => {
    // 観点 (hooks.server.ts コメント): browser はクロスオリジン POST で必ず
    // Origin を送るので、Origin/Referer 双方の不在は CLI シナリオと判断して
    // accept する。
    const fixture = await tracker.create('cli-style-save', VALID_WORKFLOW_YAML);
    const { status } = await nodePut(
      `${BASE_URL}/api/workflows/${encodeURIComponent(fixture.id)}`,
      SAVE_BODY,
      {},
    );
    // localhost guard を抜けているので 200 になるはず。
    expect(status).toBe(200);
    expect(await fixture.read()).toBe(SAVE_BODY);
  });
});

test.describe('save-workflow API: localhost guard / 環境前提', () => {
  test('localhost からの PUT は (ALLOW_PUBLIC_MUTATIONS=未設定) で通過する（環境前提の positive 担保）', async () => {
    // 観点 (review-e2e.md N-4 / S-5): playwright の dev server は
    // ALLOW_PUBLIC_MUTATIONS=未設定 (= localhost guard 有効) で起動される。
    // 「localhost なら通る」「localhost guard は通過した」の両立を 1 件で
    // positive に担保する。実際の cross-origin 拒否は同 spec の他テストで。
    const fixture = await tracker.create('localhost-save', VALID_WORKFLOW_YAML);
    const { status } = await nodePut(
      `${BASE_URL}/api/workflows/${encodeURIComponent(fixture.id)}`,
      SAVE_BODY,
      { origin: BASE_URL },
    );
    expect(status).toBe(200);
    expect(await fixture.read()).toBe(SAVE_BODY);
  });
});
