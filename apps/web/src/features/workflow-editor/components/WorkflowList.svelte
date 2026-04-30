<!--
  Workflow list view.

  Renders the "List Workflows" scenario
  (`apps/web/docs/scenarios/workflow-management/list-workflows.md`):
  a flat list of workflow summaries (id + name) with a per-row link into
  the editor. Visual language mirrors the file-tree rows in the design's
  Left Sidebar (`apps/web/design/app.pen`, frame `iHBGe` — file rows
  `mTzvO`/`NWlOe`/...): a 14px lucide `file-code` icon, the workflow name,
  and a chevron affordance on hover. Tokens come from `app.css` so the
  component theme-switches with the rest of the editor.

  Invariants honoured here:
    1. Zero-workflow case renders an empty-state card, NOT an error
       (scenario invariant 1).
    2. `name` is always rendered (scenario invariant 2 — the server falls
       back to the filename if YAML extraction fails, so the client never
       has to substitute).
    3. `id` is used as the {#each} key (scenario invariant 3 guarantees
       uniqueness within the list).

  Read-only — no mutations live here, so no companion `.remote.ts`. The
  page-level `+page.server.ts` owns the load and passes summaries via
  Props, matching the regulation rule "components do not own queries".
-->
<script lang="ts">
  import FileCode from 'lucide-svelte/icons/file-code';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import type { WorkflowSummaryDto } from '../entities/dto';
  import { workflowListCopy as copy } from './workflowListCopy';

  let {
    workflows,
  }: {
    workflows: ReadonlyArray<WorkflowSummaryDto>;
  } = $props();
</script>

{#if workflows.length === 0}
  <!--
    Empty state. Card surface mirrors the design's elevated panels
    (`$bg-surface` over `$bg-app` with a 1px subtle border + sm radius).
    Uses semantic tokens so the same markup renders correctly in the
    light theme without per-class overrides.
  -->
  <div
    class="rounded-md border border-(--color-border-default) bg-(--color-bg-surface) px-4 py-8 text-center sm:px-6 sm:py-10"
    role="status"
    aria-live="polite"
  >
    <p class="text-sm font-semibold text-(--color-text-primary)">
      {copy.emptyTitle}
    </p>
    <p class="mt-1 text-xs text-(--color-text-secondary) sm:text-sm">
      {copy.emptyHint}
    </p>
  </div>
{:else}
  <!--
    List container. `divide-y` provides per-row separators that match the
    sidebar file rows in the design (`iHBGe` → file rows separated by the
    sidebar background, here visualised as a thin `$border-subtle` rule
    because the index list lives on the app background, not inside a
    sidebar with its own surface). `overflow-hidden` keeps the rounded
    corners clipped under the row hover backgrounds.
  -->
  <ul
    aria-label={copy.listAria}
    class="divide-y divide-(--color-border-subtle) overflow-hidden rounded-md border border-(--color-border-default) bg-(--color-bg-surface)"
  >
    {#each workflows as workflow (workflow.id)}
      <li>
        <!--
          Whole-row link so the touch target spans the full row width
          (>=44px tall on mobile per WCAG 2.5.5; sm: collapses to 40px
          where pointer input dominates). `group` is the hover scope for
          the chevron reveal at the row tail.
        -->
        <a
          href={`/workflows/${encodeURIComponent(workflow.id)}`}
          class="group flex min-h-11 items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover) focus-visible:outline-none sm:min-h-10"
          aria-label={`${copy.openAction} ${workflow.name}`}
        >
          <!--
            Icon picks up the FlowCraft accent on hover/focus (`$accent`
            in the design's `viskv` activeIcon — file-code rendered in
            accent purple when its row is active). We don't render a
            permanent "active" state on the index because there is no
            current selection in this view; a transient hover/focus
            highlight is the closest analogue.
          -->
          <FileCode
            class="size-4 shrink-0 text-(--color-text-tertiary) group-hover:text-(--color-accent) group-focus-visible:text-(--color-accent)"
            aria-hidden="true"
          />
          <!--
            `min-w-0` plus `truncate` keeps long workflow names from
            pushing the chevron off the row on narrow viewports.
          -->
          <span class="min-w-0 flex-1 truncate text-(--color-text-primary)">
            {workflow.name}
          </span>
          <ChevronRight
            class="size-4 shrink-0 text-(--color-text-tertiary) opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden="true"
          />
        </a>
      </li>
    {/each}
  </ul>
{/if}
