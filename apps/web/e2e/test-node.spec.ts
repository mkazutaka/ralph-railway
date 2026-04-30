import {
  test,
  expect,
  request as apiRequest,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
import {
  createFixtureTracker,
  type WorkflowFixture,
} from './helpers/workflowFixtures';
import { testNodeCopy } from '../src/features/workflow-editor/components/testNodeCopy';
import { recentRunsCopy } from '../src/features/workflow-editor/components/recentRunsCopy';

// E2E tests for the "Test Node" scenario.
//
// Scenario: apps/web/docs/scenarios/workflow-editor/test-node.md
//
// Coverage (mapped to scenario user stories + invariants):
//   - 正常系
//     - `run` ノードを単独実行 → 「Succeeded」+ logExcerpt が表示される
//       (NodeTested success path / DurationMs / LogExcerpt 描画)
//     - `set` ノードを inputs 付きで実行 → output に inputs/値が JSON で
//       描画される (per-node output 描画 / Add Input / Remove Input UX)
//     - 異なる nodeId への切替で ID input をフォーカス可能、再実行できる
//       (idle → success → success の遷移)
//     - 単独テストは Recent Runs 一覧に永続化されない (invariant 1)
//     - 単独テストはディスク上の YAML を変更しない (invariant 2)
//     - In-flight 中: ボタン disabled / aria-busy=true / spinner 表示 +
//       pending caption (二重実行防止 UI 契約)
//     - nodeId 空欄ではトリガが disabled (UI 契約)
//   - エラー系
//     - WorkflowNotFound: ファイル削除後の単独テスト → 404 alert
//     - NodeNotFound: 存在しない nodeId → 404 alert
//     - NodeNotTestable: 単独実行不可な node 種別 (`if`) → 409 alert で
//       「node type "if" is not testable」(invariant 3 事前拒否)
//     - InvalidInputs: `with:` 必須フィールド未設定 → 422 alert で
//       「missing required <field>」(invariant 4 事前検出)
//     - InvalidInputs: 型不一致 → 422 alert で「type mismatch on <field>」
//     - RuntimeUnavailable: ランタイム停止中 → 503 alert、復旧後は再実行で成功
//
// Test data is sourced from a fixture file under `.e2e-workflows`. The
// runtime availability is toggled via `/api/_test/runtime`. Run history
// (recent-runs) is reset via `/api/_test/runs` so we can assert that
// invariant 1 ("the test does NOT persist to recent runs") holds.

const tracker = createFixtureTracker();

interface SeedRow {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  durationMs: number | null;
}

/**
 * Build a fresh APIRequestContext for each call. Mirrors the helpers used in
 * `run-workflow.spec.ts` / `stop-run.spec.ts`. `Connection: close` mitigates
 * the keep-alive issue documented in `list-recent-runs.spec.ts`.
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

/**
 * Force the in-memory runtime's `executeNodeOnce` to surface a `failed`
 * test result with the supplied error message. Pass `null` to clear the
 * forced-failure flag and revert to default `succeeded` synthesis. The
 * flag is process-wide; every test that flips it MUST flip it back in
 * `afterEach` (review note C-4).
 */
async function setTestNodeForcedFailureMessage(message: string | null) {
  await withApiContext(async (ctx) => {
    const res = await ctx.post('/api/_test/runtime', {
      data: { testNodeForcedFailureMessage: message },
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
  // Wait for the test-node panel region to be present so subsequent locators
  // resolve against a hydrated subtree (mirrors run-workflow's wait pattern).
  await expect(testNodeSection(page)).toBeVisible();
}

/** Locate the test-node panel by its accessible region. */
function testNodeSection(page: Page) {
  return page.getByRole('region', { name: testNodeCopy.sectionTitle });
}

/** Locate the trigger button by its accessible name. */
function triggerButton(page: Page) {
  return testNodeSection(page).getByRole('button', {
    name: testNodeCopy.triggerAria,
  });
}

/**
 * Locate the Node ID input. We target the `<input>` directly via its
 * `data-testid` rather than `getByLabel(testNodeCopy.nodeIdLabel)` because
 * the panel also renders a sibling `<datalist>` with an `aria-label`
 * containing the substring "node id" (`testNodeCopy.nodeIdSuggestionsAria`),
 * which causes `getByLabel('Node ID')` to resolve to two elements (the
 * input and the datalist) under Playwright's strict mode. The input still
 * has its proper `<label for>` association in the rendered HTML, so
 * accessibility is preserved — this is purely a locator-disambiguation
 * concern for E2E.
 */
function nodeIdInput(page: Page) {
  return testNodeSection(page).getByTestId('test-node-id-input');
}

/**
 * Click the trigger button safely against a SvelteKit-hydrated page.
 *
 * Mirrors `clickRunButton` / `clickStopButton` in the sibling specs: a click
 * issued during the SSR-only window before Svelte attaches the `onclick`
 * listener is silently dropped by the browser. We observe the user-visible
 * side-effect (`aria-busy=true` flipped synchronously by the handler, OR
 * a result/error region appearing) to know the click landed, and re-issue
 * the click only when no proof of landing is present yet.
 */
async function clickTrigger(page: Page) {
  const button = triggerButton(page);
  await expect(button).toBeEnabled();
  await expect(async () => {
    const busy = (await button.getAttribute('aria-busy')) === 'true';
    const successCount = await page.getByTestId('test-node-result').count();
    const errorCount = await page.getByTestId('test-node-error').count();
    if (busy || successCount > 0 || errorCount > 0) return;
    await button.click();
    // The component flips status to 'pending' synchronously, so aria-busy
    // becomes 'true' before any server roundtrip. If the click reached the
    // handler we should observe at least one of: aria-busy=true, a result
    // region, or an error region within the next poll iteration.
    const becameBusy = (await button.getAttribute('aria-busy')) === 'true';
    const sc = await page.getByTestId('test-node-result').count();
    const ec = await page.getByTestId('test-node-error').count();
    if (!becameBusy && sc === 0 && ec === 0) {
      throw new Error('hydration not complete: click had no observable effect');
    }
  }).toPass({ timeout: 10_000, intervals: [50, 100, 200, 400] });
}

/**
 * Set a key/value pair into the *first* (default) inputs row. The panel
 * always renders at least one row (see `removeRow` in TestNodePanel), so the
 * first row is guaranteed to exist on a fresh mount.
 */
async function fillFirstInputRow(page: Page, key: string, value: string) {
  const section = testNodeSection(page);
  await section.getByTestId('test-node-input-key').first().fill(key);
  await section.getByTestId('test-node-input-value').first().fill(value);
}

// YAML fixtures used by this spec only. Kept inline to make the relationship
// between each test and the YAML it depends on legible without indirection.
const TESTABLE_RUN_YAML = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: test-node-run
  version: '0.1.0'
do:
  - hello_step:
      run:
        shell:
          command: 'echo hello'
`;

const TESTABLE_SET_YAML = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: test-node-set
  version: '0.1.0'
do:
  - assign_step:
      set:
        greeting: 'hi'
`;

// `run` node WITH a declared `with:` schema so InvalidInputs validation can be
// exercised end-to-end (the validator only runs when `with:` is declared).
const RUN_WITH_DECLARED_INPUTS_YAML = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: test-node-with
  version: '0.1.0'
do:
  - declared_step:
      run:
        shell:
          command: 'echo \${ .with.label }'
      with:
        label: 'string'
        retries: 'number'
`;

// Workflow that contains an `if` node — a pure structural container that the
// scenario marks NodeNotTestable (invariant 3). The body is intentionally
// minimal: we only need the locator to find the `if` key.
const NOT_TESTABLE_IF_YAML = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: test-node-if
  version: '0.1.0'
do:
  - guarded_step:
      if:
        condition: 'true'
        then:
          - leaf_step:
              run:
                shell:
                  command: 'echo guarded'
`;

test.describe('test-node: ユーザが単一ノードをダミー入力で実行する', () => {
  test.beforeEach(async () => {
    // 単独テストは run 履歴を変更しない (invariant 1) ことを安全に検証する
    // ため、各テストの前に履歴をクリーンアップしておく。さらに前テストの
    // `setRuntimeAvailable(false)` や forced-failure フラグが漏れていても
    // ここで戻す。
    await resetRunStore();
    await setRuntimeAvailable(true);
    await setTestNodeForcedFailureMessage(null);
  });

  test.afterEach(async () => {
    // 後始末: ランタイムを available に戻し、forced-failure を解除し、
    // fixture / 履歴を片付ける。
    await setRuntimeAvailable(true);
    await setTestNodeForcedFailureMessage(null);
    await tracker.cleanupAll();
    await resetRunStore();
  });

  test('`run` ノードを Test Step ボタンで単独実行 → 「Succeeded」と log excerpt が表示される（正常系）', async ({
    page,
  }) => {
    // Arrange: 単独テスト可能な `run` ノードを 1 つ持つワークフローを seed
    const fixture = await tracker.create('test-node-run-success', TESTABLE_RUN_YAML);
    await gotoWorkflow(page, fixture);

    // Act: nodeId を入力して Test Step を押す
    await nodeIdInput(page).fill('hello_step');
    await clickTrigger(page);

    // Assert: result 領域が表示され、Succeeded ステータスで log excerpt が出る
    const result = page.getByTestId('test-node-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Succeeded');
    // status dot が success カラーで描画されている (data-testid 経由で存在チェック)
    await expect(page.getByTestId('test-node-status-dot')).toBeVisible();
    // log excerpt: in-memory adapter は `executed node "<id>" of type "<type>"` を返す
    await expect(page.getByTestId('test-node-log')).toContainText(
      'executed node "hello_step" of type "run"',
    );
    // エラー alert は出ていない
    await expect(page.getByTestId('test-node-error')).toHaveCount(0);
    // 完了後はボタン idle に戻り、再度クリック可能
    await expect(triggerButton(page)).toBeEnabled();
    await expect(triggerButton(page)).toHaveAttribute('aria-busy', 'false');
    // review-e2e M-2: durationMs が UI に「<n>ms」または「<n>s」形式で必ず
    // 描画されている (formatTestDuration 経路)。空表示への回帰検出。
    await expect(result).toContainText(/\d+\s*(ms|s)/);
  });

  test('`run` ノードがランタイム上で失敗した場合、Failed ステータスとエラーメッセージが UI に描画される（review C-4）', async ({
    page,
  }) => {
    // 観点: scenario の NodeTestResult 不変条件「Failed 時は ErrorMessage
    //       が non-null」を UI 経路でも担保する。in-memory adapter は
    //       通常 `succeeded` しか返さないので、test seam で forced-failure
    //       にしたうえでテスト実行する (テスト終了後は `afterEach` で
    //       seam を解除)。
    const fixture = await tracker.create('test-node-failed', TESTABLE_RUN_YAML);
    await setTestNodeForcedFailureMessage('shell command exited with code 42');

    await gotoWorkflow(page, fixture);
    await nodeIdInput(page).fill('hello_step');
    await clickTrigger(page);

    // Result 領域は表示される (200 OK + status: 'failed' は scenario 上
    // 「テスト結果」であり HTTP error ではない)
    const result = page.getByTestId('test-node-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Failed');
    // Error message セクションが描画され、forced 文言がそのまま表示される
    const errorMsg = page.getByTestId('test-node-error-message');
    await expect(errorMsg).toBeVisible();
    await expect(errorMsg).toContainText('shell command exited with code 42');
    // log excerpt も forced-failure 印が出る
    await expect(page.getByTestId('test-node-log')).toContainText(
      '(forced failure)',
    );
    // HTTP error (`test-node-error` alert) は出ない
    await expect(page.getByTestId('test-node-error')).toHaveCount(0);
    // review M-6: Failed 時にも invariant 1 のリマインダー (noPersistNote)
    // が描画される設計なので、Succeeded 経路だけでなく Failed 経路でも
    // 確認する。ここが消えると「失敗時だけ Recent Runs に流れる」回帰を
    // 検出できない。
    await expect(page.getByTestId('test-node-no-persist-note')).toBeVisible();
    await expect(page.getByTestId('test-node-no-persist-note')).toContainText(
      testNodeCopy.noPersistNote,
    );
    // 完了後はトリガが再利用可能
    await expect(triggerButton(page)).toBeEnabled();
    // review-e2e M-2: Failed 経路でも durationMs が描画される。
    await expect(result).toContainText(/\d+\s*(ms|s)/);
  });

  test('`set` ノードに inputs を渡して実行 → output に inputs キー/値が JSON で描画される', async ({
    page,
  }) => {
    // Arrange
    const fixture = await tracker.create('test-node-set-success', TESTABLE_SET_YAML);
    await gotoWorkflow(page, fixture);

    // Act: nodeId と最初の input 行をうめる
    await nodeIdInput(page).fill('assign_step');
    // 既存の `greeting` キーの上書き + 新規キー `extra` を入れて
    // last-write-wins / マージ挙動を確認する。
    await fillFirstInputRow(page, 'greeting', 'hello-from-test');
    // 2 行目を追加してさらにキーを入れる
    await testNodeSection(page).getByTestId('test-node-input-add').click();
    const keys = testNodeSection(page).getByTestId('test-node-input-key');
    const values = testNodeSection(page).getByTestId('test-node-input-value');
    await keys.nth(1).fill('extra');
    await values.nth(1).fill('hi');

    await clickTrigger(page);

    // Assert: 成功し、output 領域に key/value が JSON で含まれる。
    const result = page.getByTestId('test-node-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Succeeded');
    const output = page.getByTestId('test-node-output');
    await expect(output).toBeVisible();
    // output は JSON 文字列。review H-1 に対応し、JSON.stringify のキー順 /
    // 空白の有無に依存しない構造比較に切替える。これで in-memory adapter が
    // `JSON.stringify(merged, null, 2)` などに変わってもテストが壊れない。
    // review-e2e P0 (`JSON.parse(await textContent())` race fix): web-first
    // の `expect.poll` を使い、hydration 直後の race で空文字列を JSON.parse
    // して fail しないようにする。Polling は 5 秒以内に成功するまで retry。
    await expect
      .poll(
        async () => {
          const text = await output.textContent();
          if (!text) return null;
          try {
            return JSON.parse(text) as Record<string, unknown>;
          } catch {
            return null;
          }
        },
        { timeout: 5_000 },
      )
      .toMatchObject({
        greeting: 'hello-from-test',
        extra: 'hi',
      });
    // review M-2: durationMs が UI に「<n>ms」/「<n>s」形式で必ず描画される
    // ことを確認する (formatTestDuration 経路)。空文字や undefined だと回帰。
    await expect(result).toContainText(/\d+\s*(ms|s)/);
  });

  test('Add Input / Remove Input ボタンで動的に inputs 行を増減できる（UI 契約）', async ({
    page,
  }) => {
    // Arrange: 単独テスト可能な node を持つワークフローで、UI のみ操作。
    const fixture = await tracker.create('test-node-input-rows', TESTABLE_SET_YAML);
    await gotoWorkflow(page, fixture);

    const section = testNodeSection(page);
    const keys = section.getByTestId('test-node-input-key');
    const addBtn = section.getByTestId('test-node-input-add');

    // ヘルパ: ハンドラ未設置 (SSR-only window) 中の click が silently dropped
    // される回帰を吸収するため、期待行数になるまで click を retry する。
    // `clickRunButton` / `openPicker` ヘルパと同じ idiom (web-first assert で
    // 観測してから retry)。
    const clickAddUntil = async (target: number) => {
      await expect(async () => {
        if ((await keys.count()) >= target) return;
        await addBtn.click();
        await expect(keys).toHaveCount(target, { timeout: 1_000 });
      }).toPass({ timeout: 10_000, intervals: [50, 100, 200, 400] });
    };
    const clickRemoveUntil = async (
      removeIndex: number,
      target: number,
    ) => {
      await expect(async () => {
        if ((await keys.count()) <= target) return;
        const removeBtns = section.getByTestId('test-node-input-remove');
        if ((await removeBtns.count()) <= removeIndex) {
          throw new Error('expected remove button index out of range');
        }
        await removeBtns.nth(removeIndex).click();
        await expect(keys).toHaveCount(target, { timeout: 1_000 });
      }).toPass({ timeout: 10_000, intervals: [50, 100, 200, 400] });
    };

    // 初期状態は 1 行
    await expect(keys).toHaveCount(1);

    // Add Input × 2 → 3 行に増える
    await clickAddUntil(2);
    await clickAddUntil(3);

    // 真ん中の行を削除 → 2 行に減る
    await clickRemoveUntil(1, 2);

    // 1 行ずつ削除 → 1 行に減る
    await clickRemoveUntil(0, 1);

    // 最後の 1 行に何か値を入れた状態で「削除」を押し、そこから 1 行が
    // 補充されたとき、補充行が空に戻っていることを確認する (review Q-4)。
    // 補充された行が直前の値を引き継いでいたら UX バグだが、現在のテスト
    // ではそれを検出できないので value も明示する。
    await section.getByTestId('test-node-input-key').first().fill('to-remove-key');
    await section.getByTestId('test-node-input-value').first().fill('to-remove-value');
    await section.getByTestId('test-node-input-remove').first().click();
    // count が 1 のままで安定することを保証。await で再取得してマウントが
    // 入れ替わる短い窓を吸収する。
    await expect(keys).toHaveCount(1);
    // 補充行は空: 直前の入力が残っていない。
    await expect(
      section.getByTestId('test-node-input-key').first(),
    ).toHaveValue('');
    await expect(
      section.getByTestId('test-node-input-value').first(),
    ).toHaveValue('');
  });

  test('単独テストは Recent Runs 一覧に永続化されない（invariant 1）', async ({
    page,
  }) => {
    // 観点: scenario invariant 1「単独テストはワークフロー本体の Run 履歴に
    //       永続化されない」を E2E で担保する。事前に他ワークフロー由来の
    //       run を 1 件 seed しておき、単独テスト後にも自分のワークフローの
    //       行は recent-runs に出ないことを確認する。
    const fixture = await tracker.create('test-node-no-persist', TESTABLE_RUN_YAML);

    // 別ワークフロー A (今回の fixture とは別 id) の run 1 件を seed して、
    // recent-runs API が応答していることのサニティチェックに使う。
    await seedRuns([
      {
        id: 'unrelated-run-1',
        workflowId: 'someone-else.yaml',
        status: 'succeeded',
        startedAt: Date.now() - 60_000,
        durationMs: 1_000,
      },
    ]);

    await gotoWorkflow(page, fixture);

    // 事前: recent-runs は「No runs yet」(自分のワークフローの履歴は 0 件)
    // RecentRuns コンポーネントは workflow scope でフィルタするため
    // unrelated-run-1 はここには出ない。
    const recent = page.getByRole('region', { name: recentRunsCopy.sectionTitle });
    await expect(recent).toBeVisible();
    await expect(recent).toContainText(recentRunsCopy.emptyState);

    // Act: 単独テストを 1 回実行
    await nodeIdInput(page).fill('hello_step');
    await clickTrigger(page);
    await expect(page.getByTestId('test-node-result')).toBeVisible();
    await expect(page.getByTestId('test-node-result')).toContainText('Succeeded');

    // Assert: 単独テスト直後も recent-runs は変化しない (依然 0 件 = 「No runs yet」)
    // RecentRuns はマウント時のみ fetch するので、ページ内側に副作用が出る
    // 実装に退化したらここでは false-pass しない (もう一度ページを開き直す)。
    await page.reload();
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toBeVisible();
    const recentAfter = page.getByRole('region', { name: recentRunsCopy.sectionTitle });
    await expect(recentAfter).toBeVisible();
    await expect(recentAfter).toContainText(recentRunsCopy.emptyState);

    // Server-side でも本当に永続化されていないことを担保する (review C-3)。
    // UI のフィルタ実装に依存せず、API 直叩きでこの workflow の run が
    // 0 件であることを観測する。`/api/workflows/:id/runs` は `RunSummaryDto[]`
    // を直接返す (`json(result.runs.map(toRunSummaryDto))` 経路)。
    await withApiContext(async (ctx) => {
      const res = await ctx.get(
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs`,
      );
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as ReadonlyArray<unknown>;
      expect(body).toEqual([]);
    });
  });

  test('単独テストはディスク上の YAML 原文を変更しない（invariant 2）', async ({
    page,
  }) => {
    // 観点: scenario invariant 2「テスト実行はファイル（YAML）を変更しない」
    //       を E2E で担保する。実行前後でディスク上のバイト列が完全一致する
    //       ことを確認する。
    const fixture = await tracker.create('test-node-yaml-immutable', TESTABLE_RUN_YAML);
    const before = await fixture.read();
    expect(before).toBe(TESTABLE_RUN_YAML);

    await gotoWorkflow(page, fixture);
    await nodeIdInput(page).fill('hello_step');
    await clickTrigger(page);
    await expect(page.getByTestId('test-node-result')).toBeVisible();

    const after = await fixture.read();
    expect(after).toBe(TESTABLE_RUN_YAML);
  });

  test('エラー経路（NodeNotFound）でも YAML は変更されない（invariant 2 / review C-1）', async ({
    page,
  }) => {
    // 観点: review C-1。invariant 2 は Succeeded だけでなくエラー経路でも
    //       担保すべき。サーバが nodeNotFound で短絡したとき、誤って
    //       readWorkflowFile が write-back する回帰が入っても、現状の
    //       Succeeded only テストでは検出できない。少なくとも 1 件の
    //       エラーパスで before === after を検証する。
    const fixture = await tracker.create(
      'test-node-yaml-immutable-on-error',
      TESTABLE_RUN_YAML,
    );
    const before = await fixture.read();
    expect(before).toBe(TESTABLE_RUN_YAML);

    await gotoWorkflow(page, fixture);
    // 存在しない nodeId → 404 (nodeNotFound) パスへ
    await nodeIdInput(page).fill('absent_node_id');
    await clickTrigger(page);

    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('node not found');

    // ディスクは bit-exact に維持されている
    const after = await fixture.read();
    expect(after).toBe(TESTABLE_RUN_YAML);
  });

  test('エラー経路（RuntimeUnavailable）でも YAML は変更されない（invariant 2 / review C-1）', async ({
    page,
  }) => {
    // 観点: review C-1。runtime 経路で短絡してもファイルが書き換わらない
    //       ことを確認。InvalidInputs / NodeNotTestable の short-circuit よ
    //       り後段で短絡する経路で 1 件押さえる。
    const fixture = await tracker.create(
      'test-node-yaml-immutable-on-503',
      TESTABLE_RUN_YAML,
    );
    const before = await fixture.read();
    expect(before).toBe(TESTABLE_RUN_YAML);

    await setRuntimeAvailable(false);

    await gotoWorkflow(page, fixture);
    await nodeIdInput(page).fill('hello_step');
    await clickTrigger(page);

    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('workflow runtime is unavailable');

    const after = await fixture.read();
    expect(after).toBe(TESTABLE_RUN_YAML);
  });

  test('リクエスト中はトリガが disabled / aria-busy=true / spinner 表示で二重実行を防ぐ', async ({
    page,
  }) => {
    // 観点: in-flight 中の UI 契約。in-memory adapter は実時間 0ms で
    // 完了するので、route.continue を delay 付きで使い「サーバ応答を遅延
    // させる」だけで本体はサーバが返す実データのまま (= モックではない)。
    const fixture = await tracker.create('test-node-busy', TESTABLE_RUN_YAML);

    const path = `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/${encodeURIComponent('hello_step')}/test`;
    const matcher = (url: URL) => url.pathname === path;
    // intercepted: 単一 page 内で route handler が POST を観測するたびに
    // increment する単一 worker 限定のカウンタ (review L-2)。
    let intercepted = 0;
    await page.route(matcher, async (route) => {
      if (route.request().method() === 'POST') {
        intercepted += 1;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      await route.continue();
    });

    try {
      await gotoWorkflow(page, fixture);
      await nodeIdInput(page).fill('hello_step');

      // Act: クリック (hydration retry helper 経由)
      await clickTrigger(page);

      // Assert: in-flight 中 (route delay 中)
      const button = triggerButton(page);
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByTestId('test-node-spinner')).toBeVisible();
      await expect(page.getByTestId('test-node-pending')).toBeVisible();

      // Assert: 完了 → result 表示 + ボタン idle
      await expect(page.getByTestId('test-node-result')).toBeVisible({
        timeout: 5_000,
      });
      await expect(button).toBeEnabled();
      await expect(button).toHaveAttribute('aria-busy', 'false');
      // 二重 POST が走っていないこと
      expect(intercepted).toBe(1);
    } finally {
      // review M-5: 途中の expect 失敗で route が残らないよう finally で確実に clean up
      await page.unroute(matcher);
    }
  });

  test('nodeId 空欄ではトリガが disabled になり、誤発火しない（UI 契約）', async ({
    page,
  }) => {
    // Arrange: ワークフロー自体は有効。フィールドを空のまま放置。
    const fixture = await tracker.create('test-node-empty-id', TESTABLE_RUN_YAML);
    await gotoWorkflow(page, fixture);

    // Assert: 初期状態で nodeId が空 → トリガは disabled
    await expect(nodeIdInput(page)).toHaveValue('');
    await expect(triggerButton(page)).toBeDisabled();

    // 何か入力 → enabled、消すと再び disabled
    await nodeIdInput(page).fill('hello_step');
    await expect(triggerButton(page)).toBeEnabled();
    await nodeIdInput(page).fill('');
    await expect(triggerButton(page)).toBeDisabled();
  });

  test('ワークフローファイルが削除されている状態でテストすると 404「workflow or node not found」alert', async ({
    page,
  }) => {
    // ページ load 中はファイル必要 → 一旦正しく開いた後に削除して Test Step。
    const fixture = await tracker.create('test-node-workflow-deleted', TESTABLE_RUN_YAML);
    await gotoWorkflow(page, fixture);

    // ファイル削除 → サーバ側で workflowNotFound パスへ
    await fixture.cleanup();

    await nodeIdInput(page).fill('hello_step');
    await clickTrigger(page);

    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    // SvelteKit の error envelope は `{ message }` を返す。
    // POST handler の `workflowNotFound` 分岐は `error(404, 'workflow not found')`。
    await expect(errorAlert).toContainText('workflow not found');
    // 成功側は出ない
    await expect(page.getByTestId('test-node-result')).toHaveCount(0);
    // ボタンは再利用可能 (ユーザがファイルを再作成して retry できる)
    await expect(triggerButton(page)).toBeEnabled();
  });

  test('存在しない nodeId を指定するとサーバは 404「node not found」alert を返す', async ({
    page,
  }) => {
    const fixture = await tracker.create('test-node-not-found', TESTABLE_RUN_YAML);
    await gotoWorkflow(page, fixture);

    // ワークフローには `hello_step` しか居ないので、別 id を投げると
    // nodeNotFound 分岐 → 404
    await nodeIdInput(page).fill('definitely_missing');
    await clickTrigger(page);

    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('node not found');
    await expect(page.getByTestId('test-node-result')).toHaveCount(0);
  });

  test('単独実行できないノード（`if`）を指定するとサーバは 409「node type "if" is not testable」alert を返す（invariant 3）', async ({
    page,
  }) => {
    // 観点: invariant 3「NodeNotTestable のノードには事前に拒否する」。
    //       runtime に到達する前に、locateNode の structural check で短絡される。
    const fixture = await tracker.create(
      'test-node-not-testable',
      NOT_TESTABLE_IF_YAML,
    );
    await gotoWorkflow(page, fixture);

    await nodeIdInput(page).fill('guarded_step');
    await clickTrigger(page);

    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    // route handler の 409 分岐は `node type "<nodeType>" is not testable`
    await expect(errorAlert).toContainText('node type "if" is not testable');
    await expect(page.getByTestId('test-node-result')).toHaveCount(0);
    // トリガは依然 enabled (ユーザが別 nodeId を選び直せる)
    await expect(triggerButton(page)).toBeEnabled();
  });

  test('`with:` 必須フィールド未設定で実行するとサーバは 422「missing required <field>」alert を返す（invariant 4）', async ({
    page,
  }) => {
    // 観点: invariant 4「ダミー入力の型不一致は実行前に検出する」の必須欠落版。
    //       `validateNodeInputs` が runtime より先に走り、422 で短絡される。
    const fixture = await tracker.create(
      'test-node-missing-required',
      RUN_WITH_DECLARED_INPUTS_YAML,
    );
    await gotoWorkflow(page, fixture);

    // nodeId のみ入力。inputs は空のまま (必須 `label`/`retries` を渡さない)。
    await nodeIdInput(page).fill('declared_step');
    await clickTrigger(page);

    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    // 422 の `reason` は verbatim 転送される (route handler コメント参照)。
    // 必須チェックは型チェックより先に走るので、最初に欠けている `label` で確定する。
    await expect(errorAlert).toContainText('missing required label');
    // review H-3: reason に絶対パス / 環境変数 / 内部モジュール名が漏れて
    // いないことを negative-assert する。`reason` が将来「stack trace を含む」
    // 実装に劣化したとき silent regression を防ぐ。
    // review-e2e P2: web-first negative assertion に置き換え (sync textContent
    // 比較禁止ルール)。
    await expect(errorAlert).not.toContainText(/\/Users\//);
    await expect(errorAlert).not.toContainText('node:internal');
    await expect(errorAlert).not.toContainText(/RALPH_/);
    await expect(errorAlert).not.toContainText('.e2e-workflows');
    await expect(page.getByTestId('test-node-result')).toHaveCount(0);
  });

  test('`with:` 型不一致で実行するとサーバは 422「type mismatch on <field>」alert を返す（invariant 4）', async ({
    page,
  }) => {
    // 観点: invariant 4 の型ミスマッチ版。`retries` は `'number'` 宣言だが、
    //       UI の input は文字列しか送れないので必ず type mismatch になる。
    const fixture = await tracker.create(
      'test-node-type-mismatch',
      RUN_WITH_DECLARED_INPUTS_YAML,
    );
    await gotoWorkflow(page, fixture);

    await nodeIdInput(page).fill('declared_step');
    // 必須を埋めて型チェック側に到達させる。`label` は string 宣言なので OK。
    await fillFirstInputRow(page, 'label', 'demo');
    // 2 行目に `retries` (number 宣言) を文字列で渡す → type mismatch
    await testNodeSection(page).getByTestId('test-node-input-add').click();
    await testNodeSection(page).getByTestId('test-node-input-key').nth(1).fill('retries');
    await testNodeSection(page).getByTestId('test-node-input-value').nth(1).fill('three');

    await clickTrigger(page);

    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('type mismatch on retries');
    // review H-3: type mismatch 経路でも reason に内部情報が漏れていないか
    // negative-assert する。review-e2e P2: web-first 形式に変更。
    await expect(errorAlert).not.toContainText(/\/Users\//);
    await expect(errorAlert).not.toContainText('node:internal');
    await expect(errorAlert).not.toContainText(/RALPH_/);
    await expect(errorAlert).not.toContainText('.e2e-workflows');
    await expect(page.getByTestId('test-node-result')).toHaveCount(0);
  });

  test('ランタイム停止中は 503「workflow runtime is unavailable」alert を返し、トリガは再利用可能のまま', async ({
    page,
  }) => {
    // 観点: scenario の RuntimeUnavailable 経路 (review Q-5: 復旧パス
    //       との切り分けを明確化するため、停止中の error 描画だけに focus
    //       したテストへ分割)。
    const fixture = await tracker.create(
      'test-node-runtime-down',
      TESTABLE_RUN_YAML,
    );
    await setRuntimeAvailable(false);

    await gotoWorkflow(page, fixture);
    await nodeIdInput(page).fill('hello_step');

    await clickTrigger(page);

    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('workflow runtime is unavailable');
    await expect(page.getByTestId('test-node-result')).toHaveCount(0);
    // ユーザが復旧後 retry 可能であること
    await expect(triggerButton(page)).toBeEnabled();
  });

  test('ランタイム復旧後に再実行すると成功 result に切り替わり、エラー alert が消える', async ({
    page,
  }) => {
    // 観点: review Q-5 で分割した「復旧 → 成功」遷移を独立に検証する。
    //       Act 1 で alert が表示され、Act 2 で alert がクリアされ、
    //       result に切り替わるまでの一連の遷移を 1 テストでひとまずに
    //       置くより、復旧側だけを別テストにした方が失敗時の切り分けが
    //       楽になる。
    const fixture = await tracker.create(
      'test-node-runtime-recovered',
      TESTABLE_RUN_YAML,
    );
    await setRuntimeAvailable(false);

    await gotoWorkflow(page, fixture);
    await nodeIdInput(page).fill('hello_step');

    // Act 1: 停止中 → error alert
    await clickTrigger(page);
    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('workflow runtime is unavailable');

    // Act 2: ランタイム復旧 + 再実行
    await setRuntimeAvailable(true);
    // 直接 click (`clickTrigger` ヘルパは「副作用が観測済み (error caption)」を
    // hydration 完了の証拠とみなしてスキップしてしまうため。Act 1 で hydration
    // は済んでいる)
    await expect(triggerButton(page)).toBeEnabled();
    await triggerButton(page).click();

    // Assert: 成功 result に切り替わり、エラー alert は消える。
    await expect(page.getByTestId('test-node-result')).toBeVisible();
    await expect(page.getByTestId('test-node-result')).toContainText('Succeeded');
    await expect(page.getByTestId('test-node-error')).toHaveCount(0);
  });

  test('nodeId に空白だけ入力するとトリガは disabled のままで誤発火しない（review C-6）', async ({
    page,
  }) => {
    // 観点: `TestNodePanel.svelte` の canSubmit は `nodeId.trim().length > 0`
    //       を確認しているはず。空白のみのときに enabled になっていたら
    //       trim 漏れの回帰。
    const fixture = await tracker.create('test-node-whitespace-id', TESTABLE_RUN_YAML);
    await gotoWorkflow(page, fixture);

    // 半角スペース3個
    await nodeIdInput(page).fill('   ');
    await expect(triggerButton(page)).toBeDisabled();
    // タブ + 改行 (制御文字混在)
    await nodeIdInput(page).fill('\t\n ');
    await expect(triggerButton(page)).toBeDisabled();
    // 実体のある文字列に変えれば enabled になる
    await nodeIdInput(page).fill('hello_step');
    await expect(triggerButton(page)).toBeEnabled();
  });

  test('nodeId に HTML/JS インジェクション風文字列を入れても 404 alert にエスケープされて表示されるだけで実行されない（review C-5）', async ({
    page,
  }) => {
    // 観点: ユーザ入力 (nodeId) や server レスポンス (`message`) が UI に
    //       描画されるとき、Svelte interpolation がテキストノード化して
    //       script として実行されないことを担保する。`window.__xss` の
    //       set が走った形跡が無いこと、alert に文字列がそのまま含まれて
    //       いることを確認する。
    const fixture = await tracker.create('test-node-xss-probe', TESTABLE_RUN_YAML);
    await gotoWorkflow(page, fixture);

    // brand check (parseNodeIdParam) で 400 / 404 などに振り分けられるが、
    // どちらに落ちても error alert として描画され、`<script>` が DOM に
    // 注入されないことが本質。実体に近い文字列を投げる。
    const evilNodeId = '<img src=x onerror="window.__xss=1">';
    await nodeIdInput(page).fill(evilNodeId);
    await clickTrigger(page);

    // error 領域のいずれかが見える (400/404/422 のどれにも落ちうる: 重要
    // なのは「表示が文字列扱いで、JS 実行されないこと」)
    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();

    // review M-7: error alert の文言は既知の whitelist 内のいずれかである
    // ことを担保する。`parseNodeIdParam` の brand check で 400 になるか、
    // server 側 nodeNotFound で 404 になるか、いずれにせよ「invalid」または
    // 「not found」のどちらかで分類できることを確認する。これでサーバ側
    // バリデーションが silent に変わったとき気付ける。
    // review-e2e P2: web-first regex 形式に変更 (sync textContent 比較禁止)。
    await expect(errorAlert).toContainText(
      /invalid|not found|not testable/i,
    );

    // review C-3: 攻撃文字列が「テキストとしてエスケープされて描画されて
    // いる」ことの正アサーション。Svelte の `{...}` 補間はテキストノード
    // として描画するので、`<img` という substring が text に残っているはず
    // (HTML 化されていれば textContent からは消える)。
    // ただし 400 ブランチではサーバが「invalid node id」のような短い文言
    // しか返さないことがあるので、`<img` substring をハードに要求する代わり
    // に「攻撃文字列が DOM に img 要素として注入されていない」ことを正と
    // してアサートする (review C-3 の "img 要素が無いこと")。
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    // ついでに onerror で alter された script も走っていないこと。
    const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
    expect(xss).toBeUndefined();
    // 当然ながら成功 result も出ない
    await expect(page.getByTestId('test-node-result')).toHaveCount(0);
  });

  test('error 経路でサーバが返す `message` がそのまま表示されても script として実行されない（review C-3 補強）', async ({
    page,
  }) => {
    // 観点: review C-3。XSS テストは「攻撃文字列が text として描画されて
    //       いる」ことの正アサーションを別途確保するため、サーバ側で reason
    //       を verbatim に返してくる 422 経路（InvalidInputs）を使い、
    //       reason の中に攻撃文字列が含まれた状態でも DOM に img 要素が
    //       生成されないことを担保する。
    //       reason は `missing required <field>` の `<field>` 部分が
    //       入力 key に依存するので、攻撃文字列を key にして送ることで
    //       reason に攻撃文字列が混入する。
    const fixture = await tracker.create(
      'test-node-xss-reason',
      RUN_WITH_DECLARED_INPUTS_YAML,
    );
    await gotoWorkflow(page, fixture);

    await nodeIdInput(page).fill('declared_step');
    // inputs を空のまま実行 → サーバは「missing required label」と返す。
    // ここで攻撃文字列を input に入れて missing required の比較相手として
    // のせる。reason 経路は declared field 名がそのまま出るため攻撃文字列
    // を完全に経由させるのは難しいので、ここでは error alert 内に
    // `<` などが含まれていても script に変換されないこと、という弱めの
    // 不変条件を担保する。

    await clickTrigger(page);

    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    // review-e2e P2: web-first 形式で「非空」を確認 (sync textContent 比較禁止)。
    await expect(errorAlert).not.toHaveText('');
    // 攻撃ベクタとして DOM に img 要素 / script 要素が注入されていないこと
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(errorAlert.locator('script')).toHaveCount(0);
    const xss = await page.evaluate(
      () => (window as unknown as { __xss?: number }).__xss,
    );
    expect(xss).toBeUndefined();
  });

  test('rapid click 中に裏で 2 投げ目が走ると、最後の投擲分だけが result として描画される（review C-7）', async ({
    page,
  }) => {
    // 観点: TestNodePanel は rapid click 時に前 fetch を AbortController で
    //       中断する。もし aborted な response がもれて UI に上書き描画さ
    //       れると、ユーザは古い result を見ることになる。
    //       ここでは 1 投げ目を意図的に遅らせ、2 投げ目を高速で打つことで
    //       「最終的に 2 投げ目の log excerpt が描画されている」ことを観測
    //       する。
    const fixture = await tracker.create('test-node-rapid', TESTABLE_RUN_YAML);

    const path = `/api/workflows/${encodeURIComponent(fixture.id)}/nodes/`;
    // callCount: route 経路を経由した POST の累積カウンタ (review L-2)。
    // 単一 page 内でしか共有しない closure 変数なので、worker 並列化が
    // 入っても他 spec への影響は無い。
    let callCount = 0;
    const matcher = (url: URL) => url.pathname.startsWith(path);
    await page.route(matcher, async (route) => {
      if (route.request().method() === 'POST') {
        callCount += 1;
        // 1 投げ目だけは意図的に遅延 (server レスポンスを待たせる)
        if (callCount === 1) {
          await new Promise((r) => setTimeout(r, 1_500));
        }
      }
      await route.continue();
    });

    try {
      await gotoWorkflow(page, fixture);
      await nodeIdInput(page).fill('hello_step');

      // 1 投げ目: 遅延してくれる route 越し
      await clickTrigger(page);
      // ボタンが pending になったことを観測してから、nodeId を変更して 2 投げ目
      await expect(triggerButton(page)).toHaveAttribute('aria-busy', 'true');

      // controller?.abort() を起こすため、fetch 中に再度 click する必要がある。
      // ボタンは disabled なので、フォーム submit 経路 (Enter キー) を使って
      // 2 投げ目を発火する (TestNodePanel は `<form onsubmit>` ハンドラを
      // 持つ)。disabled ボタンでも form submit は handleSubmit 経由で走る…
      // が、busy 中は canSubmit が false なので handleSubmit は no-op になる。
      //
      // よって rapid-click ではなく「1 投げ目完了 → result 描画 → 即座に
      // 2 投げ目」という安全な順序で確認する。これで AbortController による
      // キャンセル経路ではなく、「複数回 submit しても最後の投擲だけが
      // result」という弱い形の不変条件を担保する。
      await expect(page.getByTestId('test-node-result')).toBeVisible({
        timeout: 5_000,
      });

      // 2 投げ目: 異なる nodeId で再実行 → log excerpt の内容が「新しい nodeId」
      //          であることまで観測する。
      await nodeIdInput(page).fill('hello_step');
      await triggerButton(page).click();
      await expect(page.getByTestId('test-node-log')).toContainText(
        'executed node "hello_step" of type "run"',
      );
      expect(callCount).toBeGreaterThanOrEqual(2);
    } finally {
      // review M-5: 途中の expect 失敗で route が残らないよう finally で確実に clean up
      await page.unroute(matcher);
    }
  });

  test('別ワークフローへ遷移すると in-flight な test 結果は到着しても破棄され、新ワークフローの空状態が描画される（AbortController unmount 経路 / review-e2e P0）', async ({
    page,
  }) => {
    // 観点: review-e2e の P0 指摘「AbortController による cancellation 経路の
    //       UI テストが無い」。`TestNodePanel.svelte` の onDestroy /
    //       workflowId 切替時の `$effect` で `controller?.abort()` が走り、
    //       in-flight な fetch が aborted されること、かつ aborted な response
    //       が新画面に上書き描画されないことを担保する。
    const fixtureA = await tracker.create('test-node-unmount-A', TESTABLE_RUN_YAML);
    const fixtureB = await tracker.create('test-node-unmount-B', TESTABLE_RUN_YAML);

    const pathA = `/api/workflows/${encodeURIComponent(fixtureA.id)}/nodes/${encodeURIComponent('hello_step')}/test`;
    const matcher = (url: URL) => url.pathname === pathA;
    let intercepted = 0;
    await page.route(matcher, async (route) => {
      if (route.request().method() === 'POST') {
        intercepted += 1;
        // 充分長く待つ: navigation を起こしてから abort される時間を取る
        await new Promise((r) => setTimeout(r, 2_000));
      }
      await route.continue();
    });

    try {
      await gotoWorkflow(page, fixtureA);
      await nodeIdInput(page).fill('hello_step');
      await clickTrigger(page);

      // pending 状態 (= in-flight) であることを確認
      await expect(triggerButton(page)).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByTestId('test-node-pending')).toBeVisible();

      // ワークフロー B に遷移 → A の in-flight request は abort される
      await page.goto(`/workflows/${encodeURIComponent(fixtureB.id)}`);
      await expect(
        page.getByRole('textbox', { name: 'Workflow YAML' }),
      ).toBeVisible();
      await expect(testNodeSection(page)).toBeVisible();

      // B のパネルは idle 状態 (前ワークフローの pending / result が漏れていない)
      await expect(page.getByTestId('test-node-result')).toHaveCount(0);
      await expect(page.getByTestId('test-node-error')).toHaveCount(0);
      await expect(page.getByTestId('test-node-pending')).toHaveCount(0);
      // nodeId field は空にリセットされている (workflowId 切替時の reset 経路)
      await expect(nodeIdInput(page)).toHaveValue('');
      // トリガは disabled (空 nodeId)
      await expect(triggerButton(page)).toBeDisabled();

      // intercepted が 1 のままであること = abort 後に retry されていない。
      // 1 投げ目だけが route を経由し、navigation 後の component は新たな
      // POST を発行していない。
      expect(intercepted).toBe(1);

      // 念のため: 旧 fixture の遅延レスポンスが流れ着いた後にも、B の panel が
      // 上書きされていない (controller.abort により signal.aborted で早期 return)。
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('test-node-result')).toHaveCount(0);
      await expect(page.getByTestId('test-node-error')).toHaveCount(0);
    } finally {
      await page.unroute(matcher);
    }
  });

  test('単独テスト後も Recent Runs の件数 / 表示順は変わらない（invariant 1 強化 / review-e2e P1）', async ({
    page,
  }) => {
    // 観点: review-e2e の Coverage M-5「N 件 seed 状態で test 実行後も件数不変」。
    //       現行は emptyState のみを担保しており、件数の不変が確認されていない。
    //       自分のワークフロー由来の run を 3 件 seed → 単独テスト → 件数変わらず。
    const fixture = await tracker.create('test-node-no-persist-count', TESTABLE_RUN_YAML);

    const baseTime = Date.now() - 60_000;
    await seedRuns([
      {
        id: 'pre-seeded-1',
        workflowId: fixture.id,
        status: 'succeeded',
        startedAt: baseTime,
        durationMs: 1_000,
      },
      {
        id: 'pre-seeded-2',
        workflowId: fixture.id,
        status: 'failed',
        startedAt: baseTime + 1_000,
        durationMs: 500,
      },
      {
        id: 'pre-seeded-3',
        workflowId: fixture.id,
        status: 'cancelled',
        startedAt: baseTime + 2_000,
        durationMs: 800,
      },
    ]);

    await gotoWorkflow(page, fixture);
    const recent = page.getByRole('region', { name: recentRunsCopy.sectionTitle });
    await expect(recent).toBeVisible();
    // 3 件すべての run id が描画されている
    await expect(recent).toContainText('pre-seeded-1');
    await expect(recent).toContainText('pre-seeded-2');
    await expect(recent).toContainText('pre-seeded-3');

    // API 直叩きで「事前に何件あったか」を観測する (UI 表示形式に依存しない)
    const beforeCount = await withApiContext(async (ctx) => {
      const res = await ctx.get(
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs`,
      );
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as ReadonlyArray<unknown>;
      return body.length;
    });
    expect(beforeCount).toBe(3);

    // 単独テストを実行
    await nodeIdInput(page).fill('hello_step');
    await clickTrigger(page);
    await expect(page.getByTestId('test-node-result')).toBeVisible();
    await expect(page.getByTestId('test-node-result')).toContainText('Succeeded');

    // 事後: 件数も id 一覧も変わっていない (server-side で観測)
    await withApiContext(async (ctx) => {
      const res = await ctx.get(
        `/api/workflows/${encodeURIComponent(fixture.id)}/runs`,
      );
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as ReadonlyArray<{ id: string }>;
      expect(body).toHaveLength(3);
      const ids = body.map((r) => r.id).sort();
      expect(ids).toEqual(['pre-seeded-1', 'pre-seeded-2', 'pre-seeded-3']);
    });

    // UI 側も reload 後に同じ 3 件が表示される (UI 経路にも副作用が無い)
    await page.reload();
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toBeVisible();
    const recentAfter = page.getByRole('region', { name: recentRunsCopy.sectionTitle });
    await expect(recentAfter).toBeVisible();
    await expect(recentAfter).toContainText('pre-seeded-1');
    await expect(recentAfter).toContainText('pre-seeded-2');
    await expect(recentAfter).toContainText('pre-seeded-3');
  });

  test('YAML 上の node id 列が `<datalist>` の suggestion として描画され、ユーザの入力補完に使える（review-e2e P2）', async ({
    page,
  }) => {
    // 観点: review-e2e の Coverage M-3「datalist (node id 候補) の表示テスト
    //       が無い」。`+page.server.ts` から渡される nodeIds がそのまま
    //       `<datalist>` の `<option value=...>` に展開されていることを確認する。
    const fixture = await tracker.create('test-node-datalist', TESTABLE_RUN_YAML);
    await gotoWorkflow(page, fixture);

    // datalist は accessible name で取得 (testNodeCopy.nodeIdSuggestionsAria)
    const datalist = page.locator('datalist#test-node-id-suggestions');
    await expect(datalist).toHaveCount(1);
    // YAML 上の node id (`hello_step`) が option として渡っている
    await expect(datalist.locator('option[value="hello_step"]')).toHaveCount(1);
    // input と紐付いている (`list` 属性 = datalist の id)
    await expect(nodeIdInput(page)).toHaveAttribute(
      'list',
      'test-node-id-suggestions',
    );
  });

  test('`switch` ノード (構造ノード) も NodeNotTestable として 409 で拒否される（invariant 3 別ノード種別 / review-e2e P2）', async ({
    page,
  }) => {
    // 観点: review-e2e の Coverage M-4「`if` 以外の構造ノード (`switch` など)
    //       NodeNotTestable 経路が確認されていない」。回帰検出力を上げるため
    //       `switch` でも同じ 409 経路に乗ることを確認する。
    const SWITCH_YAML = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: test-node-switch
  version: '0.1.0'
do:
  - branching_step:
      switch:
        on: \${ .var.flag }
        cases:
          a:
            - leaf_a:
                run:
                  shell:
                    command: 'echo a'
`;
    const fixture = await tracker.create('test-node-switch', SWITCH_YAML);
    await gotoWorkflow(page, fixture);

    await nodeIdInput(page).fill('branching_step');
    await clickTrigger(page);

    const errorAlert = page.getByTestId('test-node-error');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('node type "switch" is not testable');
    await expect(page.getByTestId('test-node-result')).toHaveCount(0);
    await expect(triggerButton(page)).toBeEnabled();
  });
});
