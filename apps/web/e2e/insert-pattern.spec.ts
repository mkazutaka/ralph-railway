import { test, expect, type Page } from '@playwright/test';
import yaml from 'js-yaml';
import { existsSync } from 'node:fs';
import {
  VALID_WORKFLOW_YAML,
  WORKFLOW_WITH_SAMPLE_STEP,
  WORKFLOW_WITH_TWO_SAMPLE_STEPS,
  WORKFLOW_WITH_LOOP_INNER,
  buildWorkflowWithExistingTaskId,
  INVALID_WORKFLOW_YAML,
  SCHEMA_INVALID_WORKFLOW_YAML,
  WORKFLOW_WITH_MISSING_DO,
  WORKFLOW_WITH_DO_NULL,
  WORKFLOW_WITH_DO_SCALAR,
  WORKFLOW_WITH_DO_MAPPING,
  buildWorkflowWithSampleStepRange,
  buildWorkflowWithLoopStepRange,
  createFixtureTracker,
  type WorkflowFixture,
} from './helpers/workflowFixtures';
import {
  openPicker,
  yamlTextarea,
  statusMessage,
  patternOption,
  expectNoInternalLeak,
} from './helpers/editor';

// Per-test fixture tracker; cleaned up centrally in `afterEach`.
const tracker = createFixtureTracker();

test.afterEach(async () => {
  await tracker.cleanupAll();
});

async function gotoWorkflow(page: Page, fixture: WorkflowFixture) {
  await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);
  await expect(yamlTextarea(page)).toBeVisible();
}

interface SupportedPatternCase {
  patternId: string;
  // Exact accessible name shown in the option list.
  optionName: string;
  // The base task id the template introduces. Verifies invariant 1 / 2.
  expectedTaskId: string;
}

// All `supported: true` entries from `patternTemplateRepository.ts`. If the
// registry grows, this list must grow with it — UI is the source of truth.
const SUPPORTED_PATTERNS: SupportedPatternCase[] = [
  { patternId: 'do', optionName: 'do (sequence)', expectedTaskId: 'sample_step' },
  { patternId: 'if', optionName: 'if (guard)', expectedTaskId: 'guarded_step' },
  { patternId: 'switch', optionName: 'switch (route)', expectedTaskId: 'route_step' },
  { patternId: 'loop', optionName: 'loop (for-each)', expectedTaskId: 'loop_step' },
  { patternId: 'set', optionName: 'set (assign)', expectedTaskId: 'assign_step' },
];

// All `supported: false` entries.
const UNSUPPORTED_PATTERNS: ReadonlyArray<{ patternId: string; optionName: string }> = [
  { patternId: 'fork', optionName: 'fork (parallel)' },
  { patternId: 'try', optionName: 'try / catch' },
  { patternId: 'retry', optionName: 'retry (backoff)' },
];

// Explicit timeout for `Inserted <id>` flash messages. The flash auto-clears
// after 3000ms in `editorState.svelte.ts`, so we cap assertions well below
// that to avoid racing with the timer.
const FLASH_TIMEOUT = 2000;

test.describe('insert-pattern: ユーザがパターンショーケースから1つを選び、編集中のワークフローへ挿入する', () => {
  for (const tc of SUPPORTED_PATTERNS) {
    test(`ユーザは ${tc.patternId} パターンを選択して、ワークフローに新しいタスクを挿入できる（正常系・全 supported パターン網羅）`, async ({
      page,
    }) => {
      // Arrange: 編集対象のワークフローを準備する
      const fixture = await tracker.create(`insert-${tc.patternId}`, VALID_WORKFLOW_YAML);
      await gotoWorkflow(page, fixture);
      await expect(yamlTextarea(page)).toHaveValue(/first_step/);

      // Act: パターンピッカーを開いて対象パターンを挿入する
      await openPicker(page);
      await patternOption(page, tc.optionName).click();

      // Assert: ピッカーは閉じられる（成功時のみ open=false になる）
      await expect(page.getByLabel('Search patterns')).toBeHidden();

      // saveMsg は role=status で `Inserted <patternId>` と表示される。
      // flash メッセージは 3 秒で消えるので明示 timeout で締める。
      await expect(statusMessage(page)).toHaveText(`Inserted ${tc.patternId}`, {
        timeout: FLASH_TIMEOUT,
      });

      // YAML テキストエリアに新しいタスク id が追加されている (web-first assertion)
      await expect(yamlTextarea(page)).toHaveValue(
        new RegExp(`${tc.expectedTaskId}(?:[:\\s])`),
      );
      // 既存の first_step も保持されている (不変条件 2 のヘッドライン確認)
      await expect(yamlTextarea(page)).toHaveValue(/first_step/);

      // 不変条件1 / 2 の構造的な詳細はディスク側 YAML のみで検証する。
      // textarea の `inputValue()` 経由のオブジェクト比較は retry が
      // 効かないためフレーキネスの温床になる (review 指摘事項)。
      const onDisk = await fixture.read();
      const parsedOnDisk = yaml.load(onDisk) as {
        document: { dsl: string; namespace: string; name: string; version: string };
        do: Array<Record<string, unknown>>;
      };
      // メタ情報 (document.dsl など) が保持されている (不変条件1: スキーマ準拠)
      expect(parsedOnDisk.document.dsl).toBe('1.0.0');
      expect(parsedOnDisk.document.namespace).toBe('e2e');
      expect(parsedOnDisk.document.name).toBe('insert-pattern-base');
      expect(parsedOnDisk.document.version).toBe('0.1.0');
      // do リストには既存 + 新規の 2 件
      expect(Array.isArray(parsedOnDisk.do)).toBe(true);
      expect(parsedOnDisk.do).toHaveLength(2);
      // 不変条件2: 既存タスクの ID は変更されない
      const diskIds = parsedOnDisk.do.map((entry) => Object.keys(entry)[0]);
      expect(diskIds).toEqual(['first_step', tc.expectedTaskId]);

      // 右ペインのグラフ (SvelteFlow) にも新規タスクのノードが描画される。
      // SvelteFlow は `data.label` をテキストノードとしてレンダリングする
      // ため、`getByText` でユーザ視点での反映を確認できる。これは
      // syncFromServer (`invalidateAll`) が走った後の visual outcome を
      // 直接検証するもので、ユーザストーリー「ワークフローへ挿入する」の
      // 最終的な見た目が壊れないことを担保する。
      await expect(
        page.getByText(tc.expectedTaskId, { exact: true }).first(),
      ).toBeVisible();

      // ページをリロードしても挿入結果が再現する（=サーバ load 関数経由でも同じ）
      await page.reload();
      await expect(yamlTextarea(page)).toHaveValue(
        new RegExp(`${tc.expectedTaskId}(?:[:\\s])`),
      );
    });
  }

  test('既存タスクと ID が衝突する場合、サフィックス付き ID で挿入され、既存 ID は保持される（不変条件2）', async ({
    page,
  }) => {
    // Arrange: 既に sample_step を持つワークフロー（do パターンの初期 ID と衝突する）
    const fixture = await tracker.create('id-conflict', WORKFLOW_WITH_SAMPLE_STEP);
    await gotoWorkflow(page, fixture);
    await expect(yamlTextarea(page)).toHaveValue(/sample_step/);

    // Act: do パターンを挿入する
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    // Assert: ピッカーが閉じる（=成功シグナル）
    await expect(page.getByLabel('Search patterns')).toBeHidden();
    // (review §3 M-4) saveMsg のフラッシュ表示も検証する。`Inserted <id>` が
    // role=status (aria-live=polite) で読み上げられることはアクセシビリティ
    // 上の重要なフィードバックなので、ID 衝突経路でも確実に発火することを
    // 担保する。`notifyInserted` 周辺が壊れたときに静かに退化しないよう、
    // popover の閉鎖だけでなくフラッシュ表示も明示 assert する。
    await expect(statusMessage(page)).toHaveText('Inserted do', { timeout: FLASH_TIMEOUT });
    // 新規タスクが追加されたことを web-first assertion で確認する
    await expect(yamlTextarea(page)).toHaveValue(/sample_step_2/);
    // 既存の sample_step (echo original) も維持されている
    await expect(yamlTextarea(page)).toHaveValue(/echo original/);

    // 構造的な不変条件はディスク側で検証する (web-first assertion で
    // 取れない順序などはここで確認する)
    const onDisk = await fixture.read();
    const parsed = yaml.load(onDisk) as { do: Array<Record<string, unknown>> };
    const ids = parsed.do.map((entry) => Object.keys(entry)[0]);
    expect(ids).toEqual(['sample_step', 'sample_step_2']);
    // 既存の sample_step の中身は echo original のまま（変更されない）
    const original = parsed.do[0]?.sample_step as { run: { shell: { command: string } } };
    expect(original.run.shell.command).toBe('echo original');
  });

  // review 2.5 Minor 指摘: do / loop は ID 衝突パスを別テストでカバーしているが
  // if / switch / set のテンプレート ID については未検証だった。テンプレート
  // 横断で同一の merge ロジックに依存しているとはいえ、registry の base id 変更
  // やテンプレート差し替えの際に sliently 壊れない保証として、すべての
  // supported パターンの「base id 衝突 → サフィックス付与」パスを網羅する。
  const NON_DO_CONFLICT_CASES: ReadonlyArray<{
    patternId: string;
    optionName: string;
    baseTaskId: string;
  }> = [
    { patternId: 'if', optionName: 'if (guard)', baseTaskId: 'guarded_step' },
    { patternId: 'switch', optionName: 'switch (route)', baseTaskId: 'route_step' },
    { patternId: 'set', optionName: 'set (assign)', baseTaskId: 'assign_step' },
  ];

  for (const tc of NON_DO_CONFLICT_CASES) {
    test(`${tc.patternId} パターン挿入時、既存タスク ${tc.baseTaskId} と ID が衝突するとサフィックス付き ID で挿入され、既存 ID は保持される（不変条件2）`, async ({
      page,
    }) => {
      // Arrange: 該当パターンの base id と同名の既存タスクを持つワークフロー
      const baseYaml = buildWorkflowWithExistingTaskId(
        tc.baseTaskId,
        `existing-${tc.baseTaskId}`,
      );
      const fixture = await tracker.create(`id-conflict-${tc.patternId}`, baseYaml);
      await gotoWorkflow(page, fixture);
      await expect(yamlTextarea(page)).toHaveValue(new RegExp(tc.baseTaskId));

      // Act: 該当パターンを挿入する
      await openPicker(page);
      await patternOption(page, tc.optionName).click();

      // Assert: ピッカーが閉じる（=成功シグナル）
      await expect(page.getByLabel('Search patterns')).toBeHidden();
      await expect(statusMessage(page)).toHaveText(`Inserted ${tc.patternId}`, {
        timeout: FLASH_TIMEOUT,
      });
      // 新規タスクは `${baseTaskId}_2` で挿入される
      await expect(yamlTextarea(page)).toHaveValue(new RegExp(`${tc.baseTaskId}_2`));
      // 既存タスク (echo original) はそのまま残っている
      await expect(yamlTextarea(page)).toHaveValue(/echo original/);

      // 構造的な不変条件はディスク側で検証する (順序を含めた厳密な確認)
      const onDisk = await fixture.read();
      const parsed = yaml.load(onDisk) as { do: Array<Record<string, unknown>> };
      const ids = parsed.do.map((entry) => Object.keys(entry)[0]);
      expect(ids).toEqual([tc.baseTaskId, `${tc.baseTaskId}_2`]);
      // 既存タスクの中身 (echo original) は変更されない
      const original = parsed.do[0]?.[tc.baseTaskId] as {
        run?: { shell?: { command?: string } };
      };
      expect(original.run?.shell?.command).toBe('echo original');
    });
  }

  test('既に sample_step / sample_step_2 が存在する場合、新規 do は sample_step_3 で挿入される（多段リネーム）', async ({
    page,
  }) => {
    const fixture = await tracker.create('id-conflict-multi', WORKFLOW_WITH_TWO_SAMPLE_STEPS);
    await gotoWorkflow(page, fixture);
    await expect(yamlTextarea(page)).toHaveValue(/sample_step_2/);

    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    await expect(page.getByLabel('Search patterns')).toBeHidden();
    // (review §3 M-4) 多段リネーム経路でも saveMsg が表示されることを検証する。
    await expect(statusMessage(page)).toHaveText('Inserted do', { timeout: FLASH_TIMEOUT });
    await expect(yamlTextarea(page)).toHaveValue(/sample_step_3/);

    // 既存 2 タスクは順序・名前ともに保持され、新規が末尾に sample_step_3
    // として追加される。順序まで確認するためディスク側でパースする。
    const onDisk = await fixture.read();
    const parsed = yaml.load(onDisk) as { do: Array<Record<string, unknown>> };
    const ids = parsed.do.map((entry) => Object.keys(entry)[0]);
    expect(ids).toEqual(['sample_step', 'sample_step_2', 'sample_step_3']);
  });

  test('loop パターン挿入時、既存の loop_step / inner_step とぶつかってもネスト子タスクの既存 ID は不変（不変条件2: 子タスク含む）', async ({
    page,
  }) => {
    // Arrange: 既に `loop_step` (top-level) と `inner_step` (loop 子) を
    // 持つワークフロー。挿入される loop テンプレートは外側を loop_step、
    // 内側を inner_step として宣言しているため、両方が衝突する。
    const fixture = await tracker.create('loop-inner', WORKFLOW_WITH_LOOP_INNER);
    await gotoWorkflow(page, fixture);
    await expect(yamlTextarea(page)).toHaveValue(/loop_step/);
    await expect(yamlTextarea(page)).toHaveValue(/inner_step/);

    // Act
    await openPicker(page);
    await patternOption(page, 'loop (for-each)').click();

    // Assert: 挿入完了
    await expect(page.getByLabel('Search patterns')).toBeHidden();
    // (review §3 M-4) loop ネスト衝突経路でも saveMsg が表示されることを検証する。
    await expect(statusMessage(page)).toHaveText('Inserted loop', { timeout: FLASH_TIMEOUT });
    await expect(yamlTextarea(page)).toHaveValue(/loop_step_2/);

    // ディスク上の YAML をパースして構造を検証する
    const onDisk = await fixture.read();
    const parsed = yaml.load(onDisk) as {
      do: Array<Record<string, { for?: unknown; do?: Array<Record<string, unknown>> }>>;
    };
    expect(parsed.do).toHaveLength(2);
    // 既存 loop_step は名前も中身も保持される
    expect(Object.keys(parsed.do[0] ?? {})[0]).toBe('loop_step');
    const existingLoop = parsed.do[0]?.loop_step;
    const existingInner = existingLoop?.do as Array<Record<string, unknown>>;
    expect(existingInner).toHaveLength(1);
    // 既存の inner_step (子) は名前を変えられていない (不変条件 2: ネスト)
    expect(Object.keys(existingInner[0] ?? {})[0]).toBe('inner_step');

    // 追加された loop_step_2 が末尾にあり、子は新たな loop スコープに
    // 入るため inner_step (テンプレート定義そのまま) のままで構わない。
    // ID は loop の `do` ごとに名前空間を持つため、既存の inner_step
    // (別の loop スコープに居る) とは衝突しない (= 不変条件 2 はスコープ
    // 単位で評価される)。
    expect(Object.keys(parsed.do[1] ?? {})[0]).toBe('loop_step_2');
    const newLoop = parsed.do[1]?.loop_step_2;
    expect(newLoop?.for).toBeDefined();
    const newInner = newLoop?.do as Array<Record<string, unknown>>;
    expect(newInner).toHaveLength(1);
    expect(Object.keys(newInner[0] ?? {})[0]).toBe('inner_step');
  });

  test('検索クエリで対象パターンのみが表示される（正常系・絞り込み）', async ({ page }) => {
    const fixture = await tracker.create('search', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);
    await openPicker(page);

    // 初期状態では全 8 件のパターン (supported 5 + unsupported 3) が表示される。
    // 期待値固定の web-first assertion にすることで、registry の登録数が変わっ
    // たときにテストが沈黙的にパスしてしまう事態を防ぐ。
    await expect(page.getByRole('option')).toHaveCount(8);

    // "loop" だけにフィルタする
    await page.getByLabel('Search patterns').fill('loop');

    // 結果は loop (for-each) のみ
    const filtered = page.getByRole('option');
    await expect(filtered).toHaveCount(1);
    await expect(filtered.first()).toContainText('loop (for-each)');

    // マッチしないクエリで「No patterns match」が表示される
    await page.getByLabel('Search patterns').fill('xyz-no-such-pattern');
    await expect(page.getByText('No patterns match')).toBeVisible();
  });

  test('検索状態は popover を閉じるとリセットされる（再度開いた時に全パターンが表示される）', async ({
    page,
  }) => {
    const fixture = await tracker.create('search-reset', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);

    await openPicker(page);
    await page.getByLabel('Search patterns').fill('loop');
    await expect(page.getByRole('option')).toHaveCount(1);

    // popover を Escape で閉じる
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Search patterns')).toBeHidden();

    // 再度開くと検索クエリが空にリセットされ、全 8 件のパターンが見える
    await openPicker(page);
    await expect(page.getByLabel('Search patterns')).toHaveValue('');
    await expect(page.getByRole('option')).toHaveCount(8);
  });

  test('キーボード操作で supported パターンを挿入できる (ArrowDown + Enter)', async ({
    page,
  }) => {
    const fixture = await tracker.create('keyboard', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);

    // popover の開閉自体はクリックヘルパーで開く (a11y の責務は bits-ui
    // 側に依存し、本テストの主眼は picker 内のキーボード選択経路)。
    await openPicker(page);

    // 検索ボックスにフォーカスを移し、"execut" でフィルタする。
    // (review 情報指摘 3) 旧テストは "lo" で 1 件しか残らず ArrowDown / ArrowUp
    // が常に同じ index に張り付いていてキーボードナビが effective に検証
    // できていなかった。"execut" は do の description ("Execute the contained
    // tasks in order.") と switch の description ("Route execution based on a
    // value.") の両方にマッチするため、フィルタ後 2 件残り、ArrowDown で
    // activeIndex を 1 つ進めて 2 件目 (switch) を選択できる。これにより
    // ArrowDown が「アクセシブルな選択状態」を実際に動かしていることを
    // 検証できる。Tab 操作の代わりにユーザが検索ボックスに焦点を当てる動作
    // を `focus()` で模す (本テストの観点はピッカー内のキーボード選択経路)。
    const search = page.getByLabel('Search patterns');
    await search.focus();
    await search.fill('execut');

    // 2 件 (do / switch) 残ることを先に確認する (テスト前提)
    await expect(page.getByRole('option')).toHaveCount(2);
    // 初期 activeIndex は 0 なので最初の option (do) が aria-selected=true
    await expect(patternOption(page, 'do (sequence)')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // ArrowDown で 2 件目 (switch) に移動 → ArrowUp で 1 件目に戻る
    await page.keyboard.press('ArrowDown');
    await expect(patternOption(page, 'switch (route)')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('ArrowUp');
    await expect(patternOption(page, 'do (sequence)')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // もう 1 度 ArrowDown して switch を選択した上で Enter で確定
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(page.getByLabel('Search patterns')).toBeHidden();
    await expect(statusMessage(page)).toHaveText('Inserted switch', {
      timeout: FLASH_TIMEOUT,
    });
    await expect(yamlTextarea(page)).toHaveValue(/route_step/);
  });

  test('挿入中はスピナーが表示され、二重クリックでも 1 回しか実行されない', async ({
    page,
  }) => {
    // Arrange: pending 状態 (pendingId が立っていてフェッチ未完了) を
    // 観察するためにレスポンスを意図的に遅延させる。`route.continue` の
    // 後で遅延を入れる方式が一部の環境でハングする (form action 後の
    // invalidateAll が再エントラントになるため) のを避けて、`route.fetch`
    // で実 API を叩いた後にレスポンス本体を `route.fulfill` で再構築する。
    //
    // (review §3 M-1) `route.continue()` は Playwright が新しいリクエストを
    // 送り直す挙動になり、form action の multipart boundary 等が壊れる懸念
    // があった。`route.fetch + route.fulfill` で実 API を 1 回だけ叩いて、
    // 取得したレスポンス (status / headers / body) をそのまま fulfill する
    // ことで、コメントと実装の乖離を解消する。
    const fixture = await tracker.create('pending', VALID_WORKFLOW_YAML);
    let insertCallCount = 0;
    await page.route(
      (url) => url.pathname.startsWith('/workflows/') && url.search.includes('/insertPattern'),
      async (route) => {
        insertCallCount += 1;
        // 実 API を叩いた直後に response を取得する (= サーバ側の書き込み
        // は完了している)。その後、UI へのレスポンス送出だけを 500ms 遅らせる
        // ことで、クライアント側の pending 状態を観察可能にする。
        const response = await route.fetch();
        const body = await response.body();
        await new Promise((r) => setTimeout(r, 500));
        await route.fulfill({
          response,
          body,
        });
      },
    );

    await gotoWorkflow(page, fixture);
    await openPicker(page);

    // Act: do オプションを click() する。click() は同期的に dispatch
    // を待つが、handleSelect の fetch は 500ms 遅延するため、その間に
    // pendingId が立った状態を観察できる。
    const doOption = patternOption(page, 'do (sequence)');
    await doOption.click();

    // 挿入中: そのオプションは disabled (busy) になる
    await expect(doOption).toBeDisabled();
    // 他の supported パターンも lockedByOther で disabled 化される
    await expect(patternOption(page, 'if (guard)')).toBeDisabled();
    // 挿入中である UI 契約は `aria-busy="true"` と `data-testid="pattern-spinner"`
    // で表現される。Tailwind ユーティリティ (`.animate-spin`) ではなくセマン
    // ティックな属性 / testid に依存することで、スタイル変更で沈黙的に壊れ
    // ない。`role`, `aria-busy` の組み合わせは支援技術にも正しく公開される。
    await expect(doOption).toHaveAttribute('aria-busy', 'true');
    await expect(doOption.getByTestId('pattern-spinner')).toBeVisible();

    // 二重クリック相当: pending 中に dispatch を再試行しても handleSelect
    // 側の `if (!p.supported || pendingId) return;` で握り潰される。
    // disabled 属性により click 自体が DOM 上発火しないことに加えて、
    // ロジック側でも防御されている。
    await doOption.dispatchEvent('click').catch(() => {});

    // 挿入完了 — Popover が閉じられ saveMsg が出るまで待つ。
    // 500ms route delay + invalidateAll の round-trip があるので
    // 余裕のある timeout を持たせる。
    await expect(page.getByLabel('Search patterns')).toBeHidden({ timeout: 15_000 });
    await expect(statusMessage(page)).toHaveText('Inserted do', { timeout: FLASH_TIMEOUT });
    await expect(yamlTextarea(page)).toHaveValue(/sample_step/);

    // サーバへのリクエストは 1 回だけ (ディスクも 1 タスクだけ追加される)
    expect(insertCallCount).toBe(1);
    const onDisk = await fixture.read();
    const parsed = yaml.load(onDisk) as { do: Array<Record<string, unknown>> };
    expect(parsed.do).toHaveLength(2);
  });

  test('挿入中に popover を閉じるとリクエストは abort され、エラーメッセージは出ない', async ({
    page,
  }) => {
    const fixture = await tracker.create('abort', VALID_WORKFLOW_YAML);

    // 挿入リクエストをサーバへ届けないまま hold する。クライアントの
    // AbortController が起動した時点で fetch は AbortError を投げ、UI 側は
    // status 0 (cancelled) として握りつぶすはず。
    //
    // (review 指摘 3): 永久 hold (`new Promise(() => {})`) はテスト終端で
    // Playwright のリソース破棄に依存するため、リトライ・並列実行で route
    // handler が解放されない懸念があった。AbortController と `page.unroute()`
    // で明示的に解放することで、handler のクリーンアップを保証する。
    const holdAborter = new AbortController();
    let insertCallCount = 0;
    const routeMatcher = (url: URL) =>
      url.pathname.startsWith('/workflows/') && url.search.includes('/insertPattern');
    await page.route(routeMatcher, async (route) => {
      insertCallCount += 1;
      await new Promise<void>((resolve) => {
        if (holdAborter.signal.aborted) {
          resolve();
          return;
        }
        holdAborter.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      // テスト後始末で abort されたら route も abort してハンドラを抜ける
      await route.abort('aborted').catch(() => {});
    });

    await gotoWorkflow(page, fixture);
    await openPicker(page);

    // Act: do を選択し、レスポンス待ち中に popover を Escape で閉じる
    await patternOption(page, 'do (sequence)').click();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Search patterns')).toBeHidden();

    // Assert: popover 内エラー (role=alert) も saveMsg も出ない
    // (status === 0 の cancelled 経路。fetch は abort されたので応答処理しない)
    await expect(page.getByRole('alert')).toHaveCount(0);
    // saveMsg は flash されないので role=status は空のはず
    await expect(statusMessage(page)).toBeHidden();

    // 念のため十分待ってから状態を再確認 (副作用が遅れて出ないこと)
    await expect(page.getByLabel('Search patterns')).toBeHidden();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Q-1: route handler が実際に少なくとも 1 回呼ばれていることを保証する。
    // form action 名 (`?/insertPattern`) のリネーム等でマッチャが沈黙的に
    // すり抜けても 0 件で完走してしまわないようにする。
    expect(insertCallCount).toBeGreaterThan(0);

    // Cleanup: hold していた route handler を解放してから unroute する。
    // unroute はマッチ済み handler が完了するのを待つため、先に signal を
    // 立てて pending な waiter を解放しないとデッドロックする。
    holdAborter.abort();
    await page.unroute(routeMatcher);
  });

  test('abort 後に再度ピッカーを開いて挿入が成功する（pendingId が abort 経路で確実に解放されること）', async ({
    page,
  }) => {
    const fixture = await tracker.create('abort-recover', VALID_WORKFLOW_YAML);

    // Phase 1: 最初のリクエストはハングさせて Escape で abort する。
    // route handler は呼ばれた回数で挙動を切り替え、2 回目以降は実 API を
    // 通すことで「abort 後の再挿入」を成立させる。
    let invocation = 0;
    const holdAborter = new AbortController();
    const routeMatcher = (url: URL) =>
      url.pathname.startsWith('/workflows/') && url.search.includes('/insertPattern');
    await page.route(routeMatcher, async (route) => {
      invocation += 1;
      if (invocation === 1) {
        // 1 回目は signal が立つまで hold (= abort 経路)。永久 hold にせず、
        // テスト終了時 / signal 立ち後に確実に handler を抜けるようにする。
        await new Promise<void>((resolve) => {
          if (holdAborter.signal.aborted) {
            resolve();
            return;
          }
          holdAborter.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await route.abort('aborted').catch(() => {});
        return;
      }
      await route.continue();
    });

    await gotoWorkflow(page, fixture);

    // 1 回目: abort
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Search patterns')).toBeHidden();

    // 2 回目: 同じパターンを再度挿入 — pendingId が解放されていれば成功する。
    // `pendingId` がリークしていると handleSelect の早期 return に当たり、
    // 何も起こらないまま saveMsg も出ないので、ここで成功を検証する。
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    await expect(page.getByLabel('Search patterns')).toBeHidden({ timeout: 15_000 });
    await expect(statusMessage(page)).toHaveText('Inserted do', { timeout: FLASH_TIMEOUT });
    await expect(yamlTextarea(page)).toHaveValue(/sample_step/);

    // ファイル側にも 1 タスクだけ追加されている (abort された 1 回目の
    // 副作用で 2 回挿入されていないこと)
    const onDisk = await fixture.read();
    const parsed = yaml.load(onDisk) as { do: Array<Record<string, unknown>> };
    expect(parsed.do).toHaveLength(2);
    expect(Object.keys(parsed.do[1] ?? {})[0]).toBe('sample_step');

    // Q-1: route が 2 回呼ばれている (1 回目: abort された hold / 2 回目: 成功)。
    // route matcher が壊れるとここで 0 になり、上の成功判定が UI 側のレース
    // に依存して通ってしまう懸念があるため、明示 assert で沈黙パスを防ぐ。
    expect(invocation).toBeGreaterThanOrEqual(2);

    // Cleanup: 残ハンドラを解放してから unroute する。
    holdAborter.abort();
    await page.unroute(routeMatcher);
  });

  test('挿入リクエストはサーバまで到達して書き込みが完了する一方、応答到着前に popover を閉じても UI が破綻しない（書き込み完了 + stale 応答破棄 / review §3 M-2）', async ({
    page,
  }) => {
    // (review §3 M-2) 旧 abort テストは `route.abort()` でサーバまで届かない
    // 経路しか担保していなかったが、ユーザ視点での真の race は「サーバが
    // 書き込みを完了し、応答だけ遅れている間にユーザが popover を閉じる」
    // 状況。このとき:
    //   - submitToken 機構により stale な応答 (= UI 上の onInserted 通知) は
    //     破棄され、popover が再度開かれても `Inserted ...` フラッシュは出ない
    //   - サーバ側の書き込み (= ファイル) は完了しているため、リロード /
    //     再描画後の YAML には新規タスクが反映されている
    // この 2 つの不変が保たれていることを担保する。
    const fixture = await tracker.create('post-write-escape', VALID_WORKFLOW_YAML);
    let insertCallCount = 0;
    const routeMatcher = (url: URL) =>
      url.pathname.startsWith('/workflows/') && url.search.includes('/insertPattern');
    // 実 API を叩いて書き込みは行いつつ、レスポンスをクライアントに返すのを
    // 遅延させる。`route.fetch` は書き込み完了を待ってから resolve する。
    await page.route(routeMatcher, async (route) => {
      insertCallCount += 1;
      const response = await route.fetch();
      const body = await response.body();
      // 書き込み完了後、Escape を確実に挟むために少しだけ遅延してから fulfill
      await new Promise((r) => setTimeout(r, 800));
      await route.fulfill({ response, body });
    });

    await gotoWorkflow(page, fixture);
    await openPicker(page);

    // Act: do を選択し、応答到着前に popover を閉じる
    await patternOption(page, 'do (sequence)').click();
    // 短い待ちの後 (= サーバ書き込みが完了している間) に Escape
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Search patterns')).toBeHidden();

    // Assert (UI): saveMsg / role=alert は出ない (= stale 応答が UI を
    // 揺さぶらない / submitToken の reset 経路が機能している)
    await expect(statusMessage(page)).toBeHidden();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Assert (server): リクエストは少なくとも 1 回サーバに届き、ファイルが
    // 書き換わっている。シナリオ「書き込み中に popover を閉じる」状況で
    // ユーザの操作 (挿入) はサーバ側でコミットされる契約。
    expect(insertCallCount).toBeGreaterThanOrEqual(1);
    // route 内の遅延 fulfill が完了するまで待つために、ファイル内容が
    // 反映されることを `expect.poll` で観察する。
    await expect
      .poll(async () => {
        const onDisk = await fixture.read();
        const parsed = yaml.load(onDisk) as { do: Array<Record<string, unknown>> };
        return parsed.do.length;
      })
      .toBe(2);

    const onDisk = await fixture.read();
    const parsed = yaml.load(onDisk) as { do: Array<Record<string, unknown>> };
    const ids = parsed.do.map((entry) => Object.keys(entry)[0]);
    expect(ids).toEqual(['first_step', 'sample_step']);

    // ページをリロードすると、サーバ側の load 関数経由で textarea には
    // 新規タスクが反映される (= ユーザが後で「やっぱり」開きなおしても
    // 操作結果は失われていない)
    await page.reload();
    await expect(yamlTextarea(page)).toHaveValue(/sample_step/);

    await page.unroute(routeMatcher);
  });

  for (const tc of UNSUPPORTED_PATTERNS) {
    test(`ランタイム未対応パターン (${tc.patternId}) はショーケースに表示されるが挿入できない（不変条件3）`, async ({
      page,
    }) => {
      const fixture = await tracker.create(`unsupported-${tc.patternId}`, VALID_WORKFLOW_YAML);
      await gotoWorkflow(page, fixture);

      await openPicker(page);

      // 該当パターンはショーケースに表示される（プレビューとして）
      const option = patternOption(page, tc.optionName);
      await expect(option).toBeVisible();
      await expect(option).toContainText('SOON');

      // ボタンとしては disabled になっている（HTML disabled 属性）。
      // ユーザは触れない (これが「不変条件3: 挿入は拒否」の UI 表現)。
      await expect(option).toBeDisabled();

      // 挿入完了メッセージは出ないし、ピッカーは閉じない
      await expect(statusMessage(page)).toBeHidden();
      await expect(page.getByLabel('Search patterns')).toBeVisible();

      // YAML は変化していない (web-first assertion)
      await expect(yamlTextarea(page)).toHaveValue(VALID_WORKFLOW_YAML);

      // ファイルにも書き込まれていない
      // (review 情報指摘 1) CR/LF 差分でフレークしないよう正規化して比較する
      const onDisk = await fixture.read();
      expect(onDisk.replace(/\r\n/g, '\n')).toBe(VALID_WORKFLOW_YAML.replace(/\r\n/g, '\n'));
    });
  }

  // (review §3 M-5) 不変条件3 は「ショーケース上は表示するが挿入不可」
  // という挙動契約。disabled 属性に依存する UI が将来「クリック可能だが
  // サーバ側で 409」のような実装に置き換わったとしても、ユーザ視点での
  // 「ショーケースから挿入できない」性質が維持されていることを担保する。
  // `force: true` で disabled をバイパスして click イベントを実発火させ、
  // それでも (a) popover が閉じない、(b) saveMsg が出ない、(c) ファイル
  // が書き換わらない、ことを検証する。
  for (const tc of UNSUPPORTED_PATTERNS) {
    test(`ランタイム未対応パターン (${tc.patternId}) を force-click しても挿入は発生しない（disabled 属性以外の防御層も含めた回帰検出 / 不変条件3）`, async ({
      page,
    }) => {
      const fixture = await tracker.create(
        `unsupported-force-${tc.patternId}`,
        VALID_WORKFLOW_YAML,
      );
      await gotoWorkflow(page, fixture);

      await openPicker(page);
      const option = patternOption(page, tc.optionName);
      await expect(option).toBeVisible();

      // Act: disabled を無視して click イベントを実発火させる。
      // PatternPicker.svelte の onclick ハンドラは `if (!p.supported || pendingId)`
      // で submit を抑止するため、disabled が外れてもサーバまで届かないはず。
      await option.click({ force: true });

      // 防御層を抜けて submit してしまう可能性に備え、念のため数百ミリ秒
      // 待った上で副作用が出ていないことを確認する。`expect.toPass` で
      // assertion を retry することで、もし非同期で saveMsg が出ても拾える。
      // ここでは「変化が無いまま安定している」ことを主眼にする。

      // Assert (a): popover は閉じない (= 成功シグナルが出ていない)
      await expect(page.getByLabel('Search patterns')).toBeVisible();
      // Assert (b): saveMsg は出ない (`Inserted <id>` のフラッシュが無い)
      await expect(statusMessage(page)).toBeHidden();
      // Assert: role=alert にエラー表示も出ない (UI 文言が静かに化けると
      // 不変条件3 の「拒否」が壊れたことに気付けないので明示する)
      await expect(page.getByRole('alert')).toHaveCount(0);

      // Assert (c): ファイルが書き換わっていない
      const onDisk = await fixture.read();
      // 改行差分でフレークしないよう CRLF を正規化して比較する (review 情報指摘)
      expect(onDisk.replace(/\r\n/g, '\n')).toBe(VALID_WORKFLOW_YAML.replace(/\r\n/g, '\n'));
      // YAML textarea の中身も初期値のまま
      await expect(yamlTextarea(page)).toHaveValue(VALID_WORKFLOW_YAML);
    });
  }

  test('既存 YAML が構文エラーで壊れている場合、挿入は拒否され UI にエラーが表示される（InvalidBaseYaml: syntax / 不変条件4）', async ({
    page,
  }) => {
    // Arrange: YAML パーサが落とすレベルで壊れた YAML
    const fixture = await tracker.create('invalid-yaml-syntax', INVALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);
    // YAML 不正でもページ自体はテキストとして読み込まれる
    await expect(yamlTextarea(page)).toHaveValue(INVALID_WORKFLOW_YAML);

    // Act: do パターンを挿入しようとする
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    // Assert: ピッカー内に role=alert のエラーが表示される
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/base workflow YAML is invalid/i);
    // エラーメッセージにサーバ内部実装のパス・関数名・スタックトレースが
    // 漏れていないこと（情報露出ガード）。`textContent()` の同期取得後比較
    // は retry が効かず flaky の温床になるため、`not.toContainText` の
    // web-first assertion で評価する。
    await expectNoInternalLeak(alert);

    // 挿入完了メッセージは出ない
    await expect(statusMessage(page)).toBeHidden();
    // ピッカーは開いたまま（ユーザがエラーを見て修正できる）
    await expect(page.getByLabel('Search patterns')).toBeVisible();

    // YAML は変化していない（保存されない）
    await expect(yamlTextarea(page)).toHaveValue(INVALID_WORKFLOW_YAML);
    // ファイルも変化していない
    const onDisk = await fixture.read();
    expect(onDisk).toBe(INVALID_WORKFLOW_YAML);
  });

  test('既存 YAML がスキーマ違反 (`do` の要素が文字列のみ) の場合も挿入は拒否される（InvalidBaseYaml: schema / 不変条件4）', async ({
    page,
  }) => {
    // Arrange: js-yaml.load は通るが、document.do の各要素が単一キー
    // mapping でないため `parseWorkflowYaml` が parseError を返す。
    const fixture = await tracker.create('invalid-yaml-schema', SCHEMA_INVALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);
    await expect(yamlTextarea(page)).toHaveValue(SCHEMA_INVALID_WORKFLOW_YAML);

    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/base workflow YAML is invalid/i);
    // 情報露出ガード: schema 違反経路でも内部パス / 関数名が漏れない
    await expectNoInternalLeak(alert);

    await expect(statusMessage(page)).toBeHidden();
    await expect(page.getByLabel('Search patterns')).toBeVisible();
    await expect(yamlTextarea(page)).toHaveValue(SCHEMA_INVALID_WORKFLOW_YAML);
    const onDisk = await fixture.read();
    expect(onDisk).toBe(SCHEMA_INVALID_WORKFLOW_YAML);
  });

  test('リネーム上限 (1000 回) を超えると IdConflict として 409 が返り、UI にエラーが表示される', async ({
    page,
  }) => {
    // Arrange: sample_step + sample_step_2..sample_step_1001 を全て持つ
    // ワークフローを作成する。merge ループは attempt=1001 まで進んだ後に
    // `attempt > MAX_RENAME_ATTEMPTS` で idConflict を返す。
    const saturated = buildWorkflowWithSampleStepRange(1001);
    const fixture = await tracker.create('id-conflict-saturated', saturated);
    await gotoWorkflow(page, fixture);
    // 一部 ID が読み込まれていることだけ確認 (1001 件全件は重いので確認しない)
    await expect(yamlTextarea(page)).toHaveValue(/sample_step_1001/);

    // Act: do を挿入する -> base id `sample_step` が衝突し続けて
    // 1000 回リネーム試行が尽きるまで衝突する
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    // Assert: 409 idConflict が role=alert に表示される
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/unable to allocate unique task ids/i);
    // 情報露出ガード: id-conflict 経路でも内部実装が漏れない
    await expectNoInternalLeak(alert);

    // saveMsg は出ず、ピッカーは閉じない (ユーザに気付かせる)
    await expect(statusMessage(page)).toBeHidden();
    await expect(page.getByLabel('Search patterns')).toBeVisible();

    // ファイルは一切変更されない (sample_step_1002 が出現しないこと)
    const onDisk = await fixture.read();
    expect(onDisk).toBe(saturated);
    expect(onDisk).not.toContain('sample_step_1002');
  });

  test('loop パターンのリネーム上限 (1000 回) を超えると IdConflict として 409 が返り、UI にエラーが表示される（ネストテンプレートでの saturated 経路）', async ({
    page,
  }) => {
    // (review §3 M-6) `do` パターンの saturated はテンプレート横断の merge
    // ロジックを担保するが、loop はネストを持つテンプレート (loop_step + 子
    // inner_step) なので、トップレベルの ID 衝突解決ロジックも合わせて検証
    // する必要がある。`do` だけだと「フラットなテンプレートでの rename」
    // しか担保できず、`registerNested` 系の経路で base id 衝突解決が壊れた
    // 場合に静かに通り抜ける可能性がある。
    //
    // Arrange: loop_step + loop_step_2..loop_step_1001 の 1001 件が既に存在
    // するワークフロー。merge ループは attempt=1001 まで進んだ後に
    // `attempt > MAX_RENAME_ATTEMPTS` で idConflict を返す。
    const saturated = buildWorkflowWithLoopStepRange(1001);
    const fixture = await tracker.create('id-conflict-loop-saturated', saturated);
    await gotoWorkflow(page, fixture);
    // 一部 ID が読み込まれていることだけ確認 (1001 件全件は重いので確認しない)
    await expect(yamlTextarea(page)).toHaveValue(/loop_step_1001/);

    // Act: loop を挿入する -> base id `loop_step` が衝突し続けて
    // 1000 回リネーム試行が尽きるまで衝突する
    await openPicker(page);
    await patternOption(page, 'loop (for-each)').click();

    // Assert: 409 idConflict が role=alert に表示される
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/unable to allocate unique task ids/i);
    // 情報露出ガード: id-conflict 経路 (loop) でも内部実装が漏れない
    await expectNoInternalLeak(alert);

    // saveMsg は出ず、ピッカーは閉じない (ユーザに気付かせる)
    await expect(statusMessage(page)).toBeHidden();
    await expect(page.getByLabel('Search patterns')).toBeVisible();

    // ファイルは一切変更されない (loop_step_1002 が出現しないこと)
    const onDisk = await fixture.read();
    expect(onDisk).toBe(saturated);
    expect(onDisk).not.toContain('loop_step_1002');
  });

  test('存在しないワークフロー ID へアクセスすると 404 が返り、エディタは表示されない（WorkflowNotFound）', async ({
    page,
  }) => {
    // Arrange: 一意かつ存在しないファイル名
    const missingId = `does-not-exist-${Date.now()}.yaml`;

    // Act: 直接アクセス
    const response = await page.goto(`/workflows/${encodeURIComponent(missingId)}`);

    // Assert: HTTP 404 が返る
    expect(response?.status()).toBe(404);
    // SvelteKit のデフォルトエラーページが表示され、エディタの "Add Node" ボタンは存在しない
    await expect(page.getByRole('button', { name: 'Insert pattern' })).toHaveCount(0);
  });

  test('ピッカーを開いた後にワークフローファイルがバックエンドで削除されると、API は 404 を返し UI にエラーが表示される（WorkflowNotFound レース）', async ({
    page,
  }) => {
    // (review §3 m-2) 旧テストは popover 操作の合間に `cleanup()` を呼ぶ
    // 順序的な疑似レースだったが、本物のレース (サーバ I/O より先にファイル
    // 削除が反映されるか) を再現するため、サーバ応答到着前に `route` で
    // 一旦リクエストを hold し、その間に確実に `cleanup` を挟む。続いて
    // route.continue() でリクエストをサーバに渡すと、サーバ側 fs.read は
    // ENOENT を観測して 404 を返す。これは「ピッカー開後の削除」レース
    // の最悪タイミング (削除がサーバ側 read より先に観測される) を担保する。
    const fixture = await tracker.create('race-deleted', VALID_WORKFLOW_YAML);

    let insertCallCount = 0;
    const releaseHold = new AbortController();
    const routeMatcher = (url: URL) =>
      url.pathname.startsWith('/workflows/') && url.search.includes('/insertPattern');
    await page.route(routeMatcher, async (route) => {
      insertCallCount += 1;
      // hold 中に外側で cleanup を完了させてから fetch する
      await new Promise<void>((resolve) => {
        if (releaseHold.signal.aborted) {
          resolve();
          return;
        }
        releaseHold.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      // 実 API を叩く (= サーバ側はこの時点でファイルを read → 404)
      const response = await route.fetch();
      const body = await response.body();
      await route.fulfill({ response, body });
    });

    await gotoWorkflow(page, fixture);
    await openPicker(page);

    // Act: click と cleanup の race を再現する。click は同期的だが
    // route handler は hold しているので fetch までは進まない。その間に
    // cleanup を確実に終わらせ、そのあとで hold を解放する。
    const clickPromise = patternOption(page, 'do (sequence)').click();
    // ファイル削除を click と並行に走らせる (= ユーザ視点の真の race)
    await Promise.all([clickPromise, fixture.cleanup()]);
    // hold 解放 → route handler がサーバを叩く (このとき既にファイルは消えている)
    releaseHold.abort();

    // role=alert にエラーが表示され、ピッカーは閉じない（ユーザに気付かせる）
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/workflow not found/i);
    // 情報露出ガード: 404 経路でもサーバ実装の手がかりが漏れない
    await expectNoInternalLeak(alert);
    await expect(page.getByLabel('Search patterns')).toBeVisible();
    await expect(statusMessage(page)).toBeHidden();

    // route が実際に呼ばれたことを保証する (matcher 失敗で素通り回帰を弾く)
    expect(insertCallCount).toBeGreaterThanOrEqual(1);

    // 削除されたファイルが副作用で再生成されていないことを fs で確認する
    expect(existsSync(fixture.path)).toBe(false);

    await page.unroute(routeMatcher);
  });

  test('`do` キーが欠落している base に最初のパターンを挿入できる（設計メモ: 空タスクリストとして扱う / 不変条件4 と矛盾しない）', async ({
    page,
  }) => {
    // Arrange: `do` キー自体が無いワークフロー (新規作成直後を想定)。
    // 設計メモ (insert-pattern.md) で「`do` キー欠落は空タスクリスト [] と
    // して扱い、最初のパターン挿入を許可する」と明文化されている経路。
    const fixture = await tracker.create('missing-do', WORKFLOW_WITH_MISSING_DO);
    await gotoWorkflow(page, fixture);
    // 元ファイルに `do:` の文字列が無いことを確認 (= 真に空の base)
    await expect(yamlTextarea(page)).toHaveValue(WORKFLOW_WITH_MISSING_DO);

    // Act: do パターンを挿入する
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    // Assert: 成功シグナル (popover が閉じる + saveMsg)
    await expect(page.getByLabel('Search patterns')).toBeHidden();
    await expect(statusMessage(page)).toHaveText('Inserted do', { timeout: FLASH_TIMEOUT });
    await expect(yamlTextarea(page)).toHaveValue(/sample_step/);

    // ディスク側で構造を検証する: do リストが 1 件で、最初の要素が sample_step
    const onDisk = await fixture.read();
    const parsed = yaml.load(onDisk) as {
      document: { dsl: string; namespace: string; name: string; version: string };
      do: Array<Record<string, unknown>>;
    };
    // メタ情報は変更されない (不変条件1: スキーマ準拠)
    expect(parsed.document.dsl).toBe('1.0.0');
    expect(parsed.document.namespace).toBe('e2e');
    expect(parsed.document.name).toBe('missing-do-key');
    expect(Array.isArray(parsed.do)).toBe(true);
    expect(parsed.do).toHaveLength(1);
    expect(Object.keys(parsed.do[0] ?? {})[0]).toBe('sample_step');
  });

  test('`do: null` (キーは存在するが値が無い) base に最初のパターンを挿入できる（設計メモ: 空タスクリストとして扱う）', async ({
    page,
  }) => {
    // Arrange: `do:` (値なし) を持つワークフロー。YAML lexer は null として
    // 解釈し、parseWorkflowYaml は空リスト [] にフォールバックする。
    const fixture = await tracker.create('do-null', WORKFLOW_WITH_DO_NULL);
    await gotoWorkflow(page, fixture);
    await expect(yamlTextarea(page)).toHaveValue(WORKFLOW_WITH_DO_NULL);

    // Act: do パターンを挿入する
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    // Assert: 成功する
    await expect(page.getByLabel('Search patterns')).toBeHidden();
    await expect(statusMessage(page)).toHaveText('Inserted do', { timeout: FLASH_TIMEOUT });
    await expect(yamlTextarea(page)).toHaveValue(/sample_step/);

    const onDisk = await fixture.read();
    const parsed = yaml.load(onDisk) as {
      document: { dsl: string; namespace: string; name: string; version: string };
      do: Array<Record<string, unknown>>;
    };
    expect(parsed.document.name).toBe('do-null');
    expect(Array.isArray(parsed.do)).toBe(true);
    expect(parsed.do).toHaveLength(1);
    expect(Object.keys(parsed.do[0] ?? {})[0]).toBe('sample_step');
  });

  test('`do` の値がスカラー (リスト型でない) の場合は InvalidBaseYaml で挿入は拒否される（設計メモ: 型違反の `do` は拒否）', async ({
    page,
  }) => {
    // Arrange: `do: 'this is not a list'` の base。YAML としてはパース可能だが
    // parseWorkflowYaml は `top-level \`do\` must be a list` で parseError を返す。
    const fixture = await tracker.create('do-scalar', WORKFLOW_WITH_DO_SCALAR);
    await gotoWorkflow(page, fixture);
    await expect(yamlTextarea(page)).toHaveValue(WORKFLOW_WITH_DO_SCALAR);

    // Act
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    // Assert: role=alert にエラー表示、saveMsg は出ない、popover は閉じない
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/base workflow YAML is invalid/i);
    // 情報露出ガード: 内部実装の漏洩なし
    await expectNoInternalLeak(alert);

    await expect(statusMessage(page)).toBeHidden();
    await expect(page.getByLabel('Search patterns')).toBeVisible();

    // ファイルは一切変更されない
    const onDisk = await fixture.read();
    expect(onDisk).toBe(WORKFLOW_WITH_DO_SCALAR);
  });

  test('`do` の値がマッピング (リスト型でない) の場合も InvalidBaseYaml で挿入は拒否される', async ({
    page,
  }) => {
    // Arrange: `do: { not: a-list }` の base。配列ではないので拒否される。
    const fixture = await tracker.create('do-mapping', WORKFLOW_WITH_DO_MAPPING);
    await gotoWorkflow(page, fixture);
    await expect(yamlTextarea(page)).toHaveValue(WORKFLOW_WITH_DO_MAPPING);

    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/base workflow YAML is invalid/i);
    await expectNoInternalLeak(alert);

    await expect(statusMessage(page)).toBeHidden();
    await expect(page.getByLabel('Search patterns')).toBeVisible();

    const onDisk = await fixture.read();
    expect(onDisk).toBe(WORKFLOW_WITH_DO_MAPPING);
  });

  test('1 ワークフローへ複数パターンを連続挿入でき、saveMsg と textarea が都度更新される', async ({
    page,
  }) => {
    const fixture = await tracker.create('multi-insert', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);

    // 1 回目: do を挿入
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();
    await expect(page.getByLabel('Search patterns')).toBeHidden();
    await expect(statusMessage(page)).toHaveText('Inserted do', { timeout: FLASH_TIMEOUT });
    await expect(yamlTextarea(page)).toHaveValue(/sample_step/);

    // 2 回目: loop を挿入。ピッカーを再度開けることを確認
    await openPicker(page);
    await patternOption(page, 'loop (for-each)').click();
    await expect(page.getByLabel('Search patterns')).toBeHidden();
    await expect(statusMessage(page)).toHaveText('Inserted loop', { timeout: FLASH_TIMEOUT });
    await expect(yamlTextarea(page)).toHaveValue(/loop_step/);

    // 3 タスクが並んでいること: 順序を含めた構造はディスク側で確認する。
    const onDisk = await fixture.read();
    const parsedOnDisk = yaml.load(onDisk) as { do: Array<Record<string, unknown>> };
    expect(parsedOnDisk.do.map((entry) => Object.keys(entry)[0])).toEqual([
      'first_step',
      'sample_step',
      'loop_step',
    ]);
  });
});
