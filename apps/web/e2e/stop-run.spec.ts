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
import { stopRunCopy } from '../src/features/workflow-editor/components/stopRunCopy';

// E2E tests for the "Stop Run" scenario.
//
// Scenario: apps/web/docs/scenarios/workflow-editor/stop-run.md
//
// Coverage (mapped to scenario user stories + invariants):
//   - 正常系
//     - 進行中 (running) の Run を選択 → Stop ボタンが表示され、クリックで
//       POST /api/workflows/:id/runs/:runId/stop が走り、「Stop requested」
//       caption が表示される (scenario step 2 success path)
//     - Stop 受理後、RunDetail パネルが再フェッチされる (refreshKey++ 経路)
//     - In-flight 中は Stop ボタンが disabled / aria-busy=true / spinner 表示
//       (二重 dispatch 防止)
//   - エラー系
//     - 終了済み Run (succeeded / failed / cancelled) を選択しても Stop ボタンは
//       一切描画されない (invariant 1: 既に終了状態の Run には停止要求を発行しない)
//     - In-flight 中に裏で run を terminal に書き換えて Stop POST が走ると、
//       サーバが 409 を返し、UI は「run is already <status>」alert を表示
//     - Run が削除されている状態で Stop POST を直接叩くと 404 が返る
//       (UI 上は button が消えるためダイレクト API で担保)
//     - ランタイム停止中 (503) で Stop ボタンを押すと
//       「workflow runtime is unavailable」alert が表示される。再開後は再試行で成功
//   - セキュリティ境界
//     - 別ワークフローに属する runId に対する POST は 404 で拒否され、
//       他ワークフローの run 情報が漏れない (cross-workflow isolation)
//     - path-traversal な runId / workflowId は 400 で拒否される
//     - クロスオリジン Origin の POST は 403 で拒否される (CSRF 境界)
//
// Test data is seeded via the test-only `/api/_test/runs` endpoint and
// runtime availability is toggled via `/api/_test/runtime` (both gated by
// `RALPH_WEB_TEST_SEED=1`).

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
 * Build a fresh APIRequestContext for each call. Mirrors the helpers used in
 * `run-workflow.spec.ts` / `read-run-detail.spec.ts`. `Connection: close`
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

/**
 * Toggle the in-memory runtime availability. The flag is process-wide, so
 * every test that flips it MUST flip it back in `afterEach` to avoid
 * cross-test pollution (mirrors `run-workflow.spec.ts`).
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
  await row.getByRole('button').click();
}

/** Locate the Stop button inside the run-detail panel by its accessible name. */
function stopButton(page: Page) {
  return runDetailSection(page).getByRole('button', {
    name: stopRunCopy.triggerAria,
  });
}

/**
 * Click the Stop button safely against a SvelteKit-hydrated page. Mirrors
 * `clickRunButton` in `run-workflow.spec.ts`: a click issued during the
 * SSR-only window before Svelte attaches the `onclick` listener is silently
 * dropped by the browser.
 *
 * Note: unlike `clickRunButton`, we cannot rely on the success caption as a
 * proof of "click reached handler" because RunDetail re-fetches synchronously
 * from `onAccepted`, which sets `loadState = { kind: 'loading' }`. That
 * unmounts the entire StopRunButton (including its success caption) before
 * the browser ever paints the success state. We therefore observe ONLY the
 * synchronous in-flight signal — `aria-busy=true` flipped by the handler
 * before it awaits — OR an inline error caption (which IS visible because
 * the error path does NOT call `onAccepted`).
 *
 * Once we observe ANY proof that the click landed (busy / error / button
 * unmount mid-roundtrip), we record it and never click again, so the helper
 * is safe against retry-induced double-fire even when the button re-mounts
 * between retries (which it does: ready → loading → ready cycle on success).
 */
async function clickStopButton(page: Page) {
  await expect(stopButton(page)).toBeEnabled();
  let clicked = false;
  await expect(async () => {
    const button = stopButton(page);
    if (clicked) {
      // Wait for the in-flight cycle to settle before returning. We're
      // satisfied once we observe the run-detail panel exit `loading`
      // (= refetch completed) — a permanent button state OR an error
      // caption. Throwing keeps `toPass` polling.
      const busy = (await button.getAttribute('aria-busy').catch(() => null)) === 'true';
      const errorCount = await page.getByTestId('stop-run-error').count();
      if (busy) {
        throw new Error('still in-flight, polling…');
      }
      // No-op once the click has been observed and the cycle has settled
      // (button steady-state OR error caption visible).
      const buttonCount = await button.count();
      if (buttonCount > 0 || errorCount > 0) return;
      // Otherwise the panel is still in `loading` (button unmounted, no
      // error). Wait one more tick.
      throw new Error('panel refetch in progress, polling…');
    }
    const busy = (await button.getAttribute('aria-busy').catch(() => null)) === 'true';
    const errorCount = await page.getByTestId('stop-run-error').count();
    if (busy || errorCount > 0) {
      // Handler already fired (either by a previous retry's click or by a
      // duplicate hydration sequence). Mark as clicked so we never re-click.
      clicked = true;
      return;
    }
    if ((await button.count()) === 0) {
      throw new Error('stop button not in DOM yet');
    }
    await button.click();
    clicked = true;
    const becameBusy = (await button.getAttribute('aria-busy').catch(() => null)) === 'true';
    const ec = await page.getByTestId('stop-run-error').count();
    if (!becameBusy && ec === 0) {
      // The button may already have unmounted between click and probe (very
      // fast 202 path with synchronous loadState=loading). That counts as
      // a successful click landing.
      if ((await stopButton(page).count()) === 0) return;
      // Otherwise hydration probably hadn't attached the handler yet. Reset
      // the clicked flag so we retry — but ONLY if no in-flight signal
      // shows up on the next iteration either, which is safer than
      // silently double-firing.
      clicked = false;
      throw new Error('hydration not complete: click had no observable effect');
    }
  }).toPass({ timeout: 10_000, intervals: [50, 100, 200, 400] });
}

/**
 * Build a SeedDetailRow + matching SeedSummaryRow pair for a run with the
 * given status. For non-terminal runs `endedAt` and `durationMs` are `null`
 * (entity invariant 4 in `runSummary.ts`).
 */
function makeRunFixture(
  workflowId: string,
  runId: string,
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled',
  baseNow: number,
): { summary: SeedSummaryRow; detail: SeedDetailRow } {
  const isTerminal =
    status === 'succeeded' || status === 'failed' || status === 'cancelled';
  const startedAt = baseNow - 5_000;
  const endedAt = isTerminal ? baseNow - 1_000 : null;
  return {
    summary: {
      id: runId,
      workflowId,
      status,
      startedAt,
      durationMs: isTerminal && endedAt !== null ? endedAt - startedAt : null,
    },
    detail: {
      id: runId,
      workflowId,
      status,
      startedAt,
      endedAt,
      nodes: [
        {
          nodeId: 'only_step',
          status:
            status === 'pending'
              ? 'pending'
              : status === 'running'
                ? 'running'
                : status === 'succeeded'
                  ? 'succeeded'
                  : status === 'failed'
                    ? 'failed'
                    : 'cancelled',
          startedAt: status === 'pending' ? null : startedAt,
          endedAt:
            isTerminal && endedAt !== null
              ? endedAt
              : null,
          output: null,
          errorMessage: status === 'failed' ? 'simulated error' : null,
          logExcerpt: '',
        },
      ],
    },
  };
}

test.describe('stop-run: ユーザが進行中の Run を Stop ボタンから停止する', () => {
  test.beforeEach(async () => {
    // Clean slate: empty run store + runtime available.
    await resetRunStore();
    await setRuntimeAvailable(true);
  });

  test.afterEach(async () => {
    // Re-enable runtime so a previous test's toggle does not poison the
    // next spec; clear fixtures + run rows.
    await setRuntimeAvailable(true);
    await tracker.cleanupAll();
    await resetRunStore();
  });

  test('進行中の run を選択して Stop を押すと POST /stop が 202 を返し、エラー caption は出ない（正常系: stopRequested）', async ({
    page,
  }) => {
    // Arrange: running 状態の run を 1 件 seed
    const fixture = await tracker.create('stop-run-success', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    const runId = 'run-stop-ok';
    const { summary, detail } = makeRunFixture(fixture.id, runId, 'running', baseNow);
    await seedRuns([summary], [detail]);

    // pass-through 観測: stop POST が走り 202 を返したことを実 API レスポンスから
    // 確認する (route.continue のみ; モック不使用)。
    // 注 (実装): RunDetail は onAccepted で `refreshKey` を bump し、parent の
    // `$effect` が `loadState = { kind: 'loading' }` をセットするため、
    // `{#if loadState.kind === 'ready' && !terminal}` を満たす期間が短く、
    // StopRunButton 内部の `stop-run-success` caption は実質的に DOM に
    // 滞留せずユーザーに観測できない。そのため正常系の検証は
    // 「stop POST が 202 で受理された」「エラー caption が出ない」「button が
    // disabled でない idle 状態に戻る (ready で再 mount された後の状態)」を
    // ネットワーク + UI 両面から担保する。
    const stopPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}/stop`;
    let stopStatus: number | null = null;
    let stopMethod: string | null = null;
    let stopPostCount = 0;
    const matcher = (url: URL) => url.pathname === stopPath;
    await page.route(matcher, async (route) => {
      stopMethod = route.request().method();
      if (route.request().method() === 'POST') stopPostCount += 1;
      const response = await route.fetch();
      stopStatus = response.status();
      await route.fulfill({ response });
    });

    // Act: ページを開いて run 行をクリック → run-detail が ready 状態になり
    // Stop ボタンが現れる (StopRunButton は loadState.kind === 'ready' &&
    // !isTerminalRunStatus(detail.status) の時のみ描画される)
    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    const stop = stopButton(page);
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();
    await expect(stop).toContainText(stopRunCopy.triggerLabel);

    // Click Stop (hydration-retry helper)
    await clickStopButton(page);

    // Assert: stop POST が走り、サーバが 202 (Accepted) を返した
    await expect.poll(() => stopMethod).toBe('POST');
    await expect.poll(() => stopStatus).toBe(202);

    // エラー caption は出ない (= Stop は受理された)
    await expect(page.getByTestId('stop-run-error')).toHaveCount(0);

    // 受理後、parent の refresh が完了し button は再び ready 状態に戻る
    // (in-memory adapter は run の status を変更しないので button は復帰する)
    await expect(stopButton(page)).toBeVisible();
    await expect(stopButton(page)).toBeEnabled();
    await expect(stopButton(page)).toHaveAttribute('aria-busy', 'false');

    // (review m-5) hydration retry での二重発火が無いことも明示する。
    // clickStopButton は既に二重発火防止のフラグを持っているが、
    // success 系テストでも POST 回数を観測値として固定することで、
    // 万一 retry path が暴発した場合に検知できるようにする。
    expect(stopPostCount).toBe(1);

    await page.unroute(matcher);
  });

  test('(review M-1) detail GET を遅延させると Stop 受理直後に「Stop requested」success caption が観測できる', async ({
    page,
  }) => {
    // 観点 (review M-1): success caption "Stop requested" は本来ユーザーへ
    // 受理を知らせる UX キューだが、通常フローでは StopRunButton の
    // onAccepted → parent.refreshKey++ → loadState=loading → button unmount
    // が同期的に走るので caption が DOM に滞留しない。テストとして「ユーザに
    // 受理が伝わる」UX を担保するため、再フェッチに走る detail GET を
    // 1.2 秒遅延させて success caption が確実に observable になる時間窓を
    // 作り、その間 caption が visible であること、コピーが
    // `stopRunCopy.acceptedLabel` と一致することを assert する。
    // (route.fulfill は pass-through; モック不使用)
    const fixture = await tracker.create(
      'stop-run-success-observable',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-success-observable';
    const { summary, detail } = makeRunFixture(
      fixture.id,
      runId,
      'running',
      baseNow,
    );
    await seedRuns([summary], [detail]);

    const detailPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}`;
    const stopPath = `${detailPath}/stop`;

    // 初回の detail GET (run 選択直後) は遅延させたくない。stop POST 後の
    // 2 回目以降の detail GET だけ遅延させたいので、stop POST が走ったか
    // どうかをフラグで管理する。
    let stopAccepted = false;
    const matcher = (url: URL) =>
      url.pathname === detailPath || url.pathname === stopPath;
    await page.route(matcher, async (route) => {
      const u = new URL(route.request().url());
      const method = route.request().method();
      if (u.pathname === stopPath && method === 'POST') {
        // pass-through で 202 を返す。受理フラグを立てる。
        const response = await route.fetch();
        stopAccepted = true;
        await route.fulfill({ response });
        return;
      }
      if (u.pathname === detailPath && method === 'GET' && stopAccepted) {
        // 受理後の再フェッチを 1.2 秒遅延させて caption の observability
        // ウィンドウを作る。
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        await route.continue();
        return;
      }
      await route.continue();
    });

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);
    await expect(stopButton(page)).toBeVisible();
    await clickStopButton(page);

    // Assert: 受理直後に success caption (role=status) が visible になる
    const success = page.getByTestId('stop-run-success');
    await expect(success).toBeVisible({ timeout: 5_000 });
    await expect(success).toHaveText(stopRunCopy.acceptedLabel);
    await expect(success).toHaveAttribute('role', 'status');
    // この時点ではエラー caption は出ない
    await expect(page.getByTestId('stop-run-error')).toHaveCount(0);

    // 遅延した detail GET が完了するまで待つと、StopRunButton は再 mount
    // されて success caption は消える (= 仕様通り)。最終状態として
    // ボタンが再び idle になっていることも担保する。
    await expect(stopButton(page)).toBeEnabled({ timeout: 5_000 });
    await expect(stopButton(page)).toHaveAttribute('aria-busy', 'false');

    await page.unroute(matcher);
  });

  test('(review M-3) ネットワーク断 (fetch reject) のとき stop-run-error alert が表示され、UI は壊れない', async ({
    page,
  }) => {
    // 観点 (review M-3): `stopRun()` の `catch` (status 0 / network error) 経路
    // を E2E で観測する。`page.route` の `route.abort('failed')` で
    // ブラウザ側 fetch を拒否し、StopRunButton が role=alert caption を
    // 描画して再試行可能 (button が enabled に戻る) であることを確認する。
    // モックではなく「実際のネット断」のシミュレーションであり、サーバ側の
    // ハンドラには到達しない (= サーバには副作用なし)。
    const fixture = await tracker.create(
      'stop-run-network-error',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-network-error';
    const { summary, detail } = makeRunFixture(
      fixture.id,
      runId,
      'running',
      baseNow,
    );
    await seedRuns([summary], [detail]);

    const stopPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}/stop`;
    let abortedCount = 0;
    const matcher = (url: URL) => url.pathname === stopPath;
    await page.route(matcher, async (route) => {
      if (route.request().method() === 'POST') {
        abortedCount += 1;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);
    const stop = stopButton(page);
    await expect(stop).toBeVisible();

    await clickStopButton(page);

    // Assert: error caption が出る (status 0 → mapStopRunHttpStatus には
    // 行かず、catch 内の `e instanceof Error ? e.message : 'network error'`
    // が message になる。chromium の fetch reject は `TypeError: Failed to fetch`
    // 系のメッセージ、もしくは Playwright が abort に与える reason によって
    // ブラウザ依存のメッセージになるため、特定の文字列ではなく
    // 「caption が visible で role=alert で 1 件だけ存在する」ことを assert
    // する)。
    const errorCaption = page.getByTestId('stop-run-error');
    await expect(errorCaption).toBeVisible();
    await expect(errorCaption).toHaveAttribute('role', 'alert');
    await expect(errorCaption).toHaveCount(1);
    // ネット断はテキストが空ではないこと (ユーザに何らかの情報が伝わる)
    await expect(errorCaption).not.toHaveText('');
    // success caption は出ない
    await expect(page.getByTestId('stop-run-success')).toHaveCount(0);
    // 復旧前提でユーザは再試行可能 (button は enabled に戻る)
    await expect(stop).toBeEnabled();
    expect(abortedCount).toBeGreaterThanOrEqual(1);

    await page.unroute(matcher);
  });

  test('(review M-2) 別 run へ切替えると直前の error caption がリセットされる（runId 切替時の状態リーク防止）', async ({
    page,
  }) => {
    // 観点 (review M-2): StopRunButton 内の `$effect(() => { ...; status = idle })`
    // が runId 変更時に `status` をリセットすることを UI 経由で担保する。
    // 1) runtime を down にした状態で run A の Stop を押 → 503 alert を確認
    // 2) runtime を復旧
    // 3) UI 上で run B の行を選択
    // 4) run B 側の StopRunButton には error caption が漏れていないことを assert
    const fixture = await tracker.create(
      'stop-run-runid-switch',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runIdA = 'run-switch-a';
    const runIdB = 'run-switch-b';
    const a = makeRunFixture(fixture.id, runIdA, 'running', baseNow);
    const b = makeRunFixture(fixture.id, runIdB, 'running', baseNow + 100);
    await seedRuns([a.summary, b.summary], [a.detail, b.detail]);

    // ランタイムを停止
    await setRuntimeAvailable(false);

    await gotoWorkflow(page, fixture);
    // run A を選択 → Stop 押 → 503 alert
    await selectRunRow(page, runIdA);
    await expect(stopButton(page)).toBeVisible();
    await clickStopButton(page);
    const errorCaption = page.getByTestId('stop-run-error');
    await expect(errorCaption).toBeVisible();
    await expect(errorCaption).toContainText('workflow runtime is unavailable');

    // ランタイム復旧 (次の Stop が成功する条件にしておく)
    await setRuntimeAvailable(true);

    // run B 行を選択 (UI 経由で切替)
    await selectRunRow(page, runIdB);

    // run B の StopRunButton が ready 状態で見える (再 mount)
    await expect(stopButton(page)).toBeVisible();
    await expect(stopButton(page)).toBeEnabled();

    // Assert: 直前の error caption がリーク残留していないこと
    await expect(page.getByTestId('stop-run-error')).toHaveCount(0);
    await expect(page.getByTestId('stop-run-success')).toHaveCount(0);
    // run-detail に runIdB が表示されていることも担保
    await expect(runDetailSection(page)).toContainText(runIdB);
  });

  test('(review m-6) pending 状態 (非 terminal) の run でも Stop ボタンが描画され、押下できる', async ({
    page,
  }) => {
    // 観点 (review m-6): scenario の RunStatus 型では `Pending` も `Running` と
    // 並んで非 terminal。invariant 1 は terminal のみを排除するので、pending
    // でも Stop ボタンが visible / enabled になり、Stop POST が 202 で受理される
    // ことを確認する。
    const fixture = await tracker.create(
      'stop-run-pending',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-pending-1';
    const { summary, detail } = makeRunFixture(
      fixture.id,
      runId,
      'pending',
      baseNow,
    );
    await seedRuns([summary], [detail]);

    const stopPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}/stop`;
    let stopStatus: number | null = null;
    let stopPostCount = 0;
    const matcher = (url: URL) => url.pathname === stopPath;
    await page.route(matcher, async (route) => {
      if (route.request().method() === 'POST') stopPostCount += 1;
      const response = await route.fetch();
      stopStatus = response.status();
      await route.fulfill({ response });
    });

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    // pending でも Stop ボタンが現れる
    const stop = stopButton(page);
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();

    await clickStopButton(page);

    // POST が 1 回だけ走り 202 が返る
    await expect.poll(() => stopStatus).toBe(202);
    expect(stopPostCount).toBe(1);
    // エラー caption は出ない
    await expect(page.getByTestId('stop-run-error')).toHaveCount(0);

    await page.unroute(matcher);
  });

  test('(review m-7) Stop 受理 → backend が cancelled に書き換え → 再フェッチ後 UI が cancelled を観測する（invariant 3 の橋渡し）', async ({
    page,
  }) => {
    // 観点 (review m-7): scenario invariant 3「実際に Cancelled 状態へ遷移
    // したかは別ワークフロー（実行状態購読）で観測する」。stop-run の責務
    // としては「受理まで」だが、UI 経路として「受理 → 再フェッチ →
    // backend が cancelled へ遷移済みなら UI に反映される」ことを担保する。
    // テスト seed 経由で stop POST 受理直後に backend の detail を cancelled
    // に書き換え、再フェッチ後の RunDetail パネルが cancelled を表示する
    // ことを assert する。
    const fixture = await tracker.create(
      'stop-run-cancelled-observed',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-cancelled-observed';
    const { summary, detail } = makeRunFixture(
      fixture.id,
      runId,
      'running',
      baseNow,
    );
    await seedRuns([summary], [detail]);

    const stopPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}/stop`;
    const matcher = (url: URL) => url.pathname === stopPath;
    await page.route(matcher, async (route) => {
      if (route.request().method() === 'POST') {
        // 実 backend に POST → 202 を取得
        const response = await route.fetch();
        // 受理後、テスト seed で detail を cancelled に書き換える
        // (= 別ワークフロー = 実行状態購読 が遷移を観測した結果のシミュレーション)
        const cancelled = makeRunFixture(
          fixture.id,
          runId,
          'cancelled',
          baseNow,
        );
        await seedRuns([cancelled.summary], [cancelled.detail]);
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);
    await expect(stopButton(page)).toBeVisible();
    await clickStopButton(page);

    // 再フェッチが完了すると detail.status === 'cancelled' になり、
    // (1) Stop ボタンが描画されない (terminal なので invariant 1)
    // (2) RunDetail のステータス pill が "Cancelled" を含む
    await expect(stopButton(page)).toHaveCount(0, { timeout: 5_000 });
    // status pill の文字 (`runStatusLabel('cancelled')` は "Cancelled")
    await expect(runDetailSection(page)).toContainText(/Cancelled/i);

    await page.unroute(matcher);
  });

  test('Stop 受理後に RunDetail パネルが再フェッチされる（refreshKey による再ロード）', async ({
    page,
  }) => {
    // 観点: scenario invariants 2 & 3 — 停止は非同期、実際の Cancelled 遷移は
    // 別ワークフロー (read-run-detail) で観測する。RunDetail は Stop 受理時に
    // 内部の `refreshKey` を bump して GET /api/.../runs/:runId を再発行する。
    // ここでは pass-through の `page.route` で stop POST 後に detail GET が
    // 1 回追加で走ることを観測する (route.continue のみ; モック不使用)。
    const fixture = await tracker.create(
      'stop-run-refetch',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-stop-refetch';
    const { summary, detail } = makeRunFixture(fixture.id, runId, 'running', baseNow);
    await seedRuns([summary], [detail]);

    // Pass-through observation of detail GETs for this specific run.
    const detailPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}`;
    const stopPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}/stop`;
    let detailGetCount = 0;
    let stopPostCount = 0;
    const matcher = (url: URL) =>
      url.pathname === detailPath || url.pathname === stopPath;
    await page.route(matcher, async (route) => {
      const u = new URL(route.request().url());
      const method = route.request().method();
      if (u.pathname === detailPath && method === 'GET') {
        detailGetCount += 1;
      } else if (u.pathname === stopPath && method === 'POST') {
        stopPostCount += 1;
      }
      await route.continue();
    });

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);

    // 初回の detail fetch を待つ
    await expect(stopButton(page)).toBeVisible();
    await expect.poll(() => detailGetCount).toBeGreaterThanOrEqual(1);
    const initialGetCount = detailGetCount;

    await clickStopButton(page);

    // Assert: stop POST が 1 回走り、その後 detail GET が追加で 1 回以上走る
    // (refreshKey++ により parent が再フェッチ → loadState=loading → 復帰)
    await expect.poll(() => stopPostCount).toBe(1);
    await expect.poll(() => detailGetCount).toBeGreaterThan(initialGetCount);

    await page.unroute(matcher);
  });

  test('リクエスト中は Stop ボタンが disabled / aria-busy=true / spinner 表示で二重実行を防ぐ', async ({
    page,
  }) => {
    // 観点: in-flight 中の UI 契約。サーバへの POST を遅延させて、その間に
    // ボタンが disabled になり spinner が出ていることを確認する。
    // route.continue の delay 経由なので実 API のレスポンス本体はサーバが
    // 生成する実データ (= モックではない)。
    const fixture = await tracker.create('stop-run-busy', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    const runId = 'run-stop-busy';
    const { summary, detail } = makeRunFixture(fixture.id, runId, 'running', baseNow);
    await seedRuns([summary], [detail]);

    const stopPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}/stop`;
    let intercepted = 0;
    const matcher = (url: URL) => url.pathname === stopPath;
    await page.route(matcher, async (route) => {
      if (route.request().method() === 'POST') {
        intercepted += 1;
        // 1.2s 遅延させてから実 API へ流す
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
      await route.continue();
    });

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);
    const stop = stopButton(page);
    await expect(stop).toBeVisible();
    await clickStopButton(page);

    // Assert: in-flight 中の状態 (delay 1.2s 中なのでまだ busy)
    await expect(stop).toBeDisabled();
    await expect(stop).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('stop-run-spinner')).toBeVisible();
    await expect(stop).toContainText(stopRunCopy.triggerBusyLabel);

    // 二重クリックを試みても in-flight 中は無視される (disabled なのでクリック自体届かない)。
    // Playwright は disabled 要素のクリックでは Actionability チェックが timeout する
    // ので force=true で押下を試行し、その後も intercepted が 1 のままであることを確認。
    await stop.click({ force: true }).catch(() => {
      // disabled 要素の click は Playwright が拒否することがあるが、ここでは
      // 「もし届いてしまっても POST は 1 回しか走らない」ことを確認したいだけ
      // なのでエラーは握りつぶす。
    });

    // 待機: 完了したらボタンが idle に戻る (busy=true → false の遷移を待つ)。
    // 注: stop-run-success caption は parent の refreshKey++ → loadState=loading
    // による StopRunButton 自体の unmount で実質的に観測できないため、ここでは
    // 「busy が抜けた」「再 mount 後に再び idle」を観測信号として使う。
    await expect(stopButton(page)).toBeVisible({ timeout: 5_000 });
    await expect(stopButton(page)).toBeEnabled();
    await expect(stopButton(page)).toHaveAttribute('aria-busy', 'false');
    // エラー caption は出ない (= 受理経路)
    await expect(page.getByTestId('stop-run-error')).toHaveCount(0);
    // 二重 POST が走っていないこと
    expect(intercepted).toBe(1);

    await page.unroute(matcher);
  });

  test('終了済みの run (succeeded / failed / cancelled) を選択しても Stop ボタンは描画されない（invariant 1）', async ({
    page,
  }) => {
    // 観点: scenario invariant 1 「既に終了状態の Run には停止要求を発行しない」。
    // UI 層は terminal 状態の Run を選んだとき StopRunButton を一切レンダリング
    // しない。3 つの terminal 状態を順に確認する。
    const fixture = await tracker.create(
      'stop-run-no-button-on-terminal',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const okFixture = makeRunFixture(fixture.id, 'run-ok', 'succeeded', baseNow);
    const failFixture = makeRunFixture(fixture.id, 'run-fail', 'failed', baseNow);
    const cancelFixture = makeRunFixture(
      fixture.id,
      'run-cancel',
      'cancelled',
      baseNow,
    );
    await seedRuns(
      [okFixture.summary, failFixture.summary, cancelFixture.summary],
      [okFixture.detail, failFixture.detail, cancelFixture.detail],
    );

    await gotoWorkflow(page, fixture);

    // succeeded
    await selectRunRow(page, 'run-ok');
    await expect(runDetailSection(page)).toContainText('run-ok');
    await expect(stopButton(page)).toHaveCount(0);

    // failed
    await selectRunRow(page, 'run-fail');
    await expect(runDetailSection(page)).toContainText('run-fail');
    await expect(stopButton(page)).toHaveCount(0);

    // cancelled
    await selectRunRow(page, 'run-cancel');
    await expect(runDetailSection(page)).toContainText('run-cancel');
    await expect(stopButton(page)).toHaveCount(0);
  });

  test('Stop POST が 409 を返したとき UI は「run is already <status>」alert を表示する（runAlreadyTerminal）', async ({
    page,
  }) => {
    // 観点: scenario の `runAlreadyTerminal` 経路。UI 上では run が running
    // のまま見えていても、実際の停止リクエストがサーバに到達した瞬間に
    // run が terminal になっていれば 409 が返る (server-side `findRun` が
    // terminal を観測するため)。これは route.continue で stop POST を
    // 遅延させ、その間にバックエンドの run row を `_test/runs` API 経由で
    // succeeded に書き換えることで再現できる。モック (route.fulfill) は
    // 使わず、サーバが生成する実 409 レスポンスを観測する。
    const fixture = await tracker.create('stop-run-409', VALID_WORKFLOW_YAML);
    const baseNow = Date.now();
    const runId = 'run-becomes-terminal';
    const running = makeRunFixture(fixture.id, runId, 'running', baseNow);
    await seedRuns([running.summary], [running.detail]);

    const stopPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}/stop`;
    const matcher = (url: URL) => url.pathname === stopPath;

    // stop POST を 1 秒遅延させ、その間に run を terminal に書き換える。
    let stopHandlerStarted = false;
    await page.route(matcher, async (route) => {
      if (route.request().method() === 'POST') {
        stopHandlerStarted = true;
        // POST がサーバへ届く前に detail を succeeded に上書きする。
        // _test/runs は同 id を upsert するので最新が反映される。
        const succeeded = makeRunFixture(
          fixture.id,
          runId,
          'succeeded',
          baseNow,
        );
        await seedRuns([succeeded.summary], [succeeded.detail]);
        // ちょっとだけ遅延 (テスト seed が反映される時間を見込む)
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await route.continue();
    });

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);
    await expect(stopButton(page)).toBeVisible();

    await clickStopButton(page);

    // Assert: error caption (role=alert) に「run is already succeeded」
    const errorCaption = page.getByTestId('stop-run-error');
    await expect(errorCaption).toBeVisible();
    await expect(errorCaption).toContainText('run is already');
    // 成功 caption は出ない
    await expect(page.getByTestId('stop-run-success')).toHaveCount(0);
    // ボタンは再利用可能 (ユーザは別 run を選び直せる)
    await expect(stopButton(page)).toBeEnabled();
    expect(stopHandlerStarted).toBe(true);

    await page.unroute(matcher);
  });

  test('ランタイム停止中 (503) では Stop ボタンを押すと「workflow runtime is unavailable」alert が出て、復旧後の再試行で成功する', async ({
    page,
  }) => {
    // Arrange: running な run を seed、ランタイムを unavailable に。
    const fixture = await tracker.create(
      'stop-run-runtime-down',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runId = 'run-stop-503';
    const running = makeRunFixture(fixture.id, runId, 'running', baseNow);
    await seedRuns([running.summary], [running.detail]);

    await setRuntimeAvailable(false);

    await gotoWorkflow(page, fixture);
    await selectRunRow(page, runId);
    const stop = stopButton(page);
    await expect(stop).toBeVisible();

    // Act 1: ランタイム停止中に Stop 押下 (hydration-retry 経由)
    await clickStopButton(page);

    // Assert: 503 → 「workflow runtime is unavailable」alert
    const errorCaption = page.getByTestId('stop-run-error');
    await expect(errorCaption).toBeVisible();
    await expect(errorCaption).toContainText('workflow runtime is unavailable');
    await expect(page.getByTestId('stop-run-success')).toHaveCount(0);
    // 再試行可能
    await expect(stop).toBeEnabled();

    // Act 2: ランタイム復旧 → 再度クリック → 成功すれば error caption が消える
    // (handler は status を 'pending' へ移して以降 'success' を立てるが、
    // success の時点で onAccepted → refreshKey++ → loadState=loading により
    // button 自体が unmount されて caption は観測できない。ここでは
    // 「error caption が消える」と「stop POST が 202 を返す」を観測信号にする)。
    const stopPath = `/api/workflows/${encodeURIComponent(fixture.id)}/runs/${encodeURIComponent(runId)}/stop`;
    let recoveryStatus: number | null = null;
    const matcher = (url: URL) => url.pathname === stopPath;
    await page.route(matcher, async (route) => {
      const response = await route.fetch();
      recoveryStatus = response.status();
      await route.fulfill({ response });
    });

    await setRuntimeAvailable(true);
    await expect(stop).toBeEnabled();
    await stop.click();

    // Assert: 復旧後の POST は 202 を返す
    await expect.poll(() => recoveryStatus).toBe(202);
    // エラー caption は消える (status='success' で上書き、その後 unmount/remount)
    await expect(page.getByTestId('stop-run-error')).toHaveCount(0);

    await page.unroute(matcher);
  });

  test('UI: 別ワークフロー A を開いた状態で別ワークフロー B の run が一切混入しない（cross-workflow isolation の UI 側担保）', async ({
    page,
  }) => {
    // 観点: stop endpoint の cross-workflow ガードに対する UI 側の担保。
    // 「A のワークフローを開いている画面に B の run が描画されない」ことを
    // 確認する。pure API 側の 404 / 機微情報非露出は
    // `e2e/integration/stop-run.api.spec.ts` に分離 (review m-4)。
    const fixtureA = await tracker.create(
      'stop-run-isolation-ui-a',
      VALID_WORKFLOW_YAML,
    );
    const fixtureB = await tracker.create(
      'stop-run-isolation-ui-b',
      VALID_WORKFLOW_YAML,
    );
    const baseNow = Date.now();
    const runIdB = 'run-b-ui-isolated';
    const runningB = makeRunFixture(fixtureB.id, runIdB, 'running', baseNow);
    await seedRuns([runningB.summary], [runningB.detail]);

    // UI: A のページを開いた状態で、RecentRuns に B の run が出ないこと、
    // および B の id が DOM 全体のどこにも出ていないこと。
    await gotoWorkflow(page, fixtureA);
    await expect(
      recentRunsSection(page).getByRole('listitem').filter({ hasText: runIdB }),
    ).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(runIdB);
  });
});
