<!--
  Run-detail panel.

  Implements the "Read Run Detail" scenario
  (apps/web/docs/scenarios/workflow-editor/read-run-detail.md). Renders the
  full per-node breakdown of a single Run: status, started timestamp,
  total duration, and one row per node with its status, output, error
  message, and log excerpt.

  Visual idiom is borrowed from the Right Panel (`SV10l` in
  `apps/web/design/app.pen`):
    - Section heading + colour-tinted "status row"
      (`Hv0EB/a1DWw`: dot + "Last run: 2s ago · Success")
    - Card-style nodes mirroring the workflow node tiles
      (`DN7Za`/`bsZWB`/...) with a left-edge tint and a status dot
      pinned in the upper-right corner.

  Mount location (provisional, parallels the recent-runs panel): the
  canonical home for the run-detail surface is the design's Right Panel
  (`SV10l`, width 340) which today renders the per-node settings. Until
  the right-panel scenario lands we mount the run-detail panel under
  the YAML buffer, side-by-side with `RecentRuns`. The component caps
  its own height + scrolls so a long node list cannot push the editor
  off-screen.

  Data flow: the panel owns its own fetch against
  `GET /api/workflows/:workflowId/runs/:runId` (review note: workflows
  / page-level loads do not own this state because the user can switch
  between runs many times per session and re-loading the page each
  time would clobber the YAML buffer). Failures surface inline so a
  network blip while inspecting a run does not throw the page into an
  error boundary.

  Out of scope (intentionally): full-log viewer (scenario invariant 3
  says the panel returns the *excerpt*; full-log retrieval lands via a
  separate scenario), retry / cancel actions on individual nodes
  (those are mutation paths that belong to a different workflow).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { RunDetailDto, NodeRunDetailDto } from '../entities/dto';
  import { isTerminalRunStatus } from '../entities/runSummary';
  import StopRunButton from './StopRunButton.svelte';
  import { runDetailCopy as copy } from './runDetailCopy';
  import { formatDuration } from './recentRunsFormat';
  import {
    computeNodeDurationMs,
    computeRunDurationMs,
    formatStartedAt,
    nodeStatusDotVar,
    nodeStatusLabel,
    runStatusDotVar,
    runStatusLabel,
    runStatusToneVar,
  } from './runDetailFormat';

  let {
    workflowId,
    runId,
    onClose,
    onStopAccepted,
    /**
     * Override hook for tests (Vitest / MSW). Mirrors `RecentRuns.svelte`:
     * resolves `globalThis.fetch` at *call* time so a test harness can
     * swap `globalThis.fetch` after construction and still be observed.
     */
    fetcher = (input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init),
  }: {
    workflowId: string;
    /** `null` when no run is selected. The panel renders an empty state. */
    runId: string | null;
    onClose?: () => void;
    /**
     * Notification hook fired after the runtime has accepted a stop
     * request. Implements the "Stop Run" scenario
     * (`apps/web/docs/scenarios/workflow-editor/stop-run.md`). Receives
     * the run id so the parent / page can re-fetch the recent-runs panel
     * (the eventual `cancelled` transition is observed via this same
     * panel's read-run-detail fetch — scenario invariants 2 & 3).
     */
    onStopAccepted?: (runId: string) => void;
    fetcher?: typeof fetch;
  } = $props();

  type LoadState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; detail: RunDetailDto }
    | { kind: 'notFound' }
    | { kind: 'error'; message: string };

  let loadState: LoadState = $state({ kind: 'idle' });

  // Bumped after the stop-run trigger reports a successful 202 receipt so
  // the panel's load `$effect` re-runs and the user can observe the
  // eventual `cancelled` transition (scenario invariants 2 & 3 say the
  // actual state change is owned by the read-run-detail scenario, not the
  // stop-run scenario). A monotonic counter is enough — we never compare
  // values, only trigger reactivity.
  let refreshKey = $state(0);

  // Cache of the most recently observed `ready` detail. Survives the
  // `ready → loading → ready` cycle that `refreshKey++` triggers from
  // `StopRunButton.onAccepted`, so the Stop button (and its inline success
  // caption) stay mounted while the panel re-fetches in the background.
  // Without this cache the StopRunButton would unmount the moment the
  // refresh kicks off, taking its `Stop requested` success caption with it
  // and starving the user of the receipt cue (review M-1). Only updated
  // when the SAME run id observes a fresh ready response — switching to a
  // different run resets the cache to avoid leaking the previous run's
  // detail into the new selection.
  let cachedReadyDetail: RunDetailDto | null = $state(null);

  // Keep a reference to the in-flight controller so swapping the
  // selected run aborts the previous request before kicking off a new
  // one. Without this we'd race two responses and the slower one would
  // overwrite the freshly-selected run's view.
  let controller: AbortController | null = null;
  onDestroy(() => controller?.abort());

  // Track which run id the cached detail belongs to, so a `runId` swap
  // invalidates the cache before the new run's fetch lands.
  let cachedRunId: string | null = null;

  $effect(() => {
    // Capture both ids so the response handler can verify they are
    // still current before committing the result. Workflow id changes
    // (user switches workflow) and run id changes (user picks a
    // different run) both require a re-fetch. `refreshKey` is read so
    // the effect also re-runs after a stop request is accepted.
    const wf = workflowId;
    const rid = runId;
    void refreshKey;
    controller?.abort();

    // Switching to a different run (or to the empty selection) clears the
    // cached detail — we must NOT keep showing the previous run's status
    // pill / Stop button while the new fetch is in flight. (review M-2 +
    // cross-run isolation invariant.)
    if (rid !== cachedRunId) {
      cachedReadyDetail = null;
      cachedRunId = rid;
    }

    if (rid === null) {
      loadState = { kind: 'idle' };
      return;
    }

    const ac = new AbortController();
    controller = ac;
    loadState = { kind: 'loading' };

    void (async () => {
      try {
        const res = await fetcher(
          `/api/workflows/${encodeURIComponent(wf)}/runs/${encodeURIComponent(rid)}`,
          { signal: ac.signal },
        );
        if (ac.signal.aborted) return;
        if (res.status === 404) {
          // Run is gone — drop the cached detail too so the Stop button
          // (which was rendered against the cache during the refresh
          // window) does not linger past the run's lifetime.
          cachedReadyDetail = null;
          loadState = { kind: 'notFound' };
          return;
        }
        if (!res.ok) {
          loadState = { kind: 'error', message: copy.errorState };
          return;
        }
        const body = (await res.json()) as RunDetailDto;
        if (ac.signal.aborted) return;
        // Cross-check: if the selection changed while we were waiting,
        // the freshly-selected run already kicked off its own fetch
        // and we don't want to commit the stale response to UI state.
        if (rid !== runId || wf !== workflowId) return;
        cachedReadyDetail = body;
        loadState = { kind: 'ready', detail: body };
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (ac.signal.aborted) return;
        loadState = { kind: 'error', message: copy.errorState };
      }
    })();
  });

  /**
   * Build the accessible label announced for each node row. Mirrors
   * the recent-runs row aria-label (review note m6 there): status is
   * conveyed only through colour in the visual layout, so the row
   * needs an accessible-name fallback that includes the status word
   * for screen readers.
   */
  function nodeAriaLabel(node: NodeRunDetailDto): string {
    const dur = formatDuration(
      computeNodeDurationMs(node.startedAt, node.endedAt),
    );
    const tail = dur === null ? copy.runningLabel : `took ${dur}`;
    return `Step ${node.nodeId}, ${nodeStatusLabel(node.status)}, ${tail}`;
  }
</script>

<!--
  Section container. Caps its own height (`max-h-[40vh]`) and scrolls
  vertically until the proper Right Panel lands; mirrors the recent-runs
  panel sibling. `border-t` matches the divider that sits above the
  recent-runs panel above.

  `<section aria-labelledby>` resolves to an accessible region with the
  heading text as its name, so E2E tests can target the panel via
  `getByRole('region', { name: 'RUN DETAIL' })`.
-->
<section
  class="flex max-h-[40vh] min-h-0 flex-col overflow-y-auto border-t border-(--color-border-default) bg-(--color-bg-surface) text-(--color-text-primary)"
  aria-labelledby="run-detail-heading"
>
  <!--
    Header row: section title on the left, optional close button on the
    right. The close button is rendered only when `onClose` is wired
    (the page integrates it; a stand-alone embed of this component
    might not). Padding tokens [10, 12, 6, 14] mirror the design's
    `recentTitle` (`k3LmuC`) so the two stacked panels share visual
    rhythm.
  -->
  <div
    class="flex items-center justify-between gap-2 pt-2.5 pr-3 pb-1.5 pl-3.5"
  >
    <h2
      id="run-detail-heading"
      class="text-[10px] font-bold tracking-[0.08em] text-(--color-text-tertiary)"
    >
      {copy.sectionTitle}
    </h2>
    <div class="flex items-center gap-2">
      <!--
        Stop trigger (stop-run scenario). Rendered only when the loaded
        run is in a non-terminal state; for terminal runs the button
        disappears entirely (scenario invariant 1: 既に終了状態の Run
        には停止要求を発行しない). Note that the button does NOT show
        during the initial fetch — we wait for `cachedReadyDetail` to be
        set so we know the actual status before deciding whether to
        render it. The button's own `onAccepted` hook re-fetches the
        run-detail panel so the UI observes the eventual `cancelled`
        transition (scenario invariants 2 & 3).

        Why `cachedReadyDetail` instead of `loadState.detail`? When the
        button's `onAccepted` bumps `refreshKey`, the `$effect` flips
        `loadState` back to `loading` while the refresh fetch is in
        flight. If the button were keyed on `loadState.kind === 'ready'`,
        it would unmount the moment the user clicks Stop, taking its
        inline "Stop requested" success caption with it. The cache
        survives the `ready → loading → ready` cycle so the caption
        stays observable to the user (review M-1). The cache is reset to
        `null` on `runId` swap and on 404 (review M-2 / lifecycle), so
        the previous run's Stop button never lingers past its own
        lifecycle.
      -->
      {#if cachedReadyDetail !== null && !isTerminalRunStatus(cachedReadyDetail.status)}
        <StopRunButton
          workflowId={workflowId}
          runId={cachedReadyDetail.id}
          onAccepted={(rid) => {
            // Bump the refresh counter so the load `$effect` re-runs and
            // the panel observes the eventual transition to `cancelled`.
            // The runtime accepts the stop asynchronously (scenario
            // invariants 2 & 3), so the first re-fetch may still show
            // `running`; callers who need to poll until terminal can do
            // so via their own scheduling.
            refreshKey += 1;
            onStopAccepted?.(rid);
          }}
        />
      {/if}
      {#if onClose && loadState.kind !== 'idle'}
        <!--
          `<button>` (not the shadcn-svelte primitive) so the icon-only
          close cue stays visually compact within the 24px-tall heading
          row. Decorative `×` is wrapped in `aria-hidden` and the
          accessible name comes from `aria-label`.
        -->
        <button
          type="button"
          onclick={onClose}
          class="grid size-5 place-items-center rounded text-(--color-text-tertiary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:outline-none"
          aria-label={copy.closeAria}
        >
          <span aria-hidden="true">×</span>
        </button>
      {/if}
    </div>
  </div>

  {#if loadState.kind === 'idle'}
    <p class="px-3.5 py-2 text-xs text-(--color-text-tertiary)">
      {copy.emptyState}
    </p>
  {:else if loadState.kind === 'loading'}
    <p
      class="px-3.5 py-2 text-xs text-(--color-text-tertiary)"
      role="status"
      aria-live="polite"
    >
      {copy.loadingState}
    </p>
  {:else if loadState.kind === 'notFound'}
    <p class="px-3.5 py-2 text-xs text-(--color-danger)" role="alert">
      {copy.notFoundState}
    </p>
  {:else if loadState.kind === 'error'}
    <p class="px-3.5 py-2 text-xs text-(--color-danger)" role="alert">
      {loadState.message}
    </p>
  {:else}
    {@const detail = loadState.detail}
    {@const totalMs = computeRunDurationMs(detail.startedAt, detail.endedAt)}
    {@const totalDur = formatDuration(totalMs)}
    <!--
      Summary block: run id, colour-tinted status pill, started
      timestamp, total duration. Mirrors the design's status row
      (`a1DWw`) but elevated to header status: bigger dot, capitalised
      status word.
    -->
    <header class="flex flex-col gap-2 px-3.5 pt-1 pb-3">
      <div class="flex items-center gap-2">
        <span
          class="inline-block size-2 shrink-0 rounded-full"
          style="background-color: var({runStatusDotVar(detail.status)})"
          data-testid="run-detail-status-dot"
          aria-hidden="true"
        ></span>
        <span
          class="min-w-0 flex-1 truncate font-mono text-xs text-(--color-text-primary)"
          title={detail.id}
        >
          {detail.id}
        </span>
        <span
          class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
          style="color: var({runStatusToneVar(detail.status)})"
        >
          {runStatusLabel(detail.status)}
        </span>
      </div>
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt class="text-(--color-text-tertiary)">{copy.startedLabel}</dt>
        <dd class="text-(--color-text-secondary)">
          {formatStartedAt(detail.startedAt)}
        </dd>
        <dt class="text-(--color-text-tertiary)">{copy.durationLabel}</dt>
        <dd class="text-(--color-text-secondary)">
          {totalDur ?? copy.runningLabel}
        </dd>
      </dl>
    </header>

    <!--
      Per-node list. The scenario's invariant 1 says we may receive
      Pending/Running nodes inside an in-flight Run, so the list always
      renders every node — empty / pending nodes get a muted dot but
      remain visible so the user can see how far the run has progressed.
    -->
    <h3
      class="border-t border-(--color-border-default) pt-2 pr-3 pb-1 pl-3.5 text-[10px] font-bold tracking-[0.08em] text-(--color-text-tertiary)"
    >
      {copy.nodesHeading}
    </h3>
    {#if detail.nodes.length === 0}
      <p class="px-3.5 py-2 text-xs text-(--color-text-tertiary)">
        {copy.nodesHeading}: 0
      </p>
    {:else}
      <ul aria-label={copy.nodesHeading} class="flex flex-col gap-2 px-3 pb-3">
        {#each detail.nodes as node (node.nodeId)}
          {@const nodeDur = formatDuration(
            computeNodeDurationMs(node.startedAt, node.endedAt),
          )}
          <li
            aria-label={nodeAriaLabel(node)}
            class="flex flex-col gap-1.5 rounded-md border border-(--color-border-default) bg-(--color-bg-elevated) p-2.5"
            data-testid="run-detail-node"
          >
            <div class="flex items-center gap-2">
              <!--
                Per-node status dot. `data-testid` exposes the decorative
                element so tests can assert the row carries one without
                relying on CSS class name internals.
              -->
              <span
                class="inline-block size-1.5 shrink-0 rounded-full"
                style="background-color: var({nodeStatusDotVar(node.status)})"
                data-testid="run-detail-node-dot"
                aria-hidden="true"
              ></span>
              <span
                class="min-w-0 flex-1 truncate font-mono text-xs text-(--color-text-primary)"
                title={node.nodeId}
              >
                {node.nodeId}
              </span>
              <span
                class="shrink-0 text-[10px] font-medium"
                style="color: var({nodeStatusDotVar(node.status)})"
                title={`status: ${node.status}`}
              >
                {nodeStatusLabel(node.status)}
              </span>
              <span class="shrink-0 text-[10px] text-(--color-text-tertiary)">
                {nodeDur ?? copy.runningLabel}
              </span>
            </div>

            {#if node.status === 'failed' && node.errorMessage !== null}
              <!--
                Failed node: scenario invariant 2 guarantees `errorMessage`
                is non-null. Surface it inline as the most-read piece of
                information for a failed run.
              -->
              <div class="flex flex-col gap-1">
                <span
                  class="text-[10px] font-semibold tracking-wide text-(--color-danger) uppercase"
                >
                  {copy.nodeErrorLabel}
                </span>
                <pre
                  class="overflow-x-auto rounded bg-(--color-danger-muted) p-2 font-mono text-[11px] whitespace-pre-wrap text-(--color-danger)"
                  data-testid="run-detail-node-error">{node.errorMessage}</pre>
              </div>
            {/if}

            {#if node.output !== null && node.output.length > 0}
              <div class="flex flex-col gap-1">
                <span
                  class="text-[10px] font-semibold tracking-wide text-(--color-text-tertiary) uppercase"
                >
                  {copy.nodeOutputLabel}
                </span>
                <pre
                  class="overflow-x-auto rounded bg-(--color-bg-canvas) p-2 font-mono text-[11px] whitespace-pre-wrap text-(--color-text-secondary)"
                  data-testid="run-detail-node-output">{node.output}</pre>
              </div>
            {/if}

            {#if node.logExcerpt.length > 0}
              <div class="flex flex-col gap-1">
                <span
                  class="text-[10px] font-semibold tracking-wide text-(--color-text-tertiary) uppercase"
                >
                  {copy.nodeLogLabel}
                </span>
                <pre
                  class="overflow-x-auto rounded bg-(--color-bg-canvas) p-2 font-mono text-[11px] whitespace-pre-wrap text-(--color-text-tertiary)"
                  data-testid="run-detail-node-log">{node.logExcerpt}</pre>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
