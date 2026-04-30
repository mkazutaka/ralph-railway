<!--
  Workflow editor page.

  Primary scenario: `docs/scenarios/workflow-management/open-workflow.md` —
  the page loads a workflow on disk, renders its YAML source plus the
  server-built `FlowGraph` in the canvas, and stays usable when the YAML is
  syntactically broken (invariant 1). The graph payload comes from the load
  function as the DMMF entity `OpenedWorkflow.graph`; the client-side
  `yamlToFlow` re-parser only takes over once the user starts editing the
  buffer (review note F-1).

  Compose-only scenarios mounted here: `insert-pattern` (PatternPicker FAB),
  `run-workflow` / `stop-run` (RunWorkflowButton + RunDetail), `read-run-detail`
  (RecentRuns / RunDetail), `test-node` (TestNodePanel). The rest of the
  Pencil design (`apps/web/design/app.pen`, frame `k1kIS`):
    - Top Bar (`Ht9Do`) with History/Settings/Share/Run + avatar
    - Left Sidebar (`iHBGe`) with file tree / recent runs
    - Right Panel (`SV10l`) with node settings tabs
    - Tab Bar / Canvas Toolbar / Execution Bar / Minimap / Zoom Controls
  is intentionally out of scope here and will land via separate scenarios.
  Only the canvas FAB (`Hkw62` "Add Node FAB") is brought in because it is
  the entry point for THIS scenario.

  Layout responsibility: this component composes the YAML buffer (left
  pane), the read-only flow visualisation (right pane / canvas), and the
  PatternPicker FAB anchored on the canvas. All mutation logic lives in
  `editorState.svelte.ts` so the page stays a thin layout shell.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Graph from '$lib/flow/Graph.svelte';
  import { yamlToFlow } from '$lib/workflow/to-flow';
  import { flowGraphFromDto } from '$lib/workflow/from-dto';
  import PatternPicker from '$features/workflow-editor/components/PatternPicker.svelte';
  import RecentRuns from '$features/workflow-editor/components/RecentRuns.svelte';
  import RunDetail from '$features/workflow-editor/components/RunDetail.svelte';
  import RunWorkflowButton from '$features/workflow-editor/components/RunWorkflowButton.svelte';
  import TestNodePanel from '$features/workflow-editor/components/TestNodePanel.svelte';
  import SaveButton from '$lib/components/save-button.svelte';
  import { createEditorState } from '$features/workflow-editor/lib/editorState.svelte';
  import { editorCopy } from '$features/workflow-editor/lib/editorCopy';

  import type { RunSummaryDto } from '$features/workflow-editor/entities/dto';

  let { data } = $props();

  // Read `data.yaml` / `data.id` once at construction to seed the editor
  // buffer. Subsequent updates flow through `syncFromServer` in the
  // `$effect` below, so this initial dereference is intentional.
  // svelte-ignore state_referenced_locally
  const editor = createEditorState({ initialYaml: data.yaml, workflowId: data.id });

  // Re-sync the buffer whenever the load function reruns (e.g. after a
  // successful pattern insertion calls `invalidateAll`, or the user
  // navigates to a different `/workflows/[id]` route while the page
  // component is reused). Passing `{ id, yaml }` keeps the captured
  // workflow id in lockstep with the buffer so `editor.save()` always
  // targets the visible workflow.
  $effect(() => {
    // Destructure the reactive deps explicitly so static analysis (and
    // human readers) can see exactly which fields drive this effect, and
    // so the call to `syncFromServer` does not hide reactive accesses
    // inside an inline object literal (review note m4).
    const { id, yaml } = data;
    editor.syncFromServer({ id, yaml });
  });

  onDestroy(() => editor.dispose());

  // Hybrid graph source (review note F-1):
  //
  //   - Initial render + idle (buffer === server YAML) → use the server-built
  //     `data.opened.graph` directly, so SSR and the first client paint render
  //     the exact same DMMF entity the rest of the feature consumes. This
  //     eliminates the "two parsers, two outputs" flicker between the SSR
  //     payload and the client `yamlToFlow` re-parse, and gives the scenario
  //     contract (`Graph: FlowGraph`) a real consumer in the UI.
  //
  //   - Live edits (buffer !== server YAML) → fall back to the client-side
  //     `yamlToFlow`, which is memoised (`apps/web/src/lib/workflow/to-flow.ts`)
  //     and produces stable references on identical input so SvelteFlow does
  //     not re-run its layout / fitView passes on every keystroke that does
  //     not change the parsed graph (review note P1-1).
  //
  // The branch reads `data.yaml` (the SSR-emitted source the server graph was
  // built against) rather than `data.opened.yaml` so it stays in lockstep with
  // the legacy `data.yaml` field that `editor.syncFromServer` already mirrors
  // — keeping the comparison string identical to the buffer-init source.
  //
  // `serverGraph` is memoised on the SSR-emitted DTO (review note P1-3): the
  // server payload is immutable per load() invocation, so we want a single
  // adapter run per navigation rather than one per keystroke. The `$derived`
  // dependency tracker only reruns this when `data.opened.graph` changes
  // identity, which happens via `invalidateAll()` after pattern insertion or
  // a route change — exactly the points the new graph should reflect.
  const serverGraph = $derived.by(() => flowGraphFromDto(data.opened.graph));
  let parsed = $derived(
    editor.yaml === data.yaml ? serverGraph : yamlToFlow(editor.yaml),
  );
  let patterns = $derived(data.patterns);
  // Heading id is shared with the textarea so screen readers announce the
  // workflow name (`data.opened.name`, with the file basename rendered next
  // to it for sighted-only context) when focus enters the YAML buffer (M-3).
  const HEADING_ID = 'workflow-editor-heading';

  // Currently inspected run. `null` means "no run selected" — the
  // RunDetail panel renders an empty-state caption in that case. The
  // selection lives on the page (not inside `RecentRuns`) so two
  // independent components — the run list and the run-detail panel —
  // can react to it without prop-drilling state through a shared
  // parent component (mirrors the read-run-detail scenario, where the
  // user picks a run in the sidebar and then reads its detail).
  let selectedRunId: string | null = $state(null);

  // Reset the selection whenever the workflow id changes. A run id
  // always belongs to a single workflow (the API returns 404 if the
  // ids don't match) so a stale selection from the previous workflow
  // would only ever resolve to a 404 panel — friendlier to clear it.
  $effect(() => {
    // Re-read the dependency explicitly so the linter / human reader
    // can see what drives the reset.
    const _id = data.id;
    void _id;
    selectedRunId = null;
  });

  /**
   * Latest run summary for the current workflow. Drives the canvas
   * Execution Bar (Pencil `hVaDB`): the bar surfaces the most recent run's
   * status / duration so the user can see "did the workflow last succeed?"
   * without leaving the canvas. `null` means no runs yet — the bar
   * collapses and the help-hint takes its slot (see `Graph.svelte`).
   *
   * Owns its own fetch (mirroring the policy already documented on
   * `RecentRuns.svelte`): re-loading the page-level `data.yaml` every time
   * a run completes would re-mount the canvas, which is too disruptive
   * just to refresh a status pill. We pull `/api/workflows/:id/runs` here,
   * sort by `startedAt`, take the first row, and refresh on a 15s tick so
   * the bar reflects new runs without forcing a hard reload.
   */
  let latestRun: RunSummaryDto | null = $state(null);

  $effect(() => {
    const id = data.id;
    const ac = new AbortController();
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const res = await fetch(`/api/workflows/${encodeURIComponent(id)}/runs`, {
          signal: ac.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as RunSummaryDto[];
        if (cancelled) return;
        // Pick the run with the most recent `startedAt`. The endpoint already
        // returns runs in reverse-chronological order today (see
        // `recentRunsRoute.ts`), but sorting defensively here keeps the
        // surface correct even if the API contract loosens later.
        const sorted = [...body].sort((a, b) => b.startedAt - a.startedAt);
        latestRun = sorted[0] ?? null;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // Soft-fail: a transient network error should not flicker the
        // canvas surface. The bar simply keeps its previous value (or
        // stays hidden if it was never populated).
      }
    }

    void refresh();
    const tick = setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      ac.abort();
      clearInterval(tick);
    };
  });
</script>

<!--
  Mobile (<lg): two equal rows so the canvas + FAB stay reachable
  without scrolling. Desktop (>=lg): side-by-side panes.

  Use `h-[100dvh]` (dynamic viewport height) so the layout collapses with
  the iOS / Android virtual keyboard rather than pushing the canvas pane
  off-screen — `100vh` keeps the full viewport size when the keyboard
  appears, which leaves the FAB unreachable on mobile devices (review note
  Optional-4).
-->
<main
  class="grid h-[100dvh] grid-cols-1 grid-rows-[minmax(40vh,1fr)_minmax(40vh,1fr)] lg:grid-cols-2 lg:grid-rows-1"
>
  <!-- Left pane: YAML buffer + save button -->
  <section
    class="flex min-h-0 flex-col border-(--color-border-default) bg-(--color-bg-app) lg:border-r"
  >
    <header
      class="flex items-center justify-between border-b border-(--color-border-default) bg-(--color-bg-surface) px-4 py-2"
    >
      <!--
        Heading carries the workflow's display name (`data.opened.name`,
        derived from the YAML `document.name` with a file-basename fallback —
        see `newOpenedWorkflow` in `entities/openedWorkflow.ts`). The file id
        is shown alongside as supplementary context so users can still see
        which file on disk is open, while screen readers announce the
        descriptive name first (review notes F-3 / F-6).
      -->
      <h1
        id={HEADING_ID}
        class="flex min-w-0 items-baseline gap-2 truncate text-sm font-medium text-(--color-text-primary)"
      >
        <span class="truncate">{data.opened.name}</span>
        <!--
          File basename is decorative for sighted users (it duplicates info
          the screen reader already gets via the `<h1>` text). Hide it from
          assistive tech with `aria-hidden="true"` so the heading announces
          the human name only, matching the read-aloud contract documented on
          the textarea below (M-3).
        -->
        <small
          class="truncate text-xs font-normal text-(--color-text-secondary)"
          aria-hidden="true">{data.id}</small
        >
      </h1>
      <div class="flex items-center gap-3 text-xs">
        {#if editor.message}
          <!--
            Error toasts go through `role="alert" aria-live="assertive"`
            because the user usually needs to act on them; success toasts
            stay on `role="status" aria-live="polite"` so they don't
            interrupt screen reader output mid-sentence (M-3).
          -->
          {#if editor.messageTone === 'error'}
            <span
              data-testid="editor-toast"
              class="text-(--color-danger)"
              role="alert"
              aria-live="assertive">{editor.message}</span
            >
          {:else}
            <!--
              Success / info toast. Wrap the message in a low-contrast
              success-tinted badge so the cue is visible even when the
              user's eye is on the canvas / textarea (review note m-5:
              `--color-success-muted` was previously defined but unused,
              and bare secondary text on the dark surface was on the
              edge of WCAG AA at small sizes). The padding also gives
              the toast a recognisable shape, distinct from the danger
              variant above.
            -->
            <span
              data-testid="editor-toast"
              class="rounded bg-(--color-success-muted) px-2 py-0.5 text-(--color-text-primary)"
              role="status"
              aria-live="polite">{editor.message}</span
            >
          {/if}
        {/if}
        <SaveButton
          type="button"
          disabled={editor.saving}
          aria-busy={editor.saving}
          onclick={() => editor.save()}
        >
          {editor.saving ? editorCopy.savingLabel : editorCopy.saveLabel}
        </SaveButton>
        <!--
          Run trigger (run-workflow scenario). POSTs to
          `/api/workflows/:id/runs` and surfaces the newly-minted run id via
          `onStarted`. We pipe the id into `selectedRunId` so the run-detail
          panel below auto-loads the fresh run; the recent-runs panel will
          pick the new row up on its next interval/refresh tick. Failures
          surface inline next to the button (own `role="alert"` region) and
          do NOT also flow into the editor toast bar — duplicate live
          regions would stutter screen-reader output (mirrors the policy
          documented for the PatternPicker insert-failure path).
        -->
        <RunWorkflowButton
          workflowId={data.id}
          onStarted={(runId) => (selectedRunId = runId)}
        />
      </div>
    </header>
    <!--
      The textarea's accessible name is `editorCopy.yamlAriaLabel`
      ("Workflow YAML"), set explicitly via `aria-label`. We deliberately
      do NOT use `aria-labelledby={HEADING_ID}` here because the heading
      content is the workflow's display name (e.g. "Daily Backup") which
      would replace the descriptive label and make the textbox harder to
      identify by role-and-name in tooling / assistive tech / Playwright.
      The heading is instead linked via `aria-describedby` so screen
      readers announce the workflow name as supplementary context after
      the role+name (M-3).
    -->
    <textarea
      class="h-full min-h-0 flex-1 resize-none overflow-auto bg-(--color-bg-canvas) p-3 font-mono text-xs whitespace-pre text-(--color-text-primary) outline-none"
      bind:value={editor.yaml}
      aria-label={editorCopy.yamlAriaLabel}
      aria-describedby={parsed.error
        ? `${HEADING_ID} ${editorCopy.yamlErrorElementId}`
        : HEADING_ID}
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
    ></textarea>
    {#if parsed.error}
      <!--
        Passive validation banner: not `role="alert"` because the message
        already lives in the textarea's `aria-describedby` chain (see above)
        and double-announcing it as an interruptive alert is hostile in
        screen-reader output. We still flag it to assistive tech via
        `aria-live="polite"` so a parse error introduced by typing is
        announced once after the user stops editing. The split between this
        passive surface and the toast `role="alert"` (M-3) is intentional —
        the toast is reserved for outcomes of explicit user actions.
      -->
      <p
        id={editorCopy.yamlErrorElementId}
        aria-live="polite"
        class="border-t border-(--color-danger-border) bg-(--color-danger-muted) px-3 py-1 text-xs text-(--color-danger)"
      >
        {parsed.error}
      </p>
    {/if}
    <!--
      Recent runs panel. Mirrors the `RECENT RUNS` section that lives at
      the bottom of the Left Sidebar (`iHBGe`) in
      `apps/web/design/app.pen` — a small uppercase heading followed by
      the most recent run rows.

      Mount location is provisional (review note M1): the canonical home
      is the design's Left Sidebar, which has not yet been built (it
      lands in a separate scenario covering the file tree + workflow
      switcher). Until then we mount it underneath the YAML textarea so
      users still see run status while editing. The component itself caps
      its height + scrolls vertically so a tall run list cannot push the
      textarea off-screen.

      The component owns its own fetch against `/api/workflows/:id/runs`
      so the editor's load function stays focused on the YAML buffer
      (re-loading the buffer every time a run completes would re-mount
      the canvas, see `+page.server.ts` `load` JSDoc).
    -->
    <RecentRuns
      workflowId={data.id}
      selectedRunId={selectedRunId}
      onSelect={(runId) => (selectedRunId = runId)}
    />
    <!--
      Run detail panel. Mirrors the read-run-detail scenario
      (`apps/web/docs/scenarios/workflow-editor/read-run-detail.md`):
      when the user picks a row in the recent-runs panel above, the
      panel here fetches `/api/workflows/:id/runs/:runId` and renders
      per-node status / output / error / log excerpts.

      Mount location is provisional (mirrors the recent-runs note):
      the canonical home is the design's Right Panel (`SV10l`, width
      340) which today shows per-node settings. Until that scenario
      lands the panel sits in the same column as the YAML buffer; the
      component caps its own height + scrolls so a long node list
      cannot push the canvas off-screen.
    -->
    <!--
      `onStopAccepted` is wired through to the page so future scenarios
      (e.g. the recent-runs panel auto-refreshing after a stop) can hook
      in here without re-plumbing props. Today RunDetail re-fetches its
      own data after a stop is accepted so the user observes the
      eventual `cancelled` transition; the recent-runs sidebar will
      update on its next interval tick — see RecentRuns' own data flow
      JSDoc for the re-fetch contract.
    -->
    <RunDetail
      workflowId={data.id}
      runId={selectedRunId}
      onClose={() => (selectedRunId = null)}
      onStopAccepted={() => {
        // Intentionally a no-op for now: RunDetail handles its own
        // refresh, and RecentRuns will catch up on its next tick. A
        // future scenario covering "auto-refresh recent runs after a
        // stop" can replace this with a refresh-trigger.
      }}
    />
    <!--
      Test Node panel. Mirrors the test-node scenario
      (`apps/web/docs/scenarios/workflow-editor/test-node.md`): the user
      enters a node id + dummy inputs and POSTs to
      `/api/workflows/:id/nodes/:nodeId/test`. The result (succeeded /
      failed + output / error / log excerpt) is rendered inline.

      Mount location is provisional (mirrors the RunDetail / RecentRuns
      siblings): the canonical home is the design's Right Panel
      (`SV10l`, width 340) which today shows per-node settings + the
      "Test Step" button. Until the right-panel scenario migrates that
      surface, the panel sits in the same column as the YAML buffer; it
      caps its own height + scrolls so a long inputs list cannot push
      the canvas off-screen.

      Scenario invariants 1 & 2 (no run history mutation, no YAML
      rewrite) are enforced server-side; the panel only owns the
      request/response cycle.
    -->
    <TestNodePanel
      workflowId={data.id}
      nodeIds={parsed.nodes.map((n) => n.id)}
    />
  </section>

  <!-- Right pane: canvas + FAB (Add Node). Mirrors `apps/web/design/app.pen`
       node `Hkw62`: the FAB floats in the upper-right corner of the canvas
       with the accent fill + soft purple shadow. `relative` here makes the
       FAB's `absolute` placement land inside the canvas pane.

       The `aria-label` makes the visualised graph discoverable to assistive
       tech as a labelled landmark — the open-workflow scenario asks the user
       to "confirm the YAML source and the visualised graph", and without a
       name the section was indistinguishable from the YAML pane in
       screen-reader rotor lists (review note F-6 follow-up). -->
  <section class="relative min-h-0 bg-(--color-bg-canvas)" aria-label="Workflow flow graph">
    <Graph nodes={parsed.nodes} edges={parsed.edges} {latestRun} />
    <!--
      FAB is positioned to align horizontally with the Canvas Toolbar
      (`gskMk`, top-center of canvas). xyflow's Panel uses ~12px top
      padding, so we mirror it (`top-3`) so the FAB and toolbar share a
      baseline (review note P2 / FAB alignment). On `sm:` we keep the
      same offset since the toolbar's Panel padding is constant.
    -->
    <div class="pointer-events-none absolute top-3 right-3 z-10">
      <div class="pointer-events-auto">
        <!--
          Insert failures are surfaced inside the picker popover only — the
          popover stays open on failure so the user can see the message in
          context and pick a different pattern. We deliberately don't echo
          the failure into the editor toast bar to avoid duplicate
          `role="alert"` regions firing simultaneously (which would flap
          screen-reader output and break Playwright's strict locator rules).
        -->
        <PatternPicker
          {patterns}
          onInserted={(id, yaml) => editor.notifyInserted(id, yaml)}
        />
      </div>
    </div>
  </section>
</main>
