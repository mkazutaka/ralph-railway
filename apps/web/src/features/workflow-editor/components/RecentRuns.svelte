<!--
  Recent runs sidebar panel.

  Implements the "List Recent Runs" scenario (apps/web/docs/scenarios/
  workflow-editor/list-recent-runs.md). Renders the list section visible at
  the bottom of the Left Sidebar in `apps/web/design/app.pen`
  (`k3LmuC` "recentTitle" + `jOimC`/`rOtfa`/`wgdx6`/`NIBmy` rows): a small
  uppercase heading, then one row per run with a status dot, the run id, and
  a `<relative-start> · <duration>` caption.

  Mount location (review note M1): the canonical home for this panel is the
  Left Sidebar (`iHBGe`, width 260, vertical layout) in the design. That
  sidebar has not been built yet — the corresponding scenario lands in a
  separate task — so this component is currently mounted underneath the
  YAML textarea on the workflow editor page. To prevent the panel from
  pushing the textarea off-screen on tall run lists, the section caps its
  height with `max-h-[40vh] overflow-y-auto` until it lives inside a real
  sidebar with its own scroll container. When the Left Sidebar lands, drop
  the local `max-h` and let the sidebar own the scroll region.

  Data flow: this component owns its own fetch against
  `GET /api/workflows/:id/runs` so the panel can refresh independently of
  the editor's load function (re-fetching the workflow YAML every time a
  run completes would re-mount the canvas). The page-level
  `+page.server.ts` load function intentionally does NOT include `runs`
  in its return value (see the JSDoc on that file's `load`); review note m1
  flagged the regulation deviation and we keep it in one place. Failures
  are surfaced inline — a network blip while the user is editing should
  not throw the page into an error boundary.

  Out of scope (intentionally): pagination, filtering, "view details"
  navigation. The scenario only specifies the list itself; we ship exactly
  that.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { RunSummaryDto } from '../entities/dto';
  import { recentRunsCopy as copy } from './recentRunsCopy';
  import {
    formatDuration,
    formatRelativeTime,
    statusDotVar,
  } from './recentRunsFormat';

  let {
    workflowId,
    selectedRunId = null,
    onSelect,
    /**
     * Override hook for tests (Vitest / MSW). Default resolves
     * `globalThis.fetch` at *call* time rather than at component
     * construction (review note m4): a wrapping arrow function lets a test
     * harness swap `globalThis.fetch` after the component has mounted and
     * still be observed. `.bind(globalThis)` would have captured the
     * original `fetch` at construction and made later swaps invisible.
     */
    fetcher = (input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init),
  }: {
    workflowId: string;
    /**
     * Run id currently rendered in the run-detail panel. The matching
     * row gets a highlighted background so the user can locate the
     * "currently inspected" run at a glance. `null` means no run is
     * selected — the read-run-detail scenario handles this branch via
     * its own empty state.
     */
    selectedRunId?: string | null;
    /**
     * Invoked when the user clicks (or activates via keyboard) a run
     * row. The page wires this to a state setter that drives the
     * run-detail panel; without `onSelect` the panel falls back to a
     * non-interactive list (older callers / tests that haven't been
     * updated still render correctly).
     */
    onSelect?: (runId: string) => void;
    fetcher?: typeof fetch;
  } = $props();

  type LoadState =
    | { kind: 'loading' }
    | { kind: 'ready'; runs: ReadonlyArray<RunSummaryDto> }
    | { kind: 'error'; message: string };

  let loadState: LoadState = $state({ kind: 'loading' });

  // `now` ticks once per minute so the relative-time column ("2m", "3h")
  // stays accurate for the duration the panel is open. Once-per-minute is
  // enough granularity for the rendered units (the smallest unit displayed
  // is "Ns", which we already round down — sub-minute drift is invisible).
  //
  // Review note m3: `Date.now()` here runs on the server during SSR. Today
  // the runs themselves are client-fetched, so the SSR-vs-client clock
  // difference never reaches the rendered output. If we ever ship initial
  // runs through `+page.server.ts`, add `$effect(() => { now = Date.now(); })`
  // so the first client paint resets the clock and the relative-time
  // column does not flicker between server time and browser time.
  let now = $state(Date.now());

  // Combine cleanup callbacks into a single `onDestroy` (review note n2)
  // so the teardown contract reads as one block instead of two
  // independently-registered LIFO callbacks.
  let controller: AbortController | null = null;
  const tick = setInterval(() => {
    now = Date.now();
  }, 60_000);
  onDestroy(() => {
    clearInterval(tick);
    controller?.abort();
  });

  $effect(() => {
    // Capture the active workflow id so the response handler can verify it
    // is still the one the user is looking at before committing the result.
    const id = workflowId;
    controller?.abort();
    const ac = new AbortController();
    controller = ac;
    loadState = { kind: 'loading' };

    void (async () => {
      try {
        const res = await fetcher(
          `/api/workflows/${encodeURIComponent(id)}/runs`,
          { signal: ac.signal },
        );
        if (ac.signal.aborted) return;
        if (!res.ok) {
          loadState = {
            kind: 'error',
            message: res.status === 404 ? 'workflow not found' : copy.errorState,
          };
          return;
        }
        const body = (await res.json()) as RunSummaryDto[];
        if (ac.signal.aborted) return;
        loadState = { kind: 'ready', runs: body };
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (ac.signal.aborted) return;
        loadState = { kind: 'error', message: copy.errorState };
      }
    })();
  });

  /**
   * Build the accessible label announced for each run row. Review note m6:
   * status used to be conveyed only through the dot colour + a `title`
   * tooltip, which fails WCAG 1.4.1 (info-by-colour-only) and is hard to
   * navigate by screen-reader. Embedding status + relative time + duration
   * in `aria-label` gives assistive tech the same caption sighted users
   * read, without changing the visual layout.
   */
  function rowAriaLabel(run: RunSummaryDto, currentNow: number): string {
    const relative = formatRelativeTime(run.startedAt, currentNow);
    const duration = formatDuration(run.durationMs);
    const tail = duration === null ? copy.runningLabel : `took ${duration}`;
    return `${run.id}, ${run.status}, started ${relative} ago, ${tail}`;
  }
</script>

<!--
  Section container. Caps its own height (`max-h-[40vh]`) and scrolls
  vertically until the proper Left Sidebar lands; review note M1+m5.
  `border-t` mirrors the design's `k3LmuC` row which carries the top
  separator stroke.
-->
<!--
  `<section aria-labelledby>` resolves to an accessible region with the
  heading text as its name, so E2E tests can reach the panel via
  `getByRole('region', { name: 'RECENT RUNS' })` without `.or()` /
  `.first()` chains (review note: avoid CSS-selector fallbacks for the
  panel locator). Svelte's a11y lint rejects an explicit `role="region"`
  here as redundant — the section + accessible name combination is
  enough on every browser/AT pair Playwright supports.
-->
<section
  class="flex max-h-[40vh] min-h-0 flex-col overflow-y-auto border-t border-(--color-border-default) bg-(--color-bg-surface) text-(--color-text-primary)"
  aria-labelledby="recent-runs-heading"
>
  <!--
    Heading mirrors `k3LmuC` "recentTitle":
      - 10px uppercase, tertiary tint, +0.8 letterSpacing
      - design padding tokens [10, 12, 6, 14] → top/right/bottom/left
        (review note n1: previous symmetric `px-3.5` lost the design's
        2px asymmetry between left and right).
    Use `<h2>` (not a div) so the sidebar establishes a heading hierarchy
    under the page's `<h1>` and screen-reader rotor users can jump to the
    list directly.
  -->
  <h2
    id="recent-runs-heading"
    class="pt-2.5 pr-3 pb-1.5 pl-3.5 text-[10px] font-bold tracking-[0.08em] text-(--color-text-tertiary)"
  >
    {copy.sectionTitle}
  </h2>

  {#if loadState.kind === 'loading'}
    <p
      class="px-3.5 py-2 text-xs text-(--color-text-tertiary)"
      role="status"
      aria-live="polite"
    >
      {copy.loadingState}
    </p>
  {:else if loadState.kind === 'error'}
    <!--
      Inline alert matches the editor's failure surfaces (PatternPicker uses
      the same role+tone): the user can retry by reloading the page or
      switching workflows, so we don't render a retry button here for the
      MVP scope.
    -->
    <p class="px-3.5 py-2 text-xs text-(--color-danger)" role="alert">
      {loadState.message}
    </p>
  {:else if loadState.runs.length === 0}
    <p class="px-3.5 py-2 text-xs text-(--color-text-tertiary)">
      {copy.emptyState}
    </p>
  {:else}
    <ul aria-label={copy.listAria} class="flex flex-col">
      {#each loadState.runs as run (run.id)}
        {@const duration = formatDuration(run.durationMs)}
        {@const isSelected = run.id === selectedRunId}
        <li
          aria-label={rowAriaLabel(run, now)}
          aria-current={isSelected ? 'true' : undefined}
          class="text-xs text-(--color-text-secondary)"
        >
          <!--
            When `onSelect` is wired (read-run-detail scenario integration),
            each row becomes a `<button>` so it carries keyboard focus,
            announces as an interactive control to screen readers, and
            participates in the `Tab` order of the surrounding region.
            When `onSelect` is omitted (older embeds / tests) the row
            renders as a plain flex container — the original list-recent-runs
            E2E suite asserts `getByRole('listitem')` either way because the
            `<li>` wrapper above is the role-bearing element.
          -->
          {#if onSelect}
            <button
              type="button"
              onclick={() => onSelect(run.id)}
              class="flex h-[26px] w-full items-center gap-2 pr-3 pl-3.5 text-left transition-colors hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover) focus-visible:outline-none aria-[current=true]:bg-(--color-accent-muted)"
              aria-current={isSelected ? 'true' : undefined}
            >
              <span
                class="inline-block size-1.5 shrink-0 rounded-full"
                style="background-color: var({statusDotVar(run.status)})"
                data-testid="run-status-dot"
                aria-hidden="true"
              ></span>
              <span class="min-w-0 flex-1 truncate font-mono text-[12px]">
                {run.id}
              </span>
              <span
                class="shrink-0 text-[10px] text-(--color-text-tertiary)"
                title={`status: ${run.status}`}
              >
                {formatRelativeTime(run.startedAt, now)}
                {' · '}
                {duration ?? copy.runningLabel}
              </span>
            </button>
          {:else}
            <div
              class="flex h-[26px] items-center gap-2 pr-3 pl-3.5"
            >
              <!--
                Status dot. `data-testid="run-status-dot"` is added so E2E
                tests can assert the decorative element renders (it conveys
                status via colour only and is hidden from a11y trees by
                `aria-hidden=true`, so role/name based locators cannot
                reach it). Tests should rely on the row's `aria-label` for
                the actual status conveyance.
              -->
              <span
                class="inline-block size-1.5 shrink-0 rounded-full"
                style="background-color: var({statusDotVar(run.status)})"
                data-testid="run-status-dot"
                aria-hidden="true"
              ></span>
              <!--
                Run id can be long (timestamps, uuids); truncate so the
                right-hand duration column stays readable on the 260px
                sidebar.
              -->
              <span class="min-w-0 flex-1 truncate font-mono text-[12px]">
                {run.id}
              </span>
              <!--
                Caption (`<relative-start> · <duration>`) mirrors design rows
                `gJDxX`/`pLl4W`/... — 10px tertiary tint. The `title`
                attribute keeps the existing tooltip contract that the e2e
                suite asserts on, but the row's accessible name (`aria-label`
                above) is what actually exposes status to assistive tech
                (review note m6).
              -->
              <span
                class="shrink-0 text-[10px] text-(--color-text-tertiary)"
                title={`status: ${run.status}`}
              >
                {formatRelativeTime(run.startedAt, now)}
                {' · '}
                {duration ?? copy.runningLabel}
              </span>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
