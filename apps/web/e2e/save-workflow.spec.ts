import { test, expect, type Page, type Locator } from '@playwright/test';
import { writeFile, unlink, access, chmod, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VALID_WORKFLOW_YAML,
  INVALID_WORKFLOW_YAML,
  WORKFLOW_WITH_XSS_NAME,
  createFixtureTracker,
} from './helpers/workflowFixtures';
import { yamlTextarea, expectNoInternalLeak } from './helpers/editor';
import { editorCopy } from '../src/features/workflow-editor/lib/editorCopy';
import { mapSaveHttpStatus } from '../src/features/workflow-editor/lib/api';

// E2E tests for the "Save Workflow" scenario.
//
// Scenario: apps/web/docs/scenarios/workflow-management/save-workflow.md
//
// User story:
//   編集中のユーザが、現在のワークフロー YAML を明示的に保存する。保存は
//   既存ワークフローへの上書きであり、構文不正な YAML も保存できる
//   （編集途中の状態を残せる）が、ID とパスは検証される。
//
// このファイルは UI 駆動の E2E のみを扱う (review-e2e.md Q-1: API を直接
// 叩くテストは E2E spec に同居させない)。Content-Type allowlist /
// パストラバーサル / CSRF / 大きい body などの API 境界は
// `integration/save-workflow.api.spec.ts` および
// `integration/save-workflow.security.spec.ts` に分離されている。
//
// Coverage (mapped to scenario steps + invariants / review-e2e.md):
//   - 正常系
//     - 編集 → Save → ディスクに上書きされ "Saved" トーストが出る
//       (workflow output: WorkflowSaved / 不変条件 1: 上書き)
//     - Save → reload で永続化されたことが画面に反映される
//       (review-e2e.md N-8 Save→reload roundtrip 担保)
//     - 構文不正な YAML でも Save できる (不変条件 2)
//     - .yml 拡張子のワークフローも保存できる
//     - HTML/JS を含むタスク名でも YAML テキストとしてのみ扱われ XSS が走らない
//       (review-e2e.md S-4)
//   - エラー系
//     - NotFound: 対象ファイルが消えた状態で Save → role=alert に
//       「workflow not found」が出る (workflow output: NotFound)
//     - Too large 短絡: 256KiB 超の YAML → ネットワークに飛ばずトースト
//       (不変条件 3: 失敗時にディスクは変わらない)
//     - StorageFailure: 書込失敗 → role=alert に "server error while saving"
//       が出てディスクが破損していない (review-e2e.md N-1 Critical /
//       不変条件 3 の本流)
//     - 同時 Save 抑止: Save 中はボタンが disabled / aria-busy=true
//       (review-e2e.md N-9)
//   - 不変条件 3: 失敗時に元のファイル内容が変わらないことを各エラー系で確認
//   - 情報漏洩確認: エラートーストに stack trace / file path / errno が出ない
//     (review-e2e.md S-2)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mirror the dev server's workflow directory (see playwright.config.ts).
const E2E_WORKFLOWS_DIR = resolve(__dirname, '../.e2e-workflows');
void E2E_WORKFLOWS_DIR;

const tracker = createFixtureTracker();

test.afterEach(async () => {
  await tracker.cleanupAll();
});

/** 編集画面の Save ボタン (アクセシブル名 "Save")。 */
function saveButton(page: Page): Locator {
  return page.getByRole('button', { name: editorCopy.saveLabel, exact: true });
}

/**
 * Save ボタン (saving 中はラベルが "Saving…" に切り替わる) を a11y 名に依存
 * せず引くための locator。saving 中の disabled / aria-busy 観測に使う
 * (review-e2e.md H-3)。Save ボタンのラベル切替で getByRole の name 一致が
 * 外れる問題を回避するため、両方の名前を許容する正規表現で取る。
 */
function saveOrSavingButton(page: Page): Locator {
  return page.getByRole('button', {
    name: new RegExp(`^(${editorCopy.saveLabel}|${editorCopy.savingLabel})$`),
  });
}

/**
 * Editor toast region. 編集画面ヘッダ内に出る save 成功 / 失敗の通知バッジを
 * 一意に引くための data-testid 経由 locator。`role="status"` / `role="alert"`
 * は RecentRuns / RunDetail / TestNodePanel / RunWorkflowButton などサブパネル
 * でも使われており、page-scope の getByRole では衝突する (= 厳密モード違反)。
 * editor-toast testid は本シナリオの save 成否表示専用 (review-e2e で要請の
 * 「strict locator」原則を維持する最小の DOM 拡張)。
 */
function editorToast(page: Page): Locator {
  return page.getByTestId('editor-toast');
}

/**
 * Build an edited YAML payload with the given suffix tag. Centralised so
 * テスト個別の "編集後 YAML" の繰り返しが減り、文言ぶれが起きない
 * (review-e2e.md Q-5)。
 */
function buildEditedYaml(tag: string): string {
  return `${VALID_WORKFLOW_YAML}# edit-tag: ${tag}\n`;
}

/**
 * ワークフローを開いて編集画面が描画されるまで待つ。テストの Arrange ステップ
 * を共通化し、`yamlTextarea` の初期値が seed と一致していることを担保する。
 *
 * SaveButton は `mounted` フラグに依存しないので `expect(button).toBeEnabled()`
 * だけでは Svelte の `onclick` ハンドラ取り付け完了を保証できない。実際の
 * click に到達できる状態を担保するため、SvelteKit クライアントが起動した
 * 印 (`__sveltekit_*` グローバル) を probe としても観測している。
 */
async function gotoWorkflow(page: Page, id: string, expectedYaml: string) {
  await page.goto(`/workflows/${encodeURIComponent(id)}`);
  await expect(yamlTextarea(page)).toBeVisible();
  await expect(yamlTextarea(page)).toHaveValue(expectedYaml);
  await expect(saveButton(page)).toBeEnabled();
  await page.waitForFunction(() => {
    return Object.keys(window).some((k) => k.startsWith('__sveltekit_'));
  });
}

/**
 * Save ボタンを押す。Svelte の `onclick` 取り付けが完了する前に click が
 * 発火すると save() 呼び出しが落ちることがあるので、PUT リクエストの発火
 * (success / 4xx / 5xx いずれでも) を retry の終端条件にして click を
 * 「効くまで」やり直す (insert-pattern.spec の openPicker と同じ防御策)。
 *
 * 短絡経路 (too-large) では PUT が飛ばないので `expectsRequest: false` を
 * 渡してリクエスト待ちをスキップする。
 *
 * 二重送信の検出: opts.maxObservedPuts が指定された場合、retry 終了後にも
 * 観測された PUT 数が上限を超えないことを assert する (review-e2e.md Q-2:
 * retry が race で二重 PUT を生んでも気付けない問題への保険)。
 */
async function clickSave(
  page: Page,
  opts: { expectsRequest?: boolean; maxObservedPuts?: number } = {},
) {
  const expectsRequest = opts.expectsRequest ?? true;
  if (!expectsRequest) {
    await saveButton(page).click();
    return;
  }
  await expect(async () => {
    const reqPromise = page.waitForRequest(
      (req) =>
        req.method() === 'PUT' &&
        new URL(req.url()).pathname.startsWith('/api/workflows/'),
      { timeout: 1000 },
    );
    await saveButton(page).click();
    await reqPromise;
  }).toPass({ timeout: 10_000 });
}

test.describe('save-workflow: 編集中のユーザが現在のワークフロー YAML を明示的に保存する', () => {
  test('編集 → Save → ディスクに上書きされ、`Saved` トーストが出る（正常系: WorkflowSaved / 不変条件 1: 上書きである）', async ({
    page,
  }) => {
    // Arrange: 既存のワークフローを seed
    const fixture = await tracker.create('save-success', VALID_WORKFLOW_YAML);
    const before = await fixture.read();
    expect(before).toBe(VALID_WORKFLOW_YAML);

    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // Act: textarea を書き換えて Save
    const editedYaml = buildEditedYaml('happy-path');
    await yamlTextarea(page).fill(editedYaml);
    await clickSave(page);

    // Assert: 成功トーストが出る (role=status / "Saved")
    const toast = editorToast(page);
    await expect(toast).toHaveText(editorCopy.saved);
    // 成功時は role=status (polite); エラー時は role=alert (assertive)
    await expect(toast).toHaveAttribute('role', 'status');

    // Assert: ボタンは再 click 可能な idle 状態に戻る
    await expect(saveButton(page)).toBeEnabled();
    await expect(saveButton(page)).toHaveAttribute('aria-busy', 'false');

    // Assert: 不変条件 1 (上書き). ディスク上の YAML が submit したものと完全一致
    const afterSave = await fixture.read();
    expect(afterSave).toBe(editedYaml);
    expect(afterSave).not.toBe(before);
  });

  test('Save した編集内容はリロード後も画面に反映される（save → reload roundtrip / 不変条件 1 上書きの永続化）', async ({
    page,
  }) => {
    // 観点 (review-e2e.md N-8): 「保存後に同じ画面を再描画したとき編集内容が
    // 反映されている」というユーザー視点の確認。`+page.server.ts` の load
    // 関数経由でファイルが再読込されるので、save → reload の round-trip は
    // ユーザストーリーの根幹。
    const fixture = await tracker.create('save-reload', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    const editedYaml = buildEditedYaml('reload-roundtrip');
    await yamlTextarea(page).fill(editedYaml);
    await clickSave(page);
    await expect(editorToast(page)).toHaveText(editorCopy.saved);

    // Reload: SvelteKit load 関数が再走し、サーバから新しい YAML が返って
    // textarea の初期値として再描画される。
    await page.reload();
    await expect(yamlTextarea(page)).toBeVisible();
    await expect(yamlTextarea(page)).toHaveValue(editedYaml);

    // ディスクとも一致する (= サーバが返した値が正しい)
    const afterReload = await fixture.read();
    expect(afterReload).toBe(editedYaml);
  });

  test('構文不正な YAML でも Save できる（不変条件 2: 編集途中の状態を残せる）', async ({
    page,
  }) => {
    // Arrange: 有効な YAML を seed して編集画面を開く (= 「編集中」状態)
    const fixture = await tracker.create('save-broken', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // Act: js-yaml が parse 失敗する unclosed flow list の YAML に書き換えて Save
    await yamlTextarea(page).fill(INVALID_WORKFLOW_YAML);
    await clickSave(page);

    // Assert: 成功トーストが出る (= server は構文を検査せず保存する)
    const toast = editorToast(page);
    await expect(toast).toHaveText(editorCopy.saved);
    await expect(toast).toHaveAttribute('role', 'status');

    // Assert: ディスクには壊れた YAML がそのまま書き込まれている (不変条件 2)
    const afterSave = await fixture.read();
    expect(afterSave).toBe(INVALID_WORKFLOW_YAML);
  });

  test('`.yml` 拡張子のワークフローも Save で正しく上書きされる（拡張子バリエーション）', async ({
    page,
  }) => {
    // Arrange: `.yml` 拡張子で seed
    const fixture = await tracker.create('save-yml', VALID_WORKFLOW_YAML, {
      extension: 'yml',
    });
    expect(fixture.id.endsWith('.yml')).toBe(true);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // Act: 編集 → Save
    const editedYaml = buildEditedYaml('yml-extension');
    await yamlTextarea(page).fill(editedYaml);
    await clickSave(page);

    await expect(editorToast(page)).toHaveText(editorCopy.saved);

    // Assert: ディスクの YAML が完全一致
    const afterSave = await fixture.read();
    expect(afterSave).toBe(editedYaml);
  });

  test('対象ファイルが消えた状態で Save → 「workflow not found」エラートーストが出てファイルは復活しない（エラー系: NotFound / 不変条件 1 上書き専用）', async ({
    page,
  }) => {
    // Arrange: ワークフローを seed → ページを開く → ファイルだけ外部から削除
    const fixture = await tracker.create('save-notfound', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // ディスクから削除して NotFound 経路を駆動。ブラウザ側の textarea は
    // そのまま残っているので、ユーザ視点では「保存しようとしたら消えていた」
    // ケースを再現する。
    await unlink(fixture.path);
    await expect(
      access(fixture.path).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');

    // Act: 編集 → Save
    await yamlTextarea(page).fill(buildEditedYaml('notfound-path'));
    await clickSave(page);

    // Assert: 失敗トースト (role=alert) に "workflow not found" を含む
    const toast = editorToast(page);
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(editorCopy.errorPrefix);
    // 文言は実装側 mapSaveHttpStatus(404) と同期 (review-e2e.md Q-6)
    await expect(toast).toContainText(mapSaveHttpStatus(404));
    // エラートーンは role=alert (assertive) で SR に割り込み告知される
    await expect(toast).toHaveAttribute('role', 'alert');

    // 情報漏洩確認 (review-e2e.md S-2): server 側スタックや内部パスが
    // トーストに展開されていない
    await expectNoInternalLeak(toast);

    // Assert: ボタンは再 click 可能な idle 状態に戻る
    await expect(saveButton(page)).toBeEnabled();

    // Assert: 不変条件 1 — Save は上書き専用なので、消えていたファイルが
    //         復活する (= 新規作成される) ことはない。
    await expect(
      access(fixture.path).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('256KiB 超の YAML で Save → クライアント側で短絡され「workflow YAML is too large」エラートーストが出てディスクは変わらない（エラー系: too-large 短絡 / 不変条件 3）', async ({
    page,
  }) => {
    // Arrange
    const fixture = await tracker.create('save-too-large', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // クライアント短絡が機能している (= ネットワークに到達しない) ことを
    // 観測するためのリクエスト監視。`PUT /api/workflows/:id` への送信が
    // 起きないことが too-large 短絡の本質的な担保。
    const putRequests: string[] = [];
    page.on('request', (req) => {
      if (
        req.method() === 'PUT' &&
        new URL(req.url()).pathname.startsWith('/api/workflows/')
      ) {
        putRequests.push(req.url());
      }
    });

    // Act: 256KiB を超える YAML を貼り付けて Save。YAML としては有効な
    // 構造を保ったまま末尾コメントだけで膨らませる。
    const filler = '#' + 'a'.repeat(256 * 1024);
    const tooLargeYaml = VALID_WORKFLOW_YAML + '\n' + filler + '\n';
    expect(new TextEncoder().encode(tooLargeYaml).byteLength).toBeGreaterThan(
      256 * 1024,
    );
    await yamlTextarea(page).fill(tooLargeYaml);
    await clickSave(page, { expectsRequest: false });

    // Assert: 失敗トーストが出ている (role=alert)
    const toast = editorToast(page);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('role', 'alert');
    await expect(toast).toContainText(editorCopy.errorPrefix);
    await expect(toast).toContainText(editorCopy.tooLarge);

    // 情報漏洩確認 (review-e2e.md S-2)
    await expectNoInternalLeak(toast);

    // Assert: ネットワークには 1 件も飛んでいない (短絡の核心)
    expect(putRequests).toHaveLength(0);

    // Assert: 不変条件 3 — 失敗時にディスク上の YAML は変わらない
    const afterSave = await fixture.read();
    expect(afterSave).toBe(VALID_WORKFLOW_YAML);

    // Assert: ボタンは idle 状態に戻り、ユーザは入力を直して retry 可能
    await expect(saveButton(page)).toBeEnabled();
  });

  test('書込失敗時 (StorageFailure) → 「server error while saving」エラートーストが出てディスクは変わらない（エラー系: StorageFailure / 不変条件 3）', async ({
    page,
  }) => {
    // 観点 (review-e2e.md N-1 Critical / シナリオ output: StorageFailure /
    // 不変条件 3): サーバが書込に失敗するケース (権限・ディスク容量等) で、
    // (a) UI に server error while saving が出る (b) ボタン idle に戻る
    // (c) ディスク上の YAML が破損していない を確認する。
    //
    // 実 FS 上で再現するためにファイル本体を chmod 0o400 (read-only) に
    // する。`workflowFileExists` は fs.access で読取権限さえあれば true を
    // 返すので EnsureExists は通り、`writeWorkflowFile` の writeFile が
    // EACCES でこける → repository が `storageFailure` を返す → route が
    // 500 にマップする。
    const fixture = await tracker.create('save-storage-failure', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // 書込権限を剥奪 (read-only)
    await chmod(fixture.path, 0o400);

    // 後始末: 失敗時もモードを戻して afterEach の cleanup (unlink) が
    // 親ディレクトリの permission に左右されないようにする。fixture.path 自体は
    // 親ディレクトリ (.e2e-workflows) の write 権限で削除されるので、ファイル
    // 本体のモードを戻すだけで十分。
    let modeRestored = false;
    const restoreMode = async () => {
      if (modeRestored) return;
      modeRestored = true;
      try {
        await chmod(fixture.path, 0o644);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    };
    try {
      // Act: 編集 → Save
      const editedYaml = buildEditedYaml('storage-failure-attempt');
      await yamlTextarea(page).fill(editedYaml);
      await clickSave(page);

      // Assert: 失敗トースト (role=alert) に server error while saving を含む
      const toast = editorToast(page);
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(editorCopy.errorPrefix);
      // 文言は実装側 mapSaveHttpStatus(500) と同期 (review-e2e.md Q-6)
      await expect(toast).toContainText(mapSaveHttpStatus(500));
      await expect(toast).toHaveAttribute('role', 'alert');

      // 情報漏洩確認 (review-e2e.md S-2): errno や file path が漏れない
      await expectNoInternalLeak(toast);
      await expect(toast).not.toContainText(/EACCES/i);
      await expect(toast).not.toContainText(/EPERM/i);
      await expect(toast).not.toContainText(/\.e2e-workflows/i);

      // Assert: ボタンは再 click 可能な idle 状態に戻る
      await expect(saveButton(page)).toBeEnabled();
      await expect(saveButton(page)).toHaveAttribute('aria-busy', 'false');

      // Assert: 不変条件 3 — 書込失敗時にディスク上の YAML は変わらない
      // (read-only にしたので writeFile が触れず、元の VALID_WORKFLOW_YAML が
      //  そのまま残っている)
      const afterSave = await fixture.read();
      expect(afterSave).toBe(VALID_WORKFLOW_YAML);

      // Assert: 権限が読取専用であることをファイル属性レベルでも担保
      // (= write 失敗の実条件が成立していた) — テストの再現性が偶発的な
      // OS 挙動に頼っていないことを示す。
      const st = await stat(fixture.path);
      // owner-write bit (0o200) が立っていない
      expect(st.mode & 0o200).toBe(0);
    } finally {
      await restoreMode();
    }
  });

  test('Save 連打中はボタンが disabled / aria-busy=true になり、PUT は 1 回しか飛ばない（同時 Save 防御 / 二重送信抑止 / a11y）', async ({
    page,
  }) => {
    // 観点 (review-e2e.md H-3 / N-9): editorState の saving フラグが true の
    // あいだ SaveButton は (a) `disabled` 属性で UI 上 click 不能になる
    // (b) `aria-busy='true'` でスクリーンリーダー / 支援技術にも「処理中」を
    // 伝える (c) 結果として追加 click はサーバに届かず PUT は 1 件のみとなる。
    // 本テストは UI の a11y 契約 (a)(b) と外形契約 (c) を同時に担保する。
    // 「PUT 数 == 1」だけだと、disabled が外れた実装に退行しても気付けない。
    const fixture = await tracker.create('save-double-click', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // 観測: PUT 数 (saving 期間中の連打 click が PUT を発生させていないか)
    const putUrls: string[] = [];
    page.on('request', (req) => {
      if (
        req.method() === 'PUT' &&
        new URL(req.url()).pathname === `/api/workflows/${fixture.id}`
      ) {
        putUrls.push(req.url());
      }
    });

    // 応答を deferred promise で gate する (review-e2e.md M-4): 固定 setTimeout
    // ではなく、テスト本文側で「saving 状態の観測が終わった」タイミングで
    // resolve を呼んで保留を解く。これで disabled/aria-busy の観測ウィンドウ
    // が CI のスケジューリング揺れに左右されず確定する。
    let releasePut: (() => void) | null = null;
    const saveResponseGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    await page.route(/\/api\/workflows\//, async (route) => {
      const req = route.request();
      if (req.method() !== 'PUT') return route.fallback();
      const path = new URL(req.url()).pathname;
      if (path !== `/api/workflows/${fixture.id}`) return route.fallback();
      // saving フラグを観測する間サーバ応答を保留する
      await saveResponseGate;
      await route.continue();
    });

    const editedYaml = buildEditedYaml('double-click');
    await yamlTextarea(page).fill(editedYaml);

    // 1 回目の click — PUT が飛ぶまで retry (hydration 待ちと race しないため)
    await expect(async () => {
      const reqPromise = page.waitForRequest(
        (req) =>
          req.method() === 'PUT' &&
          new URL(req.url()).pathname === `/api/workflows/${fixture.id}`,
        { timeout: 1000 },
      );
      await saveButton(page).click();
      await reqPromise;
    }).toPass({ timeout: 10_000 });

    // (a) saving 中のボタンは disabled で、(b) aria-busy=true である。
    // (c) ラベルも `Saving…` に切り替わっている (UI 上の進行表示)。
    // ラベル切替で a11y 名が変わるので saveOrSavingButton で取る。
    // web-first assertion なので microtask 境界の揺れは toBeDisabled の
    // retry に吸収される。
    const savingBtn = saveOrSavingButton(page);
    await expect(savingBtn).toBeDisabled();
    await expect(savingBtn).toHaveAttribute('aria-busy', 'true');
    await expect(savingBtn).toHaveText(editorCopy.savingLabel);

    // 連打: disabled なので click は実際には届かない。Playwright は disabled な
    // 要素への click を 500ms 以内に reject する → そのこと自体を期待する
    // (= 「disabled が機能していた」の positive 担保)。`force: true` を
    // 付ければ強制 click できてしまうが、ユーザは disabled な要素を click
    // できないので force しない。
    for (let i = 0; i < 3; i++) {
      await expect(
        savingBtn.click({ timeout: 500 }),
      ).rejects.toThrow();
    }

    // 連打が終わった時点でも 1 回目の PUT は保留中 → まだ 1 件のみ
    expect(putUrls).toHaveLength(1);

    // gate を開いてサーバ応答を続行させる
    releasePut!();

    // 完了 → "Saved" トースト & ボタン idle 復帰
    await expect(editorToast(page)).toHaveText(editorCopy.saved);
    await expect(saveButton(page)).toBeEnabled();
    await expect(saveButton(page)).toHaveAttribute('aria-busy', 'false');
    await expect(saveButton(page)).toHaveText(editorCopy.saveLabel);

    // 二重送信防止の中核: gate を開いた後も PUT は 1 件のままであること
    expect(putUrls).toHaveLength(1);

    // ディスクが期待通り上書きされている (= 本物のサーバが応答していた)
    expect(await fixture.read()).toBe(editedYaml);
  });

  test('Save 失敗 (NotFound) 後にユーザが入力を直し、ファイルを seed し直して再 Save すると成功する（リカバリ動線）', async ({
    page,
  }) => {
    // 観点: エラー後にフォームが unmount されず、状態を回復してから再 Save
    // できること。シナリオの「StorageFailure / NotFound で停止」「ユーザが
    // 状況を解決して再投稿」の連結経路を担保する。
    const fixture = await tracker.create('save-recover', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // Step 1: ファイルを外部削除して NotFound 経路を駆動
    await unlink(fixture.path);

    const editedYaml = buildEditedYaml('recover-step1');
    await yamlTextarea(page).fill(editedYaml);
    await clickSave(page);

    // 失敗トースト
    const toast = editorToast(page);
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(mapSaveHttpStatus(404));
    await expect(toast).toHaveAttribute('role', 'alert');

    // Step 2: 外側でファイルを再 seed し、状況を解決する
    await writeFile(fixture.path, VALID_WORKFLOW_YAML, 'utf8');

    // Step 3: 内容を再編集して再 Save
    const recoveredYaml = buildEditedYaml('recover-step3');
    await yamlTextarea(page).fill(recoveredYaml);
    await clickSave(page);

    // Assert: 成功トーストが出る (= 失敗後でも save() は再投入可能)
    await expect(editorToast(page)).toHaveText(editorCopy.saved);
    await expect(editorToast(page)).toHaveAttribute('role', 'status');

    // Assert: ディスク上の YAML が 2 回目の Save 時点の内容と完全一致
    const afterSave = await fixture.read();
    expect(afterSave).toBe(recoveredYaml);
  });

  test('保存成功トーストはユーザが再度 textarea を編集すると即座に消える（UX: 古いトーストを残さない）', async ({
    page,
  }) => {
    // 観点: editorState の `flash` は「snapshot 時点と異なる buffer に変化
    // したらトーストを消す」契約 (review note M-2)。Save 成功直後に編集
    // 再開できる UX を担保する。
    const fixture = await tracker.create('save-toast-clears', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // Save 成功 → "Saved" トースト
    const v1 = buildEditedYaml('toast-clears-v1');
    await yamlTextarea(page).fill(v1);
    await clickSave(page);
    await expect(editorToast(page)).toHaveText(editorCopy.saved);

    // 続けて textarea を 1 文字変更すると、トーストは消える
    await yamlTextarea(page).fill(v1 + '# more\n');
    await expect(editorToast(page)).toHaveCount(0);
  });

  test('UI Save が送る Content-Type は text/yaml である（API contract: text/yaml 固定）', async ({
    page,
  }) => {
    // 観点 (review-e2e.md Q-1 改修後): UI 経由の Save が常に text/yaml で
    // PUT することは E2E (UI 駆動) で確認する責務。サーバ側 415 受理ロジック
    // は integration spec で扱う (本 spec では UI 観測のみ)。
    const fixture = await tracker.create('save-content-type', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    const observedContentTypes: string[] = [];
    page.on('request', (req) => {
      if (
        req.method() === 'PUT' &&
        new URL(req.url()).pathname === `/api/workflows/${encodeURIComponent(fixture.id)}`
      ) {
        const ct = req.headers()['content-type'] ?? '';
        observedContentTypes.push(ct);
      }
    });
    await yamlTextarea(page).fill(buildEditedYaml('content-type-check'));
    await clickSave(page);
    await expect(editorToast(page)).toHaveText(editorCopy.saved);

    // 二重 click race の保険 (review-e2e.md Q-2): 観測された Content-Type
    // すべてが text/yaml であることを確認する (= retry が二重送信を生んでも
    // 値が壊れない契約)
    expect(observedContentTypes.length).toBeGreaterThanOrEqual(1);
    for (const ct of observedContentTypes) {
      expect(ct).toBe('text/yaml');
    }
  });

  test('HTML/JS を含むタスク名を含む YAML を Save → reload しても XSS が走らず、parseError でグラフが空のまま安全側に倒れる（不変条件 4: 入力検証 / セキュリティ / review-e2e.md H-2）', async ({
    page,
  }) => {
    // 観点 (review-e2e.md H-2 / S-4): 悪意ある YAML (例: <img src=x onerror=...>
    // を含む task name) を Save → reload した後、それが DOM に展開される
    // 際にスクリプトとして実行されないことを確認する。
    //
    // H-2 改善: 「textarea の生テキスト表示」だけでは textarea が plain text
    // 描画なので元来 XSS が走らない (= trivial pass)。本シナリオの真の関心は
    // 「YAML パース → FlowGraph 等 DOM rendering 経路」での XSS 防御。
    //
    // 実装上の防御線は二段ある:
    //  (a) サーバ側 `asFlowNodeId` の brand 検証で、`<img...>` のような task id
    //      を持つ YAML はノード化を拒否し、グラフ全体が空 + `parseError` で
    //      返される (parseToGraph)。= 「攻撃ペイロードはそもそもグラフ化さ
    //      れず DOM に到達しない」が一次防御。
    //  (b) クライアント側 `yamlToFlow` も同じ task id 制約を持たないが、
    //      SvelteFlow のノードラベルは `{label}` (テキスト補完) なので
    //      `innerHTML` 展開ではない (二次防御)。
    //
    // 本テストは (a) 「攻撃ペイロードを持つ YAML を保存しても、開き直した
    // 際にグラフが描画されず parseError バナーが出る」「`<img>` 等の DOM 要素
    // が一切作られない」「`window.__xss_alert__` が undefined のまま」を担保
    // する。これにより innerHTML 経路に退行した場合や、brand 検証が外れて
    // 攻撃 task id が graph 化された場合のいずれでもテストが落ちる。
    const fixture = await tracker.create('save-xss', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // textarea に XSS ペイロードを含む YAML を貼り付けて Save
    await yamlTextarea(page).fill(WORKFLOW_WITH_XSS_NAME);
    await clickSave(page);
    await expect(editorToast(page)).toHaveText(editorCopy.saved);

    // Reload して、サーバから読み戻された YAML が再描画される経路を駆動
    await page.reload();
    await expect(yamlTextarea(page)).toBeVisible();
    // textarea には生テキストとしてそのまま入っている (= encode されている)
    await expect(yamlTextarea(page)).toHaveValue(WORKFLOW_WITH_XSS_NAME);

    // 攻撃 task id が DOM のどこにも element として展開されていない:
    // (i) `<img src="x">` 要素 (ii) `<script>` 要素 (iii) `<svg onload>` 要素
    // が page 全体に存在しない。innerHTML 経路で展開されると出てくる。
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator('script[onerror], img[onerror]')).toHaveCount(0);

    // 攻撃 task id は brand 検証で拒否される → parseError バナーが描画される。
    // (これは「攻撃ペイロードがグラフ化されずに弾かれた」ことの positive
    //  担保。バナーが出ていない = brand 検証が緩んでいる = 退行。)
    const parseErrorBanner = page.locator(`#${editorCopy.yamlErrorElementId}`);
    await expect(parseErrorBanner).toBeVisible();
    await expect(parseErrorBanner).toContainText(/invalid task id/i);

    // window.__xss_alert__ は undefined のまま (= onerror が発火していない)
    const xssAlertFlag = await page.evaluate(
      () => (window as unknown as { __xss_alert__?: number }).__xss_alert__,
    );
    expect(xssAlertFlag).toBeUndefined();

    // ディスク上にも YAML 原文がそのまま入っている (bytes-in / bytes-out の
    // 透過保存 = サーバ側で escape していない)
    const onDisk = await fixture.read();
    expect(onDisk).toBe(WORKFLOW_WITH_XSS_NAME);
  });

  test('複数の XSS ペイロード (<script>, javascript:, <svg onload>) を含む YAML を Save → reload しても DOM 要素として実行・展開されない（review-e2e.md H-2）', async ({
    page,
  }) => {
    // 観点 (review-e2e.md H-2 提案): `<img onerror>` だけでなく、`<script>`,
    // `javascript:` URL, `<svg onload>` などペイロードのバリエーションも
    // 「実行されない」「DOM 要素として展開されない」ことを確認する。
    // task id は brand 検証で拒否されるので、攻撃ペイロードを task id として
    // 持つ YAML はサーバ側で必ず parseError 経路に落ちる (一次防御)。本テスト
    // はその一次防御が複数の攻撃ベクタで一様に機能していることを担保する。
    const fixture = await tracker.create('save-xss-multi', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture.id, VALID_WORKFLOW_YAML);

    // 3 つのペイロードを順番に試行。すべて task id 経由 (do リストのキー) に
    // HTML / JS 混在文字列を quote で持たせ、parseError 経路を駆動する。
    const payloads = [
      '<script>window.__xss_script__=1</script>',
      'javascript:window.__xss_javascript__=1',
      '<svg onload=window.__xss_svg__=1>',
    ];
    const multiXssYaml =
      `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: xss-multi\n  version: '0.1.0'\ndo:\n` +
      payloads
        .map(
          (p) =>
            `  - ${JSON.stringify(p)}:\n      run:\n        shell:\n          command: 'echo xss'\n`,
        )
        .join('');

    await yamlTextarea(page).fill(multiXssYaml);
    await clickSave(page);
    await expect(editorToast(page)).toHaveText(editorCopy.saved);

    // reload → サーバから読み戻された YAML が再描画される
    await page.reload();
    await expect(yamlTextarea(page)).toBeVisible();
    await expect(yamlTextarea(page)).toHaveValue(multiXssYaml);

    // どのペイロードも実行可能な DOM 要素として展開されていない:
    // - 攻撃 payload 由来の <svg onload> 要素は存在しない
    // - 攻撃 payload 由来の `javascript:` href anchor は存在しない
    //
    // NOTE: <script> 要素は SvelteKit が hydration 用に埋め込むので「全体 0」
    // を assert すると常に落ちる。攻撃 payload 由来の <script> が「実行可能
    // な script として」DOM に到達したかどうかは flag (`__xss_script__`) の
    // 実行結果で観測する (= 後段の `flags.script` が undefined のままである
    // ことが本質的な担保)。さらに SvelteKit のシリアライズは raw YAML を
    // JSON.stringify 経由で <script type="application/json"> に格納するので
    // 攻撃 marker は data の一部として現れうる — ここでの `<script>` 件数
    // チェックは false-positive を生むため避ける。
    await expect(page.locator('svg[onload]')).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:" i]')).toHaveCount(0);
    // 攻撃 payload 由来の <img src="x"> はサーバ側 brand 検証で graph から
    // 排除されているはずなので、page 全体に出現しない。
    await expect(page.locator('img[src="x"]')).toHaveCount(0);

    // parseError バナーが出ている (= brand 検証で task id が弾かれた)
    const parseErrorBanner = page.locator(`#${editorCopy.yamlErrorElementId}`);
    await expect(parseErrorBanner).toBeVisible();
    await expect(parseErrorBanner).toContainText(/invalid task id/i);

    // どのペイロードも実行されていない (window 上に痕跡が残っていない)
    const flags = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        script: w.__xss_script__,
        javascript: w.__xss_javascript__,
        svg: w.__xss_svg__,
      };
    });
    expect(flags.script).toBeUndefined();
    expect(flags.javascript).toBeUndefined();
    expect(flags.svg).toBeUndefined();

    // ディスクには YAML 原文がそのまま入っている (escape はサーバ側でも
    // 行われていない = bytes-in / bytes-out の透過保存)
    expect(await fixture.read()).toBe(multiXssYaml);
  });

  test('ディレクトリ区切り文字を含む workflow id を URL から開くと、編集画面が描画されず Save ボタンも露出しない（不変条件 4: ValidateIdentifier / UI 起点 InvalidId）', async ({
    page,
  }) => {
    // 観点 (review-e2e.md M-5 / シナリオ ValidateIdentifier substep / 不変条件 4):
    // workflow id にパス区切り文字 (`/`, `\`) が含まれる場合は asWorkflowId が
    // InvalidBrandedValueError を投げ、+page.server.ts の load が SvelteKit の
    // `error(400, 'invalid workflow id')` で短絡する。ユーザ視点では
    // 「不正な URL を踏んだら編集画面が出ない = 保存フローに到達しない」
    // ことが本質。Save ボタンも textarea も決して描画されないこと、
    // PUT が一切飛ばないことを担保する。
    //
    // 攻撃者ブラウザが path traversal を URL bar から試した場合の挙動は
    // integration/save-workflow.security.spec.ts で API 単体で網羅済みだが、
    // 「UI 起点で SaveWorkflow の InvalidId 経路に届かない」ことは UI 駆動で
    // 担保しないと、UX レベルでの退行 (= 例えば SvelteKit の future upgrade で
    // unintentionally 別画面にフォールバックする) を見逃す。
    const putRequests: string[] = [];
    page.on('request', (req) => {
      if (
        req.method() === 'PUT' &&
        new URL(req.url()).pathname.startsWith('/api/workflows/')
      ) {
        putRequests.push(req.url());
      }
    });

    // `..%2Fevil` を URL に直書き。SvelteKit の `[id]` パラメタは decode 後の
    // `../evil` を params.id として渡すため、parseWorkflowParam (asWorkflowId)
    // が「must be a basename」で 400 を投げる。
    const response = await page.goto('/workflows/..%2Fevil', {
      waitUntil: 'domcontentloaded',
    });

    // SvelteKit は load 内 error(400) を 400 ステータスのエラーページに変換する
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(400);

    // Save ボタンも textarea も画面に出ない (= 編集フォームに到達していない)
    await expect(saveButton(page)).toHaveCount(0);
    await expect(yamlTextarea(page)).toHaveCount(0);

    // クライアント側から PUT は一切飛んでいない (= 不変条件 4 を超えて
    // 「無効 id への保存試行が物理的に発生しない」ことを観測)
    expect(putRequests).toHaveLength(0);
  });
});
