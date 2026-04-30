import { expect, type Page, type Locator } from '@playwright/test';

/**
 * Open the pattern picker popover.
 *
 * Why retry the click? The picker is a Svelte component whose `onclick`
 * handler is only attached after SvelteKit's hydration completes. Playwright's
 * locator auto-wait only checks Actionability (visibility, enabled, stable
 * box) — it does *not* know whether Svelte has wired the listener yet. If we
 * click during the SSR-only window, the popover stays closed.
 *
 * We avoid the legacy `page.waitForLoadState('networkidle')` strategy
 * (Playwright officially advises against it: false-positives with hydration
 * + preload). Instead we observe the user-visible side-effect — the
 * trigger flipping `aria-expanded` to `true` — and re-issue the click via
 * `expect.toPass()` until it sticks. This is honest about what the user
 * would experience (a click is harmless if the page hasn't hydrated yet)
 * while keeping the test stable in CI.
 */
export async function openPicker(page: Page) {
  const trigger = page.getByRole('button', { name: 'Insert pattern' });
  await expect(trigger).toBeEnabled();
  await expect(async () => {
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
      await trigger.click();
    }
    await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(page.getByLabel('Search patterns')).toBeVisible();
}

/** Locate the workflow YAML textarea via its semantic aria label. */
export function yamlTextarea(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Workflow YAML' });
}

/** Locate the saveMsg status region (`role=status` aria-live). */
export function statusMessage(page: Page): Locator {
  return page.getByRole('status');
}

/**
 * Click a pattern option in the picker. `name` should be the exact accessible
 * name (label) shown in the option list.
 */
export function patternOption(page: Page, name: string): Locator {
  return page.getByRole('option', { name });
}

/**
 * Information-leak guard helper. Validates that an alert / error region does
 * NOT contain any indicator of internal implementation paths, stack frames,
 * or function names. Use across every error path so a regression in one
 * branch (e.g. id-conflict) is caught even if syntax-error path was the
 * original observation site.
 *
 * Uses web-first `not.toContainText` so retries are honored — this is the
 * key contract the review cited (sync `await locator.textContent()` then
 * `expect(text).not.toContain(...)` does not retry).
 */
export async function expectNoInternalLeak(locator: Locator) {
  await expect(locator).not.toContainText(/node_modules/i);
  await expect(locator).not.toContainText(/\/apps\/web\//i);
  await expect(locator).not.toContainText(/insertPatternWorkflow/i);
  await expect(locator).not.toContainText(/\bat\s+\S+\s+\(.+:\d+:\d+\)/i);
  // `InvalidBaseYaml(reason: parse message)` のシナリオで js-yaml の生メッセー
  // ジ (例: `YAMLException: end of the stream or a document separator is
  // expected`) が UI に展開されていないことを担保する。サーバ側の reason は
  // 内部診断目的に留め、ユーザ向けには汎用文言にラップされているべき。
  await expect(locator).not.toContainText(/YAMLException/i);
  // 設計メモで明示されている内部例外名 / branded type 漏洩のガード。
  // (review §3 m-5): `TemplateMalformed` (insert-pattern.md:156-159) と
  // branded type の internal name (`InvalidBrandedValueError`) が UI に
  // そのまま吐き出される実装ミス (例: `error(500, e.message)`) を弾く。
  await expect(locator).not.toContainText(/TemplateMalformed/i);
  await expect(locator).not.toContainText(/InvalidBrandedValueError/i);
}
