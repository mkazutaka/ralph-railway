<!--
  Empty editor / index canvas.

  After the Left Sidebar (`apps/web/design/app.pen`, frame `iHBGe`) became
  the canonical place to browse workflows, the index route no longer hosts
  its own list. Instead, when the user lands on `/` (no workflow open
  yet), this page renders the design's empty canvas surface (`EbnDF` —
  `$bg-canvas` background, with a centred elevated card prompting the
  user to pick a workflow from the sidebar or create a new one).

  Why an empty canvas instead of a redirect?
    - There is no canonical "default" workflow to redirect to. Picking
      the first one in alphabetical order would be arbitrary and would
      surprise users who expect `/` to be a neutral home.
    - The empty canvas mirrors the editor shell so the chrome (Top Bar
      + Left Sidebar) does not visually shift when the user opens a
      workflow — only the canvas content swaps.
    - The empty card preserves a discoverable "New workflow" affordance
      for users who arrive at `/` with zero workflows on disk (scenario
      invariant 1: zero workflows is a normal state, not an error).

  The "List Workflows" scenario
  (`apps/web/docs/scenarios/workflow-management/list-workflows.md`) is
  satisfied by the Left Sidebar's `WorkflowFileTree`, which renders the
  same `WorkflowSummaryDto` collection loaded by `+layout.server.ts`.
  This page intentionally avoids re-loading or re-rendering the list to
  keep the list a single source of truth.

  Why no visible page-level `<h1>` / "New" pill?
    The design (`apps/web/design/app.pen`) does NOT draw a page-level
    header on the canvas surface (`EbnDF`). The chrome already names the
    section — the sidebar (`iHBGe`) holds the literal "Workflows" label
    and the file-plus icon button, the Top Bar (`Ht9Do`) carries the
    brand → home link. Re-rendering "Workflows" + a "New" pill on top
    of the canvas violated the shell-invariance principle the design
    relies on (review-design.md M-2: "design に存在しない page-level
    header. iHBGe (LeftSidebar) と意味二重化, シェル不変性とも矛盾").

    The `<h1>` is kept off-screen via `sr-only` so:
      - assistive-tech users still hear a page heading on the empty
        canvas (every route should announce a single h1 for screen
        reader navigation),
      - existing E2E selectors that look up the heading by accessible
        name (`getByRole('heading', { name: 'Workflows', level: 1 })`)
        keep working without coupling to a visual element.
    The "New" affordance is rendered exactly once, inside the empty
    card's primary CTA — that is the single, discoverable entry point
    on the empty canvas (the sidebar's file-plus icon covers the
    populated case).
-->
<script lang="ts">
  import FilePlus from 'lucide-svelte/icons/file-plus';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import SaveButton from '$lib/components/save-button.svelte';
  import { workflowListCopy as copy } from '$features/workflow-editor/components/workflowListCopy';
  import type { PageProps } from './$types';

  // Explicit `PageProps` typing so the layout-data dependency is visible
  // at the route boundary. The route owns no `+page.server.ts` of its own
  // — `data.workflows` is supplied by `+layout.server.ts` and reaches this
  // component through SvelteKit's parent-data merge. Declaring the type
  // makes that contract auditable and gives the compiler a fail-fast hook
  // if the layout ever stops exposing the `workflows` field (review-design.frontend.md B-2).
  let { data }: PageProps = $props();

  // Are there any workflows on disk? Drives the empty card body copy:
  // when the user has zero files, we lead with the "create one" hint;
  // when they have at least one, we point them at the sidebar where the
  // canonical list now lives.
  const hasWorkflows = $derived(data.workflows.length > 0);
</script>

<!--
  Outer surface mirrors the design's Canvas Area (`EbnDF`): the editor
  shell's main column already lives on `$bg-app`, so the index canvas
  layers `$bg-canvas` on top to read as the editor's working surface
  even when no workflow is open.

  The radial-gradient `background-image` paints the same 24x24px dot
  grid the design draws across `EbnDF` (the lattice of `dot0`..`dot24`
  ellipses on `$border-subtle`, every 24px). Reproducing it here keeps
  the empty index canvas visually flush with the editor canvas a user
  reaches once they pick a file from the sidebar — same surface, same
  texture, only the foreground content differs.

  `overflow-hidden` keeps the centred empty card from scrolling on
  short viewports — the card auto-fits via the centred flex layout
  below.

  `bg-[position:0_0]` was previously set explicitly; dropped per
  review-design-frontend.md n-1 because that is the Tailwind default
  and only added arbitrary-value noise.
-->
<section
  class="relative flex h-full w-full flex-1 flex-col overflow-hidden bg-(--color-bg-canvas) bg-[radial-gradient(circle_at_1px_1px,_var(--color-border-subtle)_1px,_transparent_0)] bg-[length:24px_24px]"
  aria-label="Workflow canvas"
>
  <!--
    Off-screen page heading. See the top-of-file note: keeping the h1
    out of the visual flow honours the design's chrome-only naming
    while still announcing the page to screen-reader users and
    satisfying selectors that look up the heading by name.
  -->
  <h1 class="sr-only">{copy.pageHeading}</h1>

  <!--
    Empty canvas body. The card is anchored via the outer flex
    (`flex-1` + `items-center` + `justify-center`) so it always
    centres vertically, even on tall viewports. The card itself
    mirrors the design's elevated panels (`$bg-elevated` over the
    canvas, 1px subtle border, 12px corner radius matching
    `radius-lg`).

    Why no card-level `role="status"` / `aria-live="polite"`?
      The previous revision wrapped the whole card in a polite
      live region, which had two side effects flagged in
      review-design-indexpage-frontend.md M-1:
        1. screen-reader users heard the populated hint
           ("Open a workflow to get started…") re-announced every
           time they bounced from `/workflows/[id]` back to `/`,
        2. on a zero-workflow project the same `No workflows yet`
           string is announced by the sidebar tree's empty body
           (also a `role="status"`), so users got a duplicate
           polite cue.
      The live region is now scoped to the zero-workflow branch
      below, where the announcement is meaningful (the user just
      landed in an empty project) and rendered exclusive to the
      sidebar tree (the canvas card is `aria-live`, the sidebar
      tree's empty body keeps `role="status"` without an explicit
      `aria-live`, so the two surfaces no longer queue identical
      polite cues simultaneously).
  -->
  <div class="flex flex-1 items-center justify-center overflow-y-auto p-6 sm:p-10">
    <!--
      Empty card stays flat (no `shadow-sm`) to mirror the design's
      treatment of canvas-resident elevated panels (`EbnDF` carries
      no drop shadows on its inner cards — only the floating popovers
      like `h3L8J` "Add Node Popup" lift off the surface). A subtle
      shadow on this card was reading as "transient overlay" rather
      than "neutral home surface" (review-design-frontend.md m-1).
    -->
    <div
      class="flex w-full max-w-md flex-col items-center rounded-xl border border-(--color-border-default) bg-(--color-bg-elevated) px-6 py-10 text-center sm:px-10 sm:py-12"
    >
      <!--
        Folder-open icon (lucide `folder-open`) mirrors the sidebar's
        active project folder icon (`sQQiU` in the design). Using the
        accent fill ties the empty surface to the editor's accent
        treatment without needing a custom illustration.
      -->
      <span
        class="mb-4 flex size-12 items-center justify-center rounded-full bg-(--color-accent-muted) text-(--color-accent)"
        aria-hidden="true"
      >
        <FolderOpen class="size-6" />
      </span>

      {#if hasWorkflows}
        <!--
          Populated branch: a static neutral hint, not a live region.
          The user reached `/` deliberately (or by clicking the brand
          link) so re-announcing the body copy on every visit was
          noise. The visible text reads "Open a workflow from the
          workflows menu, or create a new one." — the `<lg` sidebar
          drawer surfaces under the same "Workflows" menu button in
          the Top Bar, so the copy stays accurate at every breakpoint
          (review-design-indexpage-frontend.md L-2).
        -->
        <p class="text-base font-semibold text-(--color-text-primary)">
          Open a workflow to get started
        </p>
        <p class="mt-2 text-sm text-(--color-text-secondary)">
          Pick a file from the workflows menu, or create a new workflow.
        </p>
      {:else}
        <!--
          Zero-workflow branch: this is the only meaningful "state"
          the page can announce, so the polite live region is scoped
          here. `role="status"` + `aria-live="polite"` so AT users
          hear the empty-state cue when the page mounts, while
          regular re-renders of the populated branch above stay
          silent (review-design-indexpage-frontend.md M-1).
        -->
        <div role="status" aria-live="polite">
          <p class="text-base font-semibold text-(--color-text-primary)">
            {copy.emptyTitle}
          </p>
          <p class="mt-2 text-sm text-(--color-text-secondary)">
            {copy.emptyHint}
          </p>
        </div>
      {/if}

      <!--
        Single primary CTA on the empty canvas. The button label uses
        `copy.newAction` ("New") so the design's discoverable affordance
        from the index route stays a single source of truth — both the
        sidebar's icon button (visual home) and this card CTA (canvas
        home) ultimately point at `/workflows/new`. The SaveButton
        wrapper carries the same accent palette as the design's
        "Add Node FAB" so the affordance reads as the primary action
        on this surface.
      -->
      <div class="mt-6">
        <SaveButton href="/workflows/new" aria-label={copy.newAction}>
          <FilePlus class="size-4" aria-hidden="true" />
          <span>{copy.newAction}</span>
        </SaveButton>
      </div>
    </div>
  </div>
</section>
