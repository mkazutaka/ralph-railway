<!--
  Execution Bar (Pencil node `hVaDB` "Execution Bar").

  A compact 36px elevated pill anchored to the bottom-center of the canvas.
  Surfaces the most recent run's headline metrics so the user can see at a
  glance whether the workflow last succeeded / failed and how long it took
  without leaving the canvas.

  Visual contract (mirrors the design):
    - 36px tall, 8px corner radius, `bg-elevated` fill, `border-default`
      stroke, soft drop shadow (`#00000030`, blur 8, offset y2).
    - Layout: <status dot> <relative-time text> <vertical divider>
      <step-status text> <vertical divider> <timer-icon> <duration text>.
    - Status dot tinted by `statusDotVar` (matches the recent-runs sidebar
      so the two surfaces stay in lockstep).
    - Step-status text is colour-tuned: success runs use `$success`;
      failed / cancelled use `$danger`; in-flight states use `$accent`.
      The design only spells out the success variant (`5/5 steps
      completed`); the other variants are derived to keep the surface
      meaningful for non-success runs without spawning a separate panel.

  Why a separate component (not inlined in `Graph.svelte`):
    - The bar is reusable across canvas surfaces (it lands in the same
      bottom-center slot as the help-hint pill, but the help-hint surface
      is a different concept and stays in `Graph.svelte` directly).
    - Keeping the formatting + colour decisions next to the markup makes
      future scenario tweaks (e.g. the stop-run scenario adding a
      "stop" affordance to the bar) localised.

  Empty / hidden behaviour:
    - When no run has happened yet (`latestRun === null`) the component
      renders nothing. The parent (`Graph.svelte`) is responsible for
      showing an alternative surface (the help-hint pill) in that case so
      the bottom-center region is not empty on a fresh workflow.
-->
<script lang="ts">
  import Timer from 'lucide-svelte/icons/timer';
  import type { RunSummaryDto } from '$features/workflow-editor/entities/dto';
  import {
    formatDuration,
    formatRelativeTime,
    statusDotVar,
  } from '$features/workflow-editor/components/recentRunsFormat';

  // The parent passes the latest run summary; `null` means "no runs yet"
  // and the bar collapses (the parent shows the help-hint instead).
  let {
    latestRun,
    totalSteps,
    now = Date.now(),
  }: {
    latestRun: RunSummaryDto | null;
    /**
     * Number of steps in the visualised graph. Drives the `${n}/${n} steps
     * completed` caption for succeeded runs. The component does not have
     * direct access to the graph DTO so the count flows in from the page
     * (it already owns the parsed graph for the canvas).
     */
    totalSteps: number;
    /**
     * Current wall clock used to derive the relative-time caption. The
     * parent page already maintains a once-per-minute ticker for the
     * recent-runs panel; we accept it as a prop so the two surfaces stay
     * in lockstep without spinning a second timer.
     */
    now?: number;
  } = $props();

  // Colour the step-status caption per the run's terminal state. The design
  // (`hVaDB/C77Va`) shows the success variant only; we extend the palette
  // for the other states so the bar is meaningful across all run outcomes.
  function stepStatusColorVar(status: RunSummaryDto['status']): string {
    switch (status) {
      case 'succeeded':
        return '--color-success';
      case 'failed':
      case 'cancelled':
        return '--color-danger';
      case 'pending':
      case 'running':
        return '--color-accent';
    }
  }

  // Caption text for the middle slot. Mirrors the design's `5/5 steps
  // completed` for the success path, and falls back to a status-only
  // caption for the other states (the design does not spell out failed /
  // cancelled / running variants — we keep them concise so the pill keeps
  // its 36px height regardless of the run state).
  function stepStatusText(run: RunSummaryDto, total: number): string {
    switch (run.status) {
      case 'succeeded':
        return total > 0 ? `${total}/${total} steps completed` : 'completed';
      case 'failed':
        return total > 0 ? `step failed (${total} total)` : 'step failed';
      case 'running':
        return 'running…';
      case 'pending':
        return 'queued';
      case 'cancelled':
        return 'cancelled';
    }
  }

  const relativeTime = $derived(
    latestRun ? formatRelativeTime(latestRun.startedAt, now) : '',
  );
  // For in-flight runs the duration is `null`; show an em-dash so the
  // layout stays put rather than collapsing the timer slot.
  const durationLabel = $derived.by(() => {
    if (!latestRun) return '';
    const d = formatDuration(latestRun.durationMs);
    return d ?? '—';
  });
  const stepStatus = $derived(latestRun ? stepStatusText(latestRun, totalSteps) : '');
  const dotVar = $derived(latestRun ? statusDotVar(latestRun.status) : '--color-text-tertiary');
  const stepColorVar = $derived(
    latestRun ? stepStatusColorVar(latestRun.status) : '--color-text-secondary',
  );
</script>

{#if latestRun}
  <!--
    `role="status"` + `aria-live="polite"` so a screen-reader announces the
    most recent run change without interrupting the user's typing flow.
    Polite (not assertive) because run completion is informational — the
    user did not initiate it from this surface (they triggered it from the
    Run button up in the header) and would not benefit from a forced
    barge-in.
  -->
  <div
    class="flex h-9 items-center gap-2.5 rounded-lg border border-(--color-border-default) bg-(--color-bg-elevated) px-3.5 shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
    role="status"
    aria-live="polite"
    aria-label="Last run summary"
    data-testid="execution-bar"
  >
    <span
      class="inline-block size-2 shrink-0 rounded-full"
      style="background-color: var({dotVar})"
      aria-hidden="true"
    ></span>
    <span class="text-[12px] leading-none text-(--color-text-secondary) whitespace-nowrap">
      Last run: {relativeTime} ago
    </span>
    <span
      class="inline-block h-[18px] w-px shrink-0 bg-(--color-border-default)"
      aria-hidden="true"
    ></span>
    <span
      class="text-[12px] font-medium leading-none whitespace-nowrap"
      style="color: var({stepColorVar})"
    >
      {stepStatus}
    </span>
    <span
      class="inline-block h-[18px] w-px shrink-0 bg-(--color-border-default)"
      aria-hidden="true"
    ></span>
    <span class="flex shrink-0 items-center gap-1 text-(--color-text-secondary)">
      <Timer class="h-3 w-3" aria-hidden="true" />
      <span class="text-[12px] font-medium leading-none tabular-nums">{durationLabel}</span>
    </span>
  </div>
{/if}
