<!--
  Reusable sidebar body.

  Encapsulates the file tree the design's `iHBGe` ("Left Sidebar") frame
  describes, without taking responsibility for the surrounding chrome —
  the desktop `<aside>` and the mobile drawer both render the same body
  through this component, so they share filter state, empty / no-match
  surfaces and active-row highlighting.

  Why a child component instead of inlining the body in
  `LeftSidebar.svelte`?
    1. Mobile (`<lg`) rolls the same content into a Dialog drawer
       (`MobileSidebarDrawer.svelte`); duplicating the markup at two call
       sites would drift over time.
    2. Filter state is *local* to the panel — both the desktop sidebar
       and the mobile drawer want their own filter buffer scoped to a
       single mount, so storing the state inside the body component lets
       each instance own its own buffer rather than promoting it to the
       layout root.

  Structure mirrors the design:
    - Header (`K9V4cN`): "Workflows" label + three icon buttons
      mirroring the design's `iconRow` cluster — `UbDKN` file-plus
      (live link → /workflows/new), `u7HgI` folder-plus (Coming
      soon: rendered as a native `<button disabled>` with `title=
      "Coming soon"` because no "create workflow directory"
      scenario exists yet — same treatment the Top Bar uses for
      History / Settings / Share so the chrome stays visible without
      pretending to be functional), and `Y2Bvb` refresh (live, runs
      `invalidateAll` to refresh the workflow listing without
      throwing away unsaved editor buffers).
    - Filter input (`KJLvI` / `ZIT2U`): `Filter files…` placeholder,
      live-filters the project workflow list.
    - Project folder section (`sQQiU` + workflow rows): rendered via
      `WorkflowFileTree` — the design's chevron + folder-open header,
      file rows with file-code icon + label + per-row status dot, and
      the active row's accent-muted fill + 2px accent left stroke all
      live in that component now. Sidebar owns the data + filter
      buffer and forwards the visible slice as props.
    - User folder section (`T54gTN`): mirrors the design's
      `~/.agents/railways` group. The web app does not surface this
      directory today, so the section renders truthfully as empty.
    - `$RALPH_RAILWAYS_PATH` section (`oB9GO`): collapsed by default
      with the literal `empty` suffix the design specifies.
    - Recent runs footer (`k3LmuC` + run rows): mounted via
      `SidebarRecentRuns.svelte`.

  Status dots: the design draws per-row dots (`Fl4x1` green on the
  active file, `X3MG0` warning on `bug-triage.yaml`). `WorkflowFileTree`
  surfaces the active row's dot today; per-row dots for inactive
  workflows would require an additional latest-run lookup per file
  that the layout-level `listWorkflowsWorkflow` deliberately does not
  perform (review-design rationale: keep the sidebar payload cheap so
  it does not invalidate on every editor keystroke). When a future
  scenario surfaces per-workflow status, the tree component already
  accepts a `statusByWorkflowId` map so the data can flow in without
  markup churn here.
-->
<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import FilePlus from 'lucide-svelte/icons/file-plus';
  import FolderPlus from 'lucide-svelte/icons/folder-plus';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Folder from 'lucide-svelte/icons/folder';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import Search from 'lucide-svelte/icons/search';
  import { Input } from '$lib/components/ui/input';
  import type { WorkflowSummaryDto } from '$features/workflow-editor/entities/dto';
  import WorkflowFileTree from '$features/workflow-editor/components/WorkflowFileTree.svelte';
  import RecentRuns from '$features/workflow-editor/components/RecentRuns.svelte';
  import { leftSidebarCopy as copy } from './leftSidebarCopy';
  import SidebarRecentRuns from './SidebarRecentRuns.svelte';
  import { getTopBarEditorHolder } from './topBarContext.svelte';

  let {
    workflows,
    onNavigate,
  }: {
    workflows: ReadonlyArray<WorkflowSummaryDto>;
    /**
     * Notified whenever the user activates a navigation row (clicks a
     * file or the create-workflow link). The mobile drawer uses this to
     * close itself after navigation; the desktop sidebar can ignore the
     * callback (default no-op).
     */
    onNavigate?: () => void;
  } = $props();

  let filter = $state('');
  // Folder collapse state for the secondary user folder
  // (`~/.agents/railways`) and the env-var folder. Both default to
  // collapsed because the web app does not surface them today —
  // leaving them expanded would render an empty body that miscues
  // users into thinking the directory is empty (review-design m-4:
  // empty folder body should not consume vertical space). Once a
  // future scenario surfaces user-scoped or env-var workflows, the
  // default can flip back to open without further markup churn.
  // The project folder's expand/collapse state lives inside
  // `WorkflowFileTree` so each tree instance owns its own toggle.
  let userExpanded = $state(false);
  let extraExpanded = $state(false);

  const activeId = $derived<string | null>(page.params.id ?? null);

  const visible = $derived.by(() => {
    const query = filter.trim().toLowerCase();
    if (query === '') return workflows;
    return workflows.filter(
      (w) =>
        w.id.toLowerCase().includes(query) ||
        w.name.toLowerCase().includes(query),
    );
  });

  const isFiltered = $derived(filter.trim() !== '');

  /**
   * Refresh the layout payload without throwing away page-local state.
   * `location.reload()` (the previous implementation) discarded any
   * unsaved YAML buffer in the editor; `invalidateAll` re-runs the
   * server `load` only and lets the editor's own `$state` survive.
   */
  function refresh(): void {
    void invalidateAll();
  }

  /**
   * Read the editor binding installed by `+layout.svelte` so the sidebar
   * can switch between two run-list surfaces:
   *
   *   - When an editor route has published itself (i.e. the user is on a
   *     `/workflows/[id]` route and the page wired `setSelectedRunId`),
   *     mount the *interactive* `RecentRuns.svelte` panel so the sidebar
   *     drives the right-column `RunDetail` selection. This consolidates
   *     the design's "list of runs lives in the sidebar" intent
   *     (`iHBGe` recent rows) with the editor's selection mechanic.
   *
   *   - Otherwise (index page, "new workflow" page, or any embed that
   *     hasn't opted into the sidebar selection contract) fall back to
   *     `SidebarRecentRuns.svelte`, the read-only footer that mirrors
   *     the same design rows but without selection.
   *
   * The holder is reactive, so flipping between routes (or unmounting
   * the editor) triggers a re-render here without prop-drilling.
   */
  const editorHolder = getTopBarEditorHolder();
  const editorBinding = $derived(editorHolder.value);
  const interactiveRunsActive = $derived(
    editorBinding !== null && editorBinding.setSelectedRunId !== undefined,
  );
</script>

<!--
  Header row (`K9V4cN` in the design). Title text is rendered through a
  non-heading element (`<div role="presentation">`) so that the
  surrounding `<aside aria-label="Workflows">` / dialog landmark stays the
  single source of name for the panel. Promoting the title to `<h2>` is
  tempting but would expose a second `Workflows` heading role on `/`,
  which collides with the index page's `<h1>Workflows</h1>` under
  Playwright's strict-locator `getByRole('heading', { name: 'Workflows' })`
  query. Two icon-button affordances mirror the design's `UbDKN` (file-
  plus → /workflows/new) and `Y2Bvb` (refresh, with the design's hovered-
  ish `$bg-hover` resting fill so the most-used action stands out).
-->
<!--
  Header row mirrors the design's `K9V4cN.padding: [0,10,0,14]` — 14px
  on the left (so the title aligns with the file row's icon column) and
  10px on the right (icon-button cluster). Spelling the two paddings
  out with `pl-3.5 pr-2.5` (≈14/10) instead of `px-3 pl-3.5` removes the
  ambiguity of an override-then-override sequence (review note m-4).
-->
<div
  class="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-(--color-border-default) pr-2.5 pl-3.5"
>
  <!--
    Sidebar section heading ("Workflows", `vMTOu` in the design).
    Intentionally rendered as a non-heading element: the index page
    already mounts `<h1 class="sr-only">Workflows</h1>`, and any extra
    role="heading" with the same name would collide with Playwright's
    `getByRole('heading', { name: 'Workflows' })` strict locator
    (`apps/web/e2e/create-workflow.spec.ts:529`). The surrounding
    `<aside aria-label="Workflows">` (or mobile dialog with the same
    aria) already names this region for assistive tech, so a screen
    reader hears the section name from the landmark itself; the
    visible text is purely a visual cue and stays as a styled `<div>`.
  -->
  <div class="text-[13px] font-semibold text-(--color-text-primary)">
    {copy.heading}
  </div>
  <div class="flex items-center gap-0.5">
    <a
      href="/workflows/new"
      class="flex size-6 items-center justify-center rounded-sm text-(--color-text-secondary) hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover) focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:outline-none"
      aria-label={copy.newWorkflowAria}
      onclick={() => onNavigate?.()}
    >
      <FilePlus class="size-3.5" aria-hidden="true" />
    </a>
    <!--
      Coming-soon folder-plus affordance (`u7HgI` in the design). Kept in
      the cluster so the header reads at the design's 3-button width
      without inventing a directory-creation flow the backend cannot
      honour. Native `<button disabled>` strips both the pointer and
      keyboard activation paths consistently — `aria-disabled` alone
      would have left the click handler reachable. Activating once a
      future scenario lands is a one-line change: drop `disabled` and
      wire an `onclick` (or upgrade to `<a href>`).
    -->
    <button
      type="button"
      class="flex size-6 items-center justify-center rounded-sm text-(--color-text-secondary) disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:outline-none"
      aria-label={copy.newFolderAria + copy.comingSoonAriaSuffix}
      title={copy.comingSoonTooltip}
      data-testid="sidebar-new-folder-button"
      disabled
    >
      <FolderPlus class="size-3.5" aria-hidden="true" />
    </button>
    <button
      type="button"
      class="flex size-6 items-center justify-center rounded-sm bg-(--color-bg-hover) text-(--color-text-secondary) hover:bg-(--color-bg-active) focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:outline-none"
      aria-label={copy.refreshAria}
      onclick={refresh}
    >
      <RefreshCw class="size-3.5" aria-hidden="true" />
    </button>
  </div>
</div>

<!-- Filter input (`KJLvI` searchWrap → `ZIT2U` searchBox). -->
<div class="shrink-0 px-3 py-2">
  <div class="relative">
    <Search
      class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-(--color-text-tertiary)"
      aria-hidden="true"
    />
    <Input
      type="text"
      bind:value={filter}
      placeholder={copy.filterPlaceholder}
      aria-label={copy.filterAria}
      class="h-7 rounded-md border border-(--color-border-subtle) bg-(--color-bg-elevated) pl-8 text-xs text-(--color-text-primary) placeholder:text-(--color-text-tertiary) focus-visible:ring-1 focus-visible:ring-(--color-accent)"
    />
  </div>
</div>

<!--
  File tree. Listed inside a labelled `<nav>` so the inner workflow rows
  show up as a navigation landmark separate from the surrounding region
  landmark (which is named by the host `<aside aria-label="Workflows">`).
  This split keeps the landmark hierarchy from collapsing into a single
  ambiguous "Workflow navigation" surface (review note 6.b).
-->
<nav
  class="min-h-0 flex-1 overflow-y-auto pb-2"
  aria-label={copy.fileListAria}
>
  <!--
    Project folder section. `WorkflowFileTree` owns the chevron
    header, file rows, active-row accent treatment and the per-row
    status dots. The sidebar passes the filtered slice (so the
    "filter narrowed everything away" empty body shows the right
    copy) and the canonical workflow count for the badge.
  -->
  <WorkflowFileTree
    workflows={visible}
    totalCount={workflows.length}
    {activeId}
    folderLabel={copy.projectFolder}
    folderToggleAria={copy.folderToggleAria}
    openLabel={copy.openLabel}
    emptyMessage={copy.emptyMessage}
    emptyHint={copy.emptyHint}
    filterNoMatch={copy.filterNoMatch}
    countAriaLabel={copy.countAriaLabel}
    {isFiltered}
    onNavigate={() => onNavigate?.()}
  />

  <!--
    Secondary "user" folder section (`T54gTN` in the design,
    `~/.agents/railways`). The web app today only mounts the project
    workflow directory, so this folder is rendered with the design's
    chevron + folder icon but without children. We keep the row
    visible (rather than hiding it entirely) so users who recognise
    the design's three-folder model see the same surface and
    understand the secondary/tertiary roots are not yet wired into
    the web app.

    Rendered as a plain `<button>` rather than a second
    `<WorkflowFileTree>` instance because the section has no
    workflow rows and no count badge — it would otherwise need a
    different prop shape (empty state hint copy, no badge, no
    rows) than the canonical project tree, and forking the tree
    component to support both shapes would obscure its single
    responsibility (a folder of workflow rows).

    Top margin mirrors the design's 8px gap between folder sections
    (`T54gTN.padding[0] = 8`, review note M-5). Tailwind `mt-2` =
    0.5rem = 8px, replacing the previous `mt-1` (4px).
  -->
  <div class="mt-2">
    <button
      type="button"
      onclick={() => (userExpanded = !userExpanded)}
      class="flex h-7 w-full items-center gap-1.5 px-3 pl-2.5 text-left hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover) focus-visible:outline-none"
      aria-expanded={userExpanded}
      aria-label={copy.folderToggleAria(copy.userFolder, userExpanded)}
    >
      {#if userExpanded}
        <ChevronDown
          class="size-3.5 shrink-0 text-(--color-text-secondary)"
          aria-hidden="true"
        />
      {:else}
        <ChevronRight
          class="size-3.5 shrink-0 text-(--color-text-secondary)"
          aria-hidden="true"
        />
      {/if}
      <Folder
        class="size-3.5 shrink-0 text-(--color-text-secondary)"
        aria-hidden="true"
      />
      <span
        class="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-(--color-text-secondary)"
      >
        {copy.userFolder}
      </span>
      <span
        class="flex h-4 items-center justify-center rounded-sm bg-(--color-bg-elevated) px-1.5 text-[10px] font-semibold text-(--color-text-tertiary)"
        aria-label={copy.countAriaLabel(0)}
      >
        0
      </span>
    </button>
    {#if userExpanded}
      <p class="px-3.5 py-2 text-[11px] text-(--color-text-tertiary)">
        {copy.userFolderEmptyHint}
      </p>
    {/if}
  </div>

  <!--
    Tertiary `$RALPH_RAILWAYS_PATH` folder (`oB9GO`). Rendered collapsed
    by default with the literal "empty" suffix the design specifies, so
    the surface accurately reflects that the env-var-backed root is not
    populated. Clicking the chevron expands an explanatory blurb
    (rather than a fake file list) so the affordance still feels
    interactive without inventing data.

    Top margin matches the user folder section above (8px = `mt-2`),
    mirroring the design's 8px inter-folder gap (`oB9GO.padding[0] = 8`,
    review note M-5).
  -->
  <div class="mt-2">
    <button
      type="button"
      onclick={() => (extraExpanded = !extraExpanded)}
      class="flex h-7 w-full items-center gap-1.5 px-3 pl-2.5 text-left hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover) focus-visible:outline-none"
      aria-expanded={extraExpanded}
      aria-label={copy.folderToggleAria(copy.extraFolder, extraExpanded)}
    >
      {#if extraExpanded}
        <ChevronDown
          class="size-3.5 shrink-0 text-(--color-text-tertiary)"
          aria-hidden="true"
        />
      {:else}
        <ChevronRight
          class="size-3.5 shrink-0 text-(--color-text-tertiary)"
          aria-hidden="true"
        />
      {/if}
      <Folder
        class="size-3.5 shrink-0 text-(--color-text-tertiary)"
        aria-hidden="true"
      />
      <span
        class="min-w-0 flex-1 truncate text-xs font-medium tracking-wide text-(--color-text-tertiary)"
      >
        {copy.extraFolder}
      </span>
      <span class="text-[10px] italic text-(--color-text-tertiary)">
        {copy.extraFolderNote}
      </span>
    </button>
  </div>
</nav>

<!--
  Recent runs footer (`k3LmuC` + rows). Anchored at the bottom of the panel.

  When the active editor route has opted into sidebar-driven selection (it
  publishes `setSelectedRunId` via the editor context bridge), we mount the
  full `RecentRuns` panel so clicking a row drives the right-column
  `RunDetail` panel. On other routes (`/`, `/workflows/new`) the read-only
  `SidebarRecentRuns` footer renders instead so the design's rows stay
  visible without selection that would have nowhere to land.
-->
{#if interactiveRunsActive && editorBinding}
  <RecentRuns
    workflowId={editorBinding.workflowId}
    selectedRunId={editorBinding.selectedRunId ?? null}
    onSelect={(runId) => editorBinding.setSelectedRunId?.(runId)}
  />
{:else}
  <SidebarRecentRuns workflowId={activeId} />
{/if}
