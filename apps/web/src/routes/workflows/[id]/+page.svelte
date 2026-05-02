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
  (RecentRuns / RunDetail), `test-node` (TestNodePanel).

  Layout (post review-design):

      ┌────────── App Shell (`+layout.svelte`) ──────────┐
      │ TopBar                                            │
      ├──────────┬─────────────────────────┬──────────────┤
      │ Left     │ Tab Bar (file tabs)     │ Right Panel  │
      │ Sidebar  ├─────────────────────────┤ (`SV10l`)    │
      │ (file    │ Canvas (FlowGraph + FAB)│  - RunDetail │
      │  tree)   │                         │  - TestNode  │
      │          ├─────────────────────────┤              │
      │  Recent  │ YAML buffer (collapsed  │              │
      │  Runs    │  bottom drawer)         │              │
      └──────────┴─────────────────────────┴──────────────┘

  This page composes the *center* and *right* columns. The Left Sidebar +
  Top Bar live in `+layout.svelte`; this page publishes its editor
  binding (workflow id, save status, selected run id) into the layout via
  `topBarContext.svelte.ts` so:
    - The Top Bar's Save / Run / "Saved" pill bind to this page's editor.
    - The Left Sidebar swaps its read-only `SidebarRecentRuns` footer for
      the interactive `RecentRuns` panel, whose row clicks drive
      `selectedRunId` here — which in turn feeds the right-column
      `RunDetail` panel.

  The previous layout stacked YAML / Canvas side-by-side and pushed
  RecentRuns / RunDetail / TestNodePanel under the YAML pane. That made
  the YAML pane a peer of the canvas and starved the per-node inspection
  surfaces of horizontal real estate; the Pencil design (`k1kIS / RV8SI`)
  treats the canvas as primary and dedicates the right column to the
  inspector. We now mirror that intent.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronUp from 'lucide-svelte/icons/chevron-up';
  import EditorTabs from '$lib/components/app-shell/EditorTabs.svelte';
  import Graph from '$lib/flow/Graph.svelte';
  import { yamlToFlow } from '$lib/workflow/to-flow';
  import { flowGraphFromDto } from '$lib/workflow/from-dto';
  import PatternPicker from '$features/workflow-editor/components/PatternPicker.svelte';
  import RunDetail from '$features/workflow-editor/components/RunDetail.svelte';
  import TestNodePanel from '$features/workflow-editor/components/TestNodePanel.svelte';
  import { createEditorState } from '$features/workflow-editor/lib/editorState.svelte';
  import { editorCopy } from '$features/workflow-editor/lib/editorCopy';
  import {
    getTopBarEditorHolder,
    type TopBarSaveStatus,
  } from '$lib/components/app-shell/topBarContext.svelte';

  import type { RunSummaryDto } from '$features/workflow-editor/entities/dto';

  let { data } = $props();

  // Read `data.yaml` / `data.id` once at construction to seed the editor
  // buffer. Subsequent updates flow through `syncFromServer` in the
  // `$effect` below, so this initial dereference is intentional.
  // svelte-ignore state_referenced_locally
  const editor = createEditorState({ initialYaml: data.yaml, workflowId: data.id });

  /**
   * Currently inspected run. `null` means "no run selected" — the
   * RunDetail panel renders an empty-state caption in that case.
   *
   * The selection lives on this page so two surfaces can react to it:
   *
   *   - The interactive `RecentRuns` panel mounted in the *layout's*
   *     left sidebar (via the editor context bridge below). Clicking a
   *     row there flows into `setSelectedRunId`, which mutates this
   *     `$state`.
   *   - The `RunDetail` panel mounted in this page's right column,
   *     which reads `selectedRunId` directly.
   *
   * Hoisted above the Top Bar bridge so the bridge's `onRunStarted`
   * callback (fired by the Top Bar's `RunWorkflowButton`) can poke it
   * directly. The same field is what the Left Sidebar reads for its
   * `aria-current` highlight on the selected run row.
   */
  let selectedRunId: string | null = $state(null);

  /**
   * Save-status summary the Top Bar's pill mirrors. Computed from the
   * editor's transient `message` + `messageTone`. Order of branches
   * matters: `saving` always wins over the post-save `message`,
   * otherwise the pill would flicker `saved → saving → saved`
   * mid-keystroke when the user starts typing again.
   */
  const topBarSaveStatus = $derived<TopBarSaveStatus>(
    editor.saving
      ? 'saving'
      : editor.message === editorCopy.saved
        ? 'saved'
        : editor.messageTone === 'error'
          ? 'error'
          : 'idle',
  );

  /**
   * Publish the editor binding to the persistent app shell. The Top Bar
   * reads `workflowId` / `saving` / `saveStatus` / `save()` /
   * `onRunStarted()`. The Left Sidebar reads `selectedRunId` /
   * `setSelectedRunId()` to mount the interactive `RecentRuns` panel
   * with selection wired through this page (review-design.md: "RecentRuns
   * をサイドバー内にマウントする").
   *
   * Stable holder identity, getters for live values — same pattern as
   * before, just with two new fields for the sidebar selection contract.
   */
  const topBarHolder = getTopBarEditorHolder();
  topBarHolder.value = {
    get workflowId() {
      return data.id;
    },
    get saving() {
      return editor.saving;
    },
    get saveStatus() {
      return topBarSaveStatus;
    },
    get selectedRunId() {
      return selectedRunId;
    },
    save: () => editor.save(),
    onRunStarted: (runId) => {
      selectedRunId = runId;
    },
    setSelectedRunId: (runId) => {
      selectedRunId = runId;
    },
  };
  onDestroy(() => {
    // Clear the binding when the editor route unmounts so the Top Bar
    // collapses Save / Run controls and the Sidebar reverts to its
    // read-only `SidebarRecentRuns` footer instead of pointing at a
    // stale workflow id.
    topBarHolder.value = null;
  });

  // Re-sync the buffer whenever the load function reruns.
  $effect(() => {
    const { id, yaml } = data;
    editor.syncFromServer({ id, yaml });
  });

  onDestroy(() => editor.dispose());

  // Hybrid graph source (review note F-1): server graph for SSR + idle
  // buffer, client `yamlToFlow` for live edits.
  const serverGraph = $derived.by(() => flowGraphFromDto(data.opened.graph));
  let parsed = $derived(
    editor.yaml === data.yaml ? serverGraph : yamlToFlow(editor.yaml),
  );
  let patterns = $derived(data.patterns);
  // Heading id is shared with the textarea so screen readers announce the
  // workflow name when focus enters the YAML buffer (M-3). Mirrors the
  // EditorTabs `aria-controls` target so the tab strip + canvas pane stay
  // associated for assistive tech.
  const HEADING_ID = 'workflow-editor-heading';
  const CANVAS_PANE_ID = 'workflow-canvas-pane';

  // Reset the selection whenever the workflow id changes. A run id always
  // belongs to a single workflow (the API returns 404 if the ids don't
  // match) so a stale selection from the previous workflow would only ever
  // resolve to a 404 panel.
  $effect(() => {
    const _id = data.id;
    void _id;
    selectedRunId = null;
  });

  /**
   * Latest run summary for the current workflow — drives the canvas
   * Execution Bar (Pencil `hVaDB`). Owns its own fetch so re-loading the
   * page-level `data.yaml` does not have to invalidate every time a run
   * completes.
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
        const sorted = [...body].sort((a, b) => b.startedAt - a.startedAt);
        latestRun = sorted[0] ?? null;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // Soft-fail: a transient network error should not flicker the
        // canvas surface.
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

  /**
   * YAML buffer drawer toggle. The design (`k1kIS / RV8SI`) does not draw
   * a YAML pane at all — the canvas is the primary editing surface and
   * the file tab represents the open document. Our app still needs the
   * raw YAML accessible (every E2E suite asserts the textarea is visible
   * on load, and the YAML is the canonical source for hand-edited
   * workflows), so we render it as a collapsible bottom drawer inside
   * the center column.
   *
   * Defaults to *open* so the textbox is visible on the first paint
   * (the open-workflow scenario explicitly verifies the buffer is
   * present + populated). Users can collapse the drawer to give the
   * canvas the full center-column height once they're done editing.
   */
  let yamlOpen: boolean = $state(true);
</script>

<!--
  Editor body.

  Two-column grid (canvas/yaml stack on the left, inspector panel on the
  right). The Left Sidebar is owned by `+layout.svelte` and sits to the
  left of this `<section>`.

  Mobile (`<lg`): the inspector stacks under the canvas+yaml column so
  every surface is reachable via vertical scroll. Desktop (`>=lg`): the
  inspector pins to the right at 340px (matching `SV10l.width: 340` in
  the design) and the center column flexes to fill the remainder.

  `h-full` matches the layout's main column height — the Top Bar's 56px
  has already been subtracted upstream.
-->
<section
  class="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(40vh,1fr)_auto] overflow-y-auto lg:grid-cols-[1fr_340px] lg:grid-rows-1 lg:overflow-hidden"
>
  <!--
    Center column: file Tab Bar (`vWzaI`) + Canvas + collapsible YAML
    buffer drawer.

    Tab Bar is rendered by `EditorTabs.svelte` (app-shell), which
    encapsulates the design's `vWzaI` 38px row + active tab silhouette
    (`iDcnj`) and wires the close affordance to navigate back to `/`.
    See the EditorTabs file header for why exactly one tab is rendered
    today (the editor route is single-document; placeholder dummy tabs
    would mis-cue users that other files are "open in another tab"
    when no per-tab buffer state exists).
  -->
  <div
    class="flex min-h-0 flex-col bg-(--color-bg-canvas) lg:overflow-hidden"
  >
    <!--
      Visually hidden `<h1>` so the route still has a single primary
      heading for assistive tech (the previous markup folded the `<h1>`
      into the inline tab; extracting EditorTabs into its own component
      means the page now owns the heading directly). Mirrors the
      sr-only heading pattern used on `/` and `/workflows/new`.
    -->
    <h1 id={HEADING_ID} class="sr-only" title={data.id}>
      {data.opened.name}
    </h1>

    <EditorTabs
      workflowId={data.id}
      workflowName={data.opened.name}
      canvasPaneId={CANVAS_PANE_ID}
    />

    <!--
      Canvas pane (mirrors `EbnDF` Canvas Area). Holds the SvelteFlow
      visualisation + the Add Node FAB (`Hkw62`). `relative` makes the
      FAB's `absolute` placement land inside this pane.
    -->
    <section
      id={CANVAS_PANE_ID}
      class="relative flex min-h-0 flex-1 flex-col bg-(--color-bg-canvas)"
      aria-label="Workflow flow graph"
    >
      <Graph nodes={parsed.nodes} edges={parsed.edges} {latestRun} />
      <!--
        FAB anchored top-right, aligned with the design's Canvas Toolbar
        baseline (`gskMk` / `Hkw62`).
      -->
      <div class="pointer-events-none absolute top-3 right-3 z-10">
        <div class="pointer-events-auto">
          <PatternPicker
            {patterns}
            onInserted={(id, yaml) => editor.notifyInserted(id, yaml)}
          />
        </div>
      </div>
    </section>

    <!--
      YAML buffer drawer.

      The Pencil design treats the canvas as the primary editing surface
      and does not draw a peer YAML pane. We still need the raw buffer
      visible (open-workflow scenario asserts both the textarea and the
      graph are present on load, and YAML is the canonical hand-editable
      format for workflows), so we render it as a collapsible bottom
      drawer that:
        - Defaults to open so the first paint shows the buffer (E2E
          contract).
        - Caps its own height (`max-h-[40vh]` on `lg:`) so a long YAML
          file cannot push the canvas off-screen.
        - Toggles via a thin header row, mirroring the design's
          surface-on-canvas rhythm (`bg-surface` over `bg-canvas`).

      The toolbar / status row owns the heading text + save toast so
      screen readers still announce the workflow name when focus enters
      the textarea (`aria-describedby` chain below). We deliberately
      avoid promoting the toggle to a `<details>` element because the
      textarea inside `<details>` would lose focus on every collapse,
      and the open-workflow E2E suite walks focus through the buffer.
    -->
    <div
      class="flex shrink-0 flex-col border-t border-(--color-border-default) bg-(--color-bg-app) lg:max-h-[40vh]"
    >
      <div
        role="region"
        aria-label={`${data.opened.name} YAML buffer toolbar`}
        class="flex items-center justify-between gap-3 border-b border-(--color-border-subtle) bg-(--color-bg-surface) px-4 py-2"
      >
        <button
          type="button"
          onclick={() => (yamlOpen = !yamlOpen)}
          aria-expanded={yamlOpen}
          aria-controls="workflow-yaml-buffer"
          class="flex min-w-0 items-center gap-2 text-xs font-medium text-(--color-text-secondary) hover:text-(--color-text-primary) focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:outline-none"
        >
          {#if yamlOpen}
            <ChevronDown class="size-3.5" aria-hidden="true" />
          {:else}
            <ChevronUp class="size-3.5" aria-hidden="true" />
          {/if}
          <span>{editorCopy.yamlAriaLabel}</span>
        </button>
        <!--
          Save toast region. Errors use `role="alert"` so they interrupt;
          success / info uses `role="status"` so it does not. Same split
          as before the layout change.
        -->
        <div class="flex items-center gap-3 text-xs" aria-live="polite">
          {#if editor.message}
            {#if editor.messageTone === 'error'}
              <span
                data-testid="editor-toast"
                class="text-(--color-danger)"
                role="alert"
                aria-live="assertive">{editor.message}</span
              >
            {:else}
              <span
                data-testid="editor-toast"
                class="rounded bg-(--color-success-muted) px-2 py-0.5 text-(--color-text-primary)"
                role="status"
                aria-live="polite">{editor.message}</span
              >
            {/if}
          {/if}
        </div>
      </div>
      {#if yamlOpen}
        <textarea
          id="workflow-yaml-buffer"
          class="min-h-[20vh] w-full flex-1 resize-none overflow-auto bg-(--color-bg-canvas) p-3 font-mono text-xs whitespace-pre text-(--color-text-primary) outline-none lg:min-h-0"
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
          <p
            id={editorCopy.yamlErrorElementId}
            aria-live="polite"
            class="border-t border-(--color-danger-border) bg-(--color-danger-muted) px-3 py-1 text-xs text-(--color-danger)"
          >
            {parsed.error}
          </p>
        {/if}
      {/if}
    </div>
  </div>

  <!--
    Right Panel (`SV10l` in `apps/web/design/app.pen`).

    The design draws a 340px-wide vertical panel pinned to the right of
    the editor body, hosting the per-node Settings/Input/Output tabs +
    "Test Step" CTA. Today the schema-driven Settings editor is not yet
    wired (no remote function exposes per-node configuration as a
    structured form), so we render the panel skeleton with the surfaces
    that *are* backed today: `RunDetail` (read-run-detail scenario) and
    `TestNodePanel` (test-node scenario).

    `RecentRuns` previously also lived here — it has been hoisted into
    the Left Sidebar so the design's "list of runs lives in the
    sidebar" intent (`iHBGe` recent-runs rows) is honoured. The page
    still owns the selected-run state; the sidebar drives it via
    `setSelectedRunId` published through the editor context bridge.

    Mobile (`<lg`): stacks under the canvas+yaml column so the inspector
    stays reachable via vertical scroll. Desktop (`>=lg`): pins to the
    right with the design's 340px width and its own scroll container.
  -->
  <aside
    class="flex min-h-0 flex-col border-t border-(--color-border-subtle) bg-(--color-bg-surface) lg:overflow-hidden lg:border-t-0 lg:border-l"
    aria-label="Workflow inspection panel"
  >
    <RunDetail
      workflowId={data.id}
      runId={selectedRunId}
      onClose={() => (selectedRunId = null)}
      onStopAccepted={() => {
        // Intentionally a no-op — the panel re-fetches itself.
      }}
    />
    <TestNodePanel
      workflowId={data.id}
      nodeIds={parsed.nodes.map((n) => n.id)}
    />
  </aside>
</section>
