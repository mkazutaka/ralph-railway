<!--
  Create Workflow form.

  Implements `apps/web/docs/scenarios/workflow-management/create-workflow.md`:
  the user enters a `WorkflowId` (a basename + .yaml/.yml) and a `YamlSource`,
  and the form POSTs to `/api/workflows`. Successful creation redirects to
  `/workflows/[id]` so the editor opens on the freshly persisted file.

  Visual language continues the editor's: the FlowCraft dark palette via
  CSS tokens (see `app.css`), shadcn-svelte primitives (`Input`, `Label`,
  `Button`) for form controls, and `SaveButton` (matching `app.pen / Hkw62`
  Add Node FAB) for the primary action so the create → edit transition is
  visually continuous.

  This component owns the entire create flow (form state + submit + error
  surfacing) so the route's `+page.svelte` can stay a thin layout shell —
  per the rules in `.claude/rules/web-frontend.md`, ページコンポーネント
  にミューテーションロジックを詰め込まない.

  Behaviour:
    - On submit → POST `/api/workflows`. On 201, redirect to the editor.
    - 400 (InvalidId / brand reject), 409 (DuplicateId), 422 (InvalidYaml)
      surface inline as a `role="alert"` alert region. The form stays
      mounted so the user can correct the field and retry.
    - The submit trigger is disabled while a request is in flight to
      prevent double-create (scenario invariant 1: 既存のワークフローを
      上書きしない — duplicate clicks must not race).

  Accessibility:
    - Labels are wired to inputs via `for=` / `id=`.
    - Help captions are linked through `aria-describedby` so screen readers
      announce them after the role+name.
    - The error alert uses `role="alert" aria-live="assertive"` so failures
      from the API are announced once when they appear.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Button } from '$lib/components/ui/button';
  import SaveButton from '$lib/components/save-button.svelte';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import AlertCircle from 'lucide-svelte/icons/alert-circle';
  import { createWorkflow } from '../lib/api';
  import {
    NEW_WORKFLOW_DEFAULT_ID,
    NEW_WORKFLOW_DEFAULT_YAML,
  } from '../lib/newWorkflowTemplate';
  import { createWorkflowCopy as copy } from './createWorkflowCopy';

  let {
    /**
     * Initial values for the form. Allows tests + future scenarios (e.g.
     * "duplicate workflow" / "import from template") to seed the buffer
     * without re-implementing the form. Defaults match the scenario's
     * canonical scaffold (`NEW_WORKFLOW_DEFAULT_*`).
     */
    initialId = NEW_WORKFLOW_DEFAULT_ID,
    initialYaml = NEW_WORKFLOW_DEFAULT_YAML,
  }: {
    initialId?: string;
    initialYaml?: string;
  } = $props();

  // svelte-ignore state_referenced_locally
  let id = $state(initialId);
  // svelte-ignore state_referenced_locally
  let yaml = $state(initialYaml);

  type Status =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'error'; message: string };

  // Annotate the union so later assignments aren't narrowed away.
  let status = $state<Status>({ kind: 'idle' });
  let busy = $derived(status.kind === 'pending');

  // Synchronous re-entry guard. `busy` is a `$derived` of `$state` and Svelte
  // 5 may evaluate derivations lazily on a microtask, which means two rapid
  // back-to-back submit events (e.g. a real user double-clicking the SaveButton
  // before the spinner state lands) can both observe `busy === false` inside
  // the same synchronous tick and fire two POSTs. The plain-JS `inFlight`
  // flag is updated synchronously inside `handleSubmit` so the second
  // dispatch sees the guard immediately. This guarantees scenario invariant
  // 1 (Persist が二重実行されない) at the form layer rather than relying on
  // the server's 409 to catch the dup.
  let inFlight = false;

  // Hydration gate. The `<form onsubmit={handleSubmit}>` listener only
  // attaches after Svelte hydrates the SSR markup. A click that lands inside
  // the SSR-only window submits the form as a vanilla browser GET, which
  // navigates to `/workflows/new?id=...&yaml=...` and leaks the user's input
  // into the URL — and silently swallows the test's intent.
  //
  // Disabling the SaveButton until `onMount` fires makes the gap visible
  // (button is greyed out) instead of letting the browser swallow the click.
  // SSR renders `mounted = false` (button disabled); the moment Svelte runs
  // `onMount` on the client, the button flips enabled and the JS handler is
  // wired up, so a click can no longer race ahead of the listener.
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
  });

  // Track the in-flight controller so an unmount or rapid double-click
  // aborts the previous request before starting a new one — prevents a
  // late response from overwriting a fresh status.
  let controller: AbortController | null = null;
  onDestroy(() => controller?.abort());

  // Stable element ids so labels / help / errors can be wired through
  // `aria-describedby` without colliding when the component is mounted
  // more than once on the same page (defensive — today the page only
  // renders one instance).
  const ID_INPUT = 'create-workflow-id';
  const ID_HELP = 'create-workflow-id-help';
  const YAML_INPUT = 'create-workflow-yaml';
  const YAML_HELP = 'create-workflow-yaml-help';
  const ERROR_REGION = 'create-workflow-error';

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    // Synchronous guard against double-submit (see `inFlight` definition above).
    if (inFlight) return;
    inFlight = true;

    controller?.abort();
    const ac = new AbortController();
    controller = ac;
    status = { kind: 'pending' };

    try {
      const result = await createWorkflow(id, yaml, { signal: ac.signal });

      if (ac.signal.aborted) return;

      if (result.ok) {
        status = { kind: 'idle' };
        await goto(`/workflows/${encodeURIComponent(result.id)}`);
        return;
      }
      if (result.kind === 'cancelled') return;
      status = { kind: 'error', message: result.message };
    } finally {
      // Release the guard whether we succeeded, errored, or were aborted, so
      // the user can retry after fixing their input.
      inFlight = false;
    }
  }
</script>

<form
  class="space-y-5"
  onsubmit={handleSubmit}
  novalidate
  aria-describedby={status.kind === 'error' ? ERROR_REGION : undefined}
>
  <div class="space-y-2">
    <Label for={ID_INPUT} class="text-(--color-text-secondary)">
      {copy.fileNameLabel}
    </Label>
    <Input
      id={ID_INPUT}
      bind:value={id}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      required
      aria-describedby={ID_HELP}
      class="border-(--color-border-default) bg-(--color-bg-surface) text-(--color-text-primary) placeholder:text-(--color-text-tertiary) focus-visible:border-(--color-accent) focus-visible:ring-(--color-accent)/40"
    />
    <p id={ID_HELP} class="text-xs text-(--color-text-tertiary)">
      {copy.fileNameHelp}
    </p>
  </div>

  <div class="space-y-2">
    <Label for={YAML_INPUT} class="text-(--color-text-secondary)">
      {copy.yamlLabel}
    </Label>
    <textarea
      id={YAML_INPUT}
      bind:value={yaml}
      class="block h-72 w-full resize-y rounded-md border border-(--color-border-default) bg-(--color-bg-canvas) p-3 font-mono text-xs whitespace-pre text-(--color-text-primary) outline-none focus-visible:border-(--color-accent) focus-visible:ring-2 focus-visible:ring-(--color-accent)/40"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      required
      aria-describedby={YAML_HELP}
    ></textarea>
    <p id={YAML_HELP} class="text-xs text-(--color-text-tertiary)">
      {copy.yamlHelp}
    </p>
  </div>

  {#if status.kind === 'error'}
    <!--
      Error alert region. Uses `role="alert" aria-live="assertive"` so a
      failed submission is announced immediately. The icon is decorative
      (`aria-hidden="true"`); the heading + message provide the accessible
      content. Modelled after the editor's danger toast (`+page.svelte`)
      so the visual language is consistent across pages.
    -->
    <div
      id={ERROR_REGION}
      role="alert"
      aria-live="assertive"
      data-testid="create-workflow-error"
      class="flex items-start gap-2 rounded-md border border-(--color-danger-border) bg-(--color-danger-muted) px-3 py-2 text-sm text-(--color-danger)"
    >
      <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div class="space-y-0.5">
        <p class="font-medium">{copy.errorHeading}</p>
        <p>{status.message}</p>
      </div>
    </div>
  {/if}

  <div class="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
    <Button
      type="button"
      variant="ghost"
      href="/"
      class="text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
    >
      {copy.cancelLabel}
    </Button>
    <SaveButton
      type="submit"
      disabled={busy || !mounted}
      aria-busy={busy}
      data-testid="create-workflow-submit"
    >
      {#if busy}
        <LoaderCircle class="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {copy.submitBusyLabel}
      {:else}
        {copy.submitLabel}
      {/if}
    </SaveButton>
  </div>
</form>
