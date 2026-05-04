import { test, expect, type Page } from '@playwright/test';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowListCopy as copy } from '../src/features/workflow-editor/components/workflowListCopy';
import { leftSidebarCopy } from '../src/lib/components/app-shell/leftSidebarCopy';

// E2E tests for the "List Workflows" scenario.
//
// Scenario: apps/web/docs/scenarios/workflow-management/list-workflows.md
//
// User story:
//   ユーザが、設定済みのディレクトリに配置されているワークフロー定義
//   （YAML）の一覧を確認する。各ワークフローは表示用の名前と識別子をもつ。
//
// Coverage (mapped to scenario invariants):
//   - 正常系
//     - 0 件のとき: empty state が表示される（不変条件 1）
//     - 複数件のとき: ファイル名昇順でリスト表示され、各行から編集画面へ遷移できる
//     - `document.name` が定義されたワークフローはその名前が表示される（SummarizeEach）
//     - `.yml` 拡張子のワークフローも一覧に出る
//     - 「New」ボタンから新規作成画面に遷移できる（入口の動線）
//   - エラー系（YAML 抽出の fallback / 不変条件 2）
//     - YAML 構文が壊れているファイルは、ファイル basename にフォールバックして
//       一覧に出る（壊れていてもエラーにしない）
//     - `document.name` が空文字 / 非文字列 / 欠落のときも basename にフォールバック
//     - 不正な拡張子 (`.txt` 等) のファイルは一覧に表示されない
//   - リンク先確認: 行クリックで `/workflows/<encoded-id>` に遷移
//   - セキュリティ: 一覧名に script タグが含まれていても DOM 注入されない

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mirror the directory passed to the dev server in `playwright.config.ts`.
const E2E_WORKFLOWS_DIR = resolve(__dirname, '../.e2e-workflows');

/** Build a unique workflow id (yaml basename) for a single test. */
function uniqueId(prefix: string, ext: 'yaml' | 'yml' = 'yaml'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

function buildYaml(documentName: string | null): string {
  if (documentName === null) {
    return `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  version: '0.1.0'\ndo:\n  - first_step:\n      run:\n        shell:\n          command: 'echo hello'\n`;
  }
  return `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: ${JSON.stringify(documentName)}\n  version: '0.1.0'\ndo:\n  - first_step:\n      run:\n        shell:\n          command: 'echo hello'\n`;
}

// js-yaml が parse 失敗するペイロード（unclosed flow list）。
// `extractWorkflowSummary` が parse 失敗を検知して basename にフォールバック
// する経路を駆動する（不変条件 2）。
const BROKEN_YAML = `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: should-not-be-seen\n  version: '0.1.0'\ndo: [unclosed\n`;

/**
 * Track files seeded by tests so afterEach can remove them regardless of
 * outcome. Also wipes the entire `.e2e-workflows` directory in beforeEach so
 * leaked files from prior failed runs don't pollute the empty-state assertion
 * (tests run sequentially: `workers: 1`, `fullyParallel: false`).
 */
function makeSeedTracker() {
  const ids = new Set<string>();
  return {
    register(id: string) {
      ids.add(id);
    },
    /**
     * Remove every regular file in the e2e workflows directory. Safe because
     * the directory is owned by the e2e harness (configured via
     * `RALPH_WORKFLOWS_DIR` in `playwright.config.ts`) and the test runner
     * is single-worker / non-parallel.
     */
    async wipeDirectory() {
      await mkdir(E2E_WORKFLOWS_DIR, { recursive: true });
      const entries = await readdir(E2E_WORKFLOWS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
          await unlink(resolve(E2E_WORKFLOWS_DIR, entry.name));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
    },
    async cleanup() {
      const errors: unknown[] = [];
      for (const id of ids) {
        try {
          await unlink(resolve(E2E_WORKFLOWS_DIR, id));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(e);
        }
      }
      ids.clear();
      if (errors.length > 0) throw errors[0];
    },
  };
}

async function seedFile(id: string, yaml: string): Promise<void> {
  await mkdir(E2E_WORKFLOWS_DIR, { recursive: true });
  await writeFile(resolve(E2E_WORKFLOWS_DIR, id), yaml, 'utf8');
}

/**
 * Locate the sidebar workflow file tree by its accessible name. The
 * "List Workflows" scenario is now satisfied via the Left Sidebar
 * (`apps/web/src/lib/components/app-shell/LeftSidebar.svelte`); the
 * index page renders an empty canvas state and no longer hosts the list
 * itself.
 */
function workflowList(page: Page) {
  return page.getByRole('navigation', { name: leftSidebarCopy.fileListAria });
}

/**
 * Locate the empty-state region by role/name. Rendered when there are zero
 * workflows (scenario invariant 1).
 *
 * Two empty surfaces use the same `No workflows yet` headline copy:
 *   1. The sidebar's `WorkflowFileTree` shows a per-tree empty body
 *      with `role="status"` and `leftSidebarCopy.emptyMessage`.
 *   2. The index page's empty canvas card uses `role="status"` and the
 *      `workflowListCopy.emptyTitle` headline (kept identical so users
 *      see one consistent "no workflows yet" message regardless of
 *      whether they look at the sidebar or the canvas).
 *
 * Both should appear when the directory is empty, so we keep this
 * helper returning ALL matching regions (the assertions below check
 * presence + text, not count).
 */
function emptyState(page: Page) {
  return page.getByRole('status').filter({ hasText: copy.emptyTitle });
}

/**
 * Locate a row in the sidebar's workflow file tree by its visible
 * workflow name. The tree's row anchors are labelled
 * `${leftSidebarCopy.openLabel} ${name}` (see `WorkflowFileTree.svelte`),
 * which differs from the now-removed standalone list (`Open ${name}`).
 * Using exact match avoids partial collisions where one workflow name
 * is a prefix of another.
 */
function workflowRow(page: Page, displayName: string) {
  return page.getByRole('link', {
    name: `${leftSidebarCopy.openLabel} ${displayName}`,
    exact: true,
  });
}

test.describe('list-workflows: ユーザがディレクトリに置かれたワークフロー一覧を確認する', () => {
  const tracker = makeSeedTracker();

  test.beforeEach(async () => {
    // 不変条件 1 (0件の正常表示) を pollution-free に検証するため、各テスト
    // 開始前にワークフロー dir を空にする。tests are sequential / single-worker
    // なので他テストとレース条件にはならない。
    await tracker.wipeDirectory();
  });

  test.afterEach(async () => {
    await tracker.cleanup();
  });

  test('ワークフローが 1 件もない状態でトップを開くと「No workflows yet」の empty state が表示される（不変条件 1: 0件はエラーにしない）', async ({
    page,
  }) => {
    // Arrange: beforeEach で dir は空

    // Act: トップ画面を開く
    await page.goto('/');

    // Assert: ヘッダ + New ボタンは常に表示される
    await expect(
      page.getByRole('heading', { name: copy.pageHeading, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: copy.newAction, exact: true }),
    ).toBeVisible();

    // Assert: empty state のメッセージが両方とも表示されている。サイドバー
    // ツリーの empty body と index canvas の empty card の両方が同じ
    // "No workflows yet" + ヒント文を出すので first() で先頭を抜き出して
    // 検証する (どちらか片方が消えても残り側で検出できるよう
    // `toHaveCount(0)` ではなく `at least one visible` を担保)。
    const empty = emptyState(page).first();
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(copy.emptyTitle);

    // Assert: サイドバーの file tree nav は landmark として残るが、その
    // 内側に workflow 行 (link) は一つもない。
    const list = workflowList(page);
    await expect(list).toBeVisible();
    await expect(list.getByRole('link')).toHaveCount(0);
  });

  test('複数のワークフローを置くと、ファイル名昇順で全件がリスト表示される（正常系: SummarizeEach + 不変条件 3 一意性）', async ({
    page,
  }) => {
    // Arrange: 3 つのワークフローを seed する。`document.name` 経路 / `.yml`
    // 拡張子経路 / 名前付きの経路を一発でカバーする。
    const idA = `aaa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`;
    const idB = `bbb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yml`;
    const idC = `ccc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`;
    const nameA = `Alpha Workflow ${idA}`;
    const nameB = `Bravo Workflow ${idB}`;
    const nameC = `Charlie Workflow ${idC}`;
    tracker.register(idA);
    tracker.register(idB);
    tracker.register(idC);
    await seedFile(idA, buildYaml(nameA));
    await seedFile(idB, buildYaml(nameB));
    await seedFile(idC, buildYaml(nameC));

    // Act
    await page.goto('/');

    // Assert: サイドバーの file tree nav が描画されている / empty state は
    // どこにも出ていない (canvas card, sidebar tree, どちらも非 empty)。
    await expect(workflowList(page)).toBeVisible();
    await expect(emptyState(page)).toHaveCount(0);

    // 各ワークフローが行として表示されており、編集画面に遷移するリンクが
    // `/workflows/<encoded-id>` を href に持つこと（不変条件 3: id は URL key）
    const rowA = workflowRow(page, nameA);
    const rowB = workflowRow(page, nameB);
    const rowC = workflowRow(page, nameC);
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();
    await expect(rowC).toBeVisible();
    await expect(rowA).toHaveAttribute(
      'href',
      `/workflows/${encodeURIComponent(idA)}`,
    );
    await expect(rowB).toHaveAttribute(
      'href',
      `/workflows/${encodeURIComponent(idB)}`,
    );
    await expect(rowC).toHaveAttribute(
      'href',
      `/workflows/${encodeURIComponent(idC)}`,
    );

    // 並び順: ファイル名昇順 (a- → b- → c-) になっている。
    // `WorkflowStore.list` が `localeCompare(id)` で安定化させているので、
    // seed した 3 件はそのままアルファベット順 (`aaa` → `bbb` → `ccc`) に並ぶ。
    // サイドバー tree の `<ul>` 内の anchor を順序付きで取得する。
    const links = workflowList(page).getByRole('link');
    await expect(links).toHaveCount(3);
    await expect(links).toHaveText([nameA, nameB, nameC]);
  });

  test('一覧の行をクリックするとワークフロー編集画面に遷移する（正常系: 出口の動線）', async ({
    page,
  }) => {
    // Arrange
    const id = uniqueId('list-click');
    const displayName = `Click Through ${id}`;
    tracker.register(id);
    await seedFile(id, buildYaml(displayName));

    // Act
    await page.goto('/');
    await workflowRow(page, displayName).click();

    // Assert: editor 画面に到達している
    await expect(page).toHaveURL(`/workflows/${encodeURIComponent(id)}`);
    await expect(
      page.getByRole('textbox', { name: 'Workflow YAML' }),
    ).toBeVisible();
  });

  test('YAML が壊れていてもファイル名 (basename) で一覧に出る（不変条件 2: Name は必ず設定される）', async ({
    page,
  }) => {
    // Arrange: parse 失敗する YAML と、正常な YAML を 1 つずつ seed する。
    // basename の表示文字列は `<id>` から `.yaml` 拡張子を除いたもの。
    const brokenId = `broken-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`;
    const brokenBasename = brokenId.replace(/\.ya?ml$/, '');
    tracker.register(brokenId);
    await seedFile(brokenId, BROKEN_YAML);

    // Act
    await page.goto('/');

    // Assert: 壊れた YAML でも行が出ており、表示名は basename に fallback
    // している（不変条件 2）。`document.name` の "should-not-be-seen" は
    // parse 失敗のため抽出できないので、UI に出てはいけない。
    const row = workflowRow(page, brokenBasename);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute(
      'href',
      `/workflows/${encodeURIComponent(brokenId)}`,
    );

    await expect(workflowList(page)).not.toContainText('should-not-be-seen');
  });

  test('`document.name` が欠落 / 空文字 / 非文字列でも basename で一覧に出る（fallback 経路: extractWorkflowSummary 不変条件 2）', async ({
    page,
  }) => {
    // Arrange: 3 種類の壊れ方を 1 テストで束ねて検証する。1 件ずつ別テスト
    // にしてもよいが、すべて同じ fallback 経路を駆動するので 1 ケースにまとめ
    // メンテ負荷を下げる。
    const idMissing = `missing-name-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`;
    const idEmpty = `empty-name-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`;
    const idNumber = `number-name-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`;
    tracker.register(idMissing);
    tracker.register(idEmpty);
    tracker.register(idNumber);

    // 1) name 欠落 (document に name キー自体が無い)
    await seedFile(idMissing, buildYaml(null));
    // 2) name が空文字 (`""` を経路として駆動)
    await seedFile(
      idEmpty,
      `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: ''\n  version: '0.1.0'\ndo:\n  - first_step:\n      run:\n        shell:\n          command: 'echo hello'\n`,
    );
    // 3) name が数値 (型不一致 = string でないので fallback)
    await seedFile(
      idNumber,
      `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: 42\n  version: '0.1.0'\ndo:\n  - first_step:\n      run:\n        shell:\n          command: 'echo hello'\n`,
    );

    // Act
    await page.goto('/');

    // Assert: いずれの行も basename にフォールバック表示される
    for (const id of [idMissing, idEmpty, idNumber]) {
      const basename = id.replace(/\.ya?ml$/, '');
      await expect(workflowRow(page, basename)).toBeVisible();
    }
    // 空文字や `42` という raw 値が UI に漏れていないこと
    const list = workflowList(page);
    await expect(list).not.toContainText(/^42$/);
  });

  test('`.yaml` / `.yml` 以外の拡張子のファイルは一覧に出ない（フィルタリング）', async ({
    page,
  }) => {
    // Arrange: 正規の `.yaml` 1 つに加えて、`.txt` ファイルを seed する。
    // `WorkflowStore.list` の `ALLOWED_EXT` フィルタが効いていれば、`.txt`
    // は一覧に出てこない。
    const yamlId = uniqueId('valid');
    const yamlName = `Valid Workflow ${yamlId}`;
    const txtId = `not-a-workflow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`;
    tracker.register(yamlId);
    tracker.register(txtId);
    await seedFile(yamlId, buildYaml(yamlName));
    await seedFile(txtId, 'not yaml content');

    // Act
    await page.goto('/');

    // Assert: yaml は出ているが、`.txt` は無視されている
    await expect(workflowRow(page, yamlName)).toBeVisible();

    // 一覧の総 link 数が 1 (= seeded yaml 1 件分) であることを確認。
    // `.txt` の id を含む行が出ていないことを否定形でも担保する。
    const list = workflowList(page);
    await expect(list.getByRole('link')).toHaveCount(1);
    await expect(list).not.toContainText('not-a-workflow');
  });

  test('一覧画面の「New」ボタンから新規作成画面に遷移できる（入口の動線）', async ({
    page,
  }) => {
    // Arrange: 中身は何でもよいので 1 件 seed しておく（list 表示と無関係に
    // 「New」ボタンが常に押せることを確認するため）
    const id = uniqueId('with-new');
    const name = `Has New ${id}`;
    tracker.register(id);
    await seedFile(id, buildYaml(name));

    // Act
    await page.goto('/');
    await page.getByRole('link', { name: copy.newAction, exact: true }).click();

    // Assert: 新規作成画面に到達
    await expect(page).toHaveURL('/workflows/new');
    await expect(
      page.getByRole('heading', { name: 'New workflow' }),
    ).toBeVisible();
  });

  test('一覧の表示名に `<script>` 文字列が含まれていても、生 HTML として展開されず DOM 注入は起きない（セキュリティ: textContent 描画担保）', async ({
    page,
  }) => {
    // 観点: `document.name` を Svelte が `{name}` で render する経路は
    // textContent ベースだが、回帰防止のため UI 経路でも担保する。
    const id = uniqueId('xss-name');
    // YAML 文字列としては JSON で escape された二重引用符付き値が入る。
    // js-yaml が parse すると `name = "<script>window.__pwn_list__=1</script>"`
    // という string になる。
    const evilName = '<script>window.__pwn_list__=1</script>';
    tracker.register(id);
    await seedFile(
      id,
      `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: ${JSON.stringify(evilName)}\n  version: '0.1.0'\ndo:\n  - first_step:\n      run:\n        shell:\n          command: 'echo hello'\n`,
    );

    // sentinel: ブラウザ側で script が evaluate されたら立つ
    await page.addInitScript(() => {
      // @ts-expect-error テスト用 sentinel
      window.__pwn_list__ = undefined;
    });

    // Act
    await page.goto('/');

    // Assert: 行は visible で、name が textContent として表示されている
    const row = workflowRow(page, evilName);
    await expect(row).toBeVisible();

    // 一覧領域に script 要素が注入されていない (= textContent 描画の証拠)
    const list = workflowList(page);
    await expect(list.locator('script')).toHaveCount(0);

    // ブラウザでは attacker の script が evaluate されていない
    const pwn = await page.evaluate(() => {
      // @ts-expect-error テスト用 sentinel
      return window.__pwn_list__;
    });
    expect(pwn).toBeUndefined();
  });
});
