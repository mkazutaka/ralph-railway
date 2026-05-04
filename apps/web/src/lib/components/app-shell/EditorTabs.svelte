<!--
  Editor file tab strip.

  Mirrors the design's multi-file tab bar (`vWzaI` "Tab Bar" in
  `apps/web/design/app.pen`):

      ┌──────────────────────────────────────────────────────────────┐
      │ ▣ nextjs-todo.yaml ✕ │ ▣ code-review.yaml ✕ │ ▣ release ●    │
      └──────────────────────────────────────────────────────────────┘
        active: $bg-canvas + 2px accent bottom stroke + accent icon
        inactive: $bg-surface, $text-secondary label, dim close glyph

  Implementation reality check (why we render exactly one tab today):

  The design speculatively draws three open files plus a "New Tab" plus
  affordance, but the editor route is single-document — `/workflows/[id]`
  loads exactly one workflow per page render and the layout payload does
  not track "which workflows the user has opened in the past". The
  scenarios under `apps/web/docs/scenarios/workflow-management/` do not
  define a "switch between open tabs without losing buffer state"
  workflow, and the YAML buffer state lives on the page (it is recreated
  every time the user navigates between workflows). Rendering placeholder
  dummy tabs (`code-review.yaml`, `release.yaml`) would mis-cue the user
  that those files are "open in another tab" — clicking them would not
  restore a per-tab buffer because no per-tab buffer exists.

  Per the implementation brief: "現行の単一ワークフロー表示を破壊しない範囲で
  『現在のファイル名のみ表示するタブ』として表現してください". We render the
  surface row (`vWzaI`) and a single active tab (`iDcnj`) for the
  currently-open file. The close button is wired to navigate back to `/`
  (the canonical "no workflow open" surface), which is the closest
  honest analog to "close this tab" given the single-document model. The
  design's "New Tab" plus button is intentionally omitted: opening a new
  file means picking one in the sidebar tree (or hitting the canvas
  empty state's CTA), so a separate `+` here would either duplicate
  sidebar functionality or pop a placeholder dialog with no scenario
  behind it. When a multi-document scenario lands, the component takes
  an array of `WorkflowTabDescriptor` and the close button gains its
  per-tab semantics.

  Why an app-shell component (not a feature component)?
  The tab strip is shell chrome — it draws the surface row above the
  canvas regardless of which feature is mounted underneath. Co-locating
  with `TopBar` / `LeftSidebar` keeps the persistent-chrome surfaces
  next to each other and makes the design's three-zone diagram trivially
  legible from the directory listing.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import FileCode from 'lucide-svelte/icons/file-code';
  import X from 'lucide-svelte/icons/x';

  let {
    workflowId,
    workflowName,
    canvasPaneId,
    closeAriaLabel,
    onCloseRequested,
  }: {
    /**
     * Full filename of the currently-open workflow (e.g. `nextjs-todo.yaml`).
     * Used for the hover-tooltip + sr-only descriptor so screen readers
     * still hear the canonical id even though the visible label can be the
     * shorter display name.
     */
    workflowId: string;
    /**
     * Display label rendered inside the tab — typically the file's
     * basename (`data.opened.name`). Falls back to `workflowId` when the
     * caller has nothing nicer to show.
     */
    workflowName: string;
    /**
     * `aria-controls` target for the active tab. Wires the tab to the
     * canvas pane the editor route renders below the strip so assistive
     * tech reports the relationship correctly.
     */
    canvasPaneId: string;
    /**
     * Visible close-button accessible name. Pages can customise this for
     * i18n; the default reads "Close <name>". Required so screen-reader
     * users know which file the close button targets when multiple tabs
     * land in a future scenario.
     */
    closeAriaLabel?: string;
    /**
     * Optional close handler. When provided, fires before the default
     * navigation so the page can persist the buffer / show a confirm
     * dialog. Returning `false` cancels the default navigation. When
     * omitted, the close button just navigates back to `/`.
     */
    onCloseRequested?: () => boolean | void;
  } = $props();

  const computedCloseAriaLabel = $derived(
    closeAriaLabel ?? `Close ${workflowName}`,
  );

  /**
   * Close handler. Defaults to navigating back to the empty-canvas index
   * route — which is the design's canonical "no workflow open" surface —
   * because the single-document editor cannot meaningfully "close" the
   * file in place. A future multi-document scenario would replace the
   * fallback with `removeTab(workflowId)`; the prop callback hook lets
   * that scenario opt-in without a breaking API change here.
   */
  function handleClose(event: MouseEvent): void {
    event.preventDefault();
    const result = onCloseRequested?.();
    if (result === false) return;
    void goto('/');
  }
</script>

<!--
  Tab Bar surface row (`vWzaI`):
    - height 38px
    - bg `$bg-surface`
    - bottom 1px `$border-subtle`
  Rendered as a `role="tablist"` with a single child `role="tab"`. The
  outer container intentionally has no nav landmark — the sidebar
  (`<nav aria-label="Workflow file list">`) is the canonical workflow
  navigator; this strip only describes "what is currently visible in
  the canvas".
-->
<div
  role="tablist"
  aria-label={`Editor tabs for ${workflowName}`}
  class="flex h-[38px] shrink-0 items-stretch border-b border-(--color-border-subtle) bg-(--color-bg-surface)"
>
  <!--
    Active tab (`iDcnj`):
      - height 38, padding [0, 12, 0, 14], gap 8
      - bg `$bg-canvas` + bottom 2px accent stroke
      - file-code icon 13px in `$accent`
      - label Inter 12 / 500 in `$text-primary`
      - close glyph 12px in `$text-tertiary`
    `border-b-2` lifts the visual baseline 2px into the canvas pane so
    the bottom underline meets the canvas surface flush, matching the
    design's `bottom: 2 / $accent` stroke on `iDcnj`.
  -->
  <div
    role="tab"
    aria-selected="true"
    aria-controls={canvasPaneId}
    tabindex="0"
    class="flex h-full items-center gap-2 border-b-2 border-(--color-accent) bg-(--color-bg-canvas) pr-3 pl-3.5"
  >
    <FileCode
      class="size-3.5 shrink-0 text-(--color-accent)"
      aria-hidden="true"
    />
    <span
      class="min-w-0 max-w-[260px] truncate text-xs font-medium text-(--color-text-primary)"
      title={workflowId}
    >
      {workflowName}
    </span>
    <!-- Hidden id for screen readers — the visible label is the basename
         but the canonical workflow id is the full filename. -->
    <span class="sr-only">{workflowId}</span>
    <!--
      Close button (`O2MFC5`). Real affordance: navigates to `/` (the
      empty-canvas surface) so "close this tab" is honest about what the
      single-document model can deliver. Hover lifts the glyph to
      `text-secondary` matching the design's hover treatment of icon
      controls in `Ht9Do`. The 12px glyph + tighter hit area would fail
      the 44x44 mobile tap target, so we expand the click target with a
      surrounding 24x24 button frame while keeping the icon glyph at the
      design's 12px size.
    -->
    <button
      type="button"
      class="ml-1 flex size-6 shrink-0 items-center justify-center rounded text-(--color-text-tertiary) hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary) focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:outline-none"
      aria-label={computedCloseAriaLabel}
      onclick={handleClose}
    >
      <X class="size-3 shrink-0" aria-hidden="true" />
    </button>
  </div>
</div>
