<!--
  Run Workflow trigger button.

  Implements the "Start Run" scenario
  (`apps/web/docs/scenarios/workflow-editor/run-workflow.md`). Mirrors the
  Run Button design (`B70DU6` in `apps/web/design/app.pen`):
    - 32px height, 6px corner radius
    - accent fill (`$accent`), white text
    - lucide `play` icon at 14×14
    - "Run" label, Inter 13/600
    - 14px horizontal padding, 6px gap between icon and label

  Behaviour:
    - On click → POST `/api/workflows/:id/runs`. The server enqueues the run
      asynchronously and returns a `StartedRunDto` with HTTP 202; we surface
      the new run id to the page (so the toast / recent-runs panel can react)
      and rely on the page-owned `RecentRuns` component to refresh on its
      own next tick. We deliberately don't `invalidateAll()` here: the editor's
      load function intentionally excludes runs (see `+page.server.ts` JSDoc),
      so the page-level data does not need a re-fetch.
    - Failures (404 / 422 / 503 / network) surface inline as a `role="alert"`
      caption next to the button. The button stays enabled so the user can
      retry once they've fixed the underlying problem (e.g. corrected the
      YAML for a 422). Specific status mapping lives in `lib/runApi.ts`.
    - The trigger is disabled while a request is in-flight to prevent
      double-dispatch (scenario invariant 3 says each run gets a unique id,
      but the user almost never wants two runs from the same click).

  Accessibility:
    - The play icon is decorative (`aria-hidden="true"`); the label "Run"
      provides the accessible name. `aria-busy` is set during the request so
      screen readers announce the in-flight state.
    - Success messages use `role="status" aria-live="polite"` so they don't
      interrupt mid-sentence reads (mirrors `+page.svelte`'s toast policy).
      Failure messages use `role="alert" aria-live="assertive"` because the
      user usually needs to act on them.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Play from 'lucide-svelte/icons/play';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import { startRun } from '../lib/runApi';
  import { runWorkflowCopy as copy } from './runWorkflowCopy';

  let {
    workflowId,
    onStarted,
    /**
     * Override hook for tests (Vitest / MSW). Resolves `globalThis.fetch` at
     * *call* time so a test harness can swap `globalThis.fetch` after
     * construction and still observe the call (mirrors `RecentRuns.svelte`).
     */
    fetcher,
    /** Optional className passed through for layout-level overrides. */
    class: className,
    /**
     * Compact (Top Bar) mode. When true, the inline success / error status
     * caption is positioned absolutely below the button so it cannot push
     * sibling controls and break the design's 56px Top Bar row invariant
     * (`Ht9Do` height: 56). Pages that mount the button in their own
     * toolbars (where vertical space is not constrained) leave this off
     * and get the original inline layout (review-design.md M-1).
     */
    compact = false,
  }: {
    workflowId: string;
    /**
     * Notification hook fired after the runtime has accepted a run. Receives
     * the freshly-minted run id so the page can highlight it in the recent-
     * runs panel or open the run-detail panel without prop-drilling state.
     * Called only on success (HTTP 202); failures stay inside this component.
     */
    onStarted?: (runId: string) => void;
    fetcher?: typeof fetch;
    class?: string;
    compact?: boolean;
  } = $props();

  type Status =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'success'; runId: string }
    | { kind: 'error'; message: string };

  // Annotate with the union type so later assignments (`pending` / `success`
  // / `error`) are not narrowed away by TypeScript inferring the initial
  // literal as `{ kind: 'idle' }`.
  let status = $state<Status>({ kind: 'idle' });
  let busy = $derived(status.kind === 'pending');

  // Track the in-flight controller so an unmount or rapid click sequence
  // aborts the previous request before starting a new one. Without this we
  // could race two responses and the slower one would overwrite the
  // freshly-issued status.
  let controller: AbortController | null = null;
  onDestroy(() => controller?.abort());

  async function handleClick() {
    if (busy) return;
    controller?.abort();
    const ac = new AbortController();
    controller = ac;
    status = { kind: 'pending' };

    const result = await startRun(workflowId, {
      signal: ac.signal,
      fetcher,
    });
    if (ac.signal.aborted) return;

    if (result.ok) {
      status = { kind: 'success', runId: result.run.id };
      onStarted?.(result.run.id);
      return;
    }
    if (result.kind === 'cancelled') {
      // Aborted by an unmount or a follow-up click — leave the UI as-is so
      // the next click starts cleanly.
      return;
    }
    status = { kind: 'error', message: result.message };
  }
</script>

<!--
  The button + status caption sit in a tight inline group so the caption can
  hug the trigger without consuming vertical space. The page's editor header
  reserves a small flex row for action controls, and this wrapper slots into
  it without disrupting the existing Save button / message layout.

  In `compact` mode (Top Bar) we float the caption below the button via
  `relative` + `absolute` so the design's 56px row invariant is preserved
  (review-design.md M-1). The wrapper also gets `shrink-0` so it cannot push
  the avatar / icon-buttons off the trailing edge of the Top Bar at narrow
  viewports.
-->
<div
  class={cn(
    'flex items-center gap-3',
    compact && 'relative shrink-0 gap-0',
    className,
  )}
>
  <Button
    type="button"
    variant="default"
    size="sm"
    aria-label={copy.triggerAria}
    aria-busy={busy}
    disabled={busy}
    onclick={handleClick}
    class={cn(
      // Mirror design `B70DU6`: 32px height (sm:h-8), 6px radius, accent fill,
      // 14px horizontal padding, 6px gap between icon and label, white text.
      // 44px tap target on touch (`h-11`) collapses to 32px on >=sm where
      // pointer input dominates.
      //
      // `focus-visible:ring-offset-2` lifts the keyboard-focus ring off
      // the button so it stays visible against the accent fill (the ring
      // colour is the same accent hue, which previously bled into the
      // button surface on focus — review note L-8). In `compact` mode
      // the offset follows `--color-bg-topbar` so the ring sits flush
      // against the Top Bar surface in both themes (`#161620` dark /
      // `#FAFAFA` light — review-design-topbar-frontend.md M-1). Outside
      // the Top Bar the original `--color-bg-surface` keeps the FAB's
      // ring offset against the canvas card surface.
      // Drop shadow is intentionally suppressed in `compact` (Top Bar)
      // mode: design `B70DU6` does not define an `effect` on the Top Bar
      // Run pill, and a soft accent shadow there visually lifts Run above
      // the neighbouring Save pill (same accent fill, no shadow), breaking
      // the Top Bar 56px row's flat hierarchy (review-design-topbar
      // -frontend.md M-1). Outside the Top Bar (e.g. canvas FAB context)
      // the original soft accent shadow is preserved.
      'h-11 gap-1.5 rounded-md bg-(--color-accent) px-3.5 text-[13px] font-semibold text-white hover:bg-(--color-accent-hover) focus-visible:ring-(--color-accent) focus-visible:ring-offset-2 sm:h-8',
      compact
        ? 'focus-visible:ring-offset-(--color-bg-topbar)'
        : 'focus-visible:ring-offset-(--color-bg-surface) shadow-[0_4px_12px_var(--color-accent-shadow)]',
    )}
  >
    {#if busy}
      <LoaderCircle
        class="h-3.5 w-3.5 shrink-0 animate-spin"
        aria-hidden="true"
        data-testid="run-workflow-spinner"
      />
      <span>{copy.triggerBusyLabel}</span>
    {:else}
      <Play class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{copy.triggerLabel}</span>
    {/if}
  </Button>

  {#if status.kind === 'success'}
    <!--
      In `compact` mode the caption floats below the button so it cannot
      push the Top Bar's avatar off-screen on narrow viewports. The
      caption stays accessible (visible + `role="status"`) so the
      run-workflow E2E suite can still observe the run id via
      `data-testid="run-workflow-success"`.
    -->
    <span
      class={cn(
        'rounded bg-(--color-success-muted) px-2 py-0.5 text-xs whitespace-nowrap text-(--color-text-primary)',
        // `z-50` on the floating compact caption so it lays above the
        // mobile drawer overlay (`z-40`) / dialog content (`z-50`). With
        // the previous `z-30` the toast briefly hid behind the drawer
        // when the user tapped Run while the navigation drawer was still
        // closing (review-design-frontend.md m-4).
        compact &&
          'absolute top-full right-0 z-50 mt-1 max-w-[min(28ch,calc(100vw-32px))] overflow-hidden text-ellipsis shadow-sm',
      )}
      role="status"
      aria-live="polite"
      data-testid="run-workflow-success"
    >
      {copy.startedTemplate(status.runId)}
    </span>
  {:else if status.kind === 'error'}
    <span
      class={cn(
        'rounded border border-(--color-danger-border) bg-(--color-danger-muted) px-2 py-0.5 text-xs whitespace-nowrap text-(--color-danger)',
        // See success caption above: `z-50` floats the error toast above
        // the mobile drawer overlay so it cannot hide behind a closing
        // drawer (review-design-frontend.md m-4). The `min(...)` cap
        // keeps the floating caption from overflowing the viewport's
        // right edge on narrow screens (review note frontend M-1):
        // `max-w-[32ch]` alone could push the toast under the avatar
        // and create a click-blocking overlay just below the bar.
        compact &&
          'absolute top-full right-0 z-50 mt-1 max-w-[min(32ch,calc(100vw-32px))] overflow-hidden text-ellipsis shadow-sm',
      )}
      role="alert"
      aria-live="assertive"
      data-testid="run-workflow-error"
    >
      {status.message}
    </span>
  {/if}
</div>
