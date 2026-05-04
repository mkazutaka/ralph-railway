<!--
  Persistent left sidebar (desktop ≥ lg).

  Mirrors `iHBGe` in `apps/web/design/app.pen`: a 260px-wide vertical
  panel laid out as

      ┌─ Workflows · [+ file] [↻] ───────┐  ← header row (`K9V4cN`)
      │ [Filter files…]                   │  ← filter input (`KJLvI`)
      ├───────────────────────────────────┤
      │ ▾ 📂 .agents/railways         (n) │  ← project folder (`sQQiU`)
      │   ▸ <workflow rows>               │
      │ ▸ 📁 ~/.agents/railways       (0) │  ← user folder (`T54gTN`)
      │ ▸ 📁 $RALPH_RAILWAYS_PATH   empty │  ← env folder (`oB9GO`)
      ├───────────────────────────────────┤
      │ RECENT RUNS                       │  ← footer (`k3LmuC`)
      │ ● <run rows>                      │
      └───────────────────────────────────┘

  Mobile (`< lg`) renders the same body through a Top Bar-triggered
  drawer (`MobileSidebarDrawer.svelte`); both surfaces share the body
  via `SidebarContent.svelte`, so the file tree, filter and active-row
  highlight stay consistent across viewports.

  This component owns only the desktop chrome (panel surface, border,
  width) and is intentionally `hidden` below the `lg` breakpoint. The
  surrounding mobile drawer takes over below that point.

  A11y: the panel is a labelled landmark via `aria-label="Workflows"`.
  We intentionally avoid `aria-labelledby` pointing at the visible
  title (which would have to be a heading), because the index page
  (`/`) already mounts an `<h1>Workflows</h1>` — exposing two heading
  roles named "Workflows" would break the existing strict-locator
  `getByRole('heading', { name: 'Workflows' })` E2E assertion. Using
  the literal `aria-label` keeps the landmark named correctly without
  introducing a second heading.
-->
<script lang="ts">
  import type { WorkflowSummaryDto } from '$features/workflow-editor/entities/dto';
  import SidebarContent from './SidebarContent.svelte';
  import { leftSidebarCopy as copy } from './leftSidebarCopy';

  let {
    workflows,
  }: {
    workflows: ReadonlyArray<WorkflowSummaryDto>;
  } = $props();
</script>

<!--
  `min-h-0 overflow-hidden` mirrors `iHBGe.clip: true` from the design
  and is required for the inner `<nav class="overflow-y-auto">` to
  compute its scroll container correctly inside the parent flex row.
  Without `min-h-0` on this aside, a tall recent-runs list could push
  the nav past the viewport in some browsers' flex implementations
  (review note M-4).
-->
<aside
  aria-label={copy.heading}
  class="hidden min-h-0 w-[260px] shrink-0 flex-col overflow-hidden border-r border-(--color-border-default) bg-(--color-bg-surface) lg:flex"
>
  <SidebarContent {workflows} />
</aside>
