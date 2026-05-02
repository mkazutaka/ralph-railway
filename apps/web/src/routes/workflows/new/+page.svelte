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

<!--
  Page sits inside the layout shell's main column; the column already
  paints the app background, so the route only owns its content
  rhythm. `h-full` + `overflow-y-auto` keeps the form scrollable on
  short viewports without producing a second scrollbar at the shell
  level.

  Shell-invariance (review note M-2): the design (`k1kIS`/`QZSIP`) has
  no page-level `<h1>` painted on the canvas — the chrome already names
  the surface (Top Bar brand link + sidebar `Workflows` label). The
  visible page heading was therefore a chrome-vs-content collision.
  We keep the heading semantically (sr-only `<h1>`) so screen readers
  still announce a single page heading and Playwright selectors that
  query `getByRole('heading', { name: 'New workflow' })` continue to
  resolve, then surface the visible form context inside the form
  surface itself (a small caption above the inputs). The heading text
  reads identically so locators match either visible or sr-only.
-->
<section class="mx-auto h-full w-full max-w-3xl space-y-6 overflow-y-auto p-6 sm:p-8">
  <h1 class="sr-only">{copy.heading}</h1>
  <p class="text-sm text-(--color-text-secondary)">{copy.subheading}</p>

  <CreateWorkflowForm />
</section>
