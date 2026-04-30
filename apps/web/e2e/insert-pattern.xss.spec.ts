import { test, expect } from '@playwright/test';
import {
  WORKFLOW_WITH_XSS_NAME,
  createFixtureTracker,
} from './helpers/workflowFixtures';
import { openPicker, yamlTextarea, patternOption } from './helpers/editor';

const tracker = createFixtureTracker();

test.afterEach(async () => {
  await tracker.cleanupAll();
});

test.describe('insert-pattern: HTML 解釈経路の XSS 回帰検出 (UI 経由)', () => {
  test('既存 YAML 内に script / 画像 onerror を含むタスク名があっても、UI 上で alert は発火しない', async ({
    page,
  }) => {
    const fixture = await tracker.create('xss', WORKFLOW_WITH_XSS_NAME);

    // alert / dialog をフックする — どんな種類の dialog でも fail させる
    let dialogTriggered = false;
    page.on('dialog', async (dialog) => {
      dialogTriggered = true;
      await dialog.dismiss();
    });

    await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);
    await expect(yamlTextarea(page)).toBeVisible();

    // do パターンを挿入した後も、グラフ描画と textarea の双方で
    // ユーザ提供文字列が HTML として解釈されない
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();
    await expect(page.getByLabel('Search patterns')).toBeHidden();
    await expect(yamlTextarea(page)).toHaveValue(/sample_step/);

    // window スコープの XSS マーカーが立っていない
    const xssMarker = await page.evaluate(
      () => (window as unknown as { __xss_alert__?: number }).__xss_alert__ ?? null,
    );
    expect(xssMarker).toBeNull();
    expect(dialogTriggered).toBe(false);

    // DOM に <img onerror> が HTML として注入されていないこと
    // (タスク名はテキストノードとしてのみ扱われるべき)。`Graph.svelte` 側の
    // 描画経路で escape が崩れた場合の回帰検出。
    const injectedImageCount = await page.evaluate(
      () => document.querySelectorAll('img[onerror]').length,
    );
    expect(injectedImageCount).toBe(0);
  });
});
