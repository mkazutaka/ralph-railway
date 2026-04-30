import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile, unlink, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkflowCopy as copy } from '../src/features/workflow-editor/components/createWorkflowCopy';
import {
  NEW_WORKFLOW_DEFAULT_ID,
  NEW_WORKFLOW_DEFAULT_YAML,
} from '../src/features/workflow-editor/lib/newWorkflowTemplate';

// E2E tests for the "Create Workflow" scenario.
//
// Scenario: apps/web/docs/scenarios/workflow-management/create-workflow.md
//
// User story:
//   ユーザが、ファイル名と初期 YAML を指定して新しいワークフローを作成する。
//   作成成功後は編集画面に遷移できる状態になる。
//
// Coverage (mapped to scenario steps + invariants):
//   - 正常系
//     - 有効な id + YAML を入れて Create → 201 / 編集画面遷移
//       (step 4 PersistWorkflow / 不変条件 4)
//     - `.yml` 拡張子でも成功する (拡張子バリエーション)
//     - ディスク上の YAML は submit したものと完全一致する
//       (不変条件 4: 作成後は同じ Id で読み出せる)
//   - エラー系 (フォームに留まり、ディスクへ書き込まれない)
//     - InvalidId: 拡張子なし / `/` パス区切り / `\\` パス区切り / 連続ドット /
//                  空文字 / 256 byte 超過
//     - DuplicateId: 既存 id への上書き拒否
//     - InvalidYaml: parse error / DSL schema 違反
//   - リカバリ動線: エラー → 修正 → 再 submit で成功
//   - 入口/出口の動線: トップ「New」リンク / フォームの Cancel
//   - セキュリティ: `<script>` 注入 / `__proto__` prototype pollution
//   - 不変条件 1 強化: Create ボタン二重 click でも POST は 1 回
//
// Hydration race: SaveButton は `mounted` フラグで SSR 中は disabled。
// Playwright の `await expect(button).toBeEnabled()` が hydration 完了を待つ
// ので、テストは「素直に click 一回」で動作する。

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mirror the directory passed to the dev server in `playwright.config.ts`.
const E2E_WORKFLOWS_DIR = resolve(__dirname, '../.e2e-workflows');

/** Build a unique workflow id (yaml basename) for a single test. */
function uniqueId(prefix: string, ext: 'yaml' | 'yml' = 'yaml'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

/** Locate the file-name input by its visible label. */
function fileNameInput(page: Page) {
  return page.getByLabel(copy.fileNameLabel, { exact: true });
}

/** Locate the YAML textarea by its visible label. */
function yamlInput(page: Page) {
  return page.getByLabel(copy.yamlLabel, { exact: true });
}

/** Locate the Create submit button by its visible (idle) label. */
function createButton(page: Page) {
  return page.getByRole('button', { name: copy.submitLabel, exact: true });
}

/** Locate the inline error alert by its testid. */
function errorAlert(page: Page) {
  return page.getByTestId('create-workflow-error');
}

/**
 * Submit the create form. The form gates the SaveButton behind an `onMount`
 * flag, so `toBeEnabled()` waits until Svelte has hydrated and wired up the
 * `onsubmit` handler. After that, a single click is sufficient — no retry
 * loop, no URL-querystring tolerance.
 */
async function submitCreateForm(page: Page) {
  const button = createButton(page);
  await expect(button).toBeEnabled();
  await button.click();
}

/**
 * Track files created by tests so afterEach can remove them regardless of
 * outcome. Cleanup is idempotent (ENOENT/ENAMETOOLONG are swallowed) so a
 * test that never reached a successful create still cleans up cleanly.
 */
function makeCreatedTracker() {
  const ids = new Set<string>();
  return {
    register(id: string) {
      ids.add(id);
    },
    async cleanup() {
      const errors: unknown[] = [];
      for (const id of ids) {
        try {
          await unlink(resolve(E2E_WORKFLOWS_DIR, id));
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          // ENOENT: ファイルが存在しない (期待通り)。
          // ENAMETOOLONG: 長すぎる id のテストでは unlink 自身が
          // ENAMETOOLONG を返す (NAME_MAX 超過)。これはディスクに何も
          // 書き込まれていないことの強い保証になるので無視してよい。
          if (code !== 'ENOENT' && code !== 'ENAMETOOLONG') errors.push(e);
        }
      }
      ids.clear();
      if (errors.length > 0) throw errors[0];
    },
  };
}

const VALID_YAML = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: create-flow
  version: '0.1.0'
do:
  - first_step:
      run:
        shell:
          command: 'echo create-workflow'
`;

test.describe('create-workflow: ユーザがファイル名と YAML を指定してワークフローを新規作成する', () => {
  const created = makeCreatedTracker();

  test.beforeEach(async () => {
    // Ensure the workflows directory exists (in case it was wiped between
    // sessions). The dev server itself also lazily creates it, but we'd
    // like the directory to be writable from this side as well.
    await mkdir(E2E_WORKFLOWS_DIR, { recursive: true });
  });

  test.afterEach(async () => {
    await created.cleanup();
  });

  test('新規作成フォームには初期テンプレート (untitled.yaml + 既定 YAML) が prefill されている', async ({
    page,
  }) => {
    // Arrange + Act: 新規作成画面を開く
    await page.goto('/workflows/new');

    // Assert: heading が表示されている
    await expect(
      page.getByRole('heading', { name: copy.heading }),
    ).toBeVisible();

    // Assert: ID とテンプレート YAML が初期値として入っている
    await expect(fileNameInput(page)).toHaveValue(NEW_WORKFLOW_DEFAULT_ID);
    await expect(yamlInput(page)).toHaveValue(NEW_WORKFLOW_DEFAULT_YAML);

    // Assert: hydration 完了後、Create ボタンは押せる状態になる
    await expect(createButton(page)).toBeEnabled();
    await expect(createButton(page)).toHaveAttribute('aria-busy', 'false');
    // エラー alert は出ていない
    await expect(errorAlert(page)).toHaveCount(0);
  });

  test('有効な id と YAML を入れて Create → 編集画面に遷移し、ディスクに同じ YAML が保存される（正常系: WorkflowCreated）', async ({
    page,
  }) => {
    const id = uniqueId('create-success');
    created.register(id);

    // Arrange
    await page.goto('/workflows/new');

    // Act: 入力値を初期テンプレートからユニークな値に書き換えて submit
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    // Assert: 編集画面 `/workflows/<id>` に遷移する (step 4 PersistWorkflow 後の navigation)
    await page.waitForURL(`/workflows/${encodeURIComponent(id)}`);
    // 編集画面の YAML textarea が描画され、submit した内容と完全一致する
    // (不変条件 4 を UI 経路でも担保する)
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toHaveValue(VALID_YAML);

    // Assert: 不変条件 4「作成後は同じ Id で読み出せる」。ディスク上の YAML
    // が submit 時の文字列と完全一致していること。
    const onDisk = await readFile(resolve(E2E_WORKFLOWS_DIR, id), 'utf8');
    expect(onDisk).toBe(VALID_YAML);
  });

  test('`.yml` 拡張子の id でも Create が成功し、ディスクに同じ YAML が保存される（正常系: 拡張子バリエーション）', async ({
    page,
  }) => {
    // 不変条件: WorkflowId は `.yaml` または `.yml` のいずれも許容される
    // (ValidateIdentifier substep)。`.yml` 経路の create を担保する。
    const id = uniqueId('create-yml', 'yml');
    created.register(id);

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    await page.waitForURL(`/workflows/${encodeURIComponent(id)}`);
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toBeVisible();
    // 編集画面に表示される YAML が submit したものと完全一致 (不変条件 4)
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toHaveValue(VALID_YAML);

    const onDisk = await readFile(resolve(E2E_WORKFLOWS_DIR, id), 'utf8');
    expect(onDisk).toBe(VALID_YAML);
  });

  test('拡張子 `.yaml` / `.yml` を持たない id を入れると 400 「invalid WorkflowId」alert が出てフォームに留まり、ファイルは作成されない（エラー系: InvalidId / 不変条件 3）', async ({
    page,
  }) => {
    // step 1 (ValidateIdentifier) の `extension not yaml/yml` 経路。
    // `WORKFLOW_ID_RE` は basename + .yaml/.yml を要求するので、拡張子を
    // 落とした id は brand コンストラクタで弾かれて 400 になる。
    const id = uniqueId('create-no-ext').replace(/\.(yaml|yml)$/, '');
    // 念のため cleanup に登録 (作成されないはずだが、書き込みがあれば検出)
    created.register(`${id}.yaml`);
    created.register(`${id}.yml`);
    created.register(id);

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    // Assert: 編集画面に遷移していない (= フォームに留まっている)
    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    // 400 経路は server の `InvalidBrandedValueError` をそのまま forward
    // するので「invalid WorkflowId」が含まれる。
    await expect(alert).toContainText('invalid WorkflowId');
    // ヘッダ (Could not create workflow) も出ている
    await expect(alert).toContainText(copy.errorHeading);

    // 入力値が保持されている (= submit 中にフォームを破棄していない)
    await expect(fileNameInput(page)).toHaveValue(id);
    // ボタンは再 submit 可能な idle 状態に戻っている
    await expect(createButton(page)).toBeEnabled();
    await expect(createButton(page)).toHaveAttribute('aria-busy', 'false');

    // URL は依然として `/workflows/new` (遷移していない / クエリも付いていない)
    await expect(page).toHaveURL('/workflows/new');

    // ディスクには何も書き込まれていない (不変条件 2,3)
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, id)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, `${id}.yaml`)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('パス区切り `/` を含む id は 400 で拒否され、ファイルもサブディレクトリも作成されない（エラー系: InvalidId / 不変条件 3 パストラバーサル防止）', async ({
    page,
  }) => {
    // step 1 (ValidateIdentifier) の `contains path separator not allowed`
    // 経路。brand コンストラクタが `/` を含む id を `must be a basename`
    // で弾くので、ディスク上のサブディレクトリには絶対に書き込まれない。
    const evilId = `subdir/${uniqueId('traversal')}`;

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(evilId);
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('invalid WorkflowId');

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');
    // 入力値が保持されている
    await expect(fileNameInput(page)).toHaveValue(evilId);
    await expect(createButton(page)).toBeEnabled();

    // 不変条件 3: パストラバーサル防止。`subdir/...` は絶対に作成されない。
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, evilId)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('既存ワークフローと同じ id で Create → 409「workflow with this id already exists」alert が出て、既存ファイルは上書きされない（エラー系: DuplicateId / 不変条件 1）', async ({
    page,
  }) => {
    // step 2 (EnsureUnique) の `id already exists` 経路。あらかじめディスク
    // に同名ファイルを seed しておき、フォーム submit でそれが 409 で拒否
    // されることを確認する。
    const id = uniqueId('duplicate');
    const original = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: original\n  version: '0.1.0'\ndo:\n  - keep_me:\n      run:\n        shell:\n          command: 'echo original'\n`;
    await writeFile(resolve(E2E_WORKFLOWS_DIR, id), original, 'utf8');
    created.register(id);

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    // 異なる中身 (= 上書きが起きていれば検出可能) を入れる
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    // server から forward される文言: `mapCreateHttpStatus` ではなく、
    // `throw error(409, 'workflow already exists')` 由来の `body.message`
    // が優先される。
    await expect(alert).toContainText(/already exists/i);
    await expect(alert).toContainText(copy.errorHeading);

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');
    await expect(createButton(page)).toBeEnabled();

    // 不変条件 1: 既存ファイルは上書きされていない
    const onDisk = await readFile(resolve(E2E_WORKFLOWS_DIR, id), 'utf8');
    expect(onDisk).toBe(original);
  });

  test('YAML 構文が壊れた状態で Create → 422「workflow YAML is invalid」alert が出てフォームに留まり、ファイルは作成されない（エラー系: InvalidYaml / 不変条件 2）', async ({
    page,
  }) => {
    // step 3 (ValidateDocument) の `parse error` 経路。`do: [unclosed` は
    // js-yaml が parse error を返す典型例 (run-workflow.spec.ts と同じ
    // ペイロード) で、`parseWorkflowYaml` が `parseError` を返し、ルートが
    // 422 にマップする。
    const id = uniqueId('invalid-yaml');
    const brokenYaml = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: broken\n  version: '0.1.0'\ndo: [unclosed\n`;
    created.register(id);

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(brokenYaml);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('workflow YAML is invalid');
    await expect(alert).toContainText(copy.errorHeading);

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');
    await expect(createButton(page)).toBeEnabled();

    // 不変条件 2: 不正な YAML はディスクに書き込まれない
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, id)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('YAML スキーマに違反する内容 (do がリストでない) で Create → 422 alert でフォームに留まり、ファイルは作成されない（エラー系: InvalidYaml schema 違反）', async ({
    page,
  }) => {
    // step 3 (ValidateDocument) の `DSL schema violation` 経路。YAML として
    // は parse できるが、`do` が文字列なのでスキーマ検証が失敗する。
    // (parseWorkflowYaml は `top-level \`do\` must be a list` 等を返す)
    const id = uniqueId('schema-invalid');
    const schemaInvalidYaml = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: schema-bad\n  version: '0.1.0'\ndo: 'this is not a list'\n`;
    created.register(id);

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(schemaInvalidYaml);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('workflow YAML is invalid');

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');

    // 不変条件 2: 不正 YAML は書き込まれない
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, id)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('連続ドット `..` を含む id は 400 で拒否され、ファイルもサブディレクトリも作成されない（エラー系: InvalidId / 不変条件 3 防御）', async ({
    page,
  }) => {
    // step 1 (ValidateIdentifier) の `consecutive dots` 経路。
    // brand regex の `(?!.*\.\.)` 制約に対応する経路で、`a..b.yaml` は
    // basename としては許容されるがディスクへの書き込み前に弾かれる。
    const id = `a..b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`;
    // 万一作成された場合に検出できるよう cleanup に登録。
    created.register(id);

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('invalid WorkflowId');

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');
    await expect(fileNameInput(page)).toHaveValue(id);
    await expect(createButton(page)).toBeEnabled();

    // ディスクには書き込まれていない
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, id)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('id を空にして Create を押すと 400「invalid WorkflowId: empty」alert が出てフォームに留まる（エラー系: InvalidId empty）', async ({
    page,
  }) => {
    // step 1 (ValidateIdentifier) の `empty` 経路。
    // `<form novalidate>` のためブラウザの required は強制されず、
    // submit ハンドラが空文字を含む POST を送る。サーバ側 `asWorkflowId`
    // が `InvalidBrandedValueError('WorkflowId', 'empty')` で拒否し、
    // 400 で alert に「invalid WorkflowId: empty」が表示される。
    await page.goto('/workflows/new');
    await fileNameInput(page).fill('');
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('invalid WorkflowId');
    await expect(alert).toContainText('empty');
    await expect(alert).toContainText(copy.errorHeading);

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');
    // 入力値（空のまま）が保持されている
    await expect(fileNameInput(page)).toHaveValue('');
    // 再 submit 可能な状態を維持
    await expect(createButton(page)).toBeEnabled();
    await expect(createButton(page)).toHaveAttribute('aria-busy', 'false');
  });

  test('エラー alert を出した後でも、入力を直して再度 Create を押せば成功する（リカバリ動線: フォーム mounted の保証）', async ({
    page,
  }) => {
    // 観点: エラー後にフォームが unmount されず、ユーザが値を直して retry
    // できること。シナリオの「DSL schema violation で停止」「ユーザが入力
    // を直して再投稿」の連結経路を担保する。
    const id = uniqueId('recover');
    const schemaInvalidYaml = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: schema-bad\n  version: '0.1.0'\ndo: 'this is not a list'\n`;
    created.register(id);

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(schemaInvalidYaml);
    await submitCreateForm(page);

    // Step 1: エラー alert 出現
    await expect(errorAlert(page)).toBeVisible();
    await expect(errorAlert(page)).toContainText('workflow YAML is invalid');

    // Step 2: 入力値はそのまま保持されているはず → YAML だけ直す
    await expect(fileNameInput(page)).toHaveValue(id);
    await yamlInput(page).fill(VALID_YAML);

    // Step 3: 再 submit
    await submitCreateForm(page);

    // Step 4: 編集画面へ遷移 + textarea に同じ YAML
    await page.waitForURL(`/workflows/${encodeURIComponent(id)}`);
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toHaveValue(VALID_YAML);

    // ディスクには 2 回目に submit した有効 YAML が書かれている
    const onDisk = await readFile(resolve(E2E_WORKFLOWS_DIR, id), 'utf8');
    expect(onDisk).toBe(VALID_YAML);
  });

  test('一覧画面の「New」ボタンから新規作成画面へ遷移できる（導線: 入口の動線担保）', async ({
    page,
  }) => {
    // 観点: トップ画面の `<SaveButton href="/workflows/new">New</SaveButton>`
    // から create フォームに到達できること。シナリオには明記されていないが
    // 「ユーザが新しいワークフローを作成する」開始点なので、入口を担保する。
    await page.goto('/');
    // ヘッダの「New」リンクをクリック
    await page.getByRole('link', { name: 'New', exact: true }).click();
    // create フォームが表示される (URL は `/workflows/new` ピッタリ)
    await expect(page).toHaveURL('/workflows/new');
    await expect(
      page.getByRole('heading', { name: copy.heading }),
    ).toBeVisible();
    await expect(fileNameInput(page)).toBeVisible();
    await expect(yamlInput(page)).toBeVisible();
    await expect(createButton(page)).toBeEnabled();
  });

  test('Cancel ボタンで一覧画面へ戻れる（導線: 中断時の脱出口）', async ({
    page,
  }) => {
    // 観点: フォーム上の Cancel リンクが root (`/`) へ戻すこと。中断経路
    // を担保しないと「フォームに入った後、戻る手段がブラウザの戻るボタン
    // しかない」状態になりうる。
    await page.goto('/workflows/new');
    await page.getByRole('link', { name: copy.cancelLabel, exact: true }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
  });

  test('id に `<script>` 文字列を含めても error alert に raw HTML として展開されず、DOM 注入は起きない（セキュリティ: XSS 緩和）', async ({
    page,
  }) => {
    // 観点 (review-e2e §3 Major): brand validation で弾かれる evil id を
    // 入れたとき、alert に「raw HTML として」展開されないこと。
    //   - server は汎用メッセージ (`invalid WorkflowId: must end with .yaml ...`)
    //     を返すので raw input は echo されない設計だが、回帰防止のため
    //     UI 側でも textContent ベースで描画されていることを担保する。
    //   - 念のため `window.__pwn__` のような副作用が走っていないことも確認。
    const evilId = '<script>window.__pwn__=1</script>';

    // page navigation 前に sentinel を初期化しておくと、submit 後に script
    // が評価された場合に確実に検出できる。
    await page.addInitScript(() => {
      // @ts-expect-error テスト用 sentinel
      window.__pwn__ = undefined;
    });

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(evilId);
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    // server から forward される brand error は raw input を含まないので、
    // alert 文字列にも `<script>` タグは現れないはず。
    await expect(alert).toContainText('invalid WorkflowId');
    await expect(alert).not.toContainText('<script>');
    await expect(alert).not.toContainText('window.__pwn__');

    // alert 領域配下に script が要素として注入されていないこと
    // (= textContent として描画されている証拠)。
    await expect(alert.locator('script')).toHaveCount(0);

    // ページ全体でも attacker の script が評価されていないこと。
    const pwn = await page.evaluate(() => {
      // @ts-expect-error テスト用 sentinel
      return window.__pwn__;
    });
    expect(pwn).toBeUndefined();

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');
  });

  test('256 byte 以上の長い id (basename byte 上限超過) は 400「invalid WorkflowId: too long」alert で拒否され、ファイルは作成されない（エラー系: InvalidId 長さ境界）', async ({
    page,
  }) => {
    // 観点: `WORKFLOW_ID_MAX_BYTES = 255` (POSIX NAME_MAX 相当) を超える id は
    // brand コンストラクタの byte 長チェックで弾かれる。UI に長さ制約は無い
    // ので、ユーザがクリップボードから長い名前を貼り付けたケースを担保する。
    // 251 文字 + `.yaml` (5 byte) = 256 byte で確実に超過する。
    const longBase = 'a'.repeat(251);
    const longId = `${longBase}.yaml`;
    // テストデータの sanity check (256 byte > 255 上限であることを確認)
    expect(Buffer.byteLength(longId, 'utf8')).toBeGreaterThan(255);
    // 万一作成された場合に検出できるよう cleanup に登録
    created.register(longId);

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(longId);
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('invalid WorkflowId');
    // brand error の reason `too long` がメッセージに含まれる
    await expect(alert).toContainText('too long');
    await expect(alert).toContainText(copy.errorHeading);

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');
    await expect(createButton(page)).toBeEnabled();

    // ディスクには書き込まれていない
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, longId)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('バックスラッシュ `\\` を含む id は 400「invalid WorkflowId: must be a basename」で拒否される（エラー系: InvalidId Windows パス区切り）', async ({
    page,
  }) => {
    // 観点: `asWorkflowId` は `/`, `\\`, `\0` を `must be a basename` で reject
    // する。`/` のみ既存テストでカバー済みで、Windows 風の `\\` 経路は未検証
    // だった。フィルタ漏れの退行検知のため UI から打ち込んで確認する。
    const evilId = `evil\\${uniqueId('backslash')}`;

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(evilId);
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('invalid WorkflowId');
    // brand error の reason に `basename` が含まれる
    await expect(alert).toContainText('basename');

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');
    await expect(createButton(page)).toBeEnabled();

    // 元の id でも、バックスラッシュ除去版でも、ファイルは作成されていない
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, evilId)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, evilId.replace('\\', ''))).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('`__proto__` キーを含む YAML は 422「workflow YAML is invalid」で拒否され、Object.prototype は汚染されずファイルも作成されない（セキュリティ: prototype pollution 緩和）', async ({
    page,
  }) => {
    // 観点: `parseWorkflowYaml` の `findForbiddenKey` が `__proto__` /
    // `constructor` / `prototype` キーを `parseError` で弾く。これは prototype
    // pollution 防止の重要なセキュリティ境界。`document.__proto__: { polluted: 1 }`
    // を含む有効 YAML 構文を投げて、サーバが 422 を返すこと、ブラウザの
    // `Object.prototype.polluted` が undefined のまま (= レスポンス処理で
    // 汚染が起きていない) ことを確認する。
    const id = uniqueId('proto-pollution');
    const pollutionYaml = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: pollution\n  version: '0.1.0'\n  __proto__:\n    polluted: 1\ndo:\n  - first_step:\n      run:\n        shell:\n          command: 'echo nope'\n`;
    created.register(id);

    // sentinel 初期化: `Object.prototype.polluted` がブラウザ側で立っていない
    // ことを確認するためのプローブ。
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (Object.prototype as any).polluted;
    });

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(pollutionYaml);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    // server から forward される 422 メッセージ
    await expect(alert).toContainText('workflow YAML is invalid');
    await expect(alert).toContainText(copy.errorHeading);

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');

    // 不変条件 2: 不正 YAML はディスクに書き込まれない
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, id)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');

    // ブラウザ側の Object.prototype が汚染されていないこと
    const polluted = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ({} as any).polluted;
    });
    expect(polluted).toBeUndefined();
  });

  test('Create ボタンを高速に二重クリックしても POST /api/workflows は 1 回しか飛ばず、ファイルは 1 つしか作成されない（不変条件 1: Persist が二重実行されない）', async ({
    page,
  }) => {
    // 観点: フォームの `inFlight` フラグ + SaveButton の `disabled={busy}`
    // により、in-flight 中の二重クリックは効果を持たない。シナリオ不変条件
    // 1 (既存ワークフローを上書きしない) を Persist 経路から担保する観点。
    // 連続クリックで `POST /api/workflows` が 2 回飛ばないこと、ディスクへの
    // 書き込みが 1 つだけであることを確認する。
    //
    // テスト戦略: 1 回目の click でリクエストが in-flight になっている間に
    // 2 回目の click を打ち込む必要があるが、ローカル開発サーバはレスポンス
    // が速すぎて click と click の間で navigation が完了してしまう。そこで
    // route handler でレスポンスを 800ms 遅延させ、その隙間に 2 回目の click
    // を発火させる。
    const id = uniqueId('double-submit');
    created.register(id);

    // POST /api/workflows のリクエストカウンタ。2 回目の click が
    // 防御層 (disabled + inFlight) で抑止されるなら 1 のままになる。
    const postRequests: string[] = [];
    page.on('request', (req) => {
      if (
        req.method() === 'POST' &&
        new URL(req.url()).pathname === '/api/workflows'
      ) {
        postRequests.push(req.url());
      }
    });

    // 800ms の人工的なレスポンス遅延を挟むことで、1 回目の click が
    // in-flight な状態で 2 回目の click を打てるウィンドウを作る。
    await page.route('**/api/workflows', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(VALID_YAML);

    // 1 回目 click 用に「Create」ラベルで取得 (idle 状態を待つ user-facing
    // locator)。2 回目の click 時点ではラベルが "Creating…" に変わっており、
    // 同じセレクタでは見つからないので busy 中は data-testid で再取得する。
    const idleButton = createButton(page);
    const buttonByTestId = page.getByTestId('create-workflow-submit');
    // hydration 完了を待つ (これが onMount 後 = handler attached の合図)
    await expect(idleButton).toBeEnabled();
    await expect(idleButton).toHaveAttribute('aria-busy', 'false');

    // Step 1: 1 回目の click。`noWaitAfter` で post-click のスタビリティ
    // 待機をスキップし、即座に 2 回目の click にいけるようにする。
    await idleButton.click({ noWaitAfter: true });
    // Step 2: 2 回目の click を即座に発火。SaveButton は busy 中ラベルが
    // "Creating…" に変わっているので testid 経由で取得する。`force: true` で
    // actionability チェックをバイパスして MouseEvent を強制発火し、抑止層
    // (`inFlight` 同期ガード + disabled 属性) が機能しているかを確認する。
    await buttonByTestId.click({ force: true, noWaitAfter: true });

    // Step 3: in-flight 期間中はボタンが busy=true で disabled、ラベルは
    // "Creating…" になっていることを確認 (= 状態の正しさを担保)。
    await expect(buttonByTestId).toHaveAttribute('aria-busy', 'true');

    // Step 4: 編集画面 `/workflows/<id>` に遷移する (delay 800ms 経過後)
    await page.waitForURL(`/workflows/${encodeURIComponent(id)}`, {
      timeout: 10_000,
    });
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toBeVisible();

    // 不変条件 1: 二重 click にもかかわらず POST は 1 回しかない
    expect(postRequests.length).toBe(1);

    // 不変条件 1: ディスクに書き込まれた YAML は submit 時のものと完全一致
    // (= 二重 POST で別の値が上書きされていないこと)
    const onDisk = await readFile(resolve(E2E_WORKFLOWS_DIR, id), 'utf8');
    expect(onDisk).toBe(VALID_YAML);
  });

  test('YAML が空白のみ (改行・スペースだけ) でも Create は 422 で拒否され、フォームに留まる（エラー系: InvalidYaml 空白のみ YAML）', async ({
    page,
  }) => {
    // 観点 (review-e2e §2-2): 空白だけの YAML は js-yaml 上は null と解釈される
    // ので、`document` キーや `do` キーが欠落しているとして parseError 経路に
    // 落ちる。空文字列ケースとは別の境界 (whitespace-only) を担保する。
    const id = uniqueId('whitespace-yaml');
    created.register(id);

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill('   \n\n  \t\n');
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('workflow YAML is invalid');

    await expect(page).toHaveURL('/workflows/new');
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, id)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('拡張子大文字 `.YAML` を含む id は 400「invalid WorkflowId」alert で拒否される（エラー系: InvalidId 拡張子 case sensitivity）', async ({
    page,
  }) => {
    // 観点 (review-e2e §2-4): brand 正規表現は `\.(yaml|yml)$` で小文字限定。
    // `.YAML` は弾かれて 400 になり、ファイルは作成されない。クリップボードの
    // 自動 capitalization や IME による大文字化を踏んでも誤って通らないこと
    // を担保する。
    const upperId = `upper-ext-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.YAML`;
    // 万一作成された場合に検出できるよう登録
    created.register(upperId);
    created.register(upperId.toLowerCase());

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(upperId);
    await yamlInput(page).fill(VALID_YAML);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('invalid WorkflowId');
    await expect(alert).toContainText(copy.errorHeading);

    // フォームに留まる + 入力値保持
    await expect(page).toHaveURL('/workflows/new');
    await expect(fileNameInput(page)).toHaveValue(upperId);
    await expect(createButton(page)).toBeEnabled();

    // 大文字版 / 小文字版どちらもディスクに書き込まれていない
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, upperId)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, upperId.toLowerCase())).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('Create 直後に同じ id で再度 Create すると 409 alert が出て、ファイル本文は最初の create のままで上書きされない（連続 create レース: 不変条件 1 強化）', async ({
    page,
  }) => {
    // 観点 (review-e2e §2-3): 1 度 create に成功し、編集画面へ遷移したあと、
    // ユーザがブラウザの「戻る」で New フォームに戻り、同じ id を再度送信
    // した時に DuplicateId が検出されること。Persist 経路の冪等性を担保する。
    const id = uniqueId('consecutive-create');
    created.register(id);
    const FIRST_YAML = VALID_YAML;
    const SECOND_YAML = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: second-attempt\n  version: '0.1.0'\ndo:\n  - second_step:\n      run:\n        shell:\n          command: 'echo second'\n`;

    // Step 1: 1 回目の create で成功して編集画面へ遷移
    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(FIRST_YAML);
    await submitCreateForm(page);
    await page.waitForURL(`/workflows/${encodeURIComponent(id)}`);
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toBeVisible();

    // Step 2: 「戻る」相当に直接 `/workflows/new` へ navigate して、同じ id で
    // 別の YAML を入れて再 submit。ブラウザ history.back と等価な経路だが、
    // テストの安定性のため明示的に goto する。
    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(SECOND_YAML);
    await submitCreateForm(page);

    // Step 3: 2 回目は 409 で拒否される
    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/already exists/i);
    await expect(alert).toContainText(copy.errorHeading);

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');
    await expect(createButton(page)).toBeEnabled();

    // 不変条件 1: ディスクの中身は 1 回目の YAML のまま (= 上書きされていない)
    const onDisk = await readFile(resolve(E2E_WORKFLOWS_DIR, id), 'utf8');
    expect(onDisk).toBe(FIRST_YAML);
    expect(onDisk).not.toBe(SECOND_YAML);
  });

  test('256 KiB を超える YAML を貼り付けて Create すると 413「workflow YAML is too large」alert が出て、ファイルは作成されない（エラー系: ペイロード上限）', async ({
    page,
  }) => {
    // 観点 (review-e2e セキュリティ §3): hooks-level の Content-Length 上限
    // (BODY_LIMIT_BYTES = 256 KiB) を超える YAML を UI から貼り付けたとき、
    // server が 413 を返し、`mapCreateHttpStatus(413)` が
    // 「workflow YAML is too large」を出すこと。フォームに留まり、ディスクへ
    // 書き込まれないこと (不変条件 2 強化)。
    const id = uniqueId('oversize-ui');
    created.register(id);
    // 既定の BODY_LIMIT_BYTES (256 KiB) を確実に超える 300 KiB の padding。
    const padding = 'a'.repeat(300 * 1024);
    const oversizeYaml = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: oversize\n  version: '0.1.0'\n  description: '${padding}'\ndo:\n  - first_step:\n      run:\n        shell:\n          command: 'echo hi'\n`;

    await page.goto('/workflows/new');
    await fileNameInput(page).fill(id);
    await yamlInput(page).fill(oversizeYaml);
    await submitCreateForm(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    // server `throw error(413, 'request body too large')` の `body.message` が
    // 優先されるが、fallback の `mapCreateHttpStatus(413)` でも
    // 「workflow YAML is too large」が含まれる。どちらでも「too large」が
    // 必ず文言に含まれることだけを assert する。
    await expect(alert).toContainText(/too large/i);
    await expect(alert).toContainText(copy.errorHeading);

    // フォームに留まる
    await expect(page).toHaveURL('/workflows/new');
    await expect(createButton(page)).toBeEnabled();

    // 不変条件 2 強化: oversize 拒否されたリクエストはディスクに何も書き込まない
    await expect(
      access(resolve(E2E_WORKFLOWS_DIR, id)).then(
        () => 'exists',
        () => 'missing',
      ),
    ).resolves.toBe('missing');
  });

  test('SSR 段階 (JS 無効) では Create ボタンが disabled のままで、ハイドレーション race による URL クエリ流出が起きない（hydration race 防御）', async ({
    browser,
  }) => {
    // 観点 (review-e2e Q-1 根治): SSR レンダリングの時点では `mounted=false`
    // のため SaveButton は `disabled` 属性を持つ。JS が無効/未到達のブラウザ
    // では「クリックしても何も起こらない」状態になり、ブラウザ default-submit
    // で `/workflows/new?id=...&yaml=...` に遷移してフォーム入力が URL に
    // 漏洩する事故を防ぐ。
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    try {
      await page.goto('/workflows/new');
      // SSR で出力された Create ボタンは disabled になっている
      const button = page.getByRole('button', {
        name: copy.submitLabel,
        exact: true,
      });
      await expect(button).toBeVisible();
      await expect(button).toBeDisabled();
    } finally {
      await ctx.close();
    }
  });
});
