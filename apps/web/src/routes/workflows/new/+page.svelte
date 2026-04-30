<!--
  New workflow page.

  Carrier UI for the create-workflow scenario
  (`apps/web/docs/scenarios/workflow-management/create-workflow.md`): the
  user picks a `WorkflowId` (basename + .yaml/.yml) and a `YamlSource`,
  the form posts to `/api/workflows`, and on success the editor page
  opens at `/workflows/[id]`.

  This route component is intentionally a thin layout shell — all form
  state, the create POST, error surfacing and post-success navigation
  live in `CreateWorkflowForm.svelte`. Mirrors the rule in
  `.claude/rules/web-frontend.md`: ページコンポーネントにミューテーション
  ロジックを詰め込まない。

  Visual language continues the editor / index pages: the FlowCraft dark
  palette via CSS tokens (see `app.css`), the `--color-bg-app` background
  for the page surface, and the same layout container width
  (`max-w-3xl`) used on `routes/+page.svelte` so the create → list
  transition keeps the same horizontal rhythm.
-->
<script lang="ts">
  import CreateWorkflowForm from '$features/workflow-editor/components/CreateWorkflowForm.svelte';
  import { createWorkflowCopy as copy } from '$features/workflow-editor/components/createWorkflowCopy';
</script>

<main class="mx-auto min-h-screen max-w-3xl space-y-6 bg-(--color-bg-app) p-6 sm:p-8">
  <header class="space-y-1">
    <h1 class="text-2xl font-semibold text-(--color-text-primary)">{copy.heading}</h1>
    <p class="text-sm text-(--color-text-secondary)">{copy.subheading}</p>
  </header>

  <CreateWorkflowForm />
</main>
