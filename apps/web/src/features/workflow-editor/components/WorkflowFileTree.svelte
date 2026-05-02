<!--
  Nested workflow file tree.

  Renders the project folder section of the design's Left Sidebar
  (`apps/web/design/app.pen`, frame `iHBGe`):

      ┌───────────────────────────────────┐
      │ ▾ 📂 .agents/railways         (n) │  ← projHeader (`sQQiU`)
      │     📄 nextjs-todo.yaml      ●    │  ← active file (`mTzvO`)
      │     📄 code-review.yaml           │  ← inactive file (`NWlOe`)
      │     📄 release.yaml               │
      │     📄 bug-triage.yaml       ●    │  ← warning dot (`X3MG0`)
      └───────────────────────────────────┘

  This component owns the chevron + folder icon header, the nested
  workflow rows (file-code icon, label, optional status dot), and the
  visual treatment of the active row (accent-muted fill + 2px accent
  inside-stroke on the left edge, accent file icon, accent label). It
  does NOT own the surrounding sidebar chrome (filter input, search,
  recent runs, secondary user / env folders) — those stay in the
  hosting `SidebarContent.svelte` so the tree component can be reused
  in any container that needs a one-folder workflow tree (e.g. a
  command palette result list, a future "switch project" picker, etc).

  Why a feature-folder component (not `$lib/components/app-shell/`)?
  The tree is the canonical visualisation of the workflow-editor
  feature's `WorkflowSummaryDto` collection — the only consumer of
  the `WorkflowSummaryDto` payload that `+layout.server.ts` loads
  (the standalone `WorkflowList` index page that previously shared
  the DTO has been retired in favour of this sidebar tree). Keeping
  the tree in the feature folder preserves a single auditable
  data → view mapping and lets the app-shell sidebar consume it as
  an opaque `<WorkflowFileTree …>` invocation without growing
  further coupling to feature internals.

  Read-only — no mutations live here. Callers own the workflow list
  payload (loaded via `+layout.server.ts` for the desktop sidebar /
  mobile drawer) and the optional per-file status map. There is no
  companion `.remote.ts` because the component does not initiate any
  data fetch on its own (project rule: components do not own
  queries; data flows top-down via Props).

  Status dots:
    The design draws per-row dots — green (`Fl4x1`) on the active
    `nextjs-todo.yaml`, warning yellow (`X3MG0`) on `bug-triage.yaml`.
    The web app's `listWorkflowsWorkflow` deliberately does not
    enrich each summary with a "latest run status" so the layout
    payload stays cheap to recompute on every navigation. To keep
    the tree honest today AND ready for a future per-file status
    enrichment, the component accepts an optional
    `statusByWorkflowId` map: when supplied, each known id renders
    the matching dot variant; when omitted, only the active row
    surfaces a dot (semantic "this is the open file" indicator,
    matching the canonical design state at editor focus).

  A11y:
    - The folder header is a `<button>` with `aria-expanded`. The
      accessible name describes the toggle action via
      `folderToggleAria(folder, expanded)` so screen readers announce
      "Collapse folder .agents/railways" / "Expand folder …".
    - Each workflow row is an anchor with `aria-current="page"` when
      the row is the currently-open workflow (semantic "this is the
      current location" cue) and a label prefixed with the host
      copy's `openLabel` to differentiate the sidebar tree row from
      the index page list row in screen-reader rotor lists.
    - Status dots are `aria-hidden` because their meaning is already
      conveyed by `aria-current` on the active row; the warning /
      error variants are accompanied by an `sr-only` text label so a
      future per-file status enrichment can communicate the state
      without relying on color alone.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import FileCode from 'lucide-svelte/icons/file-code';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import Folder from 'lucide-svelte/icons/folder';
  import type { WorkflowSummaryDto } from '../entities/dto';

  /**
   * Per-row status indicator shown as a 6×6 dot at the trailing edge
   * of the row (matches the design's `Fl4x1` / `X3MG0` ellipses).
   * `success` = green (active / latest run succeeded);
   * `warning` = amber (latest run completed with warnings);
   * `error` = red (latest run failed);
   * `running` = accent (a run is in flight for this workflow).
   *
   * The variant set is deliberately small — these are the dot
   * colours the design exercises (`$success`, `$warning`, `$error`)
   * plus an accent variant for the in-flight state. New variants
   * should be added here, NOT inferred from arbitrary status
   * strings, so the tree's visual language stays auditable.
   */
  export type WorkflowFileTreeStatus =
    | 'success'
    | 'warning'
    | 'error'
    | 'running';

  let {
    workflows,
    activeId = null,
    folderLabel,
    folderToggleAria,
    openLabel,
    emptyMessage,
    emptyHint,
    filterNoMatch,
    countAriaLabel,
    totalCount,
    statusByWorkflowId = {},
    isFiltered = false,
    initiallyExpanded = true,
    onNavigate,
  }: {
    /** Workflows to render under the folder header. */
    workflows: ReadonlyArray<WorkflowSummaryDto>;
    /**
     * Id of the currently-open workflow (matched against
     * `WorkflowSummaryDto.id`). The matching row receives the
     * accent-muted fill + left-edge accent stroke + accent text +
     * `aria-current="page"`. Pass `null` when no workflow is open
     * (e.g. the index route).
     */
    activeId?: string | null;
    /** Folder label shown next to the folder icon (`projLabel` in the design). */
    folderLabel: string;
    /**
     * Builder for the folder toggle button's accessible name.
     * Hosted in the caller's copy module so the wording stays in
     * step with the rest of the sidebar (e.g. "Collapse folder X").
     */
    folderToggleAria: (folder: string, expanded: boolean) => string;
    /**
     * Prefix for each workflow row's accessible name. Defaults are
     * intentionally NOT provided — the host owns the wording so the
     * tree slots into different copy regimes without a fork.
     */
    openLabel: string;
    /** Empty-state heading shown when `workflows` is empty. */
    emptyMessage: string;
    /** Empty-state hint shown beneath `emptyMessage`. */
    emptyHint: string;
    /**
     * Message shown when the host has filtered the visible rows down
     * to zero (e.g. via the sidebar's filter input). When the rows
     * are intrinsically empty (`workflows.length === 0`), the
     * `emptyMessage` / `emptyHint` pair is shown instead.
     */
    filterNoMatch: string;
    /**
     * Accessible name for the file-count badge. The visible badge
     * text is the integer; the label spells out the unit so screen
     * readers announce e.g. "4 workflows" instead of just "4".
     */
    countAriaLabel: (count: number) => string;
    /**
     * Number rendered inside the count badge next to the folder
     * label. Defaults to `workflows.length`. Hosts that pass a
     * filtered `workflows` slice should pass the unfiltered total
     * here so the badge keeps reporting the project's true file
     * count rather than the filter-narrowed remainder (the badge
     * is a property of the folder, not the current view).
     */
    totalCount?: number;
    /**
     * Optional per-workflow status map. Keys are workflow ids;
     * values are the dot variant. When a row has no entry, no dot
     * is rendered for that row UNLESS the row is the active row
     * (which always shows a `success` dot to match the design's
     * canonical state on editor focus).
     */
    statusByWorkflowId?: Readonly<Record<string, WorkflowFileTreeStatus>>;
    /**
     * `true` when the host has narrowed `workflows` via a filter
     * input. Used to swap the empty body between the
     * "no workflows yet" copy and the "no matching files" copy.
     */
    isFiltered?: boolean;
    /** Whether the folder section starts expanded. Defaults to `true`. */
    initiallyExpanded?: boolean;
    /**
     * Notified when a row link is activated. Mobile drawer hosts
     * use this to close the drawer after navigation; the desktop
     * sidebar can ignore the callback (default no-op).
     */
    onNavigate?: () => void;
  } = $props();

  // The chevron toggle is local state seeded from the `initiallyExpanded`
  // prop. The prop is intentionally a *seed* — once the user clicks the
  // chevron, internal state owns the value and the prop is not re-read.
  // Wrapping the seed in `untrack` documents this contract and silences
  // Svelte's "state referenced locally" lint, which would otherwise flag
  // the one-time prop read as a missed-reactivity hazard.
  let expanded = $state(untrack(() => initiallyExpanded));

  /**
   * Per-instance unique id used to wire the chevron toggle button to the
   * `<ul>` of file rows it controls (`aria-controls` ↔ `id`). Without
   * this link, screen readers can announce the toggle's expanded state
   * but cannot navigate from the trigger to the controlled region.
   * `$props.id()` is stable across SSR / hydration and unique per
   * component instance, so multiple `<WorkflowFileTree>` instances on
   * the same page (e.g. desktop sidebar + mobile drawer) do not collide.
   */
  const listId = $props.id();

  /**
   * `totalCount` defaults to the visible row count so callers that
   * are not filtering can omit the prop entirely. When a filter is
   * applied, the host passes the unfiltered total so the badge keeps
   * reflecting the folder's true contents.
   */
  const displayedCount = $derived(totalCount ?? workflows.length);

  /**
   * `success` dot for the active row mirrors the design's `Fl4x1`
   * ellipse on `nextjs-todo.yaml`. The map override always wins so a
   * future "the active workflow's latest run failed" enrichment can
   * surface red on the active row without us having to special-case
   * the active branch here.
   */
  function dotFor(workflowId: string): WorkflowFileTreeStatus | null {
    const explicit = statusByWorkflowId[workflowId];
    if (explicit) return explicit;
    if (workflowId === activeId) return 'success';
    return null;
  }

  /**
   * Tailwind utility class for each dot variant. Colocated with the
   * dot rendering so adding a new variant requires touching exactly
   * one switch — the type system already enforces exhaustive coverage
   * via the `WorkflowFileTreeStatus` union.
   */
  function dotClass(variant: WorkflowFileTreeStatus): string {
    switch (variant) {
      case 'success':
        return 'bg-(--color-success)';
      case 'warning':
        return 'bg-(--color-warning)';
      case 'error':
        return 'bg-(--color-error)';
      case 'running':
        return 'bg-(--color-accent)';
    }
  }

  /**
   * sr-only label for the dot. `aria-current="page"` already
   * communicates "this is the open file" for the active-row green
   * dot, so we leave that case unlabelled to avoid the screen reader
   * announcing "current page" twice. Non-active dots carry semantic
   * status meaning that color alone cannot convey, so they get an
   * explicit text equivalent.
   */
  function dotLabel(
    workflowId: string,
    variant: WorkflowFileTreeStatus,
  ): string | null {
    if (workflowId === activeId && variant === 'success') return null;
    switch (variant) {
      case 'success':
        return 'Last run succeeded';
      case 'warning':
        return 'Last run finished with warnings';
      case 'error':
        return 'Last run failed';
      case 'running':
        return 'Run in progress';
    }
  }
</script>

<!--
  Folder header (`sQQiU` projHeader). Mirrors the design's chevron +
  folder-open icon + bold label + count badge layout. The button is
  full-width so the entire row is a hit target for the
  expand/collapse toggle.
-->
<button
  type="button"
  onclick={() => (expanded = !expanded)}
  class="flex h-7 w-full items-center gap-1.5 px-3 pl-2.5 text-left hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover) focus-visible:outline-none"
  aria-expanded={expanded}
  aria-controls={listId}
  aria-label={folderToggleAria(folderLabel, expanded)}
>
  {#if expanded}
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
  {#if expanded}
    <FolderOpen
      class="size-3.5 shrink-0 text-(--color-accent)"
      aria-hidden="true"
    />
  {:else}
    <Folder
      class="size-3.5 shrink-0 text-(--color-accent)"
      aria-hidden="true"
    />
  {/if}
  <span
    class="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-(--color-text-secondary)"
  >
    {folderLabel}
  </span>
  <span
    class="flex h-4 items-center justify-center rounded-sm bg-(--color-bg-elevated) px-1.5 text-[10px] font-semibold text-(--color-text-tertiary)"
    aria-label={countAriaLabel(displayedCount)}
  >
    {displayedCount}
  </span>
</button>

<!--
  Body wrapper carries the `id` referenced by the header button's
  `aria-controls` and uses the `hidden` attribute to mirror the
  collapsed state — the attribute removes the subtree from the
  accessibility tree and from the visual layout in a single hop, so
  no companion `{#if expanded}` guard is needed (review-design-
  leftsidebar-frontend.md m-5: a redundant `{#if}` + `hidden` pair
  was previously recreating the row subtree on every expand).
-->
<div id={listId} hidden={!expanded}>
  {#if displayedCount === 0}
    <!--
      Intrinsically-empty body. Shown when the underlying workflow
      list is empty (no .yaml files in the configured directory).
      The "filter narrowed to zero rows" branch lives below — we
      key off `displayedCount` (the project's true file count, not
      the filter-narrowed slice) so a 0-of-0 surface always reads
      as "no workflows yet" rather than "no files match the
      filter".
    -->
    <div class="px-3.5 py-3" role="status">
      <p class="text-xs font-medium text-(--color-text-secondary)">
        {emptyMessage}
      </p>
      <p class="mt-1 text-[11px] text-(--color-text-tertiary)">
        {emptyHint}
      </p>
    </div>
  {:else if workflows.length === 0 && isFiltered}
    <p
      class="px-3.5 py-3 text-[11px] text-(--color-text-tertiary)"
      role="status"
    >
      {filterNoMatch}
    </p>
  {:else}
    <ul>
      {#each workflows as workflow (workflow.id)}
        {@const isActive = workflow.id === activeId}
        {@const dot = dotFor(workflow.id)}
        <li>
          <!--
            Active row mirrors `mTzvO`: accent-muted fill + 2px
            accent inside-stroke on the left edge. Inactive rows
            mirror `NWlOe`: tertiary file icon, secondary text,
            transparent (but still 2px-wide) border, hover-only
            fill. Both rows use `pl-[22px]` so the icon column
            lands at exactly 24px from the row's left edge
            regardless of state — the active row's accent stroke
            and the inactive row's transparent border occupy the
            same 2px gutter, so swapping between them no longer
            causes the file-code icon to jump 4px sideways on
            navigation (which the previous `pl-[20px]` /
            `pl-[24px]` split did).
          -->
          <a
            href={`/workflows/${encodeURIComponent(workflow.id)}`}
            class="group flex h-7 items-center gap-2 border-l-2 pr-3 pl-[22px] text-xs transition-colors focus-visible:outline-none {isActive
              ? 'border-(--color-accent) bg-(--color-accent-muted)'
              : 'border-transparent hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover)'}"
            aria-current={isActive ? 'page' : undefined}
            aria-label={`${openLabel} ${workflow.name}`}
            onclick={() => onNavigate?.()}
          >
            <FileCode
              class="size-3.5 shrink-0 {isActive
                ? 'text-(--color-accent)'
                : 'text-(--color-text-tertiary)'}"
              aria-hidden="true"
            />
            <span
              class="min-w-0 flex-1 truncate {isActive
                ? 'font-medium text-(--color-accent)'
                : 'text-(--color-text-secondary)'}"
            >
              {workflow.name}
            </span>
            {#if dot}
              {@const label = dotLabel(workflow.id, dot)}
              <span
                class="size-1.5 shrink-0 rounded-full {dotClass(dot)}"
                aria-hidden="true"
              ></span>
              {#if label}
                <!--
                  Visually-hidden label so the per-row status is
                  not communicated by color alone. The active
                  row's `success` dot is intentionally unlabelled
                  because `aria-current="page"` already conveys
                  that meaning to assistive tech.
                -->
                <span class="sr-only">{label}</span>
              {/if}
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
