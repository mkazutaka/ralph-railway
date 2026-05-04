<!--
  Compact RECENT RUNS footer for the Left Sidebar.

  Mirrors the design's `iHBGe` footer block (rows `jOimC`, `rOtfa`,
  `wgdx6`, `NIBmy` + the `k3LmuC` heading). This is intentionally a
  *separate* component from the editor's `RecentRuns.svelte`:

    1. The editor panel is interactive — it drives the run-detail panel
       on the right via `selectedRunId` / `onSelect`. The sidebar
       footer is read-only navigation context, not a selection
       surface, so it should not co-own that state.
    2. The editor panel is full-width with run ids in mono and a tall
       38vh scroll cap. The sidebar variant is 260px wide with the
       design's `<workflow-name> · <duration> · <stepCount>` caption
       and a strict 4-row cap.
    3. Mounting `RecentRuns.svelte` directly here would double-fetch
       `/api/workflows/:id/runs` (once for the sidebar, once for the
       editor) and produce duplicate run-row landmarks on the page.

  Data flow: when an active workflow id is provided we fetch
  `/api/workflows/:id/runs?limit=4` ourselves; when there is no active
  workflow (e.g. on `/` or `/workflows/new`) we render the empty state
  so the design's footer block stays visible without inventing fake
  runs.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { RunSummaryDto } from '$features/workflow-editor/entities/dto';
  import {
    formatDuration,
    formatRelativeTime,
    statusDotVar,
  } from '$features/workflow-editor/components/recentRunsFormat';
  import { leftSidebarCopy as copy } from './leftSidebarCopy';

  let {
    workflowId = null,
    /**
     * Test seam mirroring `RecentRuns.svelte`'s `fetcher` prop. The
     * default resolves `globalThis.fetch` at call time so test
     * harnesses can swap the global after mount.
     */
    fetcher = (input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init),
  }: {
    workflowId?: string | null;
    fetcher?: typeof fetch;
  } = $props();

  type LoadState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; runs: ReadonlyArray<RunSummaryDto> }
    | { kind: 'error'; message: string };

  let loadState: LoadState = $state({ kind: 'idle' });

  // `now` ticks every minute so the "2m ago" caption stays fresh while
  // the sidebar is mounted. Mirrors `RecentRuns.svelte`'s strategy.
  let now = $state(Date.now());
  const tick = setInterval(() => {
    now = Date.now();
  }, 60_000);
  onDestroy(() => clearInterval(tick));

  // Fetch lifecycle is owned entirely by `$effect`'s cleanup function
  // (review-design-frontend.md s-1). Keeping a top-level
  // `controller` reference + a separate `onDestroy(() => controller?.abort())`
  // duplicated the abort path: once when the effect re-ran (workflow id
  // changed) and again on unmount, which made it harder to reason about
  // the exact moment the in-flight request was severed. Returning the
  // abort from the effect cleanup gives Svelte 5 a single source of
  // truth — the runtime invokes the cleanup both when dependencies
  // change and when the component unmounts.
  $effect(() => {
    const id = workflowId;
    if (id == null) {
      loadState = { kind: 'idle' };
      return;
    }
    const ac = new AbortController();
    loadState = { kind: 'loading' };
    void (async () => {
      try {
        const res = await fetcher(
          `/api/workflows/${encodeURIComponent(id)}/runs?limit=4`,
          { signal: ac.signal },
        );
        if (ac.signal.aborted) return;
        if (!res.ok) {
          loadState = { kind: 'error', message: copy.recentRunsError };
          return;
        }
        const body = (await res.json()) as RunSummaryDto[];
        if (ac.signal.aborted) return;
        loadState = { kind: 'ready', runs: body.slice(0, 4) };
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (ac.signal.aborted) return;
        loadState = { kind: 'error', message: copy.recentRunsError };
      }
    })();
    return () => ac.abort();
  });

  /**
   * Display name for the row. Falls back to the run id (timestamp)
   * when the run summary does not carry a workflow display name —
   * the API today returns `workflowId` (filename) which already reads
   * as a short label, so we trim the trailing extension to mirror the
   * design rows ("nextjs-todo", not "nextjs-todo.yaml").
   */
  function displayName(run: RunSummaryDto): string {
    return run.workflowId.replace(/\.(ya?ml)$/i, '');
  }
</script>

<!--
  Footer container. Mirrors `k3LmuC` (10px uppercase title separated by a
  1px top border) plus the run rows. NB: this is intentionally a plain
  `<div>` (not a `<section aria-labelledby>` `region` landmark). The
  editor route's `RecentRuns.svelte` already exposes a region named
  "RECENT RUNS" and the existing E2E suite locates it via
  `getByRole('region', { name: 'RECENT RUNS' })` (see
  `apps/web/e2e/list-recent-runs.spec.ts`, `read-run-detail.spec.ts`,
  `stop-run.spec.ts`, `run-workflow.spec.ts`). Promoting this footer to
  another region with the same name would produce strict-locator
  collisions on every test that opens a workflow page. The footer's
  visible heading still reads correctly, and screen readers can still
  reach the rows via the `<ul aria-label>` below.
-->
<div class="flex shrink-0 flex-col border-t border-(--color-border-default)">
  <!--
    The design (`k3LmuC recentTitle`) renders this label as an explicit
    section heading. We deliberately avoid promoting it to a heading
    role here, however: on workflow pages the editor's `RecentRuns.svelte`
    already exposes a real `<h2 id="recent-runs-heading">RECENT RUNS</h2>`
    inside its labelled region (`apps/web/e2e/list-recent-runs.spec.ts:183`
    locates it via `getByRole('heading', { name: 'RECENT RUNS' })`), and
    duplicating the same heading name in the sidebar footer would create
    a strict-locator collision. Screen-reader users still reach this
    section through:
      - the editor's `<h2>` on every workflow page (covers the primary
        `/workflows/[id]` flow where the panel is most relevant), and
      - the sidebar's surrounding `<aside aria-label="Workflows">`
        landmark, which contains this footer block.
    The visible label keeps the design's typography (uppercase, bolder
    weight, tracked) so sighted users still see a clear section header.
  -->
  <p
    class="pt-2.5 pr-3 pb-1.5 pl-3.5 text-[10px] font-bold tracking-[0.08em] text-(--color-text-tertiary)"
  >
    {copy.recentRunsTitle}
  </p>

  {#if workflowId == null}
    <p class="px-3.5 pb-2 text-[11px] text-(--color-text-tertiary)">
      {copy.recentRunsNoActiveWorkflow}
    </p>
  {:else if loadState.kind === 'loading'}
    <p
      class="px-3.5 pb-2 text-[11px] text-(--color-text-tertiary)"
      role="status"
      aria-live="polite"
    >
      {copy.recentRunsLoading}
    </p>
  {:else if loadState.kind === 'error'}
    <!--
      Sidebar runs poll on a 15s tick and the panel is supplementary
      footer chrome, not an action surface. We announce errors as
      `role="status" aria-live="polite"` so screen readers report
      them once when the failure first appears, instead of barking
      `assertive` alerts every poll cycle (review note m-7). Users
      who need to retry can hit the sidebar Refresh button — a
      `role="alert"` here would be hostile spam.
    -->
    <p
      class="px-3.5 pb-2 text-[11px] text-(--color-danger)"
      role="status"
      aria-live="polite"
    >
      {loadState.message}
    </p>
  {:else if loadState.kind === 'ready' && loadState.runs.length === 0}
    <p class="px-3.5 pb-2 text-[11px] text-(--color-text-tertiary)">
      {copy.recentRunsEmpty}
    </p>
  {:else if loadState.kind === 'ready'}
    <ul aria-label={copy.recentRunsListAria} class="flex flex-col pb-2">
      {#each loadState.runs as run (run.id)}
        {@const duration = formatDuration(run.durationMs)}
        <li class="text-xs text-(--color-text-secondary)">
          <!--
            Row mirrors the design rows `jOimC` etc.: status dot · name ·
            "<time> · <duration>" caption. The whole row is non-interactive
            here — the editor's main RecentRuns panel owns selection.
          -->
          <div
            class="flex h-[26px] items-center gap-2 pr-3 pl-3.5"
            title={`status: ${run.status}`}
          >
            <span
              class="inline-block size-1.5 shrink-0 rounded-full"
              style="background-color: var({statusDotVar(run.status)})"
              data-testid="sidebar-run-status-dot"
              aria-hidden="true"
            ></span>
            <span class="min-w-0 flex-1 truncate text-[12px]">
              {displayName(run)}
            </span>
            <span class="shrink-0 text-[10px] text-(--color-text-tertiary)">
              {formatRelativeTime(run.startedAt, now)}
              {' · '}
              {duration ?? copy.recentRunsRunningLabel}
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
