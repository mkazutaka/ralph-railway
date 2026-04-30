import { test, expect } from '@playwright/test';
import { VALID_WORKFLOW_YAML, createFixtureTracker } from '../helpers/workflowFixtures';

// API-level integration tests for the insert-pattern endpoint. Cases here
// cannot be reproduced through the UI (e.g. UnknownPattern, registry / API
// consistency), so we exercise the same backend the UI calls and document the
// expected behavior. Kept separate from `insert-pattern.spec.ts` so the
// Playwright `request` fixture is not multiplexed with `page`-driven tests in
// the same file.
const tracker = createFixtureTracker();

test.afterEach(async () => {
  await tracker.cleanupAll();
});

test.describe('insert-pattern API: registry / 受理集合の整合性', () => {
  test('ピッカーに表示される全パターン id が API でも受理される（UI と registry の整合性 / UnknownPattern 仕様化）', async ({
    request,
  }) => {
    // GET /api/patterns で UI 経由で見える id 集合を取得
    const listResponse = await request.get('/api/patterns');
    expect(listResponse.ok()).toBe(true);
    const patterns = (await listResponse.json()) as Array<{
      id: string;
      supported: boolean;
    }>;
    expect(patterns.length).toBeGreaterThan(0);

    // ワークフロー固定の上で、supported=true は POST が成功し、supported=false は 409 を返す。
    // 一覧外の id は 404 (UnknownPattern) を返す — UI は registry id しか露出しないので、
    // 一覧内の全 id が許容され、一覧外の id は確実に拒否されることを確認する。
    //
    // (review §3 m-6) 旧テストは同一 fixture に対して全 supported pattern を
    // 順次 POST していたため、後続イテレーションは前回挿入された ID と base id
    // が衝突し、リネーム解決ロジックの副産物 (suffix 付与) で「沈黙的にパス」
    // する経路があった。registry に新 pattern が追加されて既存 template と
    // base id が同名になった場合に気付けない。各 pattern について新規 fixture
    // を作り、独立した workflow で 200 が返ることを担保する。
    for (const p of patterns) {
      const fixture = await tracker.create(
        `registry-consistency-${p.id}`,
        VALID_WORKFLOW_YAML,
      );
      const res = await request.post(
        `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
        { data: { patternId: p.id } },
      );
      if (p.supported) {
        expect(res.status(), `${p.id} should be accepted`).toBe(200);
      } else {
        // UnsupportedPattern → 409
        expect(res.status(), `${p.id} should be marked unsupported`).toBe(409);
      }
    }

    // 一覧外の id は UnknownPattern → 404 (専用の fixture で隔離)
    const fixture = await tracker.create('registry-unknown', VALID_WORKFLOW_YAML);
    const unknownRes = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      { data: { patternId: 'definitely-not-a-pattern' } },
    );
    expect(unknownRes.status()).toBe(404);
  });

  test('登録済み id でも (PatternId 正規表現は通るが registry に無い id) は UnknownPattern として 404', async ({
    request,
  }) => {
    const fixture = await tracker.create('unknown-pattern-id', VALID_WORKFLOW_YAML);
    // 'sequence' は PATTERN_ID_RE をパスするが registry には未登録
    const res = await request.post(
      `/api/workflows/${encodeURIComponent(fixture.id)}/patterns`,
      { data: { patternId: 'sequence' } },
    );
    expect(res.status()).toBe(404);
    // ファイルは変更されない
    const onDisk = await fixture.read();
    expect(onDisk).toBe(VALID_WORKFLOW_YAML);
  });

  test('UI の SUPPORTED_PATTERNS / UNSUPPORTED_PATTERNS テーブルと /api/patterns が一致する（registry 増加時の沈黙パス防止）', async ({
    request,
  }) => {
    // review 推奨 3: registry に新パターンを追加したのにテストテーブルを
    // 更新し忘れた場合、件数アサーションで気付ける一方、supported/unsupported
    // の振り分けは合わせて触らないと気付かないまま通る。`/api/patterns` を
    // 真とし、ここで両者の id 集合と supported フラグが完全一致することを
    // 検証することで沈黙パスを防ぐ。
    const listResponse = await request.get('/api/patterns');
    expect(listResponse.ok()).toBe(true);
    const patterns = (await listResponse.json()) as Array<{
      id: string;
      supported: boolean;
    }>;

    // Keep these literals in sync with the UI tables in
    // `apps/web/e2e/insert-pattern.spec.ts`. Diverging from the API will
    // immediately fail this test with a clear diff message.
    const expectedSupported = ['do', 'if', 'switch', 'loop', 'set'];
    const expectedUnsupported = ['fork', 'try', 'retry'];

    const apiSupported = patterns.filter((p) => p.supported).map((p) => p.id).sort();
    const apiUnsupported = patterns.filter((p) => !p.supported).map((p) => p.id).sort();

    expect(apiSupported).toEqual([...expectedSupported].sort());
    expect(apiUnsupported).toEqual([...expectedUnsupported].sort());

    // 集合の和が API のすべてを覆う (テーブルから漏れた id がない)
    expect(apiSupported.length + apiUnsupported.length).toBe(patterns.length);
  });
});
