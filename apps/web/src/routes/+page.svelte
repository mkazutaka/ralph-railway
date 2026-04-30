<!--
  Workflow index page.

  Implements the "List Workflows" scenario
  (`apps/web/docs/scenarios/workflow-management/list-workflows.md`):
  enumerates the workflow YAML files in the configured directory and
  links into the editor for each. Data is loaded server-side by
  `+page.server.ts` (which owns the workflow → DTO conversion); this
  component is purely presentational and only assembles the header,
  list, and surrounding layout.

  Visual language mirrors the FlowCraft Left Sidebar in the design
  (`apps/web/design/app.pen`, frame `iHBGe`): file-code icon + workflow
  name rows on a panel surface, with a `file-plus` accent CTA in the
  header echoing the design's `j3RscZ` icon button. The page itself
  lives on the app background so the panel reads as elevated, like the
  editor's main canvas.
-->
<script lang="ts">
  import FilePlus from 'lucide-svelte/icons/file-plus';
  import SaveButton from '$lib/components/save-button.svelte';
  import WorkflowList from '$features/workflow-editor/components/WorkflowList.svelte';
  import { workflowListCopy as copy } from '$features/workflow-editor/components/workflowListCopy';

  let { data } = $props();
</script>

<!--
  `min-h-screen` keeps the app background painting all the way down on
  short workflow lists. `max-w-3xl` matches the editor page's content
  column so navigating between index and editor does not produce a
  jarring width change. Mobile-first padding (`p-6 sm:p-8`) gives the
  empty-state and list breathing room on narrow viewports while still
  hugging the safe-area on phones.
-->
<main class="mx-auto min-h-screen max-w-3xl bg-(--color-bg-app) p-6 sm:p-8">
  <header class="mb-6 flex items-center justify-between gap-3">
    <h1 class="text-2xl font-semibold text-(--color-text-primary)">
      {copy.pageHeading}
    </h1>
    <!--
      Accessible name comes from the visible "New" label so the existing
      E2E suite (`getByRole('link', { name: 'New', exact: true })`)
      matches without a brittle `aria-label`. The lucide `file-plus`
      icon mirrors the design's `j3RscZ` icon button in the sidebar
      header and stays decorative via `aria-hidden`.
    -->
    <SaveButton href="/workflows/new">
      <FilePlus class="size-4" aria-hidden="true" />
      <span>{copy.newAction}</span>
    </SaveButton>
  </header>

  <WorkflowList workflows={data.workflows} />
</main>
