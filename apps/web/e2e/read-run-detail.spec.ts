import {
  test,
  expect,
  request as apiRequest,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
import {
  VALID_WORKFLOW_YAML,
  createFixtureTracker,
  type WorkflowFixture,
} from './helpers/workflowFixtures';

// E2E tests for the "Read Run Detail" panel.
//
// Scenario: apps/web/docs/scenarios/workflow-editor/read-run-detail.md
//
// Coverage:
//   - 正常系
//     - run 未選択時: 空状態文言「Select a run to see its details.」
//     - 終了済み run を選択: id / status pill / Started / Duration /
//       per-node リスト (各 node の status, output, log) が表示される
//     - 失敗ノード: invariant 2 に従い ErrorMessage が必ず描画される
//     - cancelled な run / cancelled ノード: status pill / dot / ラベルが
//       danger tint で描画される (stop-run シナリオとの結合点回帰防止)
//     - 進行中の run (invariant 1): pending / running ノードが
//       「running」ラベル付きで表示され、404 にも error にもならない
//     - skipped ノード: 独自ラベルとミュート色 dot が描画される
//     - run 選択を切り替えると panel が新しい detail に更新される
//     - close ボタンで selection が解除され idle 文言に戻る
//     - invariant 4 (副作用なし / idempotent): 同じ run を複数回続けて
//       選択しても、毎回同じ詳細が描画される (再選択で状態が変化しない)
//   - エラー系
//     - 存在しない run id を選択 → API が 404 → panel は
//       「Run not found」を表示
//     - 別ワークフローに属する run id (cross-workflow leakage):
//       URL を直接叩いて GET すると 404、また UI 操作経由でも
//       「Run not found」が出て他ワークフローの run 情報が漏れない
//     - path-traversal な runId (URL に `..` を埋め込む) を直叩きしても
//       SvelteKit が 4xx で弾き、別ワークフローの履歴が漏れない
//     - ネットワーク失敗 (connectionrefused) → 「Failed to load run detail」
//     - サーバ内部エラー (5xx 経路): brand 検証 (`asNodeId`) に失敗する
//       不正な nodeId を seed → 実 API が読み出し時に 5xx を返す →
//       UI は汎用エラー文言で縮退し、内部メッセージを露出しない
//
// Test data is seeded via the test-only `/api/_test/runs` endpoint
// (gated by `RALPH_WEB_TEST_SEED=1`, set by `playwright.config.ts`'s
// webServer). The seed endpoint accepts a `details` array which writes
// the in-memory detail map that backs `GET /api/workflows/:id/runs/:runId`.

const tracker = createFixtureTracker();

interface SeedSummaryRow {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  durationMs: number | null;
}

interface SeedNodeDetail {
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

interface SeedDetailRow {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt: number | null;
  nodes: ReadonlyArray<SeedNodeDetail>;
}

/**
 * Build a fresh APIRequestContext for each call. Mirrors the same helper
 * in `list-recent-runs.spec.ts`: we deliberately avoid the worker-scoped
 * `request` fixture so seed/reset works regardless of fixture lifecycle
 * across test files. `Connection: close` mitigates the keep-alive issue
 * documented in that spec when an earlier 413 leaves the dev server in a
 * bad state.
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

async function resetRunStore() {
  const attemptOnce = async () => {
    await withApiContext(async (ctx) => {
      const res = await ctx.delete('/api/_test/runs', { timeout: 5_000 });
      expect(res.ok(), 'test seed endpoint should be reachable').toBe(true);
    });
  };
  try {
    await attemptOnce();
  } catch {
    await attemptOnce();
  }
}

async function seedRuns(
  rows: ReadonlyArray<SeedSummaryRow>,
  details: ReadonlyArray<SeedDetailRow> = [],
) {
  await withApiContext(async (ctx) => {
    const res = await ctx.post('/api/_test/runs', {
      data: { reset: false, rows, details },
    });
    expect(
      res.ok(),
      `seed should succeed: ${res.status()} ${await res.text()}`,
    ).toBe(true);
  });
}

async function gotoWorkflow(page: Page, fixture: WorkflowFixture) {
  await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);
  await expect(
    page.getByRole('textbox', { name: 'Workflow YAML' }),
  ).toBeVisible();
}

/** Locate the run-detail section by its accessible region. */
function runDetailSection(page: Page) {
  return page.getByRole('region', { name: 'RUN DETAIL' });
}

/** Locate the recent-runs section (used to click run rows). */
function recentRunsSection(page: Page) {
  return page.getByRole('region', { name: 'RECENT RUNS' });
}

/** Click a run row by id inside the recent-runs panel. */
async function selectRunRow(page: Page, runId: string) {
  const row = recentRunsSection(page)
    .getByRole('listitem')
    .filter({ hasText: runId });
  await expect(row).toHaveCount(1);
  // The row renders as a `<button>` when `onSelect` is wired. Click via
  // the role-and-name locator so we test the same path the user takes.
  await row.getByRole('button').click();
}

test.describe('read-run-detail: ユーザが特定の Run を選択して詳細を確認する', () => {
  test.beforeEach(async () => {
    await resetRunStore();
  });

  test.afterEach(async () => {
    await tracker.cleanupAll();
    await resetRunStore();
  });

  test('run 未選択 (idle) のとき空状態文言が表示される', async ({ page }) => {
    // Arrange: run を seed しないので RecentRuns は空 → selectedRunId は null
    const fixture = await tracker.create(
      'run-detail-idle',
      VALID_WORKFLOW_YAML,
    );

    // Act
    await gotoWorkflow(page, fixture);

    // Assert: 見出しと idle 文言が表示される。アラートやノードリストは出ない。
    const section = runDetailSection(page);
    await expect(section).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'RUN DETAIL' }),
    ).toBeVisible();
    await expect(section.getByText('Select a run to see its details.')).toBeVisible();
    await expect(section.getByRole('alert')).toHaveCount(0);
    await expect(section.getByTestId('run-detail-node')).toHaveCount(0);
  });

  test('終了した run を選択すると id / status / per-node 詳細が描画される（succeeded + skipped + nodes 出力）', async ({
    page,
  }) => {
    // Arrange: succeeded な run を 1 件 seed。各種ノード状態を含めて
    // 不変条件 1 (進行中 OK) と一般的な terminal 経路の両方を担保。
    const fixture = await tracker.create(
      'run-detail-success',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-success-detail';
    await seedRuns(
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          durationMs: 4_500,
        },
      ],
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          endedAt: baseNow - 60 * 1000 + 4_500,
          nodes: [
            {
              nodeId: 'fetch_data',
              status: 'succeeded',
              startedAt: baseNow - 60 * 1000,
              endedAt: baseNow - 60 * 1000 + 1_500,
              output: 'rows=42',
              errorMessage: null,
              logExcerpt: 'INFO connecting...\nINFO done',
            },
            {
              nodeId: 'transform',
              status: 'skipped',
              startedAt: null,
              endedAt: null,
              output: null,
              errorMessage: null,
              logExcerpt: '',
            },
            {
              nodeId: 'publish',
              status: 'succeeded',
              startedAt: baseNow - 60 * 1000 + 1_500,
              endedAt: baseNow - 60 * 1000 + 4_500,
              output: 'published=42',
              errorMessage: null,
              logExcerpt: 'INFO publishing batch',
            },
          ],
        },
      ],
    );

    // Act: ページを開いて run 行をクリック
    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    // Assert: detail panel に id, status pill, Started/Duration が出る
    const section = runDetailSection(page);
    await expect(section).toBeVisible();
    await expect(section).toContainText(runId);
    await expect(section).toContainText('Success');
    await expect(section.getByText('Started')).toBeVisible();
    await expect(section.getByText('Duration')).toBeVisible();
    // Total duration: 4.5s
    await expect(section).toContainText('4.5s');
    // run 全体の status dot
    await expect(section.getByTestId('run-detail-status-dot')).toBeVisible();

    // 各ノードの行が描画されている
    const nodes = section.getByTestId('run-detail-node');
    await expect(nodes).toHaveCount(3);
    await expect(nodes).toContainText(['fetch_data', 'transform', 'publish']);

    // succeeded ノード: output と log excerpt が表示される
    const fetchRow = nodes.filter({ hasText: 'fetch_data' });
    await expect(fetchRow).toHaveCount(1);
    await expect(fetchRow).toContainText('Succeeded');
    await expect(fetchRow.getByTestId('run-detail-node-output')).toContainText(
      'rows=42',
    );
    await expect(fetchRow.getByTestId('run-detail-node-log')).toContainText(
      'INFO connecting',
    );
    // succeeded には error block は出ない
    await expect(fetchRow.getByTestId('run-detail-node-error')).toHaveCount(0);

    // skipped ノード: ラベルと dot は出るが output / log / error は無い
    const transformRow = nodes.filter({ hasText: 'transform' });
    await expect(transformRow).toContainText('Skipped');
    await expect(transformRow.getByTestId('run-detail-node-dot')).toBeVisible();
    await expect(
      transformRow.getByTestId('run-detail-node-output'),
    ).toHaveCount(0);
    await expect(transformRow.getByTestId('run-detail-node-log')).toHaveCount(0);
    await expect(
      transformRow.getByTestId('run-detail-node-error'),
    ).toHaveCount(0);

    // run-level の notFound や error 文言は出ない
    await expect(section.getByRole('alert')).toHaveCount(0);
  });

  test('失敗ノードを含む run では errorMessage が必ず描画される（invariant 2）', async ({
    page,
  }) => {
    // Arrange
    const fixture = await tracker.create(
      'run-detail-failed',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-failed-detail';
    const failureMessage =
      'shell command exited with status 1: connection refused';
    await seedRuns(
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'failed',
          startedAt: baseNow - 30 * 1000,
          durationMs: 1_200,
        },
      ],
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'failed',
          startedAt: baseNow - 30 * 1000,
          endedAt: baseNow - 30 * 1000 + 1_200,
          nodes: [
            {
              nodeId: 'first_step',
              status: 'failed',
              startedAt: baseNow - 30 * 1000,
              endedAt: baseNow - 30 * 1000 + 1_200,
              output: null,
              errorMessage: failureMessage,
              logExcerpt: 'ERROR connection refused',
            },
          ],
        },
      ],
    );

    // Act
    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    // Assert: status pill = Failed、failed ノードの error block が表示される
    const section = runDetailSection(page);
    await expect(section).toContainText('Failed');

    const failedRow = section
      .getByTestId('run-detail-node')
      .filter({ hasText: 'first_step' });
    await expect(failedRow).toHaveCount(1);
    await expect(failedRow).toContainText('Failed');
    const errorBlock = failedRow.getByTestId('run-detail-node-error');
    await expect(errorBlock).toBeVisible();
    await expect(errorBlock).toContainText(failureMessage);
    // Error label (exact match: "Error" header span, not the "ERROR" prefix
    // inside the log excerpt below).
    await expect(failedRow.getByText('Error', { exact: true })).toBeVisible();
    // ログ抜粋も表示されている (invariant 3: 抜粋のみ)
    await expect(failedRow.getByTestId('run-detail-node-log')).toContainText(
      'ERROR connection refused',
    );
  });

  test('進行中の run (running) を選択しても 404 にならず、pending/running ノードは「running」ラベル付きで表示される（invariant 1）', async ({
    page,
  }) => {
    // Arrange: in-flight run。endedAt は null、ノードに pending と running を混在
    const fixture = await tracker.create(
      'run-detail-running',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-inflight-detail';
    await seedRuns(
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'running',
          startedAt: baseNow - 5 * 1000,
          durationMs: null,
        },
      ],
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'running',
          startedAt: baseNow - 5 * 1000,
          endedAt: null,
          nodes: [
            {
              nodeId: 'step_running',
              status: 'running',
              startedAt: baseNow - 5 * 1000,
              endedAt: null,
              output: null,
              errorMessage: null,
              logExcerpt: 'INFO step in progress',
            },
            {
              nodeId: 'step_pending',
              status: 'pending',
              startedAt: null,
              endedAt: null,
              output: null,
              errorMessage: null,
              logExcerpt: '',
            },
          ],
        },
      ],
    );

    // Act
    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    // Assert: 詳細が描画される (404 にならない)。Duration は「running」プレースホルダ。
    const section = runDetailSection(page);
    await expect(section).toContainText(runId);
    // status pill (capitalised) と node-level "Running" ラベルが両方出ている。
    // Run-level pill (1) + step_running ノードラベル (1) で計 2 つあるはず。
    // 厳密一致で `Running` を拾い、duration プレースホルダの小文字 `running`
    // とは衝突させない (review M-4)。
    await expect(section.getByText('Running', { exact: true })).toHaveCount(2);
    // 「running」プレースホルダ (duration 列) は run-level dd と
    // step_running 行 / step_pending 行の duration セルに出る (= 計 3 件)。
    // 厳密一致で取得することで status pill `Running` を拾わないことを担保。
    await expect(section.getByText('running', { exact: true })).toHaveCount(3);
    // notFound 文言は出ない
    await expect(section.getByText('Run not found')).toHaveCount(0);
    await expect(section.getByText('Failed to load run detail')).toHaveCount(0);

    // pending / running ノードはともに「running」ラベルで表示される
    const nodes = section.getByTestId('run-detail-node');
    await expect(nodes).toHaveCount(2);

    const runningRow = nodes.filter({ hasText: 'step_running' });
    await expect(runningRow).toContainText('Running');
    // pending / running は durationMs 計算不能 → 「running」プレースホルダ表示
    // 厳密マッチで `Running` (status pill) と `running` (duration プレースホルダ)
    // を区別する (review M-1)。`Running` を `getByText('running', { exact: true })`
    // が拾わないことで duration セルの表示が正しいことを担保する。
    await expect(runningRow.getByText('running', { exact: true })).toBeVisible();

    const pendingRow = nodes.filter({ hasText: 'step_pending' });
    await expect(pendingRow).toContainText('Pending');
    await expect(pendingRow.getByText('running', { exact: true })).toBeVisible();

    // M-5: 各 <li> の accessible name (aria-label) が status を含み、
    // スクリーンリーダーで読み上げ可能であることを確認する。
    // 実装: `Step <id>, <Status word>, <durationLabel>`
    await expect(
      section.getByRole('listitem', {
        name: /Step step_running, Running, running/,
      }),
    ).toHaveCount(1);
    await expect(
      section.getByRole('listitem', {
        name: /Step step_pending, Pending, running/,
      }),
    ).toHaveCount(1);
  });

  test('別の run 行を選択すると panel が新しい detail に更新される', async ({
    page,
  }) => {
    // Arrange: 2 つの run を用意。ユーザが順番にクリックしたら panel の
    // 内容が切り替わることを確認する (review note: AbortController により
    // 古いレスポンスが反映されないことの間接的な観測)。
    const fixture = await tracker.create(
      'run-detail-switch',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runIdA = 'run-aaa';
    const runIdB = 'run-bbb';
    await seedRuns(
      [
        {
          id: runIdA,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          durationMs: 1_000,
        },
        {
          id: runIdB,
          workflowId: fixture.id,
          status: 'failed',
          startedAt: baseNow - 30 * 1000,
          durationMs: 800,
        },
      ],
      [
        {
          id: runIdA,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          endedAt: baseNow - 60 * 1000 + 1_000,
          nodes: [
            {
              nodeId: 'node_a',
              status: 'succeeded',
              startedAt: baseNow - 60 * 1000,
              endedAt: baseNow - 60 * 1000 + 1_000,
              output: 'A-OK',
              errorMessage: null,
              logExcerpt: 'log a',
            },
          ],
        },
        {
          id: runIdB,
          workflowId: fixture.id,
          status: 'failed',
          startedAt: baseNow - 30 * 1000,
          endedAt: baseNow - 30 * 1000 + 800,
          nodes: [
            {
              nodeId: 'node_b',
              status: 'failed',
              startedAt: baseNow - 30 * 1000,
              endedAt: baseNow - 30 * 1000 + 800,
              output: null,
              errorMessage: 'B exploded',
              logExcerpt: 'log b',
            },
          ],
        },
      ],
    );

    await gotoWorkflow(page, fixture);

    // Act 1: A をクリック
    await selectRunRow(page, runIdA);
    const section = runDetailSection(page);
    await expect(section).toContainText(runIdA);
    await expect(section).toContainText('Success');
    await expect(
      section.getByTestId('run-detail-node').filter({ hasText: 'node_a' }),
    ).toHaveCount(1);

    // Act 2: B に切り替える
    await selectRunRow(page, runIdB);

    // Assert: B の id / status / node に切り替わる
    await expect(section).toContainText(runIdB);
    await expect(section).toContainText('Failed');
    await expect(
      section.getByTestId('run-detail-node').filter({ hasText: 'node_b' }),
    ).toHaveCount(1);
    // A のノードは消えている
    await expect(
      section.getByTestId('run-detail-node').filter({ hasText: 'node_a' }),
    ).toHaveCount(0);
  });

  test('close ボタンを押すと selection が解除されて idle 文言に戻る', async ({
    page,
  }) => {
    // Arrange
    const fixture = await tracker.create(
      'run-detail-close',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-to-close';
    await seedRuns(
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          durationMs: 1_000,
        },
      ],
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          endedAt: baseNow - 60 * 1000 + 1_000,
          nodes: [
            {
              nodeId: 'only_step',
              status: 'succeeded',
              startedAt: baseNow - 60 * 1000,
              endedAt: baseNow - 60 * 1000 + 1_000,
              output: null,
              errorMessage: null,
              logExcerpt: '',
            },
          ],
        },
      ],
    );
    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    // Sanity: detail が描画されている
    const section = runDetailSection(page);
    await expect(section).toContainText(runId);

    // Act: close ボタンをクリック (aria-label 経由で取得)
    await section.getByRole('button', { name: 'Close run detail' }).click();

    // Assert: idle 文言に戻る
    await expect(
      section.getByText('Select a run to see its details.'),
    ).toBeVisible();
    await expect(section.getByTestId('run-detail-node')).toHaveCount(0);
  });

  test('存在しない run id をリクエストすると panel に「Run not found」が表示される', async ({
    page,
  }) => {
    // Arrange: run を 1 件だけ seed。詳細パネルは route.fulfill で URL を
    // 別の (存在しない) id へ書き換えて 404 経路を実 API から観測する。
    // モックではなく実 API を叩く (review §1: モック禁止)。
    const fixture = await tracker.create(
      'run-detail-404',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const realRunId = 'run-real';
    await seedRuns(
      [
        {
          id: realRunId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          durationMs: 1_000,
        },
      ],
      [
        {
          id: realRunId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          endedAt: baseNow - 60 * 1000 + 1_000,
          nodes: [
            {
              nodeId: 'only_step',
              status: 'succeeded',
              startedAt: baseNow - 60 * 1000,
              endedAt: baseNow - 60 * 1000 + 1_000,
              output: null,
              errorMessage: null,
              logExcerpt: '',
            },
          ],
        },
      ],
    );

    // Intercept the run-detail fetch and rewrite the runId path segment to a
    // non-existent id. `route.continue` re-issues the request to the real
    // server, so the 404 we observe is the actual behaviour of the API
    // (`readRunDetailWorkflow` -> `runNotFound`), not a fake response.
    const ghostRunId = 'run-ghost-does-not-exist';
    let interceptedCount = 0;
    const detailMatcher = (url: URL) =>
      url.pathname.startsWith(
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs/`,
      );
    await page.route(detailMatcher, async (route) => {
      const u = new URL(route.request().url());
      if (
        u.pathname ===
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(realRunId)}`
      ) {
        interceptedCount += 1;
        // Rewrite the URL to a guaranteed-missing run id.
        const rewritten = `${u.origin}/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(ghostRunId)}`;
        await route.continue({ url: rewritten });
        return;
      }
      await route.continue();
    });

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, realRunId);

    // Assert: 「Run not found」が role=alert として表示される
    const section = runDetailSection(page);
    const alert = section.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText('Run not found');
    // ノードリストは描画されない
    await expect(section.getByTestId('run-detail-node')).toHaveCount(0);
    // route が実際に発火している
    expect(interceptedCount).toBeGreaterThanOrEqual(1);

    await page.unroute(detailMatcher);
  });

  test('別ワークフローに属する run id を URL 直叩きしても 404 で他ワークフローの詳細が漏れない（cross-workflow 隔離）', async ({
    page,
  }) => {
    // 観点: 別ワークフロー B に属する runId を A の URL で問い合わせると、
    // route 側の workflowId mismatch ガードが 404 を返し、機微 id が
    // レスポンスに含まれない。さらに、UI 上で A のページを開いた状態で
    // RecentRuns に B の run id が一切混入しないことを確認する。
    //
    // 注: review H-1 を踏まえ、UI 経路で「ユーザが手で B の runId を入力する」
    // 経路は実装に存在しない (`selectedRunId` は UI 内部状態) ため、
    // route.continue で URL を rewrite する偽装は撤去した。実際にユーザが
    // 触れる経路 (RecentRuns 行クリック → 自分のワークフローの run のみ表示)
    // と、API 直接呼び出しによる隔離保証の 2 層で検証する。
    const fixtureA = await tracker.create(
      'run-detail-isolation-a',
      VALID_WORKFLOW_YAML,
    );
    const fixtureB = await tracker.create(
      'run-detail-isolation-b',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runIdB = 'run-b-secret-detail';
    const secretOutput = 'TOP-SECRET-PAYLOAD-DO-NOT-LEAK';
    await seedRuns(
      [
        {
          id: runIdB,
          workflowId: fixtureB.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          durationMs: 1_000,
        },
      ],
      [
        {
          id: runIdB,
          workflowId: fixtureB.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          endedAt: baseNow - 60 * 1000 + 1_000,
          nodes: [
            {
              nodeId: 'b_only_node',
              status: 'succeeded',
              startedAt: baseNow - 60 * 1000,
              endedAt: baseNow - 60 * 1000 + 1_000,
              output: secretOutput,
              errorMessage: null,
              logExcerpt: secretOutput,
            },
          ],
        },
      ],
    );

    // Direct API hit: GET /api/workflows/A/runs/<B's runId> must 404 and
    // must NOT echo any of B's payload back. This is the single most
    // important isolation test for the "Read Run Detail" scenario.
    await withApiContext(async (ctx) => {
      const res = await ctx.get(
        `/api/workflows/${encodeURIComponent(fixtureA.id)}/runs/${encodeURIComponent(runIdB)}`,
      );
      expect(res.status()).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(secretOutput);
      expect(body).not.toContain('b_only_node');
    });

    // UI: A のページを開いた状態で、RecentRuns に B の run が出ないこと、
    // および B の機微情報が main 配下のどこにも漏れていないことを確認する。
    // page.locator('body') の CSS 経路は避けて main role を使う (review L-2)。
    await gotoWorkflow(page, fixtureA);
    await expect(
      recentRunsSection(page)
        .getByRole('listitem')
        .filter({ hasText: runIdB }),
    ).toHaveCount(0);
    const main = page.getByRole('main');
    await expect(main).not.toContainText(secretOutput);
    await expect(main).not.toContainText('b_only_node');
  });

  test('ネットワーク失敗 (connectionrefused) のときパネルに「Failed to load run detail」が表示される', async ({
    page,
  }) => {
    // Arrange: run-detail fetch のみネットワーク失敗を起こす。recent-runs
    // 用の fetch は通常通り通したいので URL の prefix で絞る。
    const fixture = await tracker.create(
      'run-detail-network',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-network-detail';
    await seedRuns(
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          durationMs: 1_000,
        },
      ],
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          endedAt: baseNow - 60 * 1000 + 1_000,
          nodes: [
            {
              nodeId: 'only_step',
              status: 'succeeded',
              startedAt: baseNow - 60 * 1000,
              endedAt: baseNow - 60 * 1000 + 1_000,
              output: null,
              errorMessage: null,
              logExcerpt: '',
            },
          ],
        },
      ],
    );

    // run-detail エンドポイント (`.../runs/<runId>`) のみを abort。
    // recent-runs 一覧 (`.../runs`) は通したいので末尾にスラッシュ + id がある
    // パターンだけマッチさせる。
    let abortedCount = 0;
    const detailUrlPrefix = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/`;
    const detailMatcher = (url: URL) => url.pathname.startsWith(detailUrlPrefix);
    await page.route(detailMatcher, async (route) => {
      abortedCount += 1;
      await route.abort('connectionrefused');
    });

    // Act
    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    // Assert
    const section = runDetailSection(page);
    const alert = section.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText('Failed to load run detail');
    await expect(section.getByTestId('run-detail-node')).toHaveCount(0);
    expect(abortedCount).toBeGreaterThanOrEqual(1);

    await page.unroute(detailMatcher);
  });

  test('実 API が 5xx を返したときパネルに「Failed to load run detail」が表示される（brand 検証失敗を経由した実 5xx 経路）', async ({
    page,
  }) => {
    // 観点 (review H-1 / 重要): サーバが 5xx を返すケース (DB 接続失敗 /
    // 内部例外 / リポジトリ層の不整合) で UI が汎用エラー文言で縮退する
    // ことを担保する。
    //
    // ルール「モック禁止」に従い、route.fulfill で偽装した 500 ではなく、
    // 実 API の本物の 5xx 応答を観測する。test-only seed エンドポイントは
    // 構造的バリデーションのみ行うので、`<script>` を含む不正な nodeId を
    // 仕込める。production の read 経路 (`buildNodeRunDetailFromRow` 内の
    // `asNodeId` brand 検証) はこの id を拒否し、ハンドリングされていない
    // Error が SvelteKit の error 中間層で 5xx に変換される。
    //
    // この経路は list-recent-runs.spec.ts の XSS 多重防御テストと同じ
    // パターンで、production の防御層が実際に発火することと、
    // 「失敗時の UI が安全に縮退すること」を一度に検証する。
    const fixture = await tracker.create(
      'run-detail-500',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-real-5xx';
    // brand 検証 (`asNodeId`: `^[A-Za-z0-9][A-Za-z0-9._-]*$`) を必ず落とす
    // ペイロード。`<script>` は許可文字集合外なので production の
    // `buildNodeRunDetailFromRow` で例外になる。
    const malformedNodeId = '<script>not-a-valid-node-id</script>';
    await seedRuns(
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          durationMs: 1_000,
        },
      ],
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          endedAt: baseNow - 60 * 1000 + 1_000,
          nodes: [
            {
              nodeId: malformedNodeId,
              status: 'succeeded',
              startedAt: baseNow - 60 * 1000,
              endedAt: baseNow - 60 * 1000 + 1_000,
              output: null,
              errorMessage: null,
              logExcerpt: '',
            },
          ],
        },
      ],
    );

    // 防御層 1: 実 API の応答が 5xx になることを直接確認 (route の
    // fulfill 不使用 = サーバ実装が壊れたら気付ける契約)。
    await withApiContext(async (ctx) => {
      const res = await ctx.get(
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}`,
      );
      expect(
        res.status(),
        `expected 5xx from real API on brand-validation failure, got ${res.status()}`,
      ).toBeGreaterThanOrEqual(500);
    });

    // 防御層 2: UI 経路でも同じ 5xx を踏むと汎用エラー文言で縮退する
    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    const section = runDetailSection(page);
    const alert = section.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText('Failed to load run detail');
    // ノードリストは描画されない (brand 検証で 5xx になっているため)
    await expect(section.getByTestId('run-detail-node')).toHaveCount(0);
    // サーバ内部の brand 検証メッセージは UI に漏れない (情報漏洩防止)。
    // page.locator('body') の CSS 経路を避けて main role 配下で確認する
    // (review L-2: CSS セレクタ依存を最小化)。
    const main = page.getByRole('main');
    await expect(main).not.toContainText('asNodeId');
    await expect(main).not.toContainText('InvalidBrandedValueError');
    await expect(main).not.toContainText('run store yielded');
    // 攻撃者由来の <script> 文字列が DOM 内の任意箇所に「タグとして」
    // 注入されていない (Svelte の text 補間 + brand 検証の両方が機能している)
    await expect(section.locator('script')).toHaveCount(0);
  });

  test('遅延レスポンス時に loading 文言が表示され、stale なレスポンスが UI を上書きしない（race / loading 状態の検証）', async ({
    page,
  }) => {
    // 観点 (review M-3 + M-4):
    //   - loading 状態で `role="status"` の "Loading run detail…" が出る
    //   - A → B と素早く切り替えたとき、A のレスポンスが B より遅れて
    //     到達しても UI は B の内容を保持する (AbortController + id 二重
    //     ガードの実証)
    //
    // route.continue + delay は実 API への到達を遅らせるだけで、レスポンス
    // 自体はサーバが生成した実データなのでモックではない。
    const fixture = await tracker.create(
      'run-detail-race',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runIdA = 'run-slow-a';
    const runIdB = 'run-fast-b';
    await seedRuns(
      [
        {
          id: runIdA,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 90 * 1000,
          durationMs: 1_000,
        },
        {
          id: runIdB,
          workflowId: fixture.id,
          status: 'failed',
          startedAt: baseNow - 30 * 1000,
          durationMs: 800,
        },
      ],
      [
        {
          id: runIdA,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 90 * 1000,
          endedAt: baseNow - 90 * 1000 + 1_000,
          nodes: [
            {
              nodeId: 'node_slow_a',
              status: 'succeeded',
              startedAt: baseNow - 90 * 1000,
              endedAt: baseNow - 90 * 1000 + 1_000,
              output: 'A-PAYLOAD-DO-NOT-OVERWRITE-B',
              errorMessage: null,
              logExcerpt: 'log a',
            },
          ],
        },
        {
          id: runIdB,
          workflowId: fixture.id,
          status: 'failed',
          startedAt: baseNow - 30 * 1000,
          endedAt: baseNow - 30 * 1000 + 800,
          nodes: [
            {
              nodeId: 'node_fast_b',
              status: 'failed',
              startedAt: baseNow - 30 * 1000,
              endedAt: baseNow - 30 * 1000 + 800,
              output: null,
              errorMessage: 'B fast error',
              logExcerpt: 'log b',
            },
          ],
        },
      ],
    );

    // A のレスポンスだけ 1.5 秒遅らせる。B はそのまま素通り。
    const detailMatcher = (url: URL) =>
      url.pathname.startsWith(
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs/`,
      );
    const slowPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runIdA)}`;
    await page.route(detailMatcher, async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === slowPath) {
        // 1.5 秒待ってから実 API へ流す。これで A の応答は B より後着になる。
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue();
    });

    await gotoWorkflow(page, fixture);

    // Step 1: A をクリック → loading 文言が観測できる
    await selectRunRow(page, runIdA);
    const section = runDetailSection(page);
    // loading 中は role=status の "Loading run detail…" が出る (review M-4)
    await expect(section.getByRole('status')).toHaveText(
      'Loading run detail…',
    );

    // Step 2: A がまだ loading 中のうちに B に切り替える。B は遅延なしで
    // すぐ ready になる。AbortController が走るので A の response は
    // 後着しても UI を上書きしない。
    await selectRunRow(page, runIdB);

    // Assert (B が表示される)
    await expect(section).toContainText(runIdB);
    await expect(section).toContainText('Failed');
    const errorBlock = section.getByTestId('run-detail-node-error');
    await expect(errorBlock).toContainText('B fast error');

    // Wait: A の遅延応答が確実に到着する時間まで待つ。固定 sleep ではなく
    // 「B の表示が安定して保持される」ことの assertion で吸収する
    // (waitForTimeout 禁止ルール準拠)。toHaveText を 2 秒 timeout で
    // 評価することで A の応答到着 (T+1.5s) を跨いでも B が保たれることを
    // 担保する。
    await expect(section).toContainText(runIdB, { timeout: 2_500 });
    // A の機微 payload が一切上書きされず main 配下に出ていないこと
    // (page.locator('body') の CSS 経路は避ける — review L-2)
    const main = page.getByRole('main');
    await expect(main).not.toContainText('A-PAYLOAD-DO-NOT-OVERWRITE-B');
    await expect(main).not.toContainText('node_slow_a');

    await page.unroute(detailMatcher);
  });

  test('output / errorMessage / logExcerpt に XSS ペイロードが含まれていてもスクリプトとして実行されない', async ({
    page,
  }) => {
    // 観点 (review additional 1): node の各 text 領域は <pre>{value}</pre>
    // で Svelte がエスケープするはずだが、回帰時に grave breach となるので
    // E2E でも 1 件は確認する。`<img onerror>` の `<script>` タグは
    // Svelte の text interpolation でエスケープされるので、`window.__xss_*`
    // 系の副作用が起きないことを確認する。
    const fixture = await tracker.create(
      'run-detail-xss',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-xss-detail';
    const xssOutput = '<img src=x onerror="window.__xss_output__=1">';
    const xssError =
      '<script>window.__xss_error__=1</script>err-after';
    const xssLog = '<svg onload="window.__xss_log__=1"></svg>log-after';
    await seedRuns(
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'failed',
          startedAt: baseNow - 30 * 1000,
          durationMs: 1_000,
        },
      ],
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'failed',
          startedAt: baseNow - 30 * 1000,
          endedAt: baseNow - 30 * 1000 + 1_000,
          nodes: [
            {
              nodeId: 'xss_step',
              status: 'failed',
              startedAt: baseNow - 30 * 1000,
              endedAt: baseNow - 30 * 1000 + 1_000,
              output: xssOutput,
              errorMessage: xssError,
              logExcerpt: xssLog,
            },
          ],
        },
      ],
    );

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    // Assert: ペイロードがテキストとして可視化されている (= エスケープされている)
    const section = runDetailSection(page);
    const failedRow = section
      .getByTestId('run-detail-node')
      .filter({ hasText: 'xss_step' });
    await expect(failedRow.getByTestId('run-detail-node-output')).toContainText(
      xssOutput,
    );
    await expect(failedRow.getByTestId('run-detail-node-error')).toContainText(
      xssError,
    );
    await expect(failedRow.getByTestId('run-detail-node-log')).toContainText(
      xssLog,
    );

    // Assert: window.__xss_*__ の副作用が一切起きていない (= スクリプト未実行)
    const flags = await page.evaluate(() => ({
      output: (window as unknown as { __xss_output__?: number })
        .__xss_output__,
      error: (window as unknown as { __xss_error__?: number })
        .__xss_error__,
      log: (window as unknown as { __xss_log__?: number }).__xss_log__,
    }));
    expect(flags.output).toBeUndefined();
    expect(flags.error).toBeUndefined();
    expect(flags.log).toBeUndefined();

    // Assert: ペイロード由来の <img> / <script> / <svg> 要素が DOM に
    // 注入されていない。`xss_step` 行の中身として描画される本物の <pre>
    // のみが許容される。
    const injectedImg = failedRow.locator('img[src="x"]');
    await expect(injectedImg).toHaveCount(0);
    const injectedSvg = failedRow.locator('svg');
    await expect(injectedSvg).toHaveCount(0);
  });

  test('cancelled な run / cancelled ノードは danger tint の status pill / dot / ラベルで描画される（stop-run 結合点 / review M-3）', async ({
    page,
  }) => {
    // 観点 (review M-3): stop-run シナリオで cancelled に遷移した Run の
    // 詳細表示が回帰しないことを担保する。run-level / node-level の両方で
    // cancelled が独自の dot tint と "Cancelled" ラベルで表示される。
    const fixture = await tracker.create(
      'run-detail-cancelled',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-cancelled-detail';
    await seedRuns(
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'cancelled',
          startedAt: baseNow - 30 * 1000,
          durationMs: 1_200,
        },
      ],
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'cancelled',
          startedAt: baseNow - 30 * 1000,
          endedAt: baseNow - 30 * 1000 + 1_200,
          nodes: [
            {
              nodeId: 'cancelled_step',
              status: 'cancelled',
              startedAt: baseNow - 30 * 1000,
              endedAt: baseNow - 30 * 1000 + 1_200,
              output: null,
              errorMessage: null,
              logExcerpt: 'INFO interrupted by stop request',
            },
          ],
        },
      ],
    );

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    // Assert: run-level の status pill と dot
    const section = runDetailSection(page);
    await expect(section).toContainText(runId);
    // 厳密一致で "Cancelled" pill を確認 (Status pill 専用)
    await expect(section.getByText('Cancelled', { exact: true }).first()).toBeVisible();
    // run-level dot は data-testid 経由で取得
    await expect(section.getByTestId('run-detail-status-dot')).toBeVisible();

    // Assert: cancelled ノード行の描画
    const nodes = section.getByTestId('run-detail-node');
    await expect(nodes).toHaveCount(1);
    const cancelledRow = nodes.filter({ hasText: 'cancelled_step' });
    await expect(cancelledRow).toHaveCount(1);
    // ノードラベルも厳密一致
    await expect(
      cancelledRow.getByText('Cancelled', { exact: true }),
    ).toBeVisible();
    // ノードレベル dot
    await expect(cancelledRow.getByTestId('run-detail-node-dot')).toBeVisible();
    // cancelled は terminal なので duration が表示される ("1.2s")
    await expect(cancelledRow).toContainText('1.2s');
    // cancelled (errorMessage=null) では error block は出ない (invariant 2 の対偶:
    // failed 以外には errorMessage は付かない)
    await expect(
      cancelledRow.getByTestId('run-detail-node-error'),
    ).toHaveCount(0);
    // logExcerpt は描画される (invariant 3: 抜粋のみ)
    await expect(cancelledRow.getByTestId('run-detail-node-log')).toContainText(
      'INFO interrupted by stop request',
    );
    // a11y: aria-label に status とラベルが含まれる (review M-5 と整合)
    await expect(
      section.getByRole('listitem', {
        name: /Step cancelled_step, Cancelled, took 1\.2s/,
      }),
    ).toHaveCount(1);
  });

  test('同じ run を複数回連続で選択しても毎回同じ詳細が描画される（invariant 4: 副作用なし / idempotent）', async ({
    page,
  }) => {
    // 観点 (review M-2 / scenario invariant 4): 詳細取得は副作用を持たない。
    // 同じ run を A → close → A → close → A と繰り返し選択しても、毎回
    // 同じ id / status / node 内容が描画される (= サーバ側でも UI 側でも
    // 状態が変化しない) ことを E2E で観測する。
    const fixture = await tracker.create(
      'run-detail-idempotent',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-idempotent';
    const stableOutput = 'STABLE-OUTPUT-MUST-NOT-CHANGE';
    await seedRuns(
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          durationMs: 2_000,
        },
      ],
      [
        {
          id: runId,
          workflowId: fixture.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          endedAt: baseNow - 60 * 1000 + 2_000,
          nodes: [
            {
              nodeId: 'stable_step',
              status: 'succeeded',
              startedAt: baseNow - 60 * 1000,
              endedAt: baseNow - 60 * 1000 + 2_000,
              output: stableOutput,
              errorMessage: null,
              logExcerpt: 'INFO done',
            },
          ],
        },
      ],
    );

    await gotoWorkflow(page, fixture);
    const section = runDetailSection(page);

    // 期待される描画内容を 1 回 select したあとに dump する関数。
    const expectStableDetail = async () => {
      await expect(section).toContainText(runId);
      await expect(section.getByText('Success', { exact: true }).first()).toBeVisible();
      const node = section
        .getByTestId('run-detail-node')
        .filter({ hasText: 'stable_step' });
      await expect(node).toHaveCount(1);
      await expect(node.getByTestId('run-detail-node-output')).toContainText(
        stableOutput,
      );
      // duration 単位境界も毎回同じ ("2.0s") であること
      await expect(section).toContainText('2.0s');
    };

    // 試行 1
    await selectRunRow(page, runId);
    await expectStableDetail();

    // close → reopen
    await section.getByRole('button', { name: 'Close run detail' }).click();
    await expect(
      section.getByText('Select a run to see its details.'),
    ).toBeVisible();

    // 試行 2: 同じ run を再選択 → 同じ内容
    await selectRunRow(page, runId);
    await expectStableDetail();

    // close → reopen → 試行 3
    await section.getByRole('button', { name: 'Close run detail' }).click();
    await expect(
      section.getByText('Select a run to see its details.'),
    ).toBeVisible();
    await selectRunRow(page, runId);
    await expectStableDetail();

    // 副作用がないことの追加担保: recent-runs 側の row も増減していない
    // (詳細取得が summary store を変更していない)
    await expect(
      recentRunsSection(page)
        .getByRole('listitem')
        .filter({ hasText: runId }),
    ).toHaveCount(1);

    // 直接 API を 3 回叩いても、毎回同じ payload が返る (read-only 検証)
    await withApiContext(async (ctx) => {
      const url = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}`;
      const bodies: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await ctx.get(url);
        expect(res.status()).toBe(200);
        bodies.push(await res.text());
      }
      // すべて同一バイト列であること = 副作用がない
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[2]).toBe(bodies[0]);
    });
  });

  test('path-traversal な runId (生 `..` 含む) で URL を直叩きしても他ワークフローの詳細が漏れない（review L-3 / 境界の不変条件）', async ({
    page,
  }) => {
    // 観点 (review L-3): 攻撃者が `/api/workflows/<A>/runs/..%2F<otherId>`
    // のような URL を直接叩いても、SvelteKit のパス検証 + brand 検証
    // (`asRunId`) が 4xx で弾き、別ワークフローや別 run の詳細が漏れない
    // ことを担保する。
    //
    // 別ワークフロー B を seed しておき、攻撃ペイロードを A の URL に
    // 埋め込んだとき機微情報が応答に含まれてはならない。
    const fixtureA = await tracker.create(
      'run-detail-traversal-attacker',
      VALID_WORKFLOW_YAML,
    );
    const fixtureB = await tracker.create(
      'run-detail-traversal-victim',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runIdB = 'run-b-traversal-victim';
    const secretOutput = 'TRAVERSAL-VICTIM-PAYLOAD-DO-NOT-LEAK';
    await seedRuns(
      [
        {
          id: runIdB,
          workflowId: fixtureB.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          durationMs: 1_000,
        },
      ],
      [
        {
          id: runIdB,
          workflowId: fixtureB.id,
          status: 'succeeded',
          startedAt: baseNow - 60 * 1000,
          endedAt: baseNow - 60 * 1000 + 1_000,
          nodes: [
            {
              nodeId: 'traversal_b_node',
              status: 'succeeded',
              startedAt: baseNow - 60 * 1000,
              endedAt: baseNow - 60 * 1000 + 1_000,
              output: secretOutput,
              errorMessage: null,
              logExcerpt: secretOutput,
            },
          ],
        },
      ],
    );

    // 攻撃ベクタ 1: `..%2F` でエンコードした path-traversal を runId 位置に
    // 埋め込む。SvelteKit のルータが decode した結果 `..` を含む id を
    // brand 検証 (`asRunId`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`) が
    // 拒否し、4xx を返すことを期待する。
    await withApiContext(async (ctx) => {
      const evilRunId = '..%2F..%2F' + encodeURIComponent(runIdB);
      const res = await ctx.get(
        `/api/workflows/${encodeURIComponent(fixtureA.id)}/runs/${evilRunId}`,
      );
      expect(
        res.status(),
        `expected 4xx for path-traversal runId, got ${res.status()}`,
      ).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
      const body = await res.text();
      expect(body).not.toContain(secretOutput);
      expect(body).not.toContain('traversal_b_node');
    });

    // 攻撃ベクタ 2: 生 ASCII の `..` を runId に直接埋める。SvelteKit が
    // どのルートにマッチさせるかは状況依存だが、いずれにせよ B の機微
    // payload を返してはいけない (情報漏洩防止)。
    await withApiContext(async (ctx) => {
      // ブラウザではなく直接 HTTP で送るので生の `..` が path に残る
      const res = await ctx.get(
        `/api/workflows/${encodeURIComponent(fixtureA.id)}/runs/..`,
      );
      // 4xx か、もしくは別ルートに collapse して 404 になる。500 系ではない
      // ことを担保 (5xx はサーバ側の不具合として赤くしたい)。
      expect(
        res.status(),
        `expected 4xx for raw .. runId, got ${res.status()}`,
      ).toBeLessThan(500);
      const body = await res.text();
      expect(body).not.toContain(secretOutput);
      expect(body).not.toContain('traversal_b_node');
    });

    // UI 経路: A のページを開いた状態で B の機微情報が main 配下のどこにも
    // 出現しないことを最終確認する。
    await gotoWorkflow(page, fixtureA);
    const main = page.getByRole('main');
    await expect(main).not.toContainText(secretOutput);
    await expect(main).not.toContainText('traversal_b_node');
  });
});
