<!--
  Persistent app shell.

  Wraps every route in the design's three-zone layout (`k1kIS` in
  `apps/web/design/app.pen`):

      ┌──────────────── Top Bar (56) ────────────────┐
      │ brand · breadcrumb        history settings … │
      ├──────────┬───────────────────────────────────┤
      │ Left     │                                   │
      │ Sidebar  │  page content (`{@render …}`)     │
      │ (260)    │                                   │
      └──────────┴───────────────────────────────────┘

  The shell owns the persistent chrome; per-page content (YAML editor,
  canvas, run-detail panel, inspectors) renders inside the main column
  and is responsible for its own internal layout. The layout's load
  function (`+layout.server.ts`) supplies the workflow list the
  sidebar consumes — that's the only data this layout owns.

  Auth / error boundaries are intentionally untouched: SvelteKit's
  default `+error.svelte` propagation still works because we render
  the children inside the same `<main>` element rather than wrapping
  them in a custom error boundary.
-->
<script lang="ts">
  import '../app.css';
  import favicon from '$lib/assets/favicon.svg';
  import TopBar from '$lib/components/app-shell/TopBar.svelte';
  import LeftSidebar from '$lib/components/app-shell/LeftSidebar.svelte';
  import { provideTopBarEditorHolder } from '$lib/components/app-shell/topBarContext.svelte';

  let { data, children } = $props();

  // Install the Top Bar ↔ workflow-editor bridge. The workflow editor
  // route (`/workflows/[id]/+page.svelte`) writes into this holder so
  // the design's Save / "Saved" pill / Run controls (`Ht9Do`) can bind
  // to that page's reactive `editorState` without prop-drilling through
  // the layout. See `topBarContext.svelte.ts` for the rationale.
  provideTopBarEditorHolder();
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

<!--
  `h-[100dvh]` (dynamic viewport height) so the chrome collapses with
  the iOS / Android virtual keyboard rather than pushing the page
  off-screen. `flex flex-col` stacks the Top Bar over the body row;
  the body row is itself a `flex` container that splits into the
  fixed-width sidebar and a flex-grow main column. `min-h-0` /
  `min-w-0` propagate so a tall page (e.g. the YAML textarea) hands
  its overflow off to the page itself instead of stretching the
  shell.
-->
<div class="flex h-[100dvh] flex-col bg-(--color-bg-app) text-(--color-text-primary)">
  <TopBar workflows={data.workflows} />
  <div class="flex min-h-0 flex-1">
    <LeftSidebar workflows={data.workflows} />
    <!--
      `<main>` carries the primary landmark for screen readers. Pages
      render directly inside; their existing `min-h-screen` /
      `h-[100dvh]` constraints have been collapsed to `h-full` /
      `min-h-full` so they fit within this column without producing
      double scroll bars (see review note on the layout shell rollout).
    -->
    <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {@render children()}
    </main>
  </div>
</div>
