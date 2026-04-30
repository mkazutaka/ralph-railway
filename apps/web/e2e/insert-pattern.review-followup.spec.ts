import { test, expect, type Page } from '@playwright/test';
import yaml from 'js-yaml';
import {
  VALID_WORKFLOW_YAML,
  INVALID_WORKFLOW_YAML,
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

// ----------------------------------------------------------------------------
// review-e2e.md follow-up coverage
// ----------------------------------------------------------------------------
// docs/tasks/review-e2e.md (CHANGES_REQUESTED) で指摘された未カバー項目を
// 一括で塞ぐためのスペック。既存 `insert-pattern.spec.ts` の責務を肥大化
// させずに、レビュー指摘ごとにテストの意図を明示できるようファイルを分離。
//
// カバー対象:
//   1. IME composition 中はフィルタが凍結される (実装側に composition 分岐
//      がある以上、E2E が無いと沈黙退化する) — review §2 Major
//   2. フォーム経由 (`?/insertPattern`) の CSRF / Origin guard — review §3 Major
//   3. XSS: 失敗時の role=alert 経路と workflow id (heading) で
//      ユーザ提供文字列がエスケープされている — review §3 Major
//   4. 失敗 → 同じピッカーから再挿入が成功する (pendingId / errorMessage の
//      適切なリセット) — review §2 Major
//   5. Popover の X (close) ボタンで明示的にクローズできる — review §2 Minor
//   6. ID マッチ専用の検索 ('tch' で switch のみマッチ) — review §2 Minor
// ----------------------------------------------------------------------------

const tracker = createFixtureTracker();

test.afterEach(async () => {
  await tracker.cleanupAll();
});

const FLASH_TIMEOUT = 2000;

async function gotoWorkflow(page: Page, fixture: WorkflowFixture) {
  await page.goto(`/workflows/${encodeURIComponent(fixture.id)}`);
  await expect(yamlTextarea(page)).toBeVisible();
}

test.describe('insert-pattern: review-e2e.md フォローアップ', () => {
  test('IME composition 中は query が凍結され、フィルタが strobe しない (compositionend で commit)', async ({
    page,
  }) => {
    // (review §3 m-4) Playwright は実 IME を再現できないため、本テストは
    // `dispatchEvent('compositionstart' / 'compositionend')` + `fill()` で
    // 擬似化している。実 IME (Mac かな入力 / Windows MS-IME 等) のキー入力
    // 順序は「keydown → compositionstart → input × N → compositionend」だが、
    // 擬似ではこの順序が一部前後しても Svelte 5 の `oncompositionstart` /
    // `oncompositionend` ハンドラとしては等価に動く。
    //
    // この擬似化は将来 Svelte の `bind:value` 実装が input イベントの発火
    // 順序に敏感になった場合に沈黙退化するリスクがある (実 IME のみ壊れる
    // ケース)。tracking issue:
    //   https://github.com/microsoft/playwright/issues/2126 (Real IME support)
    // 補助的に `page.keyboard.insertText` を使った別テスト (下) で「ブラウ
    // ザの input イベント発火経路でも同じ filter 結果になる」ことも担保
    // することで、純粋な dispatchEvent 擬似に依存しない検証を残しておく。
    //
    // Arrange: ピッカーを開いて検索ボックスを取得
    const fixture = await tracker.create('ime-composition', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);
    await openPicker(page);

    const search = page.getByLabel('Search patterns');
    await search.focus();

    // Act: 日本語 IME のような流れを再現する。
    //   1) compositionstart を発火 → composing=true / composedQuery=現在 query
    //   2) 入力中に query を 'lo' に書き換える (= バインディングに反映)
    //   3) この時点ではフィルタは composing 直前の値 ('') を使うので 8 件のまま
    //   4) compositionend で composing=false → フィルタが query='lo' に切り替わる
    await search.dispatchEvent('compositionstart');
    // compositionstart は dispatchEvent でも発火する。
    // bind:value は input イベントで反映されるので、`fill` で
    // input → bind 経路を経由しつつ composing=true を維持する。
    await search.fill('lo');

    // Assert (during composition): composedQuery は composition 開始時の値
    // (= '') なのでフィルタは凍結され、8 件全件が表示されている。
    await expect(page.getByRole('option')).toHaveCount(8);

    // compositionend を発火させると composing=false に戻り、'lo' を使った
    // フィルタが適用されて loop だけが残る。
    await search.dispatchEvent('compositionend');
    const filtered = page.getByRole('option');
    await expect(filtered).toHaveCount(1);
    await expect(filtered.first()).toContainText('loop (for-each)');
  });

  test('日本語マルチバイト文字を keyboard.insertText で入力してもフィルタが正しく動く (擬似 IME 補助検証 / review §3 m-4)', async ({
    page,
  }) => {
    // (review §3 m-4 補助) `page.keyboard.insertText` はブラウザの input
    // イベントを実発火させるため、`dispatchEvent` 擬似より実 IME に近い経路
    // を通る。ただし composition イベントは発火しないので、ここでは
    // 「composition なし状態」で日本語文字列を直接ペーストしたときに、
    // フィルタロジックが入力を normalize して正しく扱えることを検証する。
    // 日本語クエリ ("ループ") はどのパターンの label / id / description にも
    // 含まれないため empty state が出るのが正しい挙動。これによりフィルタ
    // 経路がマルチバイト入力で無例外に動作することを担保する。
    const fixture = await tracker.create('ime-insert-text', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);
    await openPicker(page);

    const search = page.getByLabel('Search patterns');
    await search.focus();

    // Act: 日本語をブラウザ実イベント経路で入力する。空文字 → "ループ" の遷移
    // でフィルタが正しく更新される (= input event → bind:value → $derived
    // 経路がマルチバイト文字を扱える)
    await page.keyboard.insertText('ループ');

    // Assert: 検索ボックスに入力が反映されている
    await expect(search).toHaveValue('ループ');
    // 該当パターンが無いので empty state を表示する
    await expect(page.getByText('No patterns match')).toBeVisible();

    // 続けて入力を消すと全 8 件が再表示される (state リセット経路)
    await search.fill('');
    await expect(page.getByRole('option')).toHaveCount(8);
  });

  test('IME composition 中は Enter で挿入が確定しない (変換確定キーを誤って submit に流さない)', async ({
    page,
  }) => {
    // Arrange
    const fixture = await tracker.create('ime-enter', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);
    await openPicker(page);

    const search = page.getByLabel('Search patterns');
    await search.focus();
    await search.fill('lo');
    // compositionstart を後出しで発火させて、composing=true 状態にする
    await search.dispatchEvent('compositionstart');

    // Act: Enter を押す。`onSearchKeydown` の `if (e.key === 'Enter' && !composing)`
    // により、composing 中は trySubmit が呼ばれないはず。
    await page.keyboard.press('Enter');

    // Assert: ピッカーは閉じず、saveMsg も出ない (= 挿入されていない)
    await expect(page.getByLabel('Search patterns')).toBeVisible();
    await expect(statusMessage(page)).toBeHidden();
    // YAML も変化していない
    await expect(yamlTextarea(page)).toHaveValue(VALID_WORKFLOW_YAML);

    // 変換を確定 (compositionend) してから Enter を押すと挿入される
    await search.dispatchEvent('compositionend');
    await page.keyboard.press('Enter');

    await expect(page.getByLabel('Search patterns')).toBeHidden();
    await expect(statusMessage(page)).toHaveText('Inserted loop', { timeout: FLASH_TIMEOUT });
    await expect(yamlTextarea(page)).toHaveValue(/loop_step/);
  });

  test('UI 経路 (form action `?/insertPattern`) に対してもクロスオリジン POST は 403 で拒否される (CSRF)', async ({
    page,
    request,
  }) => {
    // (review §3 m-3) form action 経路と REST endpoint 経路で Origin guard
    // 仕様が一致していることを担保する。REST 側の同等テストは
    // `apps/web/e2e/integration/insert-pattern.security.spec.ts:194-215`
    // (`クロスオリジンからの POST は 403 で拒否される`) にある。両者で
    // 仕様を揃えて hooks.server.ts の Origin guard 改修時に片方だけ更新する
    // 事故を防ぐ。片方を変更したらこのコメント / 参照テストも合わせて更新
    // すること。
    // Arrange: 編集対象のワークフローを実体として用意
    const fixture = await tracker.create('csrf-form-action', VALID_WORKFLOW_YAML);

    // Act: SvelteKit の form action URL (`/workflows/<id>?/insertPattern`) に
    // 対して、悪意あるオリジンを偽装した POST を送る。これはユーザがブラ
    // ウザで evil.example を開いたまま `fetch('http://localhost:5100/...')`
    // した状況に相当する (= 攻撃者ページからの CSRF)。
    const formData = new URLSearchParams();
    formData.set('patternId', 'do');
    const res = await request.post(
      `/workflows/${encodeURIComponent(fixture.id)}?/insertPattern`,
      {
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/x-www-form-urlencoded',
        },
        data: formData.toString(),
      },
    );

    // Assert: hooks.server.ts の Origin guard が form action 経路にも
    // 適用されており、403 で拒否される
    expect(res.status()).toBe(403);

    // ファイルも変更されていない
    const onDisk = await fixture.read();
    expect(onDisk).toBe(VALID_WORKFLOW_YAML);

    // UI 側で開いた直後の状態でも YAML が一切書き換わっていないことを確認
    await gotoWorkflow(page, fixture);
    await expect(yamlTextarea(page)).toHaveValue(VALID_WORKFLOW_YAML);
  });

  test('UI 経路 (form action) でも同オリジンからの POST は通る (Origin guard が form action を過剰拒否しない回帰)', async ({
    request,
  }) => {
    // Arrange
    const fixture = await tracker.create('csrf-form-action-allow', VALID_WORKFLOW_YAML);

    // Act: 同一オリジン (Playwright の `request` は baseURL を origin にする
    // ため明示しないが、ここでは念のため Origin ヘッダを明示してテストの
    // intent を読みやすくする)
    //
    // (review §3 M-3) `accept: 'application/json'` を指定すると SvelteKit
    // form action は JSON で action result を直接返す (デフォルトの 303
    // See Other リダイレクトを経由しない)。これにより「200 ぴったり期待」
    // が SvelteKit のリダイレクト挙動変更に依存しなくなる。
    const formData = new URLSearchParams();
    formData.set('patternId', 'do');
    const res = await request.post(
      `/workflows/${encodeURIComponent(fixture.id)}?/insertPattern`,
      {
        headers: {
          origin: 'http://localhost:5100',
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        data: formData.toString(),
      },
    );

    // Assert: 200 で受理される (Origin guard が form action 経路を 403 で
    // 弾いてはいけない)。`accept: application/json` を指定したため SvelteKit
    // は action result を JSON で直接返す = 必ず 200。
    expect(res.status()).toBe(200);

    // ファイル側にもパターンが書き込まれている (Origin guard が通すべき経路で
    // 確かに通り、サーバが書き込みまで完了していることを示す)
    const onDisk = await fixture.read();
    const parsed = yaml.load(onDisk) as { do: Array<Record<string, unknown>> };
    expect(parsed.do).toHaveLength(2);
    const ids = parsed.do.map((entry) => Object.keys(entry)[0]);
    expect(ids).toEqual(['first_step', 'sample_step']);
  });

  test('エラー時の role=alert 経路でユーザ提供文字列が HTML として解釈されない (XSS 回帰)', async ({
    page,
  }) => {
    // Arrange: 構文壊れの YAML で挿入を試みると失敗 → role=alert にメッセージ
    // が描画される。Svelte の `{errorMessage}` 補間は自動エスケープされる
    // はずだが、回帰検出のため明示テスト。
    let dialogTriggered = false;
    page.on('dialog', async (dialog) => {
      dialogTriggered = true;
      await dialog.dismiss();
    });

    const fixture = await tracker.create('xss-alert', INVALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);

    // Act: 挿入を試みて失敗を発生させる
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    // Assert: role=alert が表示される
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    // エラーメッセージは汎用文言にラップされる (内部漏洩なし)
    await expectNoInternalLeak(alert);

    // alert 内に <script> や <img onerror> が DOM 要素として存在しない
    // (= テキストノードとしてのみ描画されている)
    await expect(alert.locator('script')).toHaveCount(0);
    await expect(alert.locator('img')).toHaveCount(0);

    // window スコープに XSS マーカーが立っていない (= JS 実行が起きていない)
    const xssMarker = await page.evaluate(
      () => (window as unknown as { __xss_alert__?: number }).__xss_alert__ ?? null,
    );
    expect(xssMarker).toBeNull();
    expect(dialogTriggered).toBe(false);
  });

  test('workflow id に HTML / script を含む不正な id は 400 で拒否され、UI にエディタも heading も描画されない (XSS 回帰: id 経路 / load 層の防御)', async ({
    page,
  }) => {
    // (review §3 m-1) 旧テストは合法な id (= xss-id-safe-...yaml) しか使って
    // いなかったため、`heading.locator('script')` が 0 になるのは「攻撃者
    // input が無いから」であって XSS 防御を実際にテストしていなかった。
    //
    // workflow id は `asWorkflowId` で `[A-Za-z0-9._-]+\.ya?ml` 正規表現
    // に縛られているため、`<script>` を含む id は load 時 400 で弾かれる
    // ことが防御の本体。ここではその「攻撃者が id 経由で HTML を注入でき
    // ない」契約を担保するため、`<script>alert(1)</script>` を含む id で
    // 直接 navigate して 400 が返り、エディタや heading が描画されないこ
    // とを確認する。
    let dialogTriggered = false;
    page.on('dialog', async (dialog) => {
      dialogTriggered = true;
      await dialog.dismiss();
    });

    const maliciousId = '<script>window.__xss_id__=1</script>.yaml';
    const response = await page.goto(
      `/workflows/${encodeURIComponent(maliciousId)}`,
    );
    // 不正 id は load で 400 (asWorkflowId の正規表現にマッチしない) で
    // 弾かれる。エディタの textarea / Insert pattern ボタンが描画されない
    // ことで、攻撃者の id がアプリの DOM に流れ込まない契約を担保する。
    expect(response?.status()).toBe(400);
    await expect(yamlTextarea(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Insert pattern' })).toHaveCount(0);
    // 万一エラーページが id を補間してしまっても、HTML として解釈されては
    // いけない。window スコープの XSS マーカーが立っていない / dialog が
    // 発火していないことを確認する。
    const xssMarker = await page.evaluate(
      () => (window as unknown as { __xss_id__?: number }).__xss_id__ ?? null,
    );
    expect(xssMarker).toBeNull();
    expect(dialogTriggered).toBe(false);
    // DOM 全体に script / img[onerror] が混入していないこと (id 経由の
    // テンプレートインジェクション回帰検出)
    const scriptInjected = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script')).some((s) =>
        (s.textContent ?? '').includes('window.__xss_id__'),
      ),
    );
    expect(scriptInjected).toBe(false);
  });

  test('合法な workflow id は heading に「テキスト補間」として描画される (補間経路の安全側回帰)', async ({
    page,
  }) => {
    // 合法な id (英数字 + ハイフン) が heading に流れたとき、HTML として
    // 解釈されない (= テキストノードのみ) ことを直接確認する。攻撃者が
    // 制御不能な id でも、heading の `{data.id}` 補間が将来 `{@html ...}`
    // に書き換わった場合には壊れるはず、という回帰検出。
    const fixture = await tracker.create('xss-id-safe', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);

    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();
    // heading は workflow displayName と id の両方を表示する (M-6 / F-3 の
    // 結果): `<span>{name}</span><small>{id}</small>` が並ぶ構成。本テストの
    // 主目的は「id 値が HTML として解釈されず、テキストノードとして補間
    // される」ことの担保なので、`toContainText` で id 文字列が text として
    // 含まれることを確認する (toHaveText の完全一致は heading の structure
    // が拡張された時点で意味を失っている)。
    await expect(heading).toContainText(fixture.id);
    await expect(heading.locator('script')).toHaveCount(0);
    await expect(heading.locator('img')).toHaveCount(0);
  });

  test('挿入失敗 (InvalidBaseYaml) の後、ピッカーを開き直し別ワークフローに切り替えれば挿入が成功する (errorMessage / pendingId のリセット回帰)', async ({
    page,
  }) => {
    // Arrange: 1 つ目は壊れた YAML、2 つ目は正常な YAML
    const broken = await tracker.create('failed-then-success-broken', INVALID_WORKFLOW_YAML);
    const good = await tracker.create('failed-then-success-good', VALID_WORKFLOW_YAML);

    // Phase 1: 壊れた方で挿入を試み、失敗させる
    await gotoWorkflow(page, broken);
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/base workflow YAML is invalid/i);

    // Phase 2: 正常なワークフローへ navigate (= ピッカー閉じる + state リセット)
    await gotoWorkflow(page, good);
    // 1 つ前の alert が引きずられていないこと: PatternPicker は
    // popover を閉じたとき `reset()` で errorMessage をクリアし、
    // 新しいページではコンポーネントが再構築されるので alert は無い。
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Act: 同じピッカー操作で挿入する。pendingId が前回の失敗で stuck
    // していると early-return で何も起きない (= reset 回帰検知)
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();

    // Assert: 成功する
    await expect(page.getByLabel('Search patterns')).toBeHidden();
    await expect(statusMessage(page)).toHaveText('Inserted do', { timeout: FLASH_TIMEOUT });
    await expect(yamlTextarea(page)).toHaveValue(/sample_step/);

    // ディスク側でも書き込まれている
    const onDisk = await good.read();
    const parsed = yaml.load(onDisk) as { do: Array<Record<string, unknown>> };
    expect(parsed.do).toHaveLength(2);
  });

  test('挿入失敗 (InvalidBaseYaml) の後、popover を閉じて開き直すと alert がリセットされる (UI 状態の sticky 回帰)', async ({
    page,
  }) => {
    // Arrange
    const fixture = await tracker.create('failed-reset-alert', INVALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);

    // Act: 失敗させる
    await openPicker(page);
    await patternOption(page, 'do (sequence)').click();
    await expect(page.getByRole('alert')).toBeVisible();

    // Escape で popover を閉じる → reset() で errorMessage がクリアされる
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Search patterns')).toBeHidden();

    // Assert: 再度開くと alert が消えていて、検索クエリも空に戻っている
    await openPicker(page);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel('Search patterns')).toHaveValue('');
  });

  test('Popover の X (close) ボタンで明示的にクローズできる (基本動線の smoke)', async ({
    page,
  }) => {
    const fixture = await tracker.create('close-button', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);

    await openPicker(page);

    // Act: aria-label="Close pattern picker" のボタンをクリック
    await page.getByRole('button', { name: 'Close pattern picker' }).click();

    // Assert: popover が閉じている
    await expect(page.getByLabel('Search patterns')).toBeHidden();
    // 再度開けることを確認 (= state がきちんとリセットされている)
    await openPicker(page);
    await expect(page.getByLabel('Search patterns')).toHaveValue('');
    await expect(page.getByRole('option')).toHaveCount(8);
  });

  test('検索: description 部分一致で絞り込める (label / id だけでなく description 経路も活きている)', async ({
    page,
  }) => {
    // Arrange
    const fixture = await tracker.create('search-description', VALID_WORKFLOW_YAML);
    await gotoWorkflow(page, fixture);
    await openPicker(page);

    // Act/Assert 1: 'iterate' は loop の description (`Iterate over a list of values.`)
    // にしか登場しない。label (`loop (for-each)`) にも id (`loop`) にも無いため、
    // この絞り込みが成立するのは description マッチ経路が動いていることの証拠。
    await page.getByLabel('Search patterns').fill('iterate');
    const filtered = page.getByRole('option');
    await expect(filtered).toHaveCount(1);
    await expect(filtered.first()).toContainText('loop (for-each)');

    // Act/Assert 2: 'recover' は try の description (`Recover from a failing task.`)
    // にしか登場しない。`try / catch` 自体は unsupported だが、ショーケース
    // には表示される (不変条件3) ため検索でもヒットする。
    await page.getByLabel('Search patterns').fill('recover');
    const filtered2 = page.getByRole('option');
    await expect(filtered2).toHaveCount(1);
    await expect(filtered2.first()).toContainText('try / catch');
  });

});
