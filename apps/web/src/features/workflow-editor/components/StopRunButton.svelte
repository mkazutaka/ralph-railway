<!--
  Stop Run trigger button.

  Implements the "Stop Run" scenario
  (`apps/web/docs/scenarios/workflow-editor/stop-run.md`). The design file
  (`apps/web/design/app.pen`) does not yet ship a dedicated stop-button
  symbol, so the visual idiom mirrors the Run Button (`B70DU6`) — same
  32px height, 6px corner radius, 14px horizontal padding, 6px gap between
  icon and label, Inter 13/600 — but is tinted with the danger token to
  signal that activating it interrupts an in-flight Run.

  Behaviour:
    - On click → POST `/api/workflows/:id/runs/:runId/stop`. The server
      forwards the request to the runtime and returns a `StopAcceptedDto`
      with HTTP 202; we surface a brief "Stop requested" caption next to
      the button so the user has a confirmation cue, and call back to the
      parent so it can refresh the run-detail panel and observe the
      eventual transition to `Cancelled` (scenario invariants 2 & 3:
      the actual Cancelled state is owned by the read-run-detail
      scenario, not this one).
    - Failures (404 / 409 / 503 / network) surface inline as a
      `role="alert"` caption next to the button. The button stays
      enabled so the user can retry once the underlying problem is
      cleared (e.g. the runtime came back online for a 503). Specific
      status mapping lives in `lib/runApi.ts`.
    - The trigger is disabled while a request is in-flight to prevent
      double-dispatch — sending two stop requests for the same Run is
      harmless (the runtime is idempotent at the receipt level) but
      surfaces a confusing 409 on the second click once the run has
      reached `cancelled`.

  Accessibility:
    - The square icon is decorative (`aria-hidden="true"`); the label
      "Stop" provides the accessible name. `aria-busy` is set during the
      request so screen readers announce the in-flight state.
    - Success messages use `role="status" aria-live="polite"` so they
      don't interrupt mid-sentence reads (mirrors `RunWorkflowButton`'s
      toast policy).
    - Failure messages use `role="alert" aria-live="assertive"` because
      the user usually needs to act on them.

  Mount location: rendered inside `RunDetail.svelte` next to the close
  button, only when the currently-displayed run is in a non-terminal state
  (pending / running). The visibility gate lives on the parent so the
  button never appears for an already-finished run, satisfying scenario
  invariant 1 (既に終了状態の Run には停止要求を発行しない). When the
  parent decides not to render this component, no stop button is shown
  at all — there is no half-disabled state for terminal runs.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Square from 'lucide-svelte/icons/square';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import { stopRun } from '../lib/runApi';
  import { stopRunCopy as copy } from './stopRunCopy';

  let {
    workflowId,
    runId,
    onAccepted,
    /**
     * Override hook for tests (Vitest / MSW). Resolves `globalThis.fetch`
     * at *call* time so a test harness can swap `globalThis.fetch` after
     * construction and still observe the call (mirrors
     * `RunWorkflowButton.svelte`).
     */
    fetcher,
    /** Optional className passed through for layout-level overrides. */
    class: className,
  }: {
    workflowId: string;
    runId: string;
    /**
     * Notification hook fired after the runtime has accepted the stop
     * request. Receives the run id so the parent can re-fetch the
     * run-detail panel and observe the eventual `cancelled` transition
     * (scenario invariants 2 & 3). Called only on success (HTTP 202);
     * failures stay inside this component.
     */
    onAccepted?: (runId: string) => void;
    fetcher?: typeof fetch;
    class?: string;
  } = $props();

  type Status =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'success' }
    | { kind: 'error'; message: string };

  // Annotate with the union type so later assignments are not narrowed
  // away by TypeScript inferring the initial literal as `{ kind: 'idle' }`.
  let status = $state<Status>({ kind: 'idle' });
  let busy = $derived(status.kind === 'pending');

  // Track the in-flight controller so an unmount or rapid click sequence
  // aborts the previous request before starting a new one. Without this
  // we could race two responses and the slower one would overwrite the
  // freshly-issued status (mirrors `RunWorkflowButton`).
  let controller: AbortController | null = null;
  onDestroy(() => controller?.abort());

  // Reset transient feedback whenever the parent swaps the selected run.
  // Without this, a "Stop requested" caption from the previous run would
  // linger on the new run's panel until the user clicks Stop again.
  $effect(() => {
    // Re-read the dependency explicitly so the reset is auditable.
    const _rid = runId;
    void _rid;
    controller?.abort();
    status = { kind: 'idle' };
  });

  async function handleClick() {
    if (busy) return;
    controller?.abort();
    const ac = new AbortController();
    controller = ac;
    status = { kind: 'pending' };

    const result = await stopRun(workflowId, runId, {
      signal: ac.signal,
      fetcher,
    });
    if (ac.signal.aborted) return;

    if (result.ok) {
      status = { kind: 'success' };
      onAccepted?.(result.stop.id);
      return;
    }
    if (result.kind === 'cancelled') {
      // Aborted by an unmount, a follow-up click, or a parent run-id swap
      // — leave the UI as-is so the next click starts cleanly.
      return;
    }
    status = { kind: 'error', message: result.message };
  }
</script>

<!--
  The button + status caption sit in a tight inline group so the caption
  can hug the trigger without consuming vertical space. The parent panel
  reserves a small flex row for action controls, and this wrapper slots
  into it without disrupting the existing close-button layout.
-->
<div class={cn('flex items-center gap-2', className)}>
  <Button
    type="button"
    variant="default"
    size="sm"
    aria-label={copy.triggerAria}
    aria-busy={busy}
    disabled={busy}
    onclick={handleClick}
    class={cn(
      // Mirror the Run Button design (`B70DU6`) but tint with the danger
      // token so the destructive nature of the action is signalled before
      // activation. 32px height (sm:h-8), 6px radius, 14px horizontal
      // padding, 6px gap between icon and label, white text. 44px tap
      // target on touch (`h-11`) collapses to 32px on >=sm where pointer
      // input dominates.
      'h-11 gap-1.5 rounded-md bg-(--color-danger) px-3.5 text-[13px] font-semibold text-white shadow-[0_4px_12px_var(--color-danger-muted)] hover:bg-(--color-danger)/90 focus-visible:ring-(--color-danger) sm:h-8',
    )}
    data-testid="stop-run-button"
  >
    {#if busy}
      <LoaderCircle
        class="h-3.5 w-3.5 shrink-0 animate-spin"
        aria-hidden="true"
        data-testid="stop-run-spinner"
      />
      <span>{copy.triggerBusyLabel}</span>
    {:else}
      <!--
        `square` is the closest lucide glyph to the conventional "stop"
        icon (a filled square is a common stop indicator on media
        controls). We render it as outline to stay visually balanced
        against the play (outline-style) icon on the Run trigger.
      -->
      <Square class="h-3.5 w-3.5 shrink-0 fill-white" aria-hidden="true" />
      <span>{copy.triggerLabel}</span>
    {/if}
  </Button>

  {#if status.kind === 'success'}
    <span
      class="rounded bg-(--color-success-muted) px-2 py-0.5 text-xs text-(--color-text-primary)"
      role="status"
      aria-live="polite"
      data-testid="stop-run-success"
    >
      {copy.acceptedLabel}
    </span>
  {:else if status.kind === 'error'}
    <span
      class="rounded border border-(--color-danger-border) bg-(--color-danger-muted) px-2 py-0.5 text-xs text-(--color-danger)"
      role="alert"
      aria-live="assertive"
      data-testid="stop-run-error"
    >
      {status.message}
    </span>
  {/if}
</div>
