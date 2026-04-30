import { test, expect, request as apiRequest, type Page, type APIRequestContext } from '@playwright/test';
import {
  VALID_WORKFLOW_YAML,
  createFixtureTracker,
  type WorkflowFixture,
} from './helpers/workflowFixtures';

// E2E tests for the "List Recent Runs" sidebar panel.
//
// Scenario: apps/web/docs/scenarios/workflow-editor/list-recent-runs.md
//
// Coverage:
//   - 正常系
//     - ワークフローに 0 件: 「No runs yet」が表示される (不変条件3)
//     - ワークフローに複数件: 各 run の id / 状態 / 時刻 / 所要時間が描画され、
//       新しい順 (StartedAt 降順) で並ぶ (不変条件2)
//     - 実行中 (running) / pending の Run は durationMs=null で「running」
//       ラベルが表示される (不変条件4)
//     - 自分のワークフローの履歴のみが表示され、他ワークフローの run は
//       混入しない (不変条件1)
//     - 失敗 / キャンセル状態の Run も一覧に出る (status tooltip / dot 着色)
//     - サイドバーは API の `?limit=` 既定値 (20 件) でキャップされ、
//       21 件以上 seed しても 20 行のみ表示される (Limit 仕様の UI 経路担保)
//     - 行レイアウト: status tooltip / 相対時刻 / 所要時間 / dot がすべて出る
//     - 所要時間の単位境界 (sub-second ms / 秒 / 分 / 時) が UI 上で
//       期待文字列に変換されて描画される (review-followup: 単位切替の回帰防止)
//   - エラー系
//     - 404 (ワークフロー削除レース): role=alert に「workflow not found」
//     - ネットワーク失敗 (connectionrefused): role=alert に「Failed to load runs」
//     - 不正な workflowId (path traversal: `%2F` でエンコードした版 と
//       `..` を直書きした素の版) で URL を直叩きしたとき、SvelteKit が 4xx で
//       応答し、recent-runs パネルに他ワークフローの履歴が混入しない
//     - run id に HTML / `<script>` / `<img onerror>` を含めても、UI は
//       text として描画して script を実行しない (XSS 防御の観測)
//     - `RALPH_WEB_TEST_SEED` 未設定状態を環境変数で確認できないため、本仕様は
//       本ファイル冒頭でドキュメントとして残し、seam 経由の seed 失敗時 (例:
//       env が落ちている本番ビルドに spec を流したとき) には beforeEach の
//       `resetRunStore` が即座に失敗し、全テストが赤になることで気付ける
//       設計とする
//
// Test data is seeded via the test-only `/api/_test/runs` endpoint (gated
// by `RALPH_WEB_TEST_SEED=1`, set by `playwright.config.ts`'s webServer).
// Each test resets the store in `beforeEach` so ordering across tests is
// deterministic; the in-memory store is module-scoped so we cannot rely
// on it being empty just because a different test seeded different rows.

const tracker = createFixtureTracker();

// Recent-runs default limit (mirrors `RECENT_RUNS_DEFAULT_LIMIT` in
// `routeHelpers.ts`). Hardcoded here on purpose: if the production default
// changes, we want this E2E to fail loudly so the contract change is
// re-reviewed with the user.
const RECENT_RUNS_DEFAULT_LIMIT = 20;

interface SeedRow {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  durationMs: number | null;
}

/**
 * Build a fresh APIRequestContext for each call. We deliberately avoid the
 * worker-scoped `request` fixture: when the suite runs end-to-end (mixed
 * `page`-driven and `request`-driven specs), Playwright disposes the
 * worker's request context between files and the next `beforeEach` that
 * tries to reuse it sees `Request context disposed`. Creating + disposing
 * a context per call keeps the seed + reset path independent of fixture
 * lifecycles. Context construction is cheap (no browser involved).
 *
 * `Connection: close` is explicitly set so each request opens a fresh TCP
 * connection. The integration security spec sends a 300 KiB POST that the
 * `hooks.server.ts` body-limit guard rejects with 413 *before* draining
 * the request body; some preceding test contexts leave the keep-alive
 * connection in an inconsistent state on Vite's dev server, which causes
 * subsequent requests on a reused connection to hang. Forcing
 * `Connection: close` sidesteps that pre-existing issue without modifying
 * production hooks code.
 */
async function withApiContext<T>(
  fn: (request: APIRequestContext) => Promise<T>,
): Promise<T> {
  const ctx = await apiRequest.newContext({
    baseURL: 'http://localhost:5100',
    extraHTTPHeaders: {
      // Disable keep-alive on requests issued through this context so the
      // server does not multiplex our seed call onto a connection left in
      // a bad state by an earlier 413-rejected body upload.
      connection: 'close',
    },
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

async function resetRunStore() {
  // Retry once with a short timeout to absorb a one-off hang. The first
  // request after the integration security spec (which sends a 300 KiB
  // body that the body-limit guard rejects with 413 *before* draining
  // the body) can stall Vite's dev server briefly: the second request
  // always succeeds. We deliberately don't extend the per-test timeout
  // because that would mask real regressions.
  const attemptOnce = async () => {
    await withApiContext(async (ctx) => {
      const res = await ctx.delete('/api/_test/runs', { timeout: 5_000 });
      expect(res.ok(), 'test seed endpoint should be reachable').toBe(true);
    });
  };
  try {
    await attemptOnce();
  } catch {
    // Surface the original failure if the retry also fails — silently
    // swallowing it would let a genuinely broken endpoint pass.
    await attemptOnce();
  }
}

async function seedRuns(rows: ReadonlyArray<SeedRow>) {
  await withApiContext(async (ctx) => {
    const res = await ctx.post('/api/_test/runs', {
      data: { reset: false, rows },
    });
    expect(res.ok(), `seed should succeed: ${res.status()} ${await res.text()}`).toBe(
      true,
    );
  });
}

async function gotoWorkflow(page: Page, fixture: WorkflowFixture) {
  await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);
  // Wait for the page to render the editor heading so we know hydration is in
  // progress before we start asserting against the recent-runs panel.
  await expect(
    page.getByRole('textbox', { name: 'Workflow YAML' }),
  ).toBeVisible();
}

/**
 * Locate the recent-runs section by its accessible region role + name.
 * Now that `<section role="region" aria-labelledby="recent-runs-heading">`
 * is set explicitly, we no longer need an `.or()` fallback or `.first()`.
 */
function recentRunsSection(page: Page) {
  return page.getByRole('region', { name: 'RECENT RUNS' });
}

/** Locate the run list (rendered only when there is at least one row). */
function runList(page: Page) {
  return page.getByRole('list', { name: 'Recent runs' });
}

test.describe('list-recent-runs: ユーザがサイドバーで直近の実行履歴を確認する', () => {
  test.beforeEach(async () => {
    // Each test starts with a clean in-memory store. Without this reset,
    // a row appended by a previous test could "leak" into a workflow id we
    // happen to reuse — fixture ids are timestamped + random so collision
    // is unlikely, but the reset makes the contract unambiguous.
    await resetRunStore();
  });

  test.afterEach(async () => {
    // Clean up workflow files and the in-memory run store so neither
    // bleeds into the next test.
    await tracker.cleanupAll();
    await resetRunStore();
  });

  test('セクション見出し「RECENT RUNS」が常に表示される（パネル契約）', async ({
    page,
  }) => {
    // Arrange: 履歴 0 件のワークフロー
    const fixture = await tracker.create('recent-runs-heading', VALID_WORKFLOW_YAML);

    // Act
    await gotoWorkflow(page, fixture);

    // Assert: 見出しは状態に関わらず常時表示され、region としてもアクセス可能
    await expect(
      page.getByRole('heading', { name: 'RECENT RUNS' }),
    ).toBeVisible();
    await expect(recentRunsSection(page)).toBeVisible();
  });

  test('履歴が 0 件のとき「No runs yet」と表示される（不変条件3: 0件は空配列）', async ({
    page,
  }) => {
    // Arrange: 同じワークフロー id で run を一切 seed しない
    const fixture = await tracker.create('recent-runs-empty', VALID_WORKFLOW_YAML);

    // Act
    await gotoWorkflow(page, fixture);

    // Assert: 空状態の文言が表示され、リストも error も出ない
    const section = recentRunsSection(page);
    await expect(section.getByText('No runs yet')).toBeVisible();
    // 0 件状態では `<ul aria-label="Recent runs">` 自体が描画されない
    await expect(runList(page)).toHaveCount(0);
    // role=alert (エラー) も出ない
    await expect(section.getByRole('alert')).toHaveCount(0);
  });

  test('複数の履歴が新しい順 (StartedAt 降順) で表示される（不変条件2）', async ({
    page,
  }) => {
    // Arrange: 3 件の run。`startedAt` の値はわざと挿入順と逆にして並べ替え
    // ロジックを検証する。
    const fixture = await tracker.create('recent-runs-order', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    await seedRuns([
      // 一番古い (1 時間前)
      {
        id: 'run-old',
        workflowId: fixture.id,
        status: 'succeeded',
        startedAt: baseNow - 60 * 60 * 1000,
        durationMs: 12_000,
      },
      // 一番新しい (1 分前)
      {
        id: 'run-new',
        workflowId: fixture.id,
        status: 'failed',
        startedAt: baseNow - 60 * 1000,
        durationMs: 3_500,
      },
      // 中間 (10 分前)
      {
        id: 'run-mid',
        workflowId: fixture.id,
        status: 'cancelled',
        startedAt: baseNow - 10 * 60 * 1000,
        durationMs: 800,
      },
    ]);

    // Act
    await gotoWorkflow(page, fixture);

    // Assert: 3 行表示され、id の並びは startedAt 降順
    const list = runList(page);
    await expect(list).toBeVisible();
    const items = list.getByRole('listitem');
    await expect(items).toHaveCount(3);
    // 行の中身 (id) を順に取得して期待順を検証する。`textContent()` の同期
    // 取得後比較は retry が効かないため、最終的な並びが安定するまで poll
    // できる `toContainText` の配列バリアントを使う。
    await expect(items).toContainText(['run-new', 'run-mid', 'run-old']);
  });

  test('実行中 (running) の Run は durationMs=null で「running」ラベルが表示される（不変条件4）', async ({
    page,
  }) => {
    // Arrange: running と succeeded を 1 件ずつ
    const fixture = await tracker.create('recent-runs-running', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    await seedRuns([
      {
        id: 'run-active',
        workflowId: fixture.id,
        status: 'running',
        // 30 秒前開始 → "30s" 相当の relative time が出る
        startedAt: baseNow - 30 * 1000,
        durationMs: null,
      },
      {
        id: 'run-finished',
        workflowId: fixture.id,
        status: 'succeeded',
        startedAt: baseNow - 5 * 60 * 1000,
        durationMs: 4_200,
      },
    ]);

    // Act
    await gotoWorkflow(page, fixture);

    // Assert: 行が 2 件表示され、running 行には "running" ラベル、
    // succeeded 行には数値の duration ("4s" や "4.2s") が表示される
    const list = runList(page);
    await expect(list).toBeVisible();
    const items = list.getByRole('listitem');
    await expect(items).toHaveCount(2);

    // 正規 a11y 経路は `aria-label` (RecentRuns.svelte の rowAriaLabel)。
    // status は aria-label に必ず含まれるので、これを主検証とする
    // (review-followup §3: title はあくまで補助で、コンポーネントが将来
    // title を外しても aria-label が壊れない限り status の伝達は保たれる)。
    const runningRow = list.getByRole('listitem', {
      name: /run-active.*running.*started.*ago.*running/i,
    });
    await expect(runningRow).toHaveCount(1);
    // 視覚出力に "running" ラベル文言が含まれることも確認する
    await expect(runningRow).toContainText('running');
    // 補助: status のツールチップ属性も running を表す。CSS セレクタ
    // `span[title]` ではなく `getByTitle` を使い user-facing locator に揃える。
    await expect(runningRow.getByTitle('status: running')).toBeVisible();

    // succeeded 行は具体的な所要時間 (秒オーダー) を表示する。
    // aria-label には `took 4.2s` の形で含まれる。
    const finishedRow = list.getByRole('listitem', {
      name: /run-finished.*succeeded.*started.*ago.*took 4\.2s/i,
    });
    await expect(finishedRow).toHaveCount(1);
    // 4_200 ms → "4.2s" (視覚出力)
    await expect(finishedRow).toContainText('4.2s');
    // 完了行は "running" ラベル文言を視覚的に含まない (右端カラムは duration)。
    // aria-label には "started 5m ago" が含まれるが "running" 文字列は出ない。
    await expect(finishedRow).not.toContainText('running');
    // 補助: succeeded 行も独自の status tooltip を持つ
    await expect(finishedRow.getByTitle('status: succeeded')).toBeVisible();
  });

  test('pending 状態の Run も一覧に含まれ、durationMs は null で「running」ラベルが出る（不変条件4: 実行中扱い）', async ({
    page,
  }) => {
    // Arrange: pending 1 件のみ
    const fixture = await tracker.create('recent-runs-pending', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    await seedRuns([
      {
        id: 'run-queued',
        workflowId: fixture.id,
        status: 'pending',
        startedAt: baseNow - 2 * 1000,
        durationMs: null,
      },
    ]);

    // Act
    await gotoWorkflow(page, fixture);

    // Assert: aria-label には status=pending と tail=runningLabel が含まれる
    // (review-followup §3: 正規 a11y 経路で status を確認する)
    const list = runList(page);
    const items = list.getByRole('listitem');
    await expect(items).toHaveCount(1);
    const queuedRow = list.getByRole('listitem', {
      name: /run-queued.*pending.*started.*ago.*running/i,
    });
    await expect(queuedRow).toHaveCount(1);
    // 視覚出力にも id と "running" 文言が出る
    await expect(queuedRow).toContainText('run-queued');
    await expect(queuedRow).toContainText('running');
    // 補助: status tooltip も pending を反映 (CSS セレクタを避けて getByTitle)
    await expect(queuedRow.getByTitle('status: pending')).toBeVisible();
  });

  test('失敗 (failed) / キャンセル (cancelled) の Run も一覧に出て、それぞれの status tooltip と dot が描画される（dot tint 分岐の回帰防止）', async ({
    page,
  }) => {
    // Arrange: failed と cancelled は dot tint が同じ (`--color-danger`) だ
    // が、tooltip は別文字列 (`status: failed` / `status: cancelled`)。
    // ordering テスト経由ではなく独立にアサートして `recentRunsFormat.ts`
    // の `statusDotVar` 分岐回帰を検出する。
    const fixture = await tracker.create('recent-runs-non-success', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    await seedRuns([
      {
        id: 'run-failed',
        workflowId: fixture.id,
        status: 'failed',
        startedAt: baseNow - 5 * 60 * 1000,
        durationMs: 700,
      },
      {
        id: 'run-cancelled',
        workflowId: fixture.id,
        status: 'cancelled',
        startedAt: baseNow - 10 * 60 * 1000,
        durationMs: 1_400,
      },
    ]);

    // Act
    await gotoWorkflow(page, fixture);

    // Assert: status は aria-label を主検証経路にする (review-followup §3)
    const list = runList(page);
    const items = list.getByRole('listitem');
    await expect(items).toHaveCount(2);

    const failedRow = list.getByRole('listitem', {
      name: /run-failed.*failed.*started.*ago.*took 700ms/i,
    });
    await expect(failedRow).toHaveCount(1);
    // 補助: title 属性 (将来 title が外れたら気付ける副次検証)
    await expect(failedRow.getByTitle('status: failed')).toBeVisible();
    // dot 装飾が描画されている (data-testid 経由で a11y ツリーに依存しない取得)
    await expect(failedRow.getByTestId('run-status-dot')).toBeVisible();
    // failed は終了状態なので "running" ラベルは出ない
    await expect(failedRow).not.toContainText('running');
    // 700ms → "700ms"
    await expect(failedRow).toContainText('700ms');

    const cancelledRow = list.getByRole('listitem', {
      name: /run-cancelled.*cancelled.*started.*ago.*took 1\.4s/i,
    });
    await expect(cancelledRow).toHaveCount(1);
    await expect(cancelledRow.getByTitle('status: cancelled')).toBeVisible();
    await expect(cancelledRow.getByTestId('run-status-dot')).toBeVisible();
    await expect(cancelledRow).not.toContainText('running');
    await expect(cancelledRow).toContainText('1.4s');
  });

  test('別ワークフローの履歴は表示されない（不変条件1: 自ワークフローのみ）', async ({
    page,
  }) => {
    // Arrange: 自分のワークフロー A と無関係なワークフロー B を作成し、
    // 両方に run を seed する。A の画面を開いたとき、B の run が
    // 漏れて表示されないことを確認する。
    const fixtureA = await tracker.create('recent-runs-isolation-a', VALID_WORKFLOW_YAML);
    const fixtureB = await tracker.create('recent-runs-isolation-b', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    await seedRuns([
      {
        id: 'run-a-only',
        workflowId: fixtureA.id,
        status: 'succeeded',
        startedAt: baseNow - 60 * 1000,
        durationMs: 1_000,
      },
      {
        id: 'run-b-leak-canary',
        workflowId: fixtureB.id,
        status: 'succeeded',
        startedAt: baseNow - 30 * 1000,
        durationMs: 1_000,
      },
    ]);

    // Act: A のページを開く
    await gotoWorkflow(page, fixtureA);

    // Assert: A の run のみ表示され、B の run id は一切出てこない
    const list = runList(page);
    await expect(list).toBeVisible();
    const items = list.getByRole('listitem');
    await expect(items).toHaveCount(1);
    await expect(items).toContainText('run-a-only');
    // B 側の id がパネルのどこにも出ないこと (リーク回帰防止)
    await expect(recentRunsSection(page)).not.toContainText(
      'run-b-leak-canary',
    );
  });

  test('履歴が API の既定 limit (20 件) を超えても、サイドバーには 20 行のみ表示される（Limit 仕様の UI 経路担保）', async ({
    page,
  }) => {
    // 観点: `/api/workflows/:id/runs` は `?limit` 既定値で 20 件にキャップ
    // する (RECENT_RUNS_DEFAULT_LIMIT)。RecentRuns コンポーネントは
    // フロント側で limit を渡していないので、サーバの既定値が UI に
    // 反映されることを実 API 経由で観測する。25 件 seed して 20 行に
    // 丸まることを確認する。
    const fixture = await tracker.create('recent-runs-limit', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    const seedCount = 25;
    const rows: SeedRow[] = [];
    for (let i = 0; i < seedCount; i++) {
      // startedAt を i に応じて単調減少させ、i=0 が最新になるよう並べる。
      // これで「上位 20 行 = 最新 20 件 (i=0..19)」「i=20..24 は cap で
      // 切り捨てられる」という関係が決定的に成立する。
      rows.push({
        id: `run-${String(i).padStart(2, '0')}`,
        workflowId: fixture.id,
        status: 'succeeded',
        startedAt: baseNow - i * 60 * 1000,
        durationMs: 1_000 + i,
      });
    }
    await seedRuns(rows);

    // Act
    await gotoWorkflow(page, fixture);

    // Assert: 描画される行は既定 limit (20) と一致する
    const items = runList(page).getByRole('listitem');
    await expect(items).toHaveCount(RECENT_RUNS_DEFAULT_LIMIT);
    // 最新の i=0 と境界 i=19 は表示される
    await expect(items.filter({ hasText: 'run-00' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'run-19' })).toHaveCount(1);
    // i=20 と i=24 (古い側) は cap で切り捨てられて表示されない
    await expect(recentRunsSection(page)).not.toContainText('run-20');
    await expect(recentRunsSection(page)).not.toContainText('run-24');
  });

  test('ページを開いた後にワークフローファイルが削除されると、パネル fetch が 404 を返し UI に「workflow not found」が表示される（削除レース）', async ({
    page,
  }) => {
    // 観点: recent-runs パネル独自の 404 分岐 (`'workflow not found'` 文言)
    // が「実際のサーバ応答が 404 だったとき」に発火することを担保する。
    //
    // ページ load 関数自体はワークフロー YAML を読むため、ファイルが
    // 最初から無いと SvelteKit のエラーページに飛ばされてパネルに到達しない。
    // そこで以下の現実的なレースを再現する:
    //   1. ワークフローを通常通り作成し、ページを開く (load 成功)
    //   2. パネルが `/api/workflows/:id/runs` を fetch する直前に
    //      `route` でリクエストを hold する
    //   3. ファイルをディスクから削除する (= バックエンドの真の状態変化)
    //   4. hold を解放して route.continue() — 実 API がファイルを read し
    //      404 を返す
    // route.fulfill による偽応答ではなく、route.continue を経由した実 API
    // 応答を観測することで「サーバ実装が壊れたら気付ける」契約を保つ。
    const fixture = await tracker.create('recent-runs-404', VALID_WORKFLOW_YAML);

    let runsCallCount = 0;
    // Deferred パターン: route handler はこの Promise を await して hold し、
    // 外側で `release()` を呼ぶと進む。AbortController を「signal=abort で
    // 進めて良い」と意味論を反転させて使うのは読みづらかったため、シンプルな
    // resolve 参照保持に置き換える (review-followup §4)。
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const routeMatcher = (url: URL) =>
      url.pathname === `/api/workflows/${encodeURIComponent(fixture.id)}/runs`;
    await page.route(routeMatcher, async (route) => {
      runsCallCount += 1;
      // hold 中に外側で fixture.cleanup() を完了させてから
      // route.continue() でサーバへ届ける
      await released;
      await route.continue();
    });

    // Act: ページを開く (load は成功) → パネル fetch が hold される
    await gotoWorkflow(page, fixture);

    // ファイル削除 (= バックエンドの状態が変わる)
    await fixture.cleanup();
    // hold 解放 → 実 API が ENOENT を観測して 404 を返す
    release();

    // Assert: パネル内の role=alert に「workflow not found」が表示される
    const section = recentRunsSection(page);
    const alert = section.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText('workflow not found');
    // リスト / 空文言は出ない
    await expect(runList(page)).toHaveCount(0);
    await expect(section.getByText('No runs yet')).toHaveCount(0);

    // route が実際に呼ばれていること (matcher が壊れて沈黙的に通ることを防ぐ)
    expect(runsCallCount).toBeGreaterThanOrEqual(1);

    await page.unroute(routeMatcher);
  });

  test('ネットワーク障害（接続失敗）が起きたときパネルに「Failed to load runs」が表示される（catch 経路 / 汎用エラー文言）', async ({
    page,
  }) => {
    // 観点: バックエンドが一時的に応答しない / DNS / TLS / 接続切断などの
    // 実際のネットワーク失敗が起きたとき、パネルが「Failed to load runs」
    // という汎用文言で UI を保護することを担保する。
    //
    // route.abort('connectionrefused') は実 API への到達を妨げて、
    // production でも起こりうる "サーバ未起動 / 接続拒否" と同じ状態を
    // ブラウザに観測させる。fetch は TypeError を投げ、UI は catch 経路
    // で `loadState = error` に遷移する。これはサーバを偽応答で置換する
    // モックではなく、ネットワーク層の現実的な障害を再現する介入。
    const fixture = await tracker.create('recent-runs-network', VALID_WORKFLOW_YAML);

    let runsCallCount = 0;
    const routeMatcher = (url: URL) =>
      url.pathname === `/api/workflows/${encodeURIComponent(fixture.id)}/runs`;
    await page.route(routeMatcher, async (route) => {
      runsCallCount += 1;
      await route.abort('connectionrefused');
    });

    // Act
    await gotoWorkflow(page, fixture);

    // Assert: 汎用文言が出る (内部エラー情報を UI に漏らさない)
    const section = recentRunsSection(page);
    const alert = section.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText('Failed to load runs');
    // 失敗時はリスト / 空文言が出ない
    await expect(runList(page)).toHaveCount(0);
    await expect(section.getByText('No runs yet')).toHaveCount(0);
    // 接続拒否されたので少なくとも 1 回は route が起動している
    expect(runsCallCount).toBeGreaterThanOrEqual(1);

    await page.unroute(routeMatcher);
  });

  test('path-traversal な workflowId で URL を直叩きすると、recent-runs パネルが他ワークフローの履歴を吐かない（境界の不変条件1）', async ({
    page,
  }) => {
    // 観点: `parseWorkflowParam` の brand 検査が、`..%2F..%2Fetc%2Fpasswd`
    // のような id を弾くことは backend のテストで担保されているが、
    // E2E でも「ユーザがそういう URL を踏んだとき UI が崩れたり、別の
    // workflow の履歴を表示したりしない」ことを確認する。
    //
    // 別ワークフロー (B) を seed しておき、攻撃ペイロードでアクセスした
    // ときに B の履歴が漏れてこないことを確認する。
    const fixtureB = await tracker.create('recent-runs-traversal-victim', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    await seedRuns([
      {
        id: 'run-b-secret',
        workflowId: fixtureB.id,
        status: 'succeeded',
        startedAt: baseNow - 30 * 1000,
        durationMs: 1_000,
      },
    ]);

    // Act: path-traversal な id を URL に直接埋め込む。`encodeURIComponent`
    // で `/` をパーセントエンコードしないと SvelteKit のルータが別ルート
    // にマッチしてしまうので明示的にエンコードする。
    const evilId = '..%2F..%2Fetc%2Fpasswd';
    const response = await page.goto(`/workflows/${evilId}`);

    // Assert: SvelteKit が 4xx を返す (400 もしくは 404 — 仕様としては
    // どちらも path-traversal をブロックする結果なので、>= 400 をチェック)
    expect(response).not.toBeNull();
    expect(response!.status()).toBeGreaterThanOrEqual(400);
    expect(response!.status()).toBeLessThan(500);

    // 攻撃ページに B の機微 id が含まれていないこと。SvelteKit のエラー
    // ページにせよ recent-runs パネルにせよ、別 workflow の履歴を吐いて
    // はいけない (情報漏洩防止)。
    await expect(page.locator('body')).not.toContainText('run-b-secret');
  });

  test('1 件の履歴が描画され、status tooltip / 相対時刻 / 所要時間がそれぞれ含まれる（行レイアウトの統合検証）', async ({
    page,
  }) => {
    // (review fallback) 行ごとの細かいレンダリング契約 (status dot + id + time
    // + duration) が将来 silently 退化しないように、最小限のシナリオで
    // すべての要素が同時に出ていることを担保する。
    const fixture = await tracker.create('recent-runs-row-shape', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    await seedRuns([
      {
        id: 'run-shape',
        workflowId: fixture.id,
        // 不変条件: succeeded の Run は durationMs を必ず持つ
        status: 'succeeded',
        startedAt: baseNow - 90 * 1000,
        durationMs: 1_500,
      },
    ]);

    await gotoWorkflow(page, fixture);

    const items = runList(page).getByRole('listitem');
    await expect(items).toHaveCount(1);
    const row = items.first();
    // id (truncate されても文字列としては保持される)
    await expect(row).toContainText('run-shape');
    // 所要時間 (1500ms → "1.5s")
    await expect(row).toContainText('1.5s');
    // 相対時刻列の検証は aria-label の "started X ago" 句で行う。
    // 視覚出力の `\d+(s|m|h|d)` 正規表現にフォールバックすると duration
    // ("1.5s") にも当たるため、relative-time が silently 消えても気付けない
    // (review-followup §4)。aria-label は `started ${relative} ago` 専用の
    // フィールドなので duration と衝突しない。
    await expect(row).toHaveAttribute(
      'aria-label',
      /started \d+(s|m|h|d) ago/,
    );
    // status tooltip (user-facing locator: getByTitle)
    await expect(row.getByTitle('status: succeeded')).toBeVisible();
    // status dot (装飾) は data-testid 経由で取得し、CSS セレクタや
    // `[aria-hidden="true"]` 依存を避ける (review §5)。
    await expect(row.getByTestId('run-status-dot')).toBeVisible();
  });

  test('所要時間の単位境界 (ms / 秒 / 分 / 時) が UI に正しく描画される（review-followup §1: 単位切替の回帰防止）', async ({
    page,
  }) => {
    // 観点: `recentRunsFormat.formatDuration` は durationMs に応じて
    //   - <1000ms     → "Nms"
    //   - <60_000ms   → "N.Ns" (sec<10) / "Ns" (sec>=10)
    //   - <3_600_000  → "Nm" / "NmMs"
    //   - >=3_600_000 → "Nh" / "NhMm"
    // と単位を切り替える。単体テストでは担保されているが、UI 経路でも
    // 「長時間 run の表示が突然壊れる」回帰を E2E で踏みたい (review-followup §1)。
    //
    // それぞれの単位境界を踏む 6 件を seed し、各行の aria-label 末尾
    // (`took ...`) で期待文字列をピンする。aria-label を使うのは
    //   1) duration 文字列が独立したフィールドとして表現されるため、
    //      relative-time とぶつからない厳密な部分一致ができる
    //   2) review-followup §3 の方針 (a11y 経路を主検証) と整合する
    // から。
    const fixture = await tracker.create(
      'recent-runs-duration-units',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();

    // 単位境界の代表値。startedAt は順序が安定するように単調減少。
    const cases: Array<{ id: string; durationMs: number; expected: string }> = [
      // 0ms — 境界 (Math.max(0, round(0)))
      { id: 'd-zero', durationMs: 0, expected: 'took 0ms' },
      // 999ms — 1 秒未満の上限
      { id: 'd-sub-second', durationMs: 999, expected: 'took 999ms' },
      // 1000ms — 秒単位への切替 (sec<10 → toFixed(1) → "1.0s")
      { id: 'd-one-second', durationMs: 1000, expected: 'took 1.0s' },
      // 90_000ms (90s = 1分30秒) — 分単位への切替で remSec≠0 の枝
      { id: 'd-minute-split', durationMs: 90_000, expected: 'took 1m30s' },
      // 3_600_000ms (1時間ぴったり) — 時単位への切替で remMin=0 の枝
      { id: 'd-one-hour', durationMs: 3_600_000, expected: 'took 1h' },
      // 5_400_000ms (1時間30分) — 時単位への切替で remMin≠0 の枝
      { id: 'd-hour-split', durationMs: 5_400_000, expected: 'took 1h30m' },
    ];

    await seedRuns(
      cases.map((c, i) => ({
        id: c.id,
        workflowId: fixture.id,
        status: 'succeeded' as const,
        startedAt: baseNow - i * 60 * 1000,
        durationMs: c.durationMs,
      })),
    );

    await gotoWorkflow(page, fixture);

    const list = runList(page);
    await expect(list.getByRole('listitem')).toHaveCount(cases.length);

    // 各 case の aria-label に期待 duration が含まれること
    for (const c of cases) {
      // RegExp.escape 相当: 単純な値しか入らないので手動 escape も不要。
      // 万一の正規表現メタ文字混入に備え、`String.raw` ではなく Regex リテラル
      // ではない `new RegExp` で `escapeRegex` 相当を避けるためベタ構築する。
      const escaped = c.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const row = list.getByRole('listitem', {
        name: new RegExp(`${c.id}.*succeeded.*${escaped}`),
      });
      await expect(row).toHaveCount(1);
      // 視覚出力にも duration 文字列が出ていることを担保
      // (aria-label だけが正しく視覚表示が壊れている、を検出するため)。
      await expect(row).toContainText(c.expected.replace('took ', ''));
    }
  });

  test('path-traversal を生 ASCII (`..`) のままURLに埋め込んでも別ワークフローの履歴が漏洩しない（review-followup §2: エスケープなし版の境界）', async ({
    page,
  }) => {
    // 観点: 攻撃者は `encodeURIComponent` を通さず、生の `..` や `/` を含む
    // URL を直接ブラウザ / curl から投げ込むことが多い。SvelteKit のパス
    // 正規化 (path collapsing) を経由する経路と、`%2F` を残してミドルウェア
    // に届く経路は別物で、後者は別テスト (元の path-traversal テスト) で
    // カバーされている。本テストは前者の経路を踏む。
    //
    // 期待挙動: SvelteKit のルータが `/workflows/[id]` パターンに `..` を
    // 含むセグメントをマッチさせず、4xx エラー (typically 404 from the
    // Svelte error page or the router) が返る。少なくともレスポンス本文に
    // 別ワークフローの run id が含まれてはならない (情報漏洩防止)。
    const fixtureB = await tracker.create(
      'recent-runs-traversal-raw-victim',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    await seedRuns([
      {
        id: 'run-b-raw-secret',
        workflowId: fixtureB.id,
        status: 'succeeded',
        startedAt: baseNow - 30 * 1000,
        durationMs: 1_000,
      },
    ]);

    // Act: 生の `..` と `/` を URL に埋め込む。ブラウザは URL を正規化する
    // ので最終的には `/etc/passwd` 相当の path に collapse される可能性が
    // あるが、それは「SvelteKit が別ワークフロー id とは解釈しない」結末を
    // 観測したいだけなので問題ない。
    const response = await page.goto('/workflows/../../etc/passwd');

    // Assert: 4xx (path-traversal がブロックされる) または 404 (別ルートに
    // collapse されてマッチしない) のいずれか。500 系であれば SvelteKit が
    // 落ちている可能性があり、それは別の不具合として検出したい。
    expect(response).not.toBeNull();
    const status = response!.status();
    expect(
      status,
      `expected 4xx for raw-traversal URL, got ${status}`,
    ).toBeGreaterThanOrEqual(400);
    expect(
      status,
      `expected 4xx for raw-traversal URL, got ${status}`,
    ).toBeLessThan(500);

    // ページ本文に B の機微 id が出ないこと。SvelteKit のエラーページにも
    // 攻撃成功時の偽パネルにも漏れてはならない。
    await expect(page.locator('body')).not.toContainText('run-b-raw-secret');
  });

  test('run id に HTML / `<script>` を含むペイロードを seed してもブラウザに到達せず、防御層 (brand 検証) と UI 表示の両方が崩れない（XSS 多重防御の観測）', async ({
    page,
  }) => {
    // 観点 (review-followup §5): scenario の `RunId = string` は型を弱く
    //取っているが、production の read path は `buildRunSummaryFromRow` の
    // brand 検証で `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` に一致しない id を
    // 拒否している (`runSummary.ts`)。これは XSS の第一防御層であり、
    // E2E 上ではこれが実際に発火することを確認したい。
    //
    // テストフロー:
    //   1. test-only seed エンドポイントは構造的バリデーションのみ行う
    //      (任意文字列を許容する)。`<script>...` の id を 1 件入れる。
    //   2. UI がパネルを描画するために `/api/workflows/:id/runs` を叩くと、
    //      brand 検証が落ちて 500 が返る (`Error: must match /^[A-Za-z0-9]...`)。
    //   3. 結果として UI には汎用エラー文言 (`Failed to load runs`) が出る。
    //   4. <script> 文字列は DOM に「行として」描画されないので、
    //      `<script>` 要素が DOM に挿入されることはなく、副作用フラグも
    //      発火しない。これが多重防御 (defense in depth) の観測。
    //
    // ベンダー側でこれが回帰したらこのテストは「副作用フラグが立つ」か
    // 「<script> がリストの一部として描画される」のいずれかで赤くなる。
    const fixture = await tracker.create(
      'recent-runs-xss-run-id',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const scriptPayload = '<script>window.__xss_run_id__=1</script>';
    await seedRuns([
      {
        id: scriptPayload,
        workflowId: fixture.id,
        status: 'succeeded',
        startedAt: baseNow - 30 * 1000,
        durationMs: 1_000,
      },
    ]);

    // Act
    await gotoWorkflow(page, fixture);

    // Assert (防御層 1): brand 検証が GET 経路で発火し、UI が汎用エラーを出す
    const section = recentRunsSection(page);
    const alert = section.getByRole('alert');
    await expect(alert).toBeVisible();
    // brand 検証失敗は 500 系を経由するので「workflow not found」(404 用文言)
    // ではなく汎用 errorState (`Failed to load runs`) が表示される
    await expect(alert).toHaveText('Failed to load runs');
    // 不正 id が混入しているのでリストは描画されない
    await expect(runList(page)).toHaveCount(0);

    // Assert (防御層 2): 仮に将来 brand 検証を緩めて id がフロントに到達した
    // としても、Svelte の text 補間は HTML を実行しない。それを観測するため
    // ページ全体で副作用フラグが立っていないことを確認する。
    // (brand 検証が機能している今は副作用フラグは元から立たないが、
    //  brand 検証が外れた未来で「Svelte 側の text 補間が壊れた」を捕捉できる。)
    const scriptFlag = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__xss_run_id__,
    );
    expect(
      scriptFlag,
      'inline <script> in run id must not execute under any defense layer',
    ).toBeUndefined();

    // recent-runs パネル内に攻撃者由来の <script> 要素が挿入されていない
    // (text 化されているか、そもそも到達していない)。
    await expect(section.locator('script')).toHaveCount(0);
  });
});
