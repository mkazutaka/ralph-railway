import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALID_WORKFLOW_YAML, createFixtureTracker } from '../helpers/workflowFixtures';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const tracker = createFixtureTracker();

test.afterEach(async () => {
  await tracker.cleanupAll();
});

// API-level (integration) security checks for the insert-pattern endpoint.
//
// Scope:
// - Path traversal / arbitrary file write through the workflow id.
// - patternId input validation (empty, prototype-pollution-style, oversized).
// - Cross-origin mutation rejection (hooks.server.ts).
//
// These cases cannot be reproduced from the UI because the UI only exposes
// registry-listed pattern ids and load-served workflow ids. They are kept
// out of `apps/web/e2e/` proper (which is reserved for UI-driven E2E) and
// live under `e2e/integration/` to make the boundary explicit.
test.describe('insert-pattern API: 入力検証 / パストラバーサル の境界', () => {
  test('ワークフロー id にパストラバーサル (../) を含む POST は 400 で拒否される', async ({
    request,
  }) => {
    // `..%2F..%2Fetc%2Fpasswd.yaml` 等。`asWorkflowId` の正規表現が basename
    // しか許さないため、SvelteKit のパスマッチで basename に正規化された後の
    // id が検査に落ちて 400 が確定挙動。実装が basename のみ許可する仕様な
    // ので 400 で固定する (以前は 400/404 を許容していたが、仕様の曖昧さを
    // 助長していた)。
    const traversal = '..%2F..%2Fetc%2Fpasswd.yaml';
    const res = await request.post(`/api/workflows/${traversal}/patterns`, {
      data: { patternId: 'do' },
    });
    expect(res.status()).toBe(400);
  });

  test('ワークフロー id にバックスラッシュを含む POST は 400 で拒否される', async ({
    request,
  }) => {
    const res = await request.post(
      `/api/workflows/${encodeURIComponent('..\\evil.yaml')}/patterns`,
      { data: { patternId: 'do' } },
    );
    expect(res.status()).toBe(400);
  });

  test('ワークフロー id に NUL バイトを含む POST は 400 で拒否される', async ({ request }) => {
    // Real NUL byte before the legitimate `.yaml` extension. NUL truncation
    // attacks try to bypass extension checks by relying on C-style string
    // termination — the server must reject these outright.
    // (review 指摘 1: テスト名と挙動の乖離を解消するため、確実に NUL バイトを送る)
    const idWithNul = `foo${String.fromCharCode(0)}.yaml`;
    const res = await request.post(
      `/api/workflows/${encodeURIComponent(idWithNul)}/patterns`,
      { data: { patternId: 'do' } },
    );
    expect(res.status()).toBe(400);
  });

  test('ワークフロー id に二重エンコードされたパストラバーサルを含む POST は 400 で拒否される', async ({
    request,
  }) => {
    // `..%2F..%2Fetc%2Fpasswd.yaml` をさらにエンコードした `%252E%252E%252F...`。
    // 一度デコードされた段階で `..%2F` 文字列となり、basename 検査が `..%2F` を
    // 名前として拒否することを担保する (二重デコードしてしまうと `..` に化ける
    // ため、その回帰を防ぐ)。
    const doubleEncoded = '%252E%252E%252F%252E%252E%252Fetc%252Fpasswd.yaml';
    const res = await request.post(`/api/workflows/${doubleEncoded}/patterns`, {
      data: { patternId: 'do' },
    });
    expect(res.status()).toBe(400);
  });

  test('ワークフロー id がドット始まりの hidden file 形式なら 400 で拒否される', async ({
    request,
  }) => {
    // `.hidden.yaml` のように先頭がドットのファイル名は basename としては
    // 一見有効だが、隠しファイルへの書き込み経路は塞いでおきたい。
    // 仕様の保険として、確実に弾かれる (basename 正規表現が先頭ドットを許さない)
    // ことを確認する。
    const res = await request.post(
      `/api/workflows/${encodeURIComponent('.hidden.yaml')}/patterns`,
      { data: { patternId: 'do' } },
    );
    expect(res.status()).toBe(400);
  });

  test('ワークフロー id の拡張子が .yaml/.yml でなければ 400 で拒否される', async ({
    request,
  }) => {
    const res = await request.post('/api/workflows/evil.txt/patterns', {
      data: { patternId: 'do' },
    });
    expect(res.status()).toBe(400);
  });

  test('patternId が空文字なら 400 で拒否される', async ({ request }) => {
    const fixture = await tracker.create('patternid-empty', VALID_WORKFLOW_YAML);
    const res = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      { data: { patternId: '' } },
    );
    expect(res.status()).toBe(400);
  });

  test('patternId が __proto__ など正規表現に違反する値なら 400 で拒否される', async ({
    request,
  }) => {
    const fixture = await tracker.create('patternid-proto', VALID_WORKFLOW_YAML);
    // PATTERN_ID_RE = /^[a-z][a-z0-9_-]{0,32}$/ により `__proto__` は先頭が `_` で reject される
    const res = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      { data: { patternId: '__proto__' } },
    );
    expect(res.status()).toBe(400);

    // `constructor` は小文字英字始まりで PATTERN_ID_RE はパスするが、
    // 登録レジストリには無いので UnknownPattern (404) になることを確認
    const res2 = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      { data: { patternId: 'constructor' } },
    );
    expect(res2.status()).toBe(404);
  });

  test('patternId に改行を含む値や極端に長い文字列は 400 で拒否される', async ({ request }) => {
    const fixture = await tracker.create('patternid-bad', VALID_WORKFLOW_YAML);
    const newlineRes = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      { data: { patternId: 'do\nrm -rf /' } },
    );
    expect(newlineRes.status()).toBe(400);

    const longRes = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      { data: { patternId: 'a'.repeat(1024) } },
    );
    expect(longRes.status()).toBe(400);
  });

  test('patternId フィールドが欠落または非文字列なら 400 で拒否される', async ({ request }) => {
    const fixture = await tracker.create('patternid-missing', VALID_WORKFLOW_YAML);
    const missingRes = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      { data: {} },
    );
    expect(missingRes.status()).toBe(400);

    const nonStringRes = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      { data: { patternId: 42 } },
    );
    expect(nonStringRes.status()).toBe(400);
  });

  test('パストラバーサル経路で機微ファイルを読み出せない (GET も同じ防御を持つ)', async ({
    request,
  }) => {
    // 攻撃者は GET でファイルを読みたいかもしれない。同じ id 検査でブロック
    // されること。SvelteKit の動的ルートマッチが url-decoded な basename に
    // しか反応しないため status は 400 で固定。
    const res = await request.get('/api/workflows/..%2F..%2Fetc%2Fpasswd.yaml');
    expect(res.status()).toBe(400);
  });

  test('e2e 作業ディレクトリ外のファイルが書き込まれないことを担保する', async ({ request }) => {
    // 不正な id で POST しても、リポジトリルートに `evil.yaml` が作られないことを確認。
    // (assertValidId が basename しか許さないので 400 だが、保険として fs を見る)
    const repoRoot = resolve(__dirname, '../../../..');
    const evilPath = resolve(repoRoot, 'evil.yaml');

    const res = await request.post('/api/workflows/..%2Fevil.yaml/patterns', {
      data: { patternId: 'do' },
    });
    expect(res.status()).toBeLessThan(500);

    // ファイルが作成されていないこと
    let exists = false;
    try {
      await readFile(evilPath, 'utf8');
      exists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    expect(exists).toBe(false);
  });

  test('クロスオリジンからの POST は 403 で拒否される (CSRF / Origin guard)', async ({
    request,
  }) => {
    // (review §3 m-3) REST endpoint 経路と form action 経路で Origin guard
    // 仕様が一致していることを担保する。form action 側の同等テストは
    // `apps/web/e2e/insert-pattern.review-followup.spec.ts` (テスト名:
    // `UI 経路 (form action ?/insertPattern) に対してもクロスオリジン POST
    //  は 403 で拒否される (CSRF)`) にある。仕様を揃えて hooks.server.ts の
    // Origin guard 改修時に片方だけ更新する事故を防ぐ。
    const fixture = await tracker.create('cross-origin', VALID_WORKFLOW_YAML);
    // hooks.server.ts は Origin ヘッダ付きで host が一致しないリクエストを
    // 403 で弾く。攻撃者ブラウザが POST してきたシナリオを模す。
    const res = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      {
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        data: { patternId: 'do' },
      },
    );
    expect(res.status()).toBe(403);

    // ファイルは変更されていない
    const onDisk = await fixture.read();
    expect(onDisk).toBe(VALID_WORKFLOW_YAML);
  });

  test('巨大なリクエストボディは 413 で拒否される (DoS 防御)', async ({ request }) => {
    const fixture = await tracker.create('body-limit', VALID_WORKFLOW_YAML);
    // hooks.server.ts の上限 256 KiB を超えるダミーボディ
    const huge = 'a'.repeat(300 * 1024);
    const res = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      {
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({ patternId: 'do', _padding: huge }),
      },
    );
    // 413 (上限超過) または 400 (JSON サイズ起因の拒否)
    expect([400, 413]).toContain(res.status());
  });
});
