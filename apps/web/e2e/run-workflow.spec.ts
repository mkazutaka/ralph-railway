import {
  test,
  expect,
  request as apiRequest,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
import {
  VALID_WORKFLOW_YAML,
  SCHEMA_INVALID_WORKFLOW_YAML,
  createFixtureTracker,
  type WorkflowFixture,
} from './helpers/workflowFixtures';
import { runWorkflowCopy } from '../src/features/workflow-editor/components/runWorkflowCopy';

// (review M-6) Build the success-toast regex from the same template the
// component renders. If `startedTemplate` is changed in the source, this
// regex compiles to match the new shape — the test never silently passes
// against a stale assumption.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const RUN_ID_PLACEHOLDER = '__RUN_ID_PLACEHOLDER__';
const RUN_STARTED_REGEX = new RegExp(
  escapeRegex(runWorkflowCopy.startedTemplate(RUN_ID_PLACEHOLDER)).replace(
    RUN_ID_PLACEHOLDER,
    '(\\S+)',
  ),
);

// E2E tests for the "Start Run" scenario.
//
// Scenario: apps/web/docs/scenarios/workflow-editor/run-workflow.md
//
// Coverage (mapped to scenario user stories + invariants):
//   - 正常系
//     - Run ボタンをクリックすると POST /api/workflows/:id/runs が走り、
//       成功トースト「Run started: <runId>」が表示される (runStarted)
//     - 成功した run id が `selectedRunId` 経由で RunDetail パネルへ伝搬し、
//       同じ id で実 API をたたきに行く (page integration)
//     - 連続クリックで 2 つの run を作成すると、両方の run id が一意で
//       (invariant 3) 文字列として非空である
//     - 別ワークフロー A / B で順に Run → 2 つの run id が衝突しない
//       (cross-workflow uniqueness, invariant 3)
//     - In-flight 中はボタンが disabled になり、aria-busy=true、spinner が
//       表示される (二重実行防止 / invariant 3 の UI 契約)
//     - Run 後にディスク上の YAML 原文が変化していない (invariant 4)
//     - POST が 1 秒未満で 202 を返し、ユーザは進捗完了を待たない
//       (invariant 5: 実行開始は非同期)
//   - エラー系
//     - InvalidYaml (parse error): YAML 構文を壊した状態で Run → 422、
//       role=alert に「workflow YAML is invalid: ...」(invariant 1)
//     - InvalidYaml (schema violation): YAML は parse 通るが do の各要素が
//       single-key mapping ではない → 422 + schema reason 文言 (invariant 1)
//     - UnsupportedNode: ランタイム未対応ノード (`fork`) を含む YAML で
//       Run → 422、role=alert に
//       「workflow uses a runtime-unsupported node type: fork」(invariant 2)
//     - WorkflowNotFound: ファイルを削除した後に Run → 404、role=alert に
//       「workflow not found」
//     - RuntimeUnavailable: ランタイムを停止した状態で Run → 503、role=alert
//       に「workflow runtime is unavailable」(再試行で復旧することも検証)
//   - セキュリティ境界
//     - path-traversal な workflowId を URL に直接入れたページから Run に
//       到達できない (POST 経路の `parseWorkflowParam` 400 を担保)
//
// Test data is seeded via the test-only `/api/_test/runs` endpoint and the
// runtime availability is toggled via `/api/_test/runtime` (both gated by
// `RALPH_WEB_TEST_SEED=1`).

const tracker = createFixtureTracker();

interface SeedRow {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  durationMs: number | null;
}

/**
 * Build a fresh APIRequestContext for each call. Mirrors the helpers used
 * in `list-recent-runs.spec.ts` / `read-run-detail.spec.ts`.
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

async function seedRuns(rows: ReadonlyArray<SeedRow>) {
  await withApiContext(async (ctx) => {
    const res = await ctx.post('/api/_test/runs', {
      data: { reset: false, rows },
    });
    expect(
      res.ok(),
      `seed should succeed: ${res.status()} ${await res.text()}`,
    ).toBe(true);
  });
}

/**
 * Toggle the in-memory runtime availability. The flag is process-wide, so
 * every test that flips it MUST flip it back in `afterEach` to avoid
 * cross-test pollution.
 */
async function setRuntimeAvailable(available: boolean) {
  await withApiContext(async (ctx) => {
    const res = await ctx.post('/api/_test/runtime', {
      data: { available },
    });
    expect(
      res.ok(),
      `runtime toggle endpoint should be reachable: ${res.status()} ${await res.text()}`,
    ).toBe(true);
  });
}

async function gotoWorkflow(page: Page, fixture: WorkflowFixture) {
  await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);
  await expect(
    page.getByRole('textbox', { name: 'Workflow YAML' }),
  ).toBeVisible();
}

/** Locate the Run button by its accessible name (`aria-label`). */
function runButton(page: Page) {
  return page.getByRole('button', {
    name: 'Start a new run of this workflow',
  });
}

/**
 * Click the Run button safely against a SvelteKit-hydrated page.
 *
 * Playwright's auto-wait covers Actionability (visibility, enabled, stable
 * box) but cannot tell whether Svelte has already attached the `onclick`
 * listener. A click issued during the SSR-only window is silently dropped
 * by the browser. Mirrors the strategy in `helpers/editor.ts::openPicker`:
 * we observe the user-visible side-effect (`aria-busy=true` *or* a status
 * caption appearing) and only re-issue the click when none of them have
 * been observed yet.
 *
 * (review F-5) The previous version polled before re-issuing, which racing
 * against a sub-millisecond runtime response could observe `busy=false`
 * AFTER the request had already resolved and re-click — producing a
 * second POST. To prevent that we:
 *   1. wait for `toBeEnabled()` so we know the SSR markup is at least live
 *   2. observe `aria-busy=true` OR a status caption ONCE; if observed, the
 *      handler has fired and we never issue a second click
 *   3. otherwise, click once and assert `aria-busy='true'` (or already
 *      transitioned to a result caption); we then exit
 */
async function clickRunButton(page: Page) {
  const button = runButton(page);
  await expect(button).toBeEnabled();
  // hydration retry: keep clicking until the handler fires once. We poll
  // *before* clicking, so a click that already triggered the handler
  // (e.g. a previous attempt) is detected and we do not issue a second.
  await expect(async () => {
    const busy = (await button.getAttribute('aria-busy')) === 'true';
    const successCount = await page
      .getByTestId('run-workflow-success')
      .count();
    const errorCount = await page.getByTestId('run-workflow-error').count();
    if (busy || successCount > 0 || errorCount > 0) {
      return;
    }
    await button.click();
    // After the click, the component immediately transitions status to
    // 'pending', which sets aria-busy=true synchronously. We deliberately
    // *don't* check for the success/error captions here so an already-
    // resolved fast response (between click + assertion) cannot be mistaken
    // for "still SSR". (review minor) The previous `aria-busy=/^(true|false)$/`
    // matched any state and was a no-op; removed to avoid implying an
    // assertion happened.
    const becameBusy = (await button.getAttribute('aria-busy')) === 'true';
    const sc = await page.getByTestId('run-workflow-success').count();
    const ec = await page.getByTestId('run-workflow-error').count();
    if (!becameBusy && sc === 0 && ec === 0) {
      throw new Error('hydration not complete: click had no observable effect');
    }
  }).toPass({ timeout: 10_000, intervals: [50, 100, 200, 400] });
}

/**
 * Extract the run id from the success toast in a retry-aware way.
 *
 * (review F-6) `textContent()` is a synchronous DOM read with no retry.
 * To keep the read flake-free, we first wait for `toContainText` (which
 * polls) so the text is guaranteed to be the final "Run started: <id>"
 * before we read it once. The single sync read at the end is safe.
 *
 * (review M-6) The matcher is derived from `runWorkflowCopy.startedTemplate`
 * so a contract regression in that copy is caught at compile/runtime, not
 * silently ignored by a hard-coded regex.
 */
async function readRunIdFromToast(page: Page): Promise<string> {
  const toast = page.getByTestId('run-workflow-success');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(RUN_STARTED_REGEX);
  const text = (await toast.textContent()) ?? '';
  const match = text.match(RUN_STARTED_REGEX);
  expect(match, `toast text should contain run id: ${text}`).not.toBeNull();
  const runId = match![1]!;
  expect(runId.length).toBeGreaterThan(0);
  return runId;
}

/**
 * Install a pass-through `page.route` hook that counts the number of
 * POST requests issued to `POST /api/workflows/:id/runs` for the given
 * fixture. The hook calls `route.continue()` so the real server still
 * processes the request — it never fakes a response. Returns the counter
 * (which the caller asserts on) plus a `dispose()` that unregisters the
 * route handler.
 *
 * (review M-1) The hydration-retry helper `clickRunButton` could in
 * principle observe a sub-millisecond response between click and probe
 * and re-fire. We attach this counter to all success-path tests so any
 * silent double-fire trips the assertion.
 */
async function trackStartRunPosts(
  page: Page,
  fixture: WorkflowFixture,
): Promise<{ counter: { value: number }; dispose: () => Promise<void> }> {
  const startRunPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs`;
  const matcher = (url: URL) => url.pathname === startRunPath;
  const counter = { value: 0 };
  await page.route(matcher, async (route) => {
    if (route.request().method() === 'POST') {
      counter.value += 1;
    }
    // Pass-through only — never `route.fulfill()`. Real server handles it.
    await route.continue();
  });
  return {
    counter,
    dispose: async () => {
      await page.unroute(matcher);
    },
  };
}

/** Locate the recent-runs section by its accessible region. */
function recentRunsSection(page: Page) {
  return page.getByRole('region', { name: 'RECENT RUNS' });
}

/** Locate the run-detail section by its accessible region. */
function runDetailSection(page: Page) {
  return page.getByRole('region', { name: 'RUN DETAIL' });
}

test.describe('run-workflow: ユーザが Run ボタンでワークフローを実行する', () => {
  test.beforeEach(async () => {
    // Clean slate every test: clear runs and ensure runtime is available.
    await resetRunStore();
    await setRuntimeAvailable(true);
  });

  test.afterEach(async () => {
    // Re-enable runtime so a previous test's toggle does not poison the
    // next spec, and clear fixtures + run rows.
    await setRuntimeAvailable(true);
    await tracker.cleanupAll();
    await resetRunStore();
  });

  test('Run ボタンを押すと runStarted パスが走り「Run started: <runId>」トーストが表示される（正常系）', async ({
    page,
  }) => {
    // Arrange: 有効な YAML を持つワークフローを用意
    const fixture = await tracker.create(
      'run-workflow-success',
      VALID_WORKFLOW_YAML,
    );

    // (review M-1) Pass-through POST counter to detect any double-fire from
    // the hydration-retry helper. `route.continue()` is used so the real
    // server still produces the response — this is observation, not a mock.
    const { counter, dispose } = await trackStartRunPosts(page, fixture);

    await gotoWorkflow(page, fixture);

    // (review minor) Observe the POST response status at the wire level so
    // a regression that returns 200 / 201 instead of 202 trips this test.
    // `waitForResponse` runs in parallel with the click triggered by the
    // hydration helper.
    const startRunPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs`;
    const responsePromise = page.waitForResponse(
      (resp) =>
        new URL(resp.url()).pathname === startRunPath &&
        resp.request().method() === 'POST',
    );

    // Act: Run ボタンをクリック (hydration retry helper 経由)
    await clickRunButton(page);
    const response = await responsePromise;
    expect(
      response.status(),
      `POST should return 202 Accepted (invariant 5: async accept), got ${response.status()}`,
    ).toBe(202);

    // Assert: 成功トーストが role=status で表示され、`Run started: ` プレフィックス
    // と何らかの run id が含まれる。
    const successToast = page.getByTestId('run-workflow-success');
    await expect(successToast).toBeVisible();
    await expect(successToast).toContainText(RUN_STARTED_REGEX);

    // 失敗側のトーストは出ない
    await expect(page.getByTestId('run-workflow-error')).toHaveCount(0);

    // ボタンは再びクリック可能な状態 (disabled でない、aria-busy=false)
    await expect(runButton(page)).toBeEnabled();
    await expect(runButton(page)).toHaveAttribute('aria-busy', 'false');

    // (review M-1) 1 click → 1 POST であること。hydration retry が二重発火
    // していないかを assert する。
    expect(
      counter.value,
      `expected exactly one POST for one click, observed ${counter.value}`,
    ).toBe(1);

    await dispose();
  });

  test('Run 成功後、run id は RunDetail パネルへ伝搬し、同じ id で実 API への詳細取得が走る（onStarted 配線）', async ({
    page,
  }) => {
    // 観点 (review F-3 / F-4):
    //   - 成功トーストに出る run id がそのまま `+page.svelte` の
    //     `selectedRunId` にセットされ、`RunDetail` 側で `GET
    //     /api/workflows/:id/runs/:runId` の URL を組み立てに行くこと
    //   - id 形式 (例: `web-` プレフィクス) は実装依存なので E2E では検査しない
    //     (将来 ULID 採用などで silently 落ちないように)
    //
    // RuntimeStore の enqueue は `RunStore` (run summary store) には書き込ま
    // ないため、started run は recent-runs 一覧には現れない。これは現時点の
    // 実装 (in-memory adapter, CLI runtime 未連携) の既知の限界であり、
    // ここでは「Run を押した結果が UI 内で run-detail パネルへ正しく伝搬する
    // かどうか」を確認する。
    const fixture = await tracker.create(
      'run-workflow-onstarted',
      VALID_WORKFLOW_YAML,
    );

    // run-detail エンドポイントの URL を観測するために route を仕込む。
    // (review M-2) `route.fulfill` (偽応答) は使わず、必ず `route.continue()`
    // で実 API へ流す。観測のみで応答は変えないポリシー。これでシナリオの
    // 「モック禁止」ルールに抵触しない。
    const detailHits: string[] = [];
    const detailMatcher = (url: URL) =>
      url.pathname.startsWith(
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs/`,
      );
    await page.route(detailMatcher, async (route) => {
      detailHits.push(new URL(route.request().url()).pathname);
      await route.continue();
    });

    await gotoWorkflow(page, fixture);
    await clickRunButton(page);

    const runId = await readRunIdFromToast(page);
    // 実装依存のプレフィクス検査は行わない (review F-4)。空文字でないことだけ。
    expect(runId.length).toBeGreaterThan(0);

    // run-detail パネルが「Run not found」を表示するか、もしくは run-detail
    // ノード描画が始まること。RuntimeStore.enqueue が DETAIL_STORE に書かない
    // ため、サーバは 404 を返す (= UI は「Run not found」alert を表示)。
    // 重要なのは「同じ run id で fetch が走った」ことなので、route の
    // 観測ですでに担保されている。
    const section = runDetailSection(page);
    await expect(section).toBeVisible();
    // RunDetail は loading → notFound のいずれかに遷移する。
    // notFound の文言が出ていれば、それは `selectedRunId` が runId に
    // セットされた結果ファイルを読みに行った証拠。
    const alert = section.getByRole('alert');
    await expect(alert).toHaveText('Run not found', { timeout: 5_000 });

    // 観測された run-detail 側の HTTP リクエストに、トーストに出た id が
    // path segment として含まれていること。これで onStarted → selectedRunId
    // → RunDetail fetch の貫通が貫通している。
    const expectedPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}`;
    expect(
      detailHits,
      `expected detail fetch for ${expectedPath}, observed: ${detailHits.join(', ')}`,
    ).toContain(expectedPath);

    await page.unroute(detailMatcher);
  });

  test('連続して Run を 2 回成功させると 2 つの一意な run id が払い出される（invariant 3 同一ワークフロー）', async ({
    page,
  }) => {
    // 観点: scenario invariant 3「RunStarted の RunId は実行ごとに一意」を
    // 同一ワークフローへの連続クリックで担保する。
    const fixture = await tracker.create(
      'run-workflow-unique-ids',
      VALID_WORKFLOW_YAML,
    );
    // (review M-1) Track POST count across both clicks so an inadvertent
    // hydration-retry double-fire of the *first* click — which would itself
    // generate two unique ids and accidentally satisfy the inequality
    // assertion below — is detected explicitly.
    const { counter, dispose } = await trackStartRunPosts(page, fixture);

    await gotoWorkflow(page, fixture);

    // 1 回目 (hydration retry helper 経由)
    await clickRunButton(page);
    const firstId = await readRunIdFromToast(page);
    expect(firstId.length).toBeGreaterThan(0);
    // 1 click → 1 POST までしか走っていないこと
    expect(
      counter.value,
      `first click should produce exactly one POST, observed ${counter.value}`,
    ).toBe(1);

    // (review F-7) 2 回目クリック前に、ボタンが完全に idle に戻ってから
    // クリックする。aria-busy='false' を観測してから手動クリック。
    await expect(runButton(page)).toBeEnabled();
    await expect(runButton(page)).toHaveAttribute('aria-busy', 'false');

    await runButton(page).click();
    // (review minor) The earlier `aria-busy=/^(true|false)$/` no-op
    // assertion was removed. Instead we rely on `toContainText` polling
    // below: the success toast is updated only when the second POST
    // resolves, so observing a new (non-firstId) id in the toast directly
    // proves the second click round-tripped through the server.

    // 2 回目のトーストは別 id を含む (toContainText は更新を poll する)
    // NOTE (race): `aria-busy` may flip true→false faster than Playwright
    // can observe in fast in-memory adapters. `toContainText` retries until
    // the new id appears, which is a stronger signal than busy state.
    const toast = page.getByTestId('run-workflow-success');
    await expect(toast).not.toContainText(firstId);
    await expect(toast).toContainText(RUN_STARTED_REGEX);
    const secondText = (await toast.textContent()) ?? '';
    const secondId = secondText.match(RUN_STARTED_REGEX)?.[1] ?? '';
    expect(secondId.length).toBeGreaterThan(0);
    expect(secondId).not.toBe(firstId);

    // (review M-1) 2 click → 2 POST であること。第二クリックも二重発火していない。
    expect(
      counter.value,
      `expected exactly two POSTs after two clicks, observed ${counter.value}`,
    ).toBe(2);

    await dispose();
  });

  test('別ワークフローで Run × 2 → 2 つの run id が衝突しない（invariant 3 cross-workflow）', async ({
    page,
  }) => {
    // 観点 (review F-4): 不変条件 3「RunStarted の RunId は実行ごとに一意」
    // のクロスワークフロー版。A と B 別々のワークフローで Run を成功させて、
    // それぞれの run id が文字列として非空 + 互いに異なることを確認する。
    const fixtureA = await tracker.create(
      'run-workflow-cross-a',
      VALID_WORKFLOW_YAML,
    );
    const fixtureB = await tracker.create(
      'run-workflow-cross-b',
      VALID_WORKFLOW_YAML,
    );

    // (review M-1) Track POSTs for both fixtures so a hydration retry that
    // double-fires either A or B is detected. Each clickRunButton call must
    // produce exactly one POST against its corresponding workflow path.
    const trackerA = await trackStartRunPosts(page, fixtureA);
    const trackerB = await trackStartRunPosts(page, fixtureB);

    // A で Run
    await gotoWorkflow(page, fixtureA);
    await clickRunButton(page);
    const idA = await readRunIdFromToast(page);
    expect(idA.length).toBeGreaterThan(0);
    expect(
      trackerA.counter.value,
      `A: expected exactly one POST, observed ${trackerA.counter.value}`,
    ).toBe(1);

    // B のページに遷移して Run
    await gotoWorkflow(page, fixtureB);
    await clickRunButton(page);
    const idB = await readRunIdFromToast(page);
    expect(idB.length).toBeGreaterThan(0);
    expect(
      trackerB.counter.value,
      `B: expected exactly one POST, observed ${trackerB.counter.value}`,
    ).toBe(1);
    // A の counter は B のクリックでは増えない (route hook が path 厳格 match)
    expect(
      trackerA.counter.value,
      `A: counter should remain 1 after B click, observed ${trackerA.counter.value}`,
    ).toBe(1);

    // 衝突しないこと
    expect(idA).not.toBe(idB);

    await trackerA.dispose();
    await trackerB.dispose();
  });

  test('リクエスト中は Run ボタンが disabled / aria-busy=true / spinner 表示で二重実行を防ぐ', async ({
    page,
  }) => {
    // 観点: in-flight 中の UI 契約。サーバへの POST を遅延させて、その間に
    // ボタンが disabled になり spinner が出ていることを確認する。
    // (review M-2) route.continue を delay 付きで使う = 実 API のレスポンス
    // を「遅らせる」だけで、レスポンス本体はサーバが生成する実データなので
    // モックではない (route.fulfill は使わない)。
    const fixture = await tracker.create(
      'run-workflow-busy',
      VALID_WORKFLOW_YAML,
    );

    const startRunPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs`;
    const matcher = (url: URL) => url.pathname === startRunPath;
    let intercepted = 0;
    await page.route(matcher, async (route) => {
      // POST のみ遅延させる (GET /runs は RecentRuns 用なのでそのまま流す)。
      if (route.request().method() === 'POST') {
        intercepted += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
      await route.continue();
    });

    await gotoWorkflow(page, fixture);

    // Act (hydration retry helper 経由)
    const button = runButton(page);
    await clickRunButton(page);

    // Assert: in-flight 中の状態 (route delay 1.2s 中なのでまだ busy)
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('run-workflow-spinner')).toBeVisible();
    // busy 中は busy ラベル「Starting…」が表示される
    await expect(button).toContainText('Starting');

    // 待機: 完了したら success トーストが出る
    await expect(page.getByTestId('run-workflow-success')).toBeVisible({
      timeout: 5_000,
    });
    // 完了後はボタン idle に戻る
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-busy', 'false');
    // 二重 POST が走っていないこと (review F-5)
    expect(intercepted).toBe(1);

    await page.unroute(matcher);
  });

  test('Run 成功はディスク上の YAML 原文を変更しない（invariant 4: workflow 本体不変）', async ({
    page,
  }) => {
    // 観点 (review F-1): 不変条件 4「ワークフロー本体 (YAML 原文) は実行
    // 開始によって変更されない」を E2E で担保する。Run の成功後にディスク
    // 上の YAML を実ファイルから読み戻し、文字単位で一致することを assert
    // する。これで将来 runtime adapter が誤ってファイルへ書き戻すような
    // 回帰を即時検知できる。
    const fixture = await tracker.create(
      'run-workflow-yaml-immutable',
      VALID_WORKFLOW_YAML,
    );

    // Sanity: 事前の YAML はテスト fixture 通りに保存されている
    const before = await fixture.read();
    expect(before).toBe(VALID_WORKFLOW_YAML);

    await gotoWorkflow(page, fixture);
    await clickRunButton(page);

    // Run 成功を待つ (副作用が確実にサーバ側で完了したのを観測してから比較)
    await expect(page.getByTestId('run-workflow-success')).toBeVisible();

    // Assert: 成功後の YAML は元と完全一致 (1 バイトの差もない)
    const after = await fixture.read();
    expect(after).toBe(VALID_WORKFLOW_YAML);
  });

  test('Run 開始は 1 秒以内に 202 を返し、ユーザは進捗完了を待たされない（invariant 5: 非同期受付）', async ({
    page,
  }) => {
    // 観点 (review F-9): 不変条件 5「実行開始は非同期であり、進捗・完了は
    // 本ワークフローの責務外」を緩い SLA (< 1.5 秒) で担保する。これは固定
    // sleep ではなく実時間の上限チェックで、「`enqueueRun` が同期完了まで
    // 待ってしまう」回帰を検知できる。1.5s は CI のばらつきを許容しつつ
    // ローカルでも信号として有効な値。
    const fixture = await tracker.create(
      'run-workflow-async',
      VALID_WORKFLOW_YAML,
    );
    await gotoWorkflow(page, fixture);

    const t0 = Date.now();
    await clickRunButton(page);
    await expect(page.getByTestId('run-workflow-success')).toBeVisible();
    const elapsed = Date.now() - t0;

    // (review M-4) 3000ms に緩和。in-memory adapter は実際には数十 ms で
    // 完了するので、3 秒を超えるなら同期完了待ちの実装に退化したシグナル。
    // 1500ms は CI のサーバ温まり時 / GC / Vite 遅延コンパイルで偽陽性 fail
    // が出やすかったので、信号の質を保ったまま耐性を上げる。
    expect(
      elapsed,
      `Run start should resolve within 3000ms (was ${elapsed}ms)`,
    ).toBeLessThan(3000);
  });

  test('YAML が壊れているとき Run は 422 で「workflow YAML is invalid」エラー alert を出す（invariant 1: 構文エラーで実行を開始しない）', async ({
    page,
  }) => {
    // Arrange: ファイルの YAML を壊した状態で Run を押す。textarea を編集
    // しても `editor.save()` を経ないとサーバ側ファイルは変わらないので、
    // ファイル自体を壊した状態で開く。
    const fixture = await tracker.create(
      'run-workflow-invalid-yaml',
      VALID_WORKFLOW_YAML,
    );
    // ディスク上の YAML を「unclosed flow list」で上書きして parser を壊す。
    // (review minor) fixture.write() ヘルパ経由で書く。`node:fs/promises` の
    // 直叩きは fixture 抽象に穴を空けるので避ける。
    const brokenYaml = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: broken\n  version: '0.1.0'\ndo: [unclosed\n`;
    await fixture.write(brokenYaml);

    await gotoWorkflow(page, fixture);

    // Act
    await clickRunButton(page);

    // Assert: role=alert に invalidYaml の文言
    const errorToast = page.getByTestId('run-workflow-error');
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText('workflow YAML is invalid');
    // 成功側は出ない
    await expect(page.getByTestId('run-workflow-success')).toHaveCount(0);
    // ボタンは再利用可能 (ユーザが YAML を直して retry できる)
    await expect(runButton(page)).toBeEnabled();

    // invariant 1 系列: 実行開始失敗時もファイルは変更されない
    const after = await fixture.read();
    expect(after).toBe(brokenYaml);
  });

  test('YAML がスキーマ違反 (do の各要素がマッピングでない) のとき Run は 422 で schema reason 付きの alert を出す（invariant 1: schema violation）', async ({
    page,
  }) => {
    // 観点 (review Major): `parseWorkflowYaml` には parse error と schema
    // violation の 2 経路がある。`SCHEMA_INVALID_WORKFLOW_YAML` (`do: - just_a_string`)
    // は YAML 自体は valid だがワークフロースキーマに違反 (do の各要素は
    // single-key mapping でなければならない)。サーバはこれを invalidYaml と
    // 判定し、reason に「each \`do\` entry must be a mapping」を含める。
    // parse error 系 (`run-workflow-invalid-yaml`) と独立してテストすることで、
    // 将来 yaml.ts の reason 文言が parse error / schema violation で分岐
    // するように改修されたとき silently 落ちる回帰を即時検知する。
    const fixture = await tracker.create(
      'run-workflow-schema-invalid',
      VALID_WORKFLOW_YAML,
    );
    // valid な YAML を schema 違反版で上書き
    await fixture.write(SCHEMA_INVALID_WORKFLOW_YAML);

    await gotoWorkflow(page, fixture);

    // Act
    await clickRunButton(page);

    // Assert: invalidYaml の文言 + schema reason が含まれる
    const errorToast = page.getByTestId('run-workflow-error');
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText('workflow YAML is invalid');
    // 現実装の schema-violation reason: 「each `do` entry must be a mapping」。
    // この文言が変わった場合、テンプレ追従を促すための fail として有効。
    await expect(errorToast).toContainText('each `do` entry must be a mapping');
    await expect(page.getByTestId('run-workflow-success')).toHaveCount(0);
    await expect(runButton(page)).toBeEnabled();

    // invariant 4: 失敗系でもファイル原文は変更されない
    const after = await fixture.read();
    expect(after).toBe(SCHEMA_INVALID_WORKFLOW_YAML);
  });

  test('ランタイム未対応ノードを含む YAML では Run が 422 で「runtime-unsupported node type: <type>」alert を出す（invariant 2）', async ({
    page,
  }) => {
    // Arrange: ランタイムが対応していない `fork` ノードを含む YAML を seed。
    // ファイルパスは fixture.create が割り当てるので、そのままディスクに
    // 書き込む内容として未対応ノードを使う。
    const unsupportedYaml = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: unsupported-node
  version: '0.1.0'
do:
  - bad_step:
      fork:
        - a
        - b
`;
    const fixture = await tracker.create(
      'run-workflow-unsupported',
      unsupportedYaml,
    );

    await gotoWorkflow(page, fixture);

    // Act
    await clickRunButton(page);

    // Assert: 未対応ノード名 `fork` が文言に含まれる
    const errorToast = page.getByTestId('run-workflow-error');
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText(
      'workflow uses a runtime-unsupported node type: fork',
    );
    await expect(page.getByTestId('run-workflow-success')).toHaveCount(0);
    await expect(runButton(page)).toBeEnabled();

    // (review minor) invariant 4 全網羅: 失敗系でもファイル原文不変
    const after = await fixture.read();
    expect(after).toBe(unsupportedYaml);
  });

  test('ワークフローファイルが削除されている状態で Run を押すと 404「workflow not found」alert が出る', async ({
    page,
  }) => {
    // Arrange: ページ load 中はファイルが存在するが、Run 直前に削除する。
    // ページ load 時点でファイルが無いと SvelteKit が 404 ページを出して
    // ボタンに到達しないため、いったん load を成功させる必要がある。
    const fixture = await tracker.create(
      'run-workflow-not-found',
      VALID_WORKFLOW_YAML,
    );

    await gotoWorkflow(page, fixture);

    // ファイルを削除してから Run をクリック
    await fixture.cleanup();

    await clickRunButton(page);

    // Assert
    const errorToast = page.getByTestId('run-workflow-error');
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText('workflow not found');
    await expect(page.getByTestId('run-workflow-success')).toHaveCount(0);
  });

  test('ランタイム停止中は Run が 503「workflow runtime is unavailable」alert を出し、復旧後は同じボタンで成功する', async ({
    page,
  }) => {
    // Arrange: 有効な YAML、しかしランタイムを unavailable にする。
    const fixture = await tracker.create(
      'run-workflow-runtime-down',
      VALID_WORKFLOW_YAML,
    );
    await setRuntimeAvailable(false);

    await gotoWorkflow(page, fixture);

    // Act 1: ランタイム停止中
    await clickRunButton(page);

    // Assert: 503 → 「workflow runtime is unavailable」alert
    const errorToast = page.getByTestId('run-workflow-error');
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText('workflow runtime is unavailable');
    await expect(page.getByTestId('run-workflow-success')).toHaveCount(0);
    // 再試行可能 (ユーザがインフラを復旧したら再クリックできる)
    await expect(runButton(page)).toBeEnabled();

    // (review minor) invariant 4 全網羅: ランタイム停止失敗系でも YAML 原文不変
    const yamlAfterFailure = await fixture.read();
    expect(yamlAfterFailure).toBe(VALID_WORKFLOW_YAML);

    // Act 2: ランタイム復旧
    await setRuntimeAvailable(true);
    // (review M-5) `clickRunButton` ヘルパを再利用しない理由: ヘルパは
    // 「副作用が観測済み (error caption がある)」を hydration 完了の証拠と
    // 解釈して click をスキップする。Act 1 が残した error caption が依然
    // として DOM 上にあるので、ここでヘルパを呼ぶと「もう発火した」と
    // 誤判定して再クリックを発行しない。hydration は Act 1 の click で
    // 既に完了済みなので、`toBeEnabled()` を待ったうえで一度 click すれ
    // ば十分。
    await expect(runButton(page)).toBeEnabled();
    await runButton(page).click();

    // Assert: 成功トーストに切り替わり、エラー alert は消える。
    // status は 'success' に再代入されるので、過去の error テストid は単一の
    // status に上書きされる (component implementation に従う)。
    await expect(page.getByTestId('run-workflow-success')).toBeVisible();
    await expect(page.getByTestId('run-workflow-error')).toHaveCount(0);
  });

  test('path-traversal な workflowId を URL に直接入れたページでは Run ボタンに到達できない（POST 経路の `parseWorkflowParam` 400 境界）', async ({
    page,
  }) => {
    // 観点 (review F-2): GET 経路の path-traversal 拒否は
    // `list-recent-runs.spec.ts` で担保されているが、POST 経路 (Run ボタン
    // の実体) も `parseWorkflowParam` を通っている。E2E では「ユーザが
    // 攻撃 URL を踏んだとき UI が崩れたり、別 workflow の Run ボタンに
    // 到達したりしない」ことを確認する。
    //
    // 別ワークフロー B を seed しておき、攻撃 URL でアクセスしたときに
    // SvelteKit が 4xx を返し、Run ボタンに到達できず B の機微情報も
    // 漏れていないことを確認する。
    const fixtureB = await tracker.create(
      'run-workflow-traversal-victim',
      VALID_WORKFLOW_YAML,
    );

    // Act: path-traversal なペイロードでアクセス。`/` をパーセントエンコード
    // しないと SvelteKit のルータが別ルートにマッチするので明示的にエンコードする。
    const evilId = '..%2F..%2Fetc%2Fpasswd';
    const response = await page.goto(`/workflows/${evilId}`);

    // (review M-3) Assert: SvelteKit の page load `parseWorkflowParam` は
    // `..` を含む id を `error(400, 'invalid workflow id')` で拒否する。
    // 400 を「ステータス 1 つだけ」に絞り、backend 実装と整合させる。
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(400);

    // Run ボタンに到達できないこと (= load 自体が 4xx で UI に Run ボタンが
    // 描画されない)。
    await expect(runButton(page)).toHaveCount(0);

    // B の id がエラーページに漏れていないこと
    await expect(page.locator('body')).not.toContainText(fixtureB.id);

    // 直接 POST も (API レイヤで) 400 を返すこと。これでルートハンドラの
    // 入口ガードが POST 経路にも効いていることを担保する。
    await withApiContext(async (ctx) => {
      const res = await ctx.post(`/api/workflows/${evilId}/runs`);
      // (review M-3) 400 へ厳格化。brand 違反は 400 を返す契約。
      expect(res.status()).toBe(400);
      const body = await res.text();
      // (review M-3) レスポンスに攻撃文字列の生形・デコード形いずれも
      // echo していないこと。一般的な 400 レスポンスには汎用エラー文言
      // (`invalid workflow id`) のみが含まれる。
      const decoded = decodeURIComponent(evilId); // '../../etc/passwd'
      expect(body).not.toContain(evilId);
      expect(body).not.toContain(decoded);
      expect(body).not.toContain('etc/passwd');
      // B の id (機微情報) もエラーボディに漏れていないこと
      expect(body).not.toContain(fixtureB.id);
    });
  });

  // NOTE (review minor): 413 (body-limit) / 403 (same-origin) の API ガード
  // 境界テストは `e2e/integration/run-workflow.security.spec.ts` に分離済み。
  // これは observation: それらのケースは UI 経由では踏めない (ブラウザは自前の
  // Origin を捏造できないし、超過 body は通常生成しない) ため、UI 駆動 E2E と
  // 切り分けたほうが観点整理が明確になる。
});
