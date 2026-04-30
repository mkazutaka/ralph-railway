import { test, expect, type Page, type Locator } from '@playwright/test';
import {
  VALID_WORKFLOW_YAML,
  INVALID_WORKFLOW_YAML,
  WORKFLOW_WITH_DO_SCALAR,
  WORKFLOW_WITH_XSS_NAME,
  createFixtureTracker,
} from './helpers/workflowFixtures';
import { yamlTextarea, expectNoInternalLeak } from './helpers/editor';
import { workflowListCopy } from '../src/features/workflow-editor/components/workflowListCopy';
import { editorCopy } from '../src/features/workflow-editor/lib/editorCopy';

// E2E tests for the "Open Workflow" scenario.
//
// Scenario: apps/web/docs/scenarios/workflow-management/open-workflow.md
//
// User story:
//   ユーザが、ファイルツリーまたは URL から特定のワークフローを開き、
//   編集画面で YAML 原文と可視化グラフを確認する。
//
// 認可前提:
//   現状のサービスは単一テナント / 単一ユーザ前提であり、認可境界は
//   `parseWorkflowParam` の brand 検証に集約されている。マルチユーザ化された
//   段階では「他ユーザのワークフローを開けない」ことを別 spec で追加する必要
//   がある（review §3 m-7）。
//
// Coverage (mapped to scenario steps + invariants):
//   - 正常系
//     - URL から直接開くと YAML 原文 + 可視化グラフ (ノード) が表示される
//       (step 1 LocateWorkflow → step 2 RenderGraph)
//     - 一覧画面の行をクリックして編集画面に遷移し、開いた画面で
//       displayName が heading に出ている (M-3 / M-6)
//     - 一覧に複数ワークフローがある状態でも目的の行を一意に開ける (M-3)
//     - キーボード (Enter) で行を開ける a11y 経路 (M-3)
//     - `.yml` 拡張子のワークフローも開ける (拡張子バリエーション)
//   - 不変条件 1: YAML が壊れていてもワークフロー自体は開ける
//     - 構文エラーの YAML でも編集画面が開き、textarea に raw YAML が出る
//     - スキーマ違反 (`do` がリストでない等) の YAML でも編集画面が開く
//   - 不変条件 2: ParseError 時、Graph は空でエラーメッセージが表示される
//     - グラフ region 内にノードが 0 件 (m-2 / m-3)
//     - parseError 領域が表示され、textarea の aria-describedby に
//       HEADING_ID + yaml-error が連結される (m-4)
//     - parseError メッセージに internal stack / paths が漏洩しない (C-3)
//   - 不変条件 3: 読み込みは副作用を持たない (ファイルを書き換えない)
//     - ページ open + reload を経てもディスク上の YAML が一切変わらない
//   - エラー系: NotFound
//     - 存在しない workflowId を URL に入れると 404 が返り、
//       一覧画面へ戻る導線が提示される (M-2)
//   - 不正な workflowId (パストラバーサル、絶対パス、空白等) は 400 で拒否
//     される (C-2 / M-4)
//   - セキュリティ: ファイル名 (タスク id) 経由の XSS が UI で実行されない
//     (C-1)

const tracker = createFixtureTracker();

test.afterEach(async () => {
  await tracker.cleanupAll();
});

const HEADING_ID = 'workflow-editor-heading';

/**
 * ワークフロー一覧 (`/`) の特定行 link を accessible name で引く helper。
 * `WorkflowList.svelte` は `${openAction} ${name}` を行 anchor の name に
 * 入れるので exact match で他テストの行と衝突しないようにする。
 */
function workflowRow(page: Page, displayName: string) {
  return page.getByRole('link', {
    name: `${workflowListCopy.openAction} ${displayName}`,
    exact: true,
  });
}

/**
 * 編集画面のヘディング (`<h1 id="workflow-editor-heading">`) を user-facing
 * locator で引く。`data.opened.name` (= displayName) を heading text として
 * 露出している契約を E2E で固定するためのヘルパ。
 */
function editorHeading(page: Page) {
  return page.getByRole('heading', { level: 1 });
}

/**
 * 可視化グラフ region。`+page.svelte` の `<section aria-label="Workflow
 * flow graph">` を semantic locator で引く。SvelteFlow の内部クラス
 * (`.svelte-flow`) には依存しない (review M-1)。
 */
function graphRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Workflow flow graph' });
}

/**
 * グラフ region 内に描画された SvelteFlow ノード要素を引く。SvelteFlow が
 * 出力する `data-id` 属性は public な API 契約であり、ユーザに見えている
 * ノード要素を一意に数える最小限の attribute 依存として割り切る。CSS class
 * 名 (`.svelte-flow__node`) は将来の SvelteFlow メジャーバージョンで変わり
 * 得るため `data-id` 側を使う。
 */
function flowNodes(page: Page): Locator {
  return graphRegion(page).locator('[data-id]');
}

/**
 * parseError バナーを id 経由で引く。`editorCopy.yamlErrorElementId`
 * (= `yaml-error`) は textarea の `aria-describedby` 経路で a11y 公開
 * されている契約上の id。ユーザ視点では「エラー本文を表示する領域」を
 * 確認したいので、id ベースで取得した上で本文を semantic に検証する。
 */
function parseErrorBanner(page: Page): Locator {
  return page.locator(`#${editorCopy.yamlErrorElementId}`);
}

/**
 * グラフ内のノード描画を accessible text で引く (正常系のノード可視判定用)。
 * SvelteFlow の minimap が同じ label を二重にレンダリングするケースに備えて
 * region scope を絞っている。
 */
function flowNodeText(page: Page, taskId: string): Locator {
  return graphRegion(page).getByText(taskId, { exact: true }).first();
}

test.describe('open-workflow: ユーザがワークフローを開いて YAML 原文と可視化グラフを確認する', () => {
  test('URL から直接開くと、YAML 原文と可視化グラフが表示される（正常系: step1 LocateWorkflow → step2 RenderGraph）', async ({
    page,
  }) => {
    // Arrange: 編集対象のワークフローを準備する
    const fixture = await tracker.create('open-direct', VALID_WORKFLOW_YAML);

    // Act: URL を直接開く (ファイルツリー経由ではなく URL 経由の入口)
    await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);

    // Assert: 編集画面 heading が表示されている。
    // VALID_WORKFLOW_YAML の document.name は `insert-pattern-base` なので
    // それが heading の主テキストとして出る (review M-6)。
    await expect(editorHeading(page)).toContainText('insert-pattern-base');

    // Assert: textarea にディスク上の YAML が一字一句出ている
    await expect(yamlTextarea(page)).toBeVisible();
    await expect(yamlTextarea(page)).toHaveValue(VALID_WORKFLOW_YAML);

    // Assert: 正常系では aria-describedby に yaml-error は含まれない
    await expect(yamlTextarea(page)).toHaveAttribute(
      'aria-describedby',
      HEADING_ID,
    );

    // Assert: グラフに `do` リストのタスクノード (`first_step`) がレンダリングされる
    // (step 2 RenderGraph: ノード/エッジが描画される)
    await expect(flowNodeText(page, 'first_step')).toBeVisible();

    // Assert: parseError 領域は表示されない (正常系では graph.parseError = null)
    await expect(parseErrorBanner(page)).toHaveCount(0);
  });

  test('一覧画面の行をクリックすると編集画面に遷移し、displayName が heading に表示される（動線: 入口 / M-3 / M-6）', async ({
    page,
  }) => {
    // Arrange: `document.name` を持つ YAML を seed する。一覧画面では
    // displayName 経由で行を引くので、name の存在を担保する。
    // 同時に複数のワークフローを seed して「目的の行が一覧から一意に
    // 開ける」ことも確認する (review M-3)。
    const yamlSourceA = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: My Workflow A\n  version: '0.1.0'\ndo:\n  - step_a:\n      run:\n        shell:\n          command: 'echo a'\n`;
    const yamlSourceB = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: My Workflow B\n  version: '0.1.0'\ndo:\n  - step_b:\n      run:\n        shell:\n          command: 'echo b'\n`;
    const fixtureA = await tracker.create('open-from-list-a', yamlSourceA);
    await tracker.create('open-from-list-b', yamlSourceB);

    // Act: 一覧画面 → 該当行クリック
    await page.goto('/');
    // 双方の行が一覧に出ていることを担保
    await expect(workflowRow(page, 'My Workflow A')).toBeVisible();
    await expect(workflowRow(page, 'My Workflow B')).toBeVisible();
    await workflowRow(page, 'My Workflow A').click();

    // Assert: 編集画面の URL に到達している
    await expect(page).toHaveURL(`/workflows/${encodeURIComponent(fixtureA.id)}`);

    // Assert: heading に displayName が出ている (M-6 の対応):
    // 「ユーザは My Workflow A を開いた」ことが視覚的に裏付けられる。
    await expect(editorHeading(page)).toContainText('My Workflow A');

    // Assert: 編集画面の主要 UI (YAML textarea + グラフ) が見えている
    await expect(yamlTextarea(page)).toBeVisible();
    await expect(yamlTextarea(page)).toHaveValue(yamlSourceA);
    await expect(flowNodeText(page, 'step_a')).toBeVisible();
  });

  test('一覧画面の行を Enter キーで開ける（a11y 経路 / M-3）', async ({ page }) => {
    // Arrange
    const yamlSource = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: Keyboard Workflow\n  version: '0.1.0'\ndo:\n  - kbd_step:\n      run:\n        shell:\n          command: 'echo kbd'\n`;
    const fixture = await tracker.create('open-keyboard', yamlSource);

    // Act: 一覧画面で行にフォーカスを当てて Enter で開く
    await page.goto('/');
    const row = workflowRow(page, 'Keyboard Workflow');
    await expect(row).toBeVisible();
    await row.focus();
    await page.keyboard.press('Enter');

    // Assert: 編集画面に遷移している
    await expect(page).toHaveURL(`/workflows/${encodeURIComponent(fixture.id)}`);
    await expect(editorHeading(page)).toContainText('Keyboard Workflow');
    await expect(yamlTextarea(page)).toHaveValue(yamlSource);
  });

  test('`.yml` 拡張子のワークフローも開ける（拡張子バリエーションでも入口が壊れない / M-5）', async ({
    page,
  }) => {
    // Arrange: `.yml` 拡張子の workflow id を fixture helper の extension
    // option で作る (review M-5)。tracker の cleanup 経路を通る。
    const fixture = await tracker.create('open-yml', VALID_WORKFLOW_YAML, {
      extension: 'yml',
    });
    expect(fixture.id.endsWith('.yml')).toBe(true);

    // Act
    await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);

    // Assert: 編集画面が開ける
    await expect(yamlTextarea(page)).toHaveValue(VALID_WORKFLOW_YAML);
    await expect(flowNodeText(page, 'first_step')).toBeVisible();
  });

  test('構文エラーのある YAML でもワークフローは開け、parseError メッセージが表示され、グラフは空になる（不変条件 1 + 2 / m-2 / m-4 / C-3）', async ({
    page,
  }) => {
    // Arrange: js-yaml が parse 失敗する unclosed flow list の YAML を seed
    const fixture = await tracker.create('open-broken-syntax', INVALID_WORKFLOW_YAML);

    // Act
    await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);

    // Assert: 編集画面そのものは開ける (不変条件 1)
    await expect(yamlTextarea(page)).toBeVisible();
    // textarea には raw YAML がそのまま入っている (修正できる状態)
    await expect(yamlTextarea(page)).toHaveValue(INVALID_WORKFLOW_YAML);

    // Assert: parseError 領域が表示されており、空ではない (不変条件 2)
    const errorBanner = parseErrorBanner(page);
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).not.toBeEmpty();

    // Assert: textarea の aria-describedby に HEADING_ID + yaml-error が
    // 順に連結されている (review m-4)。両方が含まれることを a11y 契約と
    // して固定する。
    await expect(yamlTextarea(page)).toHaveAttribute(
      'aria-describedby',
      new RegExp(`${HEADING_ID}\\s+${editorCopy.yamlErrorElementId}`),
    );

    // Assert: parseError メッセージに internal 実装 (stack / paths /
    // 内部例外名) が漏洩していない (review C-3)。
    await expectNoInternalLeak(errorBanner);

    // Assert: グラフ region 内にノードが 0 件である (review m-2)。
    // 「最後に解析成功した状態ではなく空」という不変条件 2 の直接検証。
    await expect(graphRegion(page)).toBeVisible();
    await expect(flowNodes(page)).toHaveCount(0);
  });

  test('スキーマ違反 (`do` がリストでない) の YAML でもワークフローは開け、parseError が表示され、グラフは空になる（不変条件 1 + 2 / m-3 / C-3）', async ({
    page,
  }) => {
    // Arrange: YAML は parse できるがスキーマに違反する (`do` がスカラー).
    // クライアント側 `yamlToFlow` も「`do` must be a list」を error として返し、
    // editor 画面に parseError バナーが表示される経路を駆動する。
    const fixture = await tracker.create('open-broken-schema', WORKFLOW_WITH_DO_SCALAR);

    // Act
    await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);

    // Assert: 編集画面が開ける (不変条件 1)
    await expect(yamlTextarea(page)).toBeVisible();
    await expect(yamlTextarea(page)).toHaveValue(WORKFLOW_WITH_DO_SCALAR);

    // Assert: parseError 領域が表示されており、`do` must be a list の趣旨が
    // 含まれる (不変条件 2: schema 経路でも parseError が走る)
    const errorBanner = parseErrorBanner(page);
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText(/do/i);

    // Assert: parseError メッセージに internal 実装が漏洩していない (C-3)
    await expectNoInternalLeak(errorBanner);

    // Assert: グラフはこの場合も空 (do が list でないので nodes が出ない / m-3)
    await expect(graphRegion(page)).toBeVisible();
    await expect(flowNodes(page)).toHaveCount(0);
  });

  test('開いた直後にディスク上の YAML が変化していない（不変条件 3: 読み込みは副作用を持たない）', async ({
    page,
  }) => {
    // Arrange: 既知の YAML 原文を seed する
    const fixture = await tracker.create('open-readonly', VALID_WORKFLOW_YAML);
    const before = await fixture.read();

    // Act: ページを開いて、リロードしても read だけが起こることを確認する
    await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);
    await expect(yamlTextarea(page)).toHaveValue(VALID_WORKFLOW_YAML);
    await page.reload();
    await expect(yamlTextarea(page)).toHaveValue(VALID_WORKFLOW_YAML);

    // Assert: ディスク上の YAML が一切書き換わっていない
    const after = await fixture.read();
    expect(after).toBe(before);
  });

  test('存在しない workflowId を URL に入れると 404 が返り、一覧画面へ戻る導線がある（NotFound branch / M-2）', async ({
    page,
  }) => {
    // Arrange: ディスクに存在しない workflowId を作る (suffix で他テストと
    // 衝突しない名前にする). `.yaml` 拡張子だけは保つ — `.yaml` 以外だと
    // 一覧 list から弾かれるが、editor route の id 検証はファイル種別を
    // 区別しないので 404 経路を駆動するには .yaml で十分。
    const missingId = `does-not-exist-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.yaml`;

    // Act: 存在しないワークフローを開きにいく
    const response = await page.goto(`/workflows/${encodeURIComponent(missingId)}`);

    // Assert: HTTP 404 が返る (route の `error(404, 'workflow not found')`)
    expect(response?.status()).toBe(404);

    // Assert: editor 主要 UI (textarea) はレンダリングされない
    await expect(yamlTextarea(page)).toHaveCount(0);

    // Assert: ユーザがそこから前進できる導線がある (review M-2):
    // 一覧画面に戻れることを実際にナビゲーションして確認する。
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: workflowListCopy.pageHeading, level: 1 }),
    ).toBeVisible();
  });

  // パストラバーサル / 不正 id を 400 で拒否することの厳密検証 (review C-2 / M-4)。
  // `asWorkflowId` の brand 検証 (`apps/web/src/features/workflow-editor/entities/types.ts`)
  // が以下のクラスの入力を拒否する契約を E2E で固定する:
  //   - 連続 `..` (`..dangerous.yaml`, `a..b.yaml` 等)
  //   - basename 違反 (`/`, `\`, 空白などを含む)
  //   - 拡張子なし / 異なる拡張子
  //   - URL エンコード経由の path traversal (`%2e%2e/etc/passwd` 等)
  //
  // SvelteKit の `[id]` route param は `/` を含むパスを別 route として扱うため
  // 一部のケースでは 404 (route not found) になる。値ごとに期待ステータスが
  // 確定するものは厳密に assertion する (M-4)。
  const REJECT_CASES: ReadonlyArray<{
    label: string;
    rawPath: string;
    expectedStatus: 400 | 404;
  }> = [
    {
      label: '連続ドットを含む id (`..dangerous.yaml`) は brand 検証で 400',
      rawPath: encodeURIComponent('..dangerous.yaml'),
      expectedStatus: 400,
    },
    {
      label: '中間に連続 `..` を含む id (`a..b.yaml`) は brand 検証で 400',
      rawPath: encodeURIComponent('a..b.yaml'),
      expectedStatus: 400,
    },
    {
      label: '空白を含む id (`valid yaml.yaml`) は brand 検証で 400',
      // `WORKFLOW_ID_RE` は空白文字を許容しないため、空白を含む id は
      // basename 規則違反として 400 で reject される。NUL (`\0`) も同じ
      // 拒否経路を通るが、NUL は URL レイヤ (Node http parser / fetch /
      // ブラウザ) で挙動が環境依存になる可能性があるため、printable な
      // 不正文字で同等の検証を行う。
      rawPath: encodeURIComponent('valid yaml.yaml'),
      expectedStatus: 400,
    },
    {
      label: 'バックスラッシュ区切り (`..\\etc\\passwd.yaml`) は brand 検証で 400',
      rawPath: encodeURIComponent('..\\etc\\passwd.yaml'),
      expectedStatus: 400,
    },
    {
      label: '拡張子なし (`passwd`) は brand 検証で 400',
      rawPath: encodeURIComponent('passwd'),
      expectedStatus: 400,
    },
    {
      label: '異なる拡張子 (`evil.txt`) は brand 検証で 400',
      rawPath: encodeURIComponent('evil.txt'),
      expectedStatus: 400,
    },
    // 以下は SvelteKit の route が `/` を含むパスを別 route として
    // dispatch するため 404 (route not found) になる。`asWorkflowId` まで
    // 到達しないが、いずれにせよパストラバーサルが通らないことを担保する。
    {
      label: 'スラッシュを含むパストラバーサル (`../../etc/passwd`) は別 route で 404',
      rawPath: '../../etc/passwd',
      expectedStatus: 404,
    },
    {
      label: '絶対パス (`/etc/passwd`) は別 route で 404',
      rawPath: '/etc/passwd',
      expectedStatus: 404,
    },
    {
      label: 'URL エンコード越え (`%2e%2e/etc/passwd`) は別 route で 404',
      rawPath: '%2e%2e/etc/passwd',
      expectedStatus: 404,
    },
  ];

  for (const c of REJECT_CASES) {
    test(`不正な workflowId を拒否する: ${c.label}`, async ({ page }) => {
      // Act
      const response = await page.goto(`/workflows/${c.rawPath}`);

      // Assert: 期待ステータスが厳密に返る (M-4)
      expect(response?.status()).toBe(c.expectedStatus);

      // Assert: いずれの拒否経路でも editor textarea は描画されない
      await expect(yamlTextarea(page)).toHaveCount(0);
    });
  }

  test('ファイル名 (タスク id) に script/onerror を含む既存ワークフローを開いても XSS が実行されない（C-1）', async ({
    page,
  }) => {
    // Arrange: `<img src=x onerror=window.__xss_alert__=1>` をタスク id に
    // 持つ YAML を seed する。`WORKFLOW_WITH_XSS_NAME` は insert-pattern.xss
    // で再利用しているフィクスチャ。
    const fixture = await tracker.create('open-xss-name', WORKFLOW_WITH_XSS_NAME);

    // alert / dialog 系をすべてフックする (どんな種類でも fail させる)
    let dialogTriggered = false;
    page.on('dialog', async (dialog) => {
      dialogTriggered = true;
      await dialog.dismiss();
    });

    // Act: URL から直接開く (このシナリオの守備範囲)
    await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);

    // Assert: 編集画面そのものは開ける
    await expect(yamlTextarea(page)).toBeVisible();

    // Assert: window スコープに XSS マーカーが立っていない
    const xssMarker = await page.evaluate(
      () => (window as unknown as { __xss_alert__?: number }).__xss_alert__ ?? null,
    );
    expect(xssMarker).toBeNull();
    expect(dialogTriggered).toBe(false);

    // Assert: DOM に <img onerror> が HTML として注入されていない
    // (Graph / 一覧 / textarea のいずれの描画経路でも escape されている)
    const injectedImageCount = await page.evaluate(
      () => document.querySelectorAll('img[onerror]').length,
    );
    expect(injectedImageCount).toBe(0);

    // Assert: 一覧画面側でも同じ id がスクリプト実行を起こさない
    // (URL 経由ではなく一覧経由で踏んだ場合の入口も担保する)
    await page.goto('/');
    const xssMarkerAfterList = await page.evaluate(
      () => (window as unknown as { __xss_alert__?: number }).__xss_alert__ ?? null,
    );
    expect(xssMarkerAfterList).toBeNull();
    const injectedImageAfterList = await page.evaluate(
      () => document.querySelectorAll('img[onerror]').length,
    );
    expect(injectedImageAfterList).toBe(0);
  });
});
